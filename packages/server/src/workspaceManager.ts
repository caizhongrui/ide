/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Workspace Manager (SQLite-backed)
 *
 *  K-Watcher (v0.2.23)：每个工作区启一个 chokidar 文件系统 watcher，
 *  外部手动新建/删除文件（命令行 touch、其他 IDE 创建、git checkout 等）
 *  也能实时通知前端刷新 @ 引用文件候选缓存。
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import type { WorkspaceInfo } from './types.js';
import { getDb } from './database.js';

/** workspace watcher 上抛的批处理事件。added/removed 都是工作区相对路径。 */
export type WorkspaceFilesChange = {
	workspaceId: string;
	workspacePath: string;
	added:    string[];
	removed:  string[];
};
export type WorkspaceFilesListener = (change: WorkspaceFilesChange) => void;

type WsRecord = WorkspaceInfo & { id: string };

/** 数据库行类型 */
interface WsRow {
	id:        string;
	path:      string;
	name:      string;
	opened_at: number;
}

function rowToRecord(row: WsRow): WsRecord {
	return { id: row.id, path: row.path, name: row.name, openedAt: row.opened_at };
}

export class WorkspaceManager {
	// ─── K-Watcher：每工作区一个 chokidar 文件系统 watcher ────────────────────
	private readonly watchers      = new Map<string, FSWatcher>();
	private readonly pendingByWs   = new Map<string, { added: Set<string>; removed: Set<string> }>();
	private readonly flushTimers   = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly listeners     = new Set<WorkspaceFilesListener>();
	/** 同 IGNORED_DIRS 一致：传给 chokidar 的 anymatch glob，让它在遍历期间直接 prune 这些目录 */
	private static readonly IGNORED_GLOBS: readonly (string | RegExp)[] = [
		/(^|[\/\\])\../,                  // dotfiles
		'**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**',
		'**/target/**', '**/__pycache__/**', '**/vendor/**', '**/Pods/**',
		'**/coverage/**',
	];

	// ─── 初始化 ─────────────────────────────────────────────────────────────

	/**
	 * 从数据库加载工作区列表。
	 * 返回的对象每次操作都直接查询 SQLite，无内存缓存。
	 */
	static async load(): Promise<WorkspaceManager> {
		const mgr = new WorkspaceManager();
		// 触发 DB 初始化（schema 创建）
		const db = getDb();
		const count = (db.prepare('SELECT COUNT(*) as c FROM workspaces').get() as { c: number }).c;
		console.log(`[Database] 已加载 ${count} 个工作区`);
		// 给已存在的工作区启 watcher（启动失败不阻塞服务启动）
		await mgr.startAllWatchers().catch(e => console.error('[WorkspaceWatcher] startAllWatchers:', e));
		return mgr;
	}

	// ─── K-Watcher API ──────────────────────────────────────────────────────

