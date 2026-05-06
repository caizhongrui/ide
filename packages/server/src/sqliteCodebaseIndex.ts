/*---------------------------------------------------------------------------------------------
 *  Maxian Server — SQLite-backed Codebase Index (B4)
 *
 *  实现 ICodebaseIndex 接口：扫工作区 → 提取文件树/API/模块/依赖 → embedding → 持久化。
 *
 *  当前 V1 实现（务实版）：
 *  - 文件树：fs 递归扫；忽略 node_modules / .git / dist / build / .next 等
 *  - 关键 API：基于轻量正则识别 export function / class / const，不依赖 LSP（避免 sidecar 依赖）
 *  - 依赖图：扫 import / require / from '...' 模式
 *  - 模块概要：按 src 子目录分组，把该目录的 API 名字拼起来作为 summary
 *  - 架构总结：根据顶层目录 + package.json + tsconfig 启发式生成
 *  - embedding：keyword embedding（已有 KeywordEmbeddingService）；search 走内存余弦
 *
 *  后续 V2 增强方向（不在本 V1 范围）：
 *  - LSP 抽 DocumentSymbol（更精确的 signature/docstring）
 *  - LLM 生成更高质量的架构 / 模块 summary（小模型成本可接受）
 *  - sqlite-vec 替代内存余弦（>5K APIs 时）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type ICodebaseIndex,
	type CodebaseIndexSnapshot,
	type CodebaseApiEntry,
	type CodebaseFileNode,
	type CodebaseModuleSummary,
	type CodebaseDepsEntry,
	type CodebaseSearchHit,
	type SymbolKind,
	searchEntriesByEmbedding,
} from '@maxian/core/codebase-index';
import { KeywordEmbeddingService, type EmbeddingService } from '@maxian/core/mcp';
import { getDb } from './database.js';

// ─── 扫描配置 ─────────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
	'out', 'target', '.cache', '.parcel-cache', 'coverage',
	'.maxian', '.idea', '.vscode',
]);
const CODE_EXTS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.py', '.rs', '.go', '.java', '.kt', '.swift',
	'.c', '.cpp', '.h', '.hpp',
	'.rb', '.php', '.cs',
	'.vue', '.svelte',
]);
const MAX_FILE_BYTES = 200 * 1024; // 200KB 跳大文件

interface FileScanResult {
	files: CodebaseFileNode[];
	apis:  CodebaseApiEntry[];
	deps:  CodebaseDepsEntry[];
}

// ─── 公共 helpers ─────────────────────────────────────────────────────────────

function bufferToFloat32(buf: Buffer | null): Float32Array | null {
	if (!buf) return null;
	const arr = new Float32Array(buf.byteLength / 4);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	for (let i = 0; i < arr.length; i++) arr[i] = view.getFloat32(i * 4, true);
	return arr;
}

function float32ToBuffer(arr: Float32Array): Buffer {
	const buf = Buffer.alloc(arr.length * 4);
	for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4);
	return buf;
}

// ─── 扫描器 ─────────────────────────────────────────────────────────────────

/** 让出 event loop（不阻塞 server 响应其他 HTTP 请求） */
const yieldToLoop = (): Promise<void> =>
	new Promise<void>((r) => setImmediate(r));

const YIELD_EVERY_FILES = 100;     // 每扫 100 文件让一次 loop

/**
 * 递归扫描工作区，收集文件 + 关键 API + 依赖。
 * 增量模式（since）：只处理 mtime > since 的文件。
 *
 * **异步化**：每处理 YIELD_EVERY_FILES 个文件 await yieldToLoop() 让出主线程，
 * 否则大项目（万级文件）期间 server event loop 完全卡死，浏览器其他请求全部超时。
 * 同时把进度通过 onProgress 实时上报，避免用户面对几十秒的"无反馈黑盒"。
 */
