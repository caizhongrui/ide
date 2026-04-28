/*---------------------------------------------------------------------------------------------
 *  Maxian Server — SQLite Database Layer
 *
 *  使用 better-sqlite3（同步 API）替代 JSON 文件持久化。
 *  数据库位置：~/.maxian/maxian.db
 *  表结构：
 *    workspaces       — 工作区列表
 *    sessions         — 会话元数据
 *    messages         — 会话 UI 消息（用户+助手完整内容）
 *    history_entries  — API 对话历史条目（MessageParam，按 position 有序）
 *--------------------------------------------------------------------------------------------*/

import type Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * 数据目录优先级：
 *   1. 环境变量 `MAXIAN_DATA_DIR`（绝对路径或可解析的相对路径）— 多进程隔离场景必备
 *      （例如 IDE sidecar 与桌面端共存时，IDE 把 DATA_DIR 指向 ~/.maxian-ide 避免 SQLite 写竞争）
 *   2. 默认 `~/.maxian`
 *
 * 仅影响 SQLite 数据文件位置；config.json / plugins / skills 等仍由各自模块决定。
 */
const ENV_DATA_DIR = (process.env.MAXIAN_DATA_DIR || '').trim();
export const DB_DIR  = ENV_DATA_DIR
	? path.resolve(ENV_DATA_DIR)
	: path.join(os.homedir(), '.maxian');
export const DB_PATH = path.join(DB_DIR, 'maxian.db');

/**
 * 运行时检测：Bun 环境（由 bun --compile 产出的单文件二进制）用 `bun:sqlite`
 * 原因：better-sqlite3 的 `bindings` 模块在 Bun 虚拟 FS 里找不到 package.json 报错。
 * Bun 运行时把 sqlite 内置编译进二进制，零外部依赖。
 *
 * Node 环境（yarn tauri dev / 正常 node 运行）仍用 better-sqlite3（有完整的 Node N-API
 * prebuild），开发体验不变。
 *
 * 两者 API 表面 99% 相同，仅 `.pragma()` 需薄薄一层适配。
 */
const IS_BUN = typeof (globalThis as any).Bun !== 'undefined';

/** 用 Function 构造器绕过 bundler 静态分析（同 pty 的套路） */
async function loadDatabaseClass(): Promise<new (file: string) => Database.Database> {
	if (IS_BUN) {
		const modName = 'bun' + ':' + 'sqlite';   // 拆字符串防扫描
		const dyn = new Function('m', 'return import(m)');
		const mod = await dyn(modName);
		// bun:sqlite 的 Database 缺少 .pragma() —— 打补丁
		const BunDb = mod.Database;
		const proto = BunDb.prototype;
		if (!proto.pragma) {
			proto.pragma = function(pragma: string, opts?: { simple?: boolean }) {
				// better-sqlite3 行为：返回 object[] 或 (simple=true) 的标量
				const sql = 'PRAGMA ' + pragma;
				const rows = this.query(sql).all() as any[];
				if (opts?.simple) {
					const first = rows[0];
					if (!first) return undefined;
					return first[Object.keys(first)[0]];
				}
				return rows;
			};
		}
		return BunDb;
	}
	// Node 环境：直接 import better-sqlite3
	const mod = await import('better-sqlite3');
	return mod.default as any;
}

let _db: Database.Database | null = null;
let _DatabaseCtor: (new (file: string) => Database.Database) | null = null;

/** 获取单例数据库连接（首次调用时初始化 schema） */
export function getDb(): Database.Database {
	if (!_db) {
		if (!_DatabaseCtor) {
			throw new Error('Database 尚未初始化。请先在入口处 await initDb() 完成异步加载');
		}
		fs.mkdirSync(DB_DIR, { recursive: true });
		_db = new _DatabaseCtor(DB_PATH);
		// WAL 模式：读写不互锁，并发性能更好
		_db.pragma('journal_mode = WAL');
		// 外键约束开启
		_db.pragma('foreign_keys = ON');
		initSchema(_db);
		console.log(`[Database] SQLite opened at ${DB_PATH} (${IS_BUN ? 'bun:sqlite' : 'better-sqlite3'})`);
	}
	return _db;
}

/** 初始化数据库驱动（必须在 getDb() 之前调用一次） */
export async function initDb(): Promise<void> {
	if (_DatabaseCtor) return;
	_DatabaseCtor = await loadDatabaseClass();
}