	/** 订阅所有工作区的文件变化（批处理，100ms 时窗合并）。返回 unsubscribe。*/
	subscribeFileChanges(listener: WorkspaceFilesListener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** 关闭所有 watcher（server shutdown 调）。*/
	async dispose(): Promise<void> {
		const ids = Array.from(this.watchers.keys());
		await Promise.all(ids.map(id => this.stopWatcher(id)));
		for (const t of this.flushTimers.values()) clearTimeout(t);
		this.flushTimers.clear();
		this.pendingByWs.clear();
		this.listeners.clear();
	}

	private async startAllWatchers(): Promise<void> {
		for (const ws of this.list()) {
			try { await this.startWatcher(ws.id, ws.path); }
			catch (e) { console.error(`[WorkspaceWatcher] start ${ws.id} (${ws.path}):`, e); }
		}
	}

	private async startWatcher(wsId: string, wsPath: string): Promise<void> {
		if (this.watchers.has(wsId)) return;
		const watcher = chokidar.watch(wsPath, {
			ignored:        WorkspaceManager.IGNORED_GLOBS as (string | RegExp)[],
			ignoreInitial:  true,           // 已有文件由 listFiles 一次性提供，不重发
			persistent:     true,
			depth:          15,             // 与 listFiles walkDir maxDepth 一致
			awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
		});
		watcher.on('add',    p => this.recordChange(wsId, wsPath, p, 'added'));
		watcher.on('unlink', p => this.recordChange(wsId, wsPath, p, 'removed'));
		watcher.on('error',  err => console.error(`[WorkspaceWatcher] ${wsId} runtime:`, err));
		this.watchers.set(wsId, watcher);
		console.log(`[WorkspaceWatcher] ✅ ${wsId} → ${wsPath}`);
	}

	private async stopWatcher(wsId: string): Promise<void> {
		const w = this.watchers.get(wsId);
		if (!w) return;
		this.watchers.delete(wsId);
		try { await w.close(); } catch (e) { console.error(`[WorkspaceWatcher] close ${wsId}:`, e); }
		const t = this.flushTimers.get(wsId);
		if (t) { clearTimeout(t); this.flushTimers.delete(wsId); }
		this.pendingByWs.delete(wsId);
	}

	private recordChange(wsId: string, wsPath: string, absPath: string, kind: 'added' | 'removed'): void {
		// K-Win：归一化为 POSIX 风格 '/'，跟 listFiles() 输出格式一致，否则 Windows 上
		// 前端 wsFileCache 既有 '\' 又有 '/' 路径，去重 Set 会出双份。
		const rel = path.relative(wsPath, absPath).split(path.sep).join('/');
		// 排除工作区外（chokidar 偶尔会推出 root 路径自身）
		if (!rel || rel.startsWith('..')) return;
		let pending = this.pendingByWs.get(wsId);
		if (!pending) {
			pending = { added: new Set(), removed: new Set() };
			this.pendingByWs.set(wsId, pending);
		}
		if (kind === 'added') {
			pending.added.add(rel);
			pending.removed.delete(rel);     // 抖动：先删后建，最终保留 add
		} else {
			pending.removed.add(rel);
			pending.added.delete(rel);
		}
		if (!this.flushTimers.has(wsId)) {
			const t = setTimeout(() => {
				this.flushTimers.delete(wsId);
				this.flushPending(wsId);
			}, 100);
			this.flushTimers.set(wsId, t);
		}
	}

	private flushPending(wsId: string): void {
		const pending = this.pendingByWs.get(wsId);
		if (!pending) return;
		this.pendingByWs.delete(wsId);
		const added   = Array.from(pending.added);
		const removed = Array.from(pending.removed);
		if (added.length === 0 && removed.length === 0) return;
		const ws = this.get(wsId);
		if (!ws) return;                    // workspace 已被删
		const change: WorkspaceFilesChange = {
			workspaceId: wsId, workspacePath: ws.path, added, removed,
		};
		for (const listener of this.listeners) {
			try { listener(change); } catch (e) {
				console.error('[WorkspaceWatcher] listener:', e);
			}
		}
	}

	// ─── 查询 ────────────────────────────────────────────────────────────────

	list(): WsRecord[] {
		const db = getDb();
		const rows = db.prepare('SELECT * FROM workspaces ORDER BY opened_at DESC').all() as WsRow[];
		return rows.map(rowToRecord);
	}

	get(id: string): WsRecord | null {
		const db = getDb();
		const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WsRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	// ─── 增删改 ──────────────────────────────────────────────────────────────

	async add(absolutePath: string): Promise<WsRecord> {
		const resolved = path.resolve(absolutePath);
		const stat = await fs.stat(resolved);
		if (!stat.isDirectory()) {
			throw new Error(`${resolved} is not a directory`);
		}

		const db = getDb();
		// 去重：路径已存在则直接返回
		const existing = db.prepare('SELECT * FROM workspaces WHERE path = ?').get(resolved) as WsRow | undefined;
		if (existing) return rowToRecord(existing);

		const id = randomUUID();
		const name = path.basename(resolved);
		const openedAt = Date.now();

		db.prepare(
			'INSERT INTO workspaces (id, path, name, opened_at) VALUES (?, ?, ?, ?)'
		).run(id, resolved, name, openedAt);

		// 启动文件 watcher（失败不阻塞 add 成功）
		this.startWatcher(id, resolved).catch(e => console.error(`[WorkspaceWatcher] add-start ${id}:`, e));

		return { id, path: resolved, name, openedAt };
	}

	rename(id: string, name: string): WsRecord {
		const db = getDb();
		const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WsRow | undefined;
		if (!row) throw new Error(`Workspace ${id} not found`);
		const trimmed = name.trim();
		if (!trimmed) throw new Error('工作区名称不能为空');

		db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(trimmed, id);
		return rowToRecord({ ...row, name: trimmed });
	}

	async remove(id: string): Promise<void> {
		// 先停 watcher 再删 DB 行；防止 watcher 在 stop 前 fire 一次 emit 拿到 null workspace
		await this.stopWatcher(id);
		const db = getDb();
		db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
	}

	/**
	 * 列出工作区下的文件（相对路径）。
	 * 若提供非空 query，则仅返回文件名或路径包含 query（大小写不敏感）的文件。
	 *
	 * 深度上限 15：Java Maven / 单体仓库典型路径
	 *   <ws>/<sub-project>/<module>/src/main/java/com/<group>/<feature>/<sub>/Class.java
	 *   = 10 层；如果工作区根再外面套一层（如 /qdport/ai → 含多个 maven 项目）就到 11 层。
	 *   原来 8 层会把 src/main/java/com/x/y/z/Foo.java 这类路径全砍掉，导致所有 Java
	 *   源码看不到。15 层足够覆盖常见 Java / Go / 嵌套 monorepo 结构。
	 *   配合 IGNORED_DIRS 过滤 node_modules / target / dist / build 等大目录，性能可控。
	 */
	/** F15a: workspaceId → 完整文件列表的内存缓存。第一次 listFiles 后填充；
	 *  之后所有 query 都直接走内存过滤，秒回。chokidar 通过 addToFileCache/removeFromFileCache 增量更新。 */
	private fileCache = new Map<string, string[]>();
	/** F15a: 同一 workspace 的并发 listFiles 调用去重（避免重复扫） */
	private scanningPromise = new Map<string, Promise<string[]>>();

	async listFiles(id: string, query: string = ''): Promise<string[]> {
		const ws = this.get(id);
		if (!ws) throw new Error(`Workspace ${id} not found`);

		// F15a: 优先命中缓存
		let files = this.fileCache.get(id);
		if (!files) {
			// 缓存 miss：启动扫描（去重 — 同一 ws 并发只扫一次）+ await
			let promise = this.scanningPromise.get(id);
			if (!promise) {
				promise = (async () => {
					const results: string[] = [];
					await this.walkDir(ws.path, ws.path, results, 0, 15);
					this.fileCache.set(id, results);
					return results;
				})();
				this.scanningPromise.set(id, promise);
				void promise.finally(() => this.scanningPromise.delete(id));
			}
			files = await promise;
		}

		if (!query || query === '*' || query === '**/*') return files;

		// 过滤：文件名或相对路径含 query（忽略大小写）
		const q = query.toLowerCase().replace(/^\*|\*$/g, ''); // 去掉 glob 通配符
		if (!q) return files;
		return files.filter(f => f.toLowerCase().includes(q));
	}

	/** F15a: chokidar 'add' 事件回调（cli.ts subscribeFileChanges 内调用），增量更新缓存 */
	addToFileCache(workspaceId: string, relPath: string): void {
		const cache = this.fileCache.get(workspaceId);
		if (cache && !cache.includes(relPath)) cache.push(relPath);
	}

	/** F15a: chokidar 'unlink' 事件回调（cli.ts subscribeFileChanges 内调用），增量更新缓存 */
	removeFromFileCache(workspaceId: string, relPath: string): void {
		const cache = this.fileCache.get(workspaceId);
		if (cache) {
			const idx = cache.indexOf(relPath);
			if (idx >= 0) cache.splice(idx, 1);
		}
	}

	/** F15b: 启动预扫——sidecar 启动后立即对所有 workspace fire-and-forget 填缓存。
	 *  用户切换 workspace 时大概率缓存已就绪，避免首次 86s 卡顿。失败静默忽略，下次同步 listFiles 重试。 */
	prefetchAllFiles(): void {
		for (const ws of this.list()) {
			void this.listFiles(ws.id).catch(() => { /* 静默 */ });
		}
	}

	private static readonly IGNORED_DIRS = new Set([
		'node_modules', 'dist', 'build', 'out', 'target', '.git',
		'.svn', '__pycache__', '.pytest_cache', '.mypy_cache',
		'vendor', 'Pods', '.gradle', '.idea', '.vscode',
		'coverage', '.nyc_output', '.turbo', '.next', '.nuxt',
		// F15c: 加 Java / .NET / Maven / 临时目录
		'bin', 'obj', '.mvn', 'tmp', 'temp',
	]);

	private async walkDir(
		root: string,
		current: string,
		out: string[],
		depth: number,
		maxDepth: number
	): Promise<void> {
		if (depth > maxDepth) return;
		let entries: import('node:fs').Dirent[];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (WorkspaceManager.IGNORED_DIRS.has(entry.name)) continue;
			const full = path.join(current, entry.name);
			// K-Win (v0.2.24)：path.relative() 在 Windows 返回反斜杠 (a\b\c.java)，
			// 前端的 buildFileTree() 用 '/'.split() 切路径建树会失败，导致整个文件
			// 列表在 Windows 上变成一长串扁平节点（看不到树形结构）。
			// 统一归一化为 POSIX 风格 '/'，与 listFiles() 全链路约定一致。
			const rel = path.relative(root, full).split(path.sep).join('/');
			if (entry.isDirectory()) {
				await this.walkDir(root, full, out, depth + 1, maxDepth);
			} else {
				out.push(rel);
			}
		}
	}
}