async function scanWorkspaceAsync(
	workspacePath: string,
	since?: number,
	onProgress?: (msg: string) => void,
): Promise<FileScanResult> {
	const files: CodebaseFileNode[] = [];
	const apis:  CodebaseApiEntry[] = [];
	const deps:  Map<string, Map<string, number>> = new Map(); // from → to → count
	let scanned = 0;

	const walk = async (dir: string): Promise<void> => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (ent.name.startsWith('.') && ent.name !== '.maxian') {
				if (IGNORED_DIRS.has(ent.name)) continue;
			}
			if (IGNORED_DIRS.has(ent.name)) continue;
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!ent.isFile()) continue;
			const ext = path.extname(ent.name).toLowerCase();
			if (!CODE_EXTS.has(ext)) continue;
			let st: fs.Stats;
			try { st = fs.statSync(full); } catch { continue; }
			if (st.size > MAX_FILE_BYTES) continue;
			if (since !== undefined && st.mtimeMs <= since) continue;

			const rel = path.relative(workspacePath, full);
			let content: string;
			try {
				content = fs.readFileSync(full, 'utf8');
			} catch {
				continue;
			}
			const lines = content.split('\n');

			files.push({
				path:    rel,
				purpose: inferFilePurpose(rel, content),
				loc:     lines.length,
				mtime:   st.mtimeMs,
			});

			// 提取关键 API
			const fileApis = extractApis(rel, content, lines);
			apis.push(...fileApis);

			// 提取依赖
			const fileDeps = extractDeps(content);
			if (fileDeps.length > 0) {
				let m = deps.get(rel);
				if (!m) { m = new Map(); deps.set(rel, m); }
				for (const d of fileDeps) m.set(d, (m.get(d) ?? 0) + 1);
			}

			scanned++;
			if (scanned % YIELD_EVERY_FILES === 0) {
				onProgress?.(`扫描中... 已处理 ${scanned} 个文件 (当前: ${rel.length > 60 ? '...' + rel.slice(-60) : rel})`);
				await yieldToLoop();
			}
		}
	};
	await walk(workspacePath);

	const depsList: CodebaseDepsEntry[] = [];
	for (const [from, m] of deps) {
		for (const [to, count] of m) depsList.push({ from, to, count });
	}

	onProgress?.(`扫描完成：${files.length} 文件 / ${apis.length} API / ${depsList.length} 依赖`);
	return { files, apis, deps: depsList };
}