/** 初始化表结构（idempotent，可反复调用） */
function initSchema(db: Database.Database): void {
	db.exec(`
		-- ── 工作区 ──────────────────────────────────────────────
		CREATE TABLE IF NOT EXISTS workspaces (
			id         TEXT    PRIMARY KEY,
			path       TEXT    UNIQUE NOT NULL,
			name       TEXT    NOT NULL,
			opened_at  INTEGER NOT NULL
		);

		-- ── 会话元数据 ────────────────────────────────────────────
		CREATE TABLE IF NOT EXISTS sessions (
			id            TEXT    PRIMARY KEY,
			title         TEXT    NOT NULL,
			status        TEXT    NOT NULL DEFAULT 'idle',
			created_at    INTEGER NOT NULL,
			updated_at    INTEGER NOT NULL,
			message_count INTEGER NOT NULL DEFAULT 0,
			input_tokens  INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			workspace_path TEXT   NOT NULL,
			mode          TEXT    NOT NULL DEFAULT 'code',
			ui_mode       TEXT    NOT NULL DEFAULT 'code'
		);

		-- ── UI 消息 ───────────────────────────────────────────────
		CREATE TABLE IF NOT EXISTS messages (
			id         TEXT    PRIMARY KEY,
			session_id TEXT    NOT NULL,
			role       TEXT    NOT NULL,
			content    TEXT    NOT NULL,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);

		-- ── API 历史条目 ──────────────────────────────────────────
		CREATE TABLE IF NOT EXISTS history_entries (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT    NOT NULL,
			role       TEXT    NOT NULL,
			content    TEXT    NOT NULL,
			position   INTEGER NOT NULL,
			reasoning  TEXT,    -- DeepSeek thinking / OpenAI o1 思维链原文（多轮回传必需）
			FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);

		-- ── 文件快照（撤销用 + 切换会话恢复变更列表） ────────────────
		-- action: 'created' | 'modified' | 'deleted'，由 cli.ts 写入时传入
		CREATE TABLE IF NOT EXISTS file_snapshots (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT    NOT NULL,
			path       TEXT    NOT NULL,
			content    TEXT    NOT NULL,
			action     TEXT    NOT NULL DEFAULT 'modified',
			created_at INTEGER NOT NULL
		);

		-- ── 索引 ──────────────────────────────────────────────────
		CREATE INDEX IF NOT EXISTS idx_messages_session
			ON messages(session_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_history_session
			ON history_entries(session_id, position);
		CREATE INDEX IF NOT EXISTS idx_sessions_updated
			ON sessions(updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_snapshots_session_path
			ON file_snapshots(session_id, path, created_at DESC);
	`);

	// ── 数据库迁移：补充新增列（对已存在的旧数据库） ─────────────────────────
	const cols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map(r => r.name);
	if (!cols.includes('ui_mode')) {
		db.exec(`ALTER TABLE sessions ADD COLUMN ui_mode TEXT NOT NULL DEFAULT 'code'`);
		console.log('[Database] 迁移完成：sessions 表新增 ui_mode 列');
	}
	if (!cols.includes('archived')) {
		db.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
		console.log('[Database] 迁移完成：sessions 表新增 archived 列');
	}
	if (!cols.includes('pinned')) {
		db.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
		console.log('[Database] 迁移完成：sessions 表新增 pinned 列');
	}

	// ── file_snapshots 表迁移：补 action 列 ─────────────────────────────
	const fsCols = (db.pragma('table_info(file_snapshots)') as Array<{ name: string }>).map(r => r.name);
	if (!fsCols.includes('action')) {
		db.exec(`ALTER TABLE file_snapshots ADD COLUMN action TEXT NOT NULL DEFAULT 'modified'`);
		console.log('[Database] 迁移完成：file_snapshots 表新增 action 列');
	}

	// ── history_entries 表迁移：补 reasoning 列 ─────────────────────────
	// DeepSeek thinking / OpenAI o1 系列：多轮 assistant 消息必须回传 reasoning_content；
	// 旧库该列不存在，在此补齐（NULL 视为无 reasoning，不影响非 thinking 模型）。
	const heCols = (db.pragma('table_info(history_entries)') as Array<{ name: string }>).map(r => r.name);
	const justAddedReasoning = !heCols.includes('reasoning');
	if (justAddedReasoning) {
		db.exec(`ALTER TABLE history_entries ADD COLUMN reasoning TEXT`);
		console.log('[Database] 迁移完成：history_entries 表新增 reasoning 列');
	}

	// 老 session 救援：从 messages 表里把 (reasoning row → 紧跟的 assistant row) 配对
	// 还原到 history_entries.reasoning，让旧会话也能继续多轮。
	// 思路：messages 是 UI 层显示历史，按 created_at 严格有序，老版本 sidecar 流式时
	// 总是先 fire reasoning 再 fire assistant_message，所以这种"reasoning → assistant"
	// 的相邻对一一对应于 history_entries 里的 assistant 条目。
	if (justAddedReasoning) {
		try {
			const sessionRows = db.prepare(`SELECT id FROM sessions`).all() as Array<{ id: string }>;
			let backfilledSessions = 0;
			let backfilledEntries  = 0;
			for (const s of sessionRows) {
				const msgs = db.prepare(
					`SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC`
				).all(s.id) as Array<{ role: string; content: string }>;
				const reasoningPairs: string[] = [];
				let pending: string | null = null;
				for (const m of msgs) {
					if (m.role === 'reasoning') {
						pending = m.content;
					} else if (m.role === 'assistant') {
						reasoningPairs.push(pending ?? '');
						pending = null;
					} else {
						pending = null; // 中间夹了 user/tool/error，前面的 reasoning 不再认
					}
				}
				if (reasoningPairs.length === 0) continue;

				const entries = db.prepare(
					`SELECT id, role FROM history_entries WHERE session_id = ? ORDER BY position ASC`
				).all(s.id) as Array<{ id: number; role: string }>;
				const update = db.prepare(`UPDATE history_entries SET reasoning = ? WHERE id = ?`);
				let assistantIdx = 0;
				let touched = 0;
				const txn = db.transaction(() => {
					for (const e of entries) {
						if (e.role !== 'assistant') continue;
						const r = reasoningPairs[assistantIdx];
						assistantIdx++;
						if (r) { update.run(r, e.id); touched++; }
					}
				});
				txn();
				if (touched > 0) {
					backfilledSessions++;
					backfilledEntries += touched;
				}
			}
			if (backfilledEntries > 0) {
				console.log(`[Database] 迁移完成：${backfilledSessions} 个会话回填了 ${backfilledEntries} 条 reasoning_content`);
			}
		} catch (e) {
			console.warn('[Database] reasoning 迁移回填失败（继续启动，不影响正常使用）:', e);
		}
	}

	// ── K5 历史 token 估算回填（一次性，幂等） ─────────────────────────
	// 背景：v0.2.11 之前 sessions.input_tokens / output_tokens 从未被写入，
	// 但历史 ai_call_logs 是远端上报，本地无数据可恢复。
	// 妥协：从 history_entries 内容长度估算（char/4），UI 用户可接受 ±20% 误差好过看到 0。
	backfillSessionTokensFromHistory(db);
}

