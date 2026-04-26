/*---------------------------------------------------------------------------------------------
 *  Maxian Core — NodeSearchService（ISearchService 的默认 Node 实现）
 *
 *  执行策略：
 *  1. 优先调用系统 ripgrep（`rg`）—— 速度最快、ignore 规则最一致
 *  2. rg 不可用时 fallback 到纯 JS 遍历 + RegExp（兼容任何 Node 环境）
 *
 *  Sidecar / Cloud Worker / 任何无 vscode 平台的形态都使用本实现。
 *  IDE 形态使用 VSCodeSearchService（包装 vscode 内置 ripgrep + ignoreFiles）。
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { normalizePerlInlineFlags } from '../utils/regexFlagsCompat.js';

import type {
	ISearchService,
	SearchTextOptions,
	SearchTextMatch,
} from '../interfaces/ISearchService.js';

/** 单行预览最大长度（与 IDE 对齐 400） */
const MAX_PREVIEW_LINE_CHARS = 400;

/** rg 子进程整体超时（默认 60s，调用方可通过 AbortSignal 提前取消） */
const RG_TIMEOUT_MS = 60_000;

/** JS fallback 遍历单文件最大字节（超大二进制跳过） */
const FALLBACK_MAX_FILE_BYTES = 1024 * 1024;

export class NodeSearchService implements ISearchService {
	constructor(
		/** 工作区根目录（用于 picomatch 相对匹配） */
		private readonly workspaceRoot: string,
		/** 可选：显式指定 rg 路径；未传则尝试系统 PATH */
		private readonly rgBinary:      string = 'rg',
	) {}

	async searchText(opts: SearchTextOptions): Promise<SearchTextMatch[]> {
		// 先试 ripgrep
		try {
			return await this.searchWithRipgrep(opts);
		} catch (e) {
			// rg 不可用 / 启动失败 → fallback 到 JS 实现
			if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return this.searchWithJsWalk(opts);
			}
			throw e;
		}
	}

	// ─────────────────────────────────────────────────────────────────
	// Ripgrep 子进程实现
	// ─────────────────────────────────────────────────────────────────

	private searchWithRipgrep(opts: SearchTextOptions): Promise<SearchTextMatch[]> {
		return new Promise((resolve, reject) => {
			const args: string[] = [
				'--json',
				'--max-count', String(opts.maxResults ?? 5000),
			];

			if (!(opts.isRegExp ?? true)) args.push('--fixed-strings');
			if (opts.isCaseSensitive)      args.push('--case-sensitive');
			else                           args.push('--ignore-case');
			if (opts.isWordMatch)          args.push('--word-regexp');

			for (const include of opts.includeGlobs ?? []) {
				args.push('--glob', include);
			}
			for (const exclude of opts.excludeGlobs ?? []) {
				args.push('--glob', `!${exclude}`);
			}

			args.push(opts.pattern);
			args.push(opts.folder);

			const child = spawn(this.rgBinary, args, {
				cwd:   opts.folder,
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			const matches: SearchTextMatch[] = [];
			let buffer = '';
			let killed = false;

			const timeout = setTimeout(() => {
				killed = true;
				child.kill('SIGTERM');
			}, RG_TIMEOUT_MS);

			const onAbort = () => {
				killed = true;
				child.kill('SIGTERM');
			};
			opts.signal?.addEventListener('abort', onAbort, { once: true });

			child.stdout.on('data', (chunk: Buffer) => {
				buffer += chunk.toString('utf8');
				let idx;
				while ((idx = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, idx);
					buffer    = buffer.slice(idx + 1);
					if (!line.trim()) continue;

					try {
						const evt = JSON.parse(line);
						if (evt.type === 'match') {
							const data = evt.data;
							const filePath   = data.path?.text ?? '';
							const lineNumber = data.line_number ?? 0;
							const lineText   = (data.lines?.text ?? '').replace(/\r?\n$/, '');
							matches.push({
								filePath,
								lineNumber,
								line: truncatePreviewLine(lineText),
							});
						}
					} catch { /* skip malformed JSON line */ }
				}
			});

			child.stderr.on('data', () => { /* swallow rg warnings */ });

			child.once('error', err => {
				clearTimeout(timeout);
				opts.signal?.removeEventListener('abort', onAbort);
				reject(err);
			});

			child.once('close', code => {
				clearTimeout(timeout);
				opts.signal?.removeEventListener('abort', onAbort);
				if (killed) {
					resolve(matches); // 部分结果（超时/取消）
					return;
				}
				// rg exit code: 0 = matches, 1 = no matches, 2 = error
				if (code === 0 || code === 1) {
					resolve(matches);
				} else {
					reject(new Error(`ripgrep exit ${code}`));
				}
			});
		});
	}

	// ─────────────────────────────────────────────────────────────────
	// JS Walk fallback（无 ripgrep 时）
	// ─────────────────────────────────────────────────────────────────

	private async searchWithJsWalk(opts: SearchTextOptions): Promise<SearchTextMatch[]> {
		const matches: SearchTextMatch[] = [];
		const limit                       = opts.maxResults ?? 5000;

		const includeMatchers = (opts.includeGlobs ?? []).map(p => picomatch(p, { dot: true }));
		const excludeMatchers = (opts.excludeGlobs ?? []).map(p => picomatch(p, { dot: true }));

		let regex: RegExp;
		try {
			// 支持 AI 生成的 Perl 风格内联标志 (?i) / (?ims) 等 → 转成 JS flags
			const norm = normalizePerlInlineFlags(opts.pattern, opts.isCaseSensitive ? 'g' : 'gi');
			regex = new RegExp(norm.pattern, norm.flags);
		} catch (e) {
			throw new Error(`Invalid regex: ${opts.pattern} — ${(e as Error).message}`);
		}

		const walk = (dir: string): void => {
			if (matches.length >= limit) return;
			if (opts.signal?.aborted) return;

			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
			catch { return; }

			for (const e of entries) {
				if (matches.length >= limit) return;
				if (opts.signal?.aborted) return;

				const full = path.join(dir, e.name);
				const rel  = path.relative(opts.folder, full).replace(/\\/g, '/');

				if (excludeMatchers.some(m => m(rel))) continue;

				if (e.isDirectory()) {
					walk(full);
				} else if (e.isFile()) {
					if (includeMatchers.length > 0 && !includeMatchers.some(m => m(rel))) continue;

					try {
						const st = fs.statSync(full);
						if (st.size > FALLBACK_MAX_FILE_BYTES) continue;
					} catch { continue; }

					let content: string;
					try { content = fs.readFileSync(full, 'utf8'); }
					catch { continue; }

					const lines = content.split(/\r?\n/);
					for (let i = 0; i < lines.length; i++) {
						if (matches.length >= limit) break;
						const ln = lines[i];
						if (regex.test(ln)) {
							matches.push({
								filePath:   full,
								lineNumber: i + 1,
								line:       truncatePreviewLine(ln),
							});
						}
						regex.lastIndex = 0; // reset for global flag
					}
				}
			}
		};

		walk(opts.folder);
		return matches;
	}
}

function truncatePreviewLine(line: string): string {
	const trimmed = line.trim();
	if (trimmed.length <= MAX_PREVIEW_LINE_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_PREVIEW_LINE_CHARS)}...`;
}
