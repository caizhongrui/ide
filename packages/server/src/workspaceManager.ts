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
		// F18：启动时从 DB 把已扫过的文件列表秒填内存热缓存（几十 ms，不扫盘）。
		// 之后 cli.ts prefetchAllFiles() 会后台全扫校对（绝不阻塞）修正关闭期变化。
		mgr.loadFileCacheFromDb();
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
		// F18：chokidar 实时增量 → 同步内存热缓存 + DB（再 broadcast 前端）
		for (const p of added)   this.addToFileCache(wsId, p);
		for (const p of removed) this.removeFromFileCache(wsId, p);
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
		// F18：新 workspace 后台全扫一次建文件缓存（fire-and-forget，绝不阻塞 add 返回）
		this.scanWorkspaceFilesBg(id, resolved);

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
	/** F18: workspaceId → 完整文件列表的内存热缓存（从 DB 填，chokidar 实时增量同步）。
	 *  listFiles 永远只读这里 —— **绝不在请求路径上做全量扫描**（那会阻塞 HTTP 连接）。 */
	private fileCache = new Map<string, string[]>();
	/** F18: 内存 Set 镜像（O(1) 去重判断，避免 includes 线性扫几万条） */
	private fileCacheSet = new Map<string, Set<string>>();
	/** F18: 正在后台全扫的 ws（去重，避免并发重复全扫） */
	private scanningInProgress = new Set<string>();

	// ─── F18 DB 持久层 helpers ───────────────────────────────────────────────
	/** 从 DB 读某 ws 的文件列表 */
	private loadFilesFromDb(wsId: string): string[] {
		try {
			const db = getDb();
			const rows = db.prepare('SELECT path FROM workspace_files WHERE workspace_id = ?').all(wsId) as Array<{ path: string }>;
			return rows.map(r => r.path);
		} catch { return []; }
	}
	private isFilesScanned(wsId: string): boolean {
		try {
			const db = getDb();
			const row = db.prepare('SELECT files_scanned FROM workspaces WHERE id = ?').get(wsId) as { files_scanned?: number } | undefined;
			return !!row?.files_scanned;
		} catch { return false; }
	}
	/** 全量替换某 ws 的 DB 文件列表（事务批量，置 files_scanned=1）。在后台调用，不在请求路径。 */
	private saveFilesToDb(wsId: string, files: string[]): void {
		try {
			const db = getDb();
			const tx = db.transaction((list: string[]) => {
				db.prepare('DELETE FROM workspace_files WHERE workspace_id = ?').run(wsId);
				const ins = db.prepare('INSERT OR IGNORE INTO workspace_files (workspace_id, path) VALUES (?, ?)');
				for (const p of list) ins.run(wsId, p);
				db.prepare('UPDATE workspaces SET files_scanned = 1 WHERE id = ?').run(wsId);
			});
			tx(files);
		} catch (e) { console.error('[F18] saveFilesToDb:', e); }
	}
	private dbInsertFile(wsId: string, relPath: string): void {
		try { getDb().prepare('INSERT OR IGNORE INTO workspace_files (workspace_id, path) VALUES (?, ?)').run(wsId, relPath); } catch { /* ignore */ }
	}
	private dbDeleteFile(wsId: string, relPath: string): void {
		try { getDb().prepare('DELETE FROM workspace_files WHERE workspace_id = ? AND path = ?').run(wsId, relPath); } catch { /* ignore */ }
	}

	/** F18 启动：从 DB 把所有 ws 的文件列表填进内存热缓存（秒回，不扫盘）。 */
	loadFileCacheFromDb(): void {
		for (const ws of this.list()) {
			const files = this.loadFilesFromDb(ws.id);
			if (files.length > 0) {
				this.fileCache.set(ws.id, files);
				this.fileCacheSet.set(ws.id, new Set(files));
			}
		}
	}

	/**
	 * @param id workspaceId
	 * @param query 模糊过滤（路径子串）
	 * @param _wait 兼容旧签名，已忽略 —— listFiles **永不阻塞**，只读内存缓存。
	 *
	 * F18：listFiles 只读内存 fileCache（启动时已从 DB 填）。缓存未就绪（从没扫过的新 ws）→
	 * 立即返回空 + 后台 fire-and-forget 全扫（绝不在请求路径 await 全量扫描，避免占住 HTTP 连接）。
	 */
	async listFiles(id: string, query: string = '', _wait: boolean = true): Promise<string[]> {
		const ws = this.get(id);
		if (!ws) throw new Error(`Workspace ${id} not found`);

		let files = this.fileCache.get(id);
		if (!files) {
			// 内存没有 → 从 DB 兜底读一次（可能 loadFileCacheFromDb 之后新加的 ws）
			const fromDb = this.loadFilesFromDb(id);
			if (fromDb.length > 0) {
				this.fileCache.set(id, fromDb);
				this.fileCacheSet.set(id, new Set(fromDb));
				files = fromDb;
			} else {
				// 真的从没扫过 → 触发后台全扫（不阻塞），本次立即返回空
				this.scanWorkspaceFilesBg(id, ws.path);
				return [];
			}
		}

		if (!query || query === '*' || query === '**/*') return files;
		const q = query.toLowerCase().replace(/^\*|\*$/g, '');
		if (!q) return files;
		return files.filter(f => f.toLowerCase().includes(q));
	}

	/**
	 * F18 后台全扫（fire-and-forget，绝不阻塞）：walkDir 全扫 → 写内存 + DB → broadcast 前端。
	 * 用于：① 新 ws 首次扫描；② 启动后台校对（和 DB diff，修正 app 关闭期间的变化）。
	 * walkDir 本身是 async（每层 readdir 让出事件循环），全程不阻塞其它请求。
	 */
	scanWorkspaceFilesBg(wsId: string, wsPath: string): void {
		if (this.scanningInProgress.has(wsId)) return;
		this.scanningInProgress.add(wsId);
		void (async () => {
			try {
				const results: string[] = [];
				await this.walkDir(wsPath, wsPath, results, 0, 15);
				const fresh = new Set(results);
				const old = this.fileCacheSet.get(wsId) ?? new Set<string>();
				// diff：算出新增 / 删除（用于 broadcast 前端增量更新）
				const added:   string[] = results.filter(p => !old.has(p));
				const removed: string[] = [...old].filter(p => !fresh.has(p));
				// 写内存
				this.fileCache.set(wsId, results);
				this.fileCacheSet.set(wsId, fresh);
				// 写 DB（事务批量，置 files_scanned=1）
				this.saveFilesToDb(wsId, results);
				// 有变化 → broadcast 前端增量
				if (added.length > 0 || removed.length > 0) {
					const ws = this.get(wsId);
					if (ws) {
						const change: WorkspaceFilesChange = { workspaceId: wsId, workspacePath: ws.path, added, removed };
						for (const listener of this.listeners) {
							try { listener(change); } catch { /* ignore */ }
						}
					}
				}
				console.log(`[F18] ${wsId} 全扫完成：${results.length} 文件（新增 ${added.length} / 删除 ${removed.length}）`);
			} catch (e) {
				console.error('[F18] scanWorkspaceFilesBg:', e);
			} finally {
				this.scanningInProgress.delete(wsId);
			}
		})();
	}

	/** F18 chokidar 'add' 实时回写：内存 + DB（路径已归一化 POSIX） */
	addToFileCache(workspaceId: string, relPath: string): void {
		const set = this.fileCacheSet.get(workspaceId);
		if (set && !set.has(relPath)) {
			set.add(relPath);
			this.fileCache.get(workspaceId)?.push(relPath);
			this.dbInsertFile(workspaceId, relPath);
		} else if (!set) {
			// 缓存还没建（首次扫描前的变化）—— 仍写 DB，扫描时会合并
			this.dbInsertFile(workspaceId, relPath);
		}
	}

	/** F18 chokidar 'unlink' 实时回写：内存 + DB */
	removeFromFileCache(workspaceId: string, relPath: string): void {
		const set = this.fileCacheSet.get(workspaceId);
		if (set?.has(relPath)) {
			set.delete(relPath);
			const arr = this.fileCache.get(workspaceId);
			if (arr) {
				const idx = arr.indexOf(relPath);
				if (idx >= 0) arr.splice(idx, 1);
			}
		}
		this.dbDeleteFile(workspaceId, relPath);
	}

	/** F18 启动文件缓存策略（绝不阻塞、绝不抢启动期资源）：
	 *  ① loadFileCacheFromDb 已秒填内存（已扫过的 ws）；
	 *  ② **从没扫过的（files_scanned=0）** → 立即后台全扫建缓存（必须，否则没数据）；
	 *  ③ **已扫过的** → DB 缓存已就绪，启动**不立即全扫**（之前并发全扫所有 ws 的几万次 readdir
	 *     会占满 Bun 单线程事件循环数十秒，拖慢同期的 messages/git 请求 —— 实测 net 21~37s）。
	 *     改为延迟 90s（避开启动期 UI/消息加载）后**串行、错峰**校对，每个之间隔 8s，且 walkDir
	 *     每层让出事件循环 —— 修正应用关闭期间的文件变化，但绝不影响启动期。 */
	prefetchAllFiles(): void {
		const all = this.list();
		const scanned: WsRecord[] = [];
		for (const ws of all) {
			if (!this.isFilesScanned(ws.id)) {
				this.scanWorkspaceFilesBg(ws.id, ws.path);   // 首次建缓存：立即后台扫
			} else {
				scanned.push(ws);                              // 已扫过：延迟错峰校对
			}
		}
		if (scanned.length > 0) {
			void (async () => {
				await new Promise(r => setTimeout(r, 90_000));  // 避开启动期
				for (const ws of scanned) {
					this.scanWorkspaceFilesBg(ws.id, ws.path);
					await new Promise(r => setTimeout(r, 8_000)); // 串行错峰，不并发
				}
			})();
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
		// F18：每读完一个目录就让出事件循环一拍，给同期的 HTTP 请求（messages/git）插队的机会，
		// 避免大项目几万次 readdir 把 Bun 单线程占满数十秒、拖慢用户操作。setImmediate 开销极小。
		await new Promise<void>(r => setImmediate(r));
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