/**
 * 从 history_entries 内容估算并回填 sessions.input_tokens / output_tokens。
 * 仅对 input_tokens=0 AND output_tokens=0 的 session 跑（幂等）。
 * 估算公式：char count / 4（GPT 系列粗略 token-per-char 比例）
 */
/**
 * 对外暴露：手动触发"全量回填会话 token"。
 * 用户点击设置面板"重新计算所有会话 token 用量"按钮时调用（O3）。
 *
 * @param force true = 不论 input/output 是否已有值，全部按 history 重算覆盖；
 *              false = 仅对 input=0 AND output=0 的会话回填（默认，启动时行为）
 * @returns 回填的 session 数
 */
export function recalculateAllSessionTokens(force = false): number {
	const db = getDb();
	const where = force ? '1=1' : 'input_tokens = 0 AND output_tokens = 0';
	const candidates = db.prepare(
		`SELECT id FROM sessions WHERE ${where}`
	).all() as Array<{ id: string }>;
	if (candidates.length === 0) return 0;

	const update = db.prepare(
		`UPDATE sessions SET input_tokens = ?, output_tokens = ? WHERE id = ?`
	);
	const histStmt = db.prepare(
		`SELECT content, position FROM history_entries WHERE session_id = ? ORDER BY position ASC`
	);

	let touched = 0;
	for (const { id } of candidates) {
		const rows = histStmt.all(id) as Array<{ content: string; position: number }>;
		if (rows.length === 0) continue;
		let inputChars = 0, outputChars = 0;
		for (const r of rows) {
			const len = (r.content || '').length;
			if (r.position % 2 === 0) inputChars += len;
			else outputChars += len;
		}
		const estIn = Math.round(inputChars / 4);
		const estOut = Math.round(outputChars / 4);
		if (estIn > 0 || estOut > 0) {
			update.run(estIn, estOut, id);
			touched++;
		}
	}
	return touched;
}

function backfillSessionTokensFromHistory(db: ReturnType<typeof getDb>): void {
	try {
		// 找出所有"两个 token 都为 0"的 session（候选回填对象）
		const candidates = db.prepare(
			`SELECT id FROM sessions WHERE input_tokens = 0 AND output_tokens = 0`
		).all() as Array<{ id: string }>;

		if (candidates.length === 0) return;

		const update = db.prepare(
			`UPDATE sessions SET input_tokens = ?, output_tokens = ? WHERE id = ?`
		);
		// 按 session 一次扫历史
		const histStmt = db.prepare(
			`SELECT content, position FROM history_entries WHERE session_id = ? ORDER BY position ASC`
		);

		let touched = 0;
		for (const { id } of candidates) {
			const rows = histStmt.all(id) as Array<{ content: string; position: number }>;
			if (rows.length === 0) continue;
			let inputChars = 0;
			let outputChars = 0;
			// history_entries 排列：偶数 position 通常是 user / 工具结果 → input；奇数是 assistant → output
			// 但更准确：直接累加 content 长度，按位置奇偶粗分（实际 maxian 协议同时含 user / assistant / tool 多种 role 在 message 里）
			for (const r of rows) {
				const len = (r.content || '').length;
				if (r.position % 2 === 0) inputChars += len;
				else outputChars += len;
			}
			const estIn  = Math.round(inputChars  / 4);
			const estOut = Math.round(outputChars / 4);
			if (estIn > 0 || estOut > 0) {
				update.run(estIn, estOut, id);
				touched++;
			}
		}

		if (touched > 0) {
			console.log(`[Database] K5 回填：${touched} 个会话的 token 用量按 history 估算回填（误差 ±20%，是估算值非真实统计）`);
		}
	} catch (e) {
		console.warn('[Database] K5 回填失败（不影响正常使用）:', (e as Error).message);
	}
}