/** 启发式推断文件用途（≤80 字一句话） */
function inferFilePurpose(relPath: string, content: string): string {
	// 优先看顶部注释
	const headBlock = content.slice(0, 500);
	const blockMatch = headBlock.match(/^\s*\/\*+\s*([\s\S]+?)\s*\*+\//);
	if (blockMatch) {
		const t = blockMatch[1]
			.split('\n')
			.map(l => l.replace(/^\s*\*\s?/, '').trim())
			.filter(l => l && !l.startsWith('Copyright') && !l.startsWith('@'))
			.join(' ')
			.slice(0, 80);
		if (t.length > 5) return t;
	}
	const lineComment = content.match(/^\s*\/\/\s*(.+)$/m) || content.match(/^\s*#\s*(.+)$/m);
	if (lineComment) {
		const t = lineComment[1].slice(0, 80).trim();
		if (t.length > 5 && !/^!|copyright|license/i.test(t)) return t;
	}
	// 退路：用文件名
	const base = path.basename(relPath, path.extname(relPath));
	return base;
}

/** 简单正则提取 export function/class/const 等 */
function extractApis(filePath: string, content: string, lines: string[]): CodebaseApiEntry[] {
	const apis: CodebaseApiEntry[] = [];
	// TypeScript / JS：export function / class / interface / type / const ...
	const patterns: Array<{ re: RegExp; kind: SymbolKind }> = [
		{ re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*([^{]*)\{/gm, kind: 'function' },
		{ re: /^export\s+class\s+([A-Za-z_$][\w$]*)\s*([^{]*)\{/gm, kind: 'class' },
		{ re: /^export\s+interface\s+([A-Za-z_$][\w$]*)\s*([^{]*)\{/gm, kind: 'interface' },
		{ re: /^export\s+type\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gm, kind: 'type' },
		{ re: /^export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]\s*([^\n]+)/gm, kind: 'const' },
		// Python
		{ re: /^def\s+([a-z_][\w]*)\s*\(([^)]*)\)\s*:/gm, kind: 'function' },
		{ re: /^class\s+([A-Za-z_][\w]*)\s*[:(]/gm, kind: 'class' },
	];
	for (const { re, kind } of patterns) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const name = m[1];
			if (!name) continue;
			const startIdx = m.index;
			// 计算行号
			const before = content.slice(0, startIdx);
			const startLine = before.split('\n').length;
			// 简单估 endLine：往下找 50 行内的下一个 export 或文件末尾
			let endLine = Math.min(startLine + 50, lines.length);
			// docstring：上面 1-3 行注释
			let docstring: string | undefined;
			for (let i = startLine - 2; i >= Math.max(0, startLine - 6) && i >= 0; i--) {
				const line = lines[i] ?? '';
				if (/^\s*(\/\/|\*|#|\/\*\*|\*\/)/.test(line) || line.trim() === '') {
					if (!docstring) docstring = '';
					docstring = line.replace(/^\s*[\/\*\s#]+|\*+\/\s*$/g, '').trim() + (docstring ? '\n' + docstring : '');
				} else {
					break;
				}
			}
			apis.push({
				filePath,
				symbolName: name,
				symbolKind: kind,
				signature:  m[2]?.trim().slice(0, 200),
				docstring:  docstring?.slice(0, 300),
				startLine,
				endLine,
			});
		}
	}
	return apis;
}

/** 简单提取 import / require 依赖 */
function extractDeps(content: string): string[] {
	const out = new Set<string>();
	const patterns = [
		/import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
		/require\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const re of patterns) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) out.add(m[1]);
	}
	return Array.from(out);
}

// ─── 模块概要 / 架构总结 ─────────────────────────────────────────────────────

function summarizeModules(workspacePath: string, files: CodebaseFileNode[], apis: CodebaseApiEntry[]): CodebaseModuleSummary[] {
	// 按 src 第一级子目录分组
	const groups: Map<string, { files: CodebaseFileNode[]; apis: CodebaseApiEntry[] }> = new Map();
	for (const f of files) {
		const parts = f.path.split(path.sep);
		// 跳过根目录的零散文件（留作"misc"）
		const top = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '<root>';
		if (top === 'src' || top === '<root>') continue;
		// 太深的就用前两段
		const dir = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
		let g = groups.get(dir);
		if (!g) { g = { files: [], apis: [] }; groups.set(dir, g); }
		g.files.push(f);
	}
	for (const a of apis) {
		const parts = a.filePath.split(path.sep);
		const dir = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
		const g = groups.get(dir);
		if (g) g.apis.push(a);
	}

	const out: CodebaseModuleSummary[] = [];
	for (const [dirPath, g] of groups) {
		// 简单 summary：列出 top-3 文件 + top-5 API
		const topFiles = g.files
			.sort((a, b) => b.loc - a.loc)
			.slice(0, 3)
			.map(f => f.path);
		const topApis = g.apis.slice(0, 5).map(a => a.symbolName).join(', ');
		const summary = `${g.files.length} 个文件，${g.apis.length} 个导出。${topApis ? '主要 API: ' + topApis : ''}`;
		out.push({ dirPath, summary, keyFiles: topFiles });
	}
	void workspacePath;
	return out.sort((a, b) => b.summary.length - a.summary.length).slice(0, 12);
}

function generateArchitectureMarkdown(workspacePath: string, files: CodebaseFileNode[]): string {
	const lines: string[] = [];
	const wsName = path.basename(workspacePath);
	lines.push(`# ${wsName}`, '');

	// 检测项目类型
	let projectType = '未知';
	try {
		const pkg = path.join(workspacePath, 'package.json');
		if (fs.existsSync(pkg)) {
			const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
			projectType = json.name ? `Node.js / ${json.name}` : 'Node.js';
			if (json.dependencies?.react) projectType += ' (React)';
			else if (json.dependencies?.vue) projectType += ' (Vue)';
			else if (json.dependencies?.['solid-js']) projectType += ' (Solid)';
			else if (json.dependencies?.next) projectType += ' (Next.js)';
		}
	} catch { /* ignore */ }
	if (fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) projectType = 'Rust';
	else if (fs.existsSync(path.join(workspacePath, 'pyproject.toml'))) projectType = 'Python';
	else if (fs.existsSync(path.join(workspacePath, 'go.mod'))) projectType = 'Go';

	lines.push(`**项目类型**：${projectType}`);
	lines.push(`**文件总数**：${files.length}（仅代码文件）`);
	lines.push('');

	// 顶层目录概览
	const topDirs = new Map<string, number>();
	for (const f of files) {
		const top = f.path.split(path.sep)[0];
		topDirs.set(top, (topDirs.get(top) ?? 0) + 1);
	}
	const sorted = Array.from(topDirs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
	if (sorted.length > 0) {
		lines.push('## 顶层结构', '');
		for (const [dir, count] of sorted) {
			lines.push(`- \`${dir}/\` — ${count} 个文件`);
		}
		lines.push('');
	}

	// 入口文件猜测
	const entries = files.filter(f =>
		/^(src\/|)(index|main|cli|server|app)\.(ts|tsx|js|py|rs|go)$/.test(f.path)
		|| /package\.json$/.test(f.path)
	).slice(0, 5);
	if (entries.length > 0) {
		lines.push('## 入口文件', '');
		for (const f of entries) {
			lines.push(`- \`${f.path}\`：${f.purpose}`);
		}
	}

	return lines.join('\n');
}

// ─── 主类 ─────────────────────────────────────────────────────────────────────

export class SqliteCodebaseIndex implements ICodebaseIndex {
	private readonly embedding: EmbeddingService;

	constructor(embedding?: EmbeddingService) {
		this.embedding = embedding ?? new KeywordEmbeddingService();
	}

	async rebuild(
		workspaceId: string,
		workspacePath: string,
		opts?: { incremental?: boolean; onProgress?: (msg: string) => void },
	): Promise<CodebaseIndexSnapshot> {
		const incremental = opts?.incremental === true;
		const onProgress = opts?.onProgress ?? (() => {});

		const db = getDb();
		const existing = db.prepare('SELECT * FROM codebase_index_meta WHERE workspace_id = ?').get(workspaceId) as
			| { last_indexed_at: number } | undefined;
		const since = incremental && existing ? existing.last_indexed_at : undefined;

		onProgress('扫描工作区...');
		// 使用异步版本，scanWorkspaceAsync 内部每 100 文件让一次 event loop +
		// 通过 onProgress 上报进度（前端 SSE 看得到）。
		const { files, apis, deps } = await scanWorkspaceAsync(workspacePath, since, onProgress);

		// 计算 API embedding（批量）
		onProgress(`计算 ${apis.length} 个 API 的向量...`);
		if (apis.length > 0) {
			const texts = apis.map(a => `${a.symbolName} (${a.symbolKind}) — ${a.docstring ?? ''}`);
			const vectors = await this.embedding.embed(texts);
			for (let i = 0; i < apis.length; i++) apis[i].embedding = vectors[i];
		}
		await yieldToLoop();   // 大项目此处也容易卡几百 ms，让一次

		onProgress('生成模块概要 + 架构总结...');
		const modules      = summarizeModules(workspacePath, files, apis);
		const architecture = generateArchitectureMarkdown(workspacePath, files);
		await yieldToLoop();

		// 持久化
		onProgress('写入数据库...');
		const now = Date.now();
		// 使用位置参数绑定（bun:sqlite 对 @name 命名参数在某些 prepare 后不会再次解析名字，
		// 导致 wpath 注入失败 → workspace_path 为 null → NOT NULL 触发）。改为位置参数稳定可靠。
		db.prepare(
			`INSERT INTO codebase_index_meta (workspace_id, workspace_path, last_indexed_at, file_count, api_count, module_count, architecture, tree_json, modules_json, deps_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(workspace_id) DO UPDATE SET
				workspace_path=excluded.workspace_path,
				last_indexed_at=excluded.last_indexed_at,
				file_count=excluded.file_count,
				api_count=excluded.api_count,
				module_count=excluded.module_count,
				architecture=excluded.architecture,
				tree_json=excluded.tree_json,
				modules_json=excluded.modules_json,
				deps_json=excluded.deps_json`,
		).run(
			workspaceId,
			workspacePath,
			now,
			files.length,
			apis.length,
			modules.length,
			architecture,
			JSON.stringify(files),
			JSON.stringify(modules),
			JSON.stringify(deps),
		);

		// API 表：增量则只清/插刷新过的文件，全量则清全部
		if (!incremental) {
			db.prepare('DELETE FROM codebase_index_apis WHERE workspace_id = ?').run(workspaceId);
		} else if (apis.length > 0) {
			const filesToWipe = new Set(apis.map(a => a.filePath));
			const stmt = db.prepare('DELETE FROM codebase_index_apis WHERE workspace_id = ? AND file_path = ?');
			for (const fp of filesToWipe) stmt.run(workspaceId, fp);
		}
		const insertApi = db.prepare(
			`INSERT INTO codebase_index_apis (workspace_id, file_path, symbol_name, symbol_kind, signature, docstring, start_line, end_line, embedding)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const a of apis) {
			insertApi.run(
				workspaceId,
				a.filePath,
				a.symbolName,
				a.symbolKind,
				a.signature ?? null,
				a.docstring ?? null,
				a.startLine,
				a.endLine,
				a.embedding ? float32ToBuffer(a.embedding) : null,
			);
		}

		onProgress(`完成（${files.length} 文件 / ${apis.length} API / ${modules.length} 模块）`);

		return {
			workspaceId,
			workspacePath,
			lastIndexedAt: now,
			fileCount:     files.length,
			apiCount:      apis.length,
			moduleCount:   modules.length,
			architecture,
			tree:          files,
			modules,
			deps,
		};
	}

	async getSnapshot(workspaceId: string): Promise<CodebaseIndexSnapshot | null> {
		const db = getDb();
		const row = db.prepare('SELECT * FROM codebase_index_meta WHERE workspace_id = ?').get(workspaceId) as
			| {
				workspace_id:    string;
				workspace_path:  string;
				last_indexed_at: number;
				file_count:      number;
				api_count:       number;
				module_count:    number;
				architecture:    string | null;
				tree_json:       string | null;
				modules_json:    string | null;
				deps_json:       string | null;
			}
			| undefined;
		if (!row) return null;
		const safeParse = <T>(s: string | null, fallback: T): T => {
			if (!s) return fallback;
			try { return JSON.parse(s) as T; } catch { return fallback; }
		};
		return {
			workspaceId:   row.workspace_id,
			workspacePath: row.workspace_path,
			lastIndexedAt: row.last_indexed_at,
			fileCount:     row.file_count,
			apiCount:      row.api_count,
			moduleCount:   row.module_count,
			architecture:  row.architecture ?? undefined,
			tree:          safeParse(row.tree_json,    [] as CodebaseFileNode[]),
			modules:       safeParse(row.modules_json, [] as CodebaseModuleSummary[]),
			deps:          safeParse(row.deps_json,    [] as CodebaseDepsEntry[]),
		};
	}

	async search(workspaceId: string, query: string, maxResults = 10): Promise<CodebaseSearchHit[]> {
		const db = getDb();
		const rows = db.prepare(
			'SELECT id, file_path, symbol_name, symbol_kind, signature, docstring, start_line, end_line, embedding FROM codebase_index_apis WHERE workspace_id = ?',
		).all(workspaceId) as Array<{
			id:           number;
			file_path:    string;
			symbol_name:  string;
			symbol_kind:  string;
			signature:    string | null;
			docstring:    string | null;
			start_line:   number;
			end_line:     number;
			embedding:    Buffer | null;
		}>;
		const entries: CodebaseApiEntry[] = rows.map(r => ({
			id:         r.id,
			filePath:   r.file_path,
			symbolName: r.symbol_name,
			symbolKind: r.symbol_kind as SymbolKind,
			signature:  r.signature ?? undefined,
			docstring:  r.docstring ?? undefined,
			startLine:  r.start_line,
			endLine:    r.end_line,
			embedding:  bufferToFloat32(r.embedding) ?? undefined,
		}));
		return searchEntriesByEmbedding(this.embedding, query, entries, maxResults, 0.05);
	}

	async delete(workspaceId: string): Promise<void> {
		const db = getDb();
		db.prepare('DELETE FROM codebase_index_meta WHERE workspace_id = ?').run(workspaceId);
		db.prepare('DELETE FROM codebase_index_apis WHERE workspace_id = ?').run(workspaceId);
	}
}
