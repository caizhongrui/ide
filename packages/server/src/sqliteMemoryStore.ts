/*---------------------------------------------------------------------------------------------
 *  Maxian Server — SQLite-backed Memory Store (B3)
 *
 *  实现 IMemoryStore 接口，基于 better-sqlite3 持久化。
 *
 *  向量层：当前用 KeywordEmbedding + 朴素扫描（100-1000 条记忆 < 5ms）。
 *  达到 5000+ 条规模可后续切 sqlite-vec（vec0 虚拟表）。当前不依赖 sqlite-vec 编译，避免引入
 *  原生模块的安装/打包复杂度。
 *
 *  Schema：见 database.ts memories 表。
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import {
	type IMemoryStore,
	type MemoryRecord,
	type MemorySearchHit,
	type MemoryQuery,
	type MemoryScope,
	type MemoryCategory,
	type MemorySource,
} from '@maxian/core/memory';
import {
	KeywordEmbeddingService,
	cosineSimilarity,
	type EmbeddingService,
} from '@maxian/core/mcp';
import { getDb } from './database.js';

interface MemoryRow {
	id:               string;
	scope:            string;
	workspace_id:     string | null;
	session_id:       string | null;
	category:         string;
	content:          string;
	source:           string;
	starred:          number;
	created_at:       number;
	last_accessed_at: number;
	access_count:     number;
	embedding:        Buffer | null; // Float32Array LE bytes
}

function rowToRecord(row: MemoryRow): MemoryRecord {
	return {
		id:             row.id,
		scope:          row.scope as MemoryScope,
		workspaceId:    row.workspace_id ?? undefined,
		sessionId:      row.session_id ?? undefined,
		category:       row.category as MemoryCategory,
		content:        row.content,
		source:         row.source as MemorySource,
		starred:        !!row.starred,
		createdAt:      row.created_at,
		lastAccessedAt: row.last_accessed_at,
		accessCount:    row.access_count,
	};
}

function bufferToFloat32(buf: Buffer | null): Float32Array | null {
	if (!buf) return null;
	// 拷贝避免共用底层 ArrayBuffer
	const arr = new Float32Array(buf.byteLength / 4);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	for (let i = 0; i < arr.length; i++) {
		arr[i] = view.getFloat32(i * 4, true); // little-endian
	}
	return arr;
}

function float32ToBuffer(arr: Float32Array): Buffer {
	const buf = Buffer.alloc(arr.length * 4);
	for (let i = 0; i < arr.length; i++) {
		buf.writeFloatLE(arr[i], i * 4);
	}
	return buf;
}

export class SqliteMemoryStore implements IMemoryStore {
	private readonly embedding: EmbeddingService;

	constructor(embedding?: EmbeddingService) {
		this.embedding = embedding ?? new KeywordEmbeddingService();
	}

	async add(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>): Promise<MemoryRecord> {
		const id = `mem_${Date.now()}_${randomUUID().slice(0, 6)}`;
		const now = Date.now();
		const vec = (await this.embedding.embed([record.content]))[0];
		const db = getDb();
		// 位置参数（bun:sqlite 的 @name 命名参数在某些情况下会丢失绑定，改用 ? 稳定可靠）
		db.prepare(
			`INSERT INTO memories (id, scope, workspace_id, session_id, category, content, source, starred, created_at, last_accessed_at, access_count, embedding)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			record.scope,
			record.workspaceId ?? null,
			record.sessionId ?? null,
			record.category,
			record.content,
			record.source,
			record.starred ? 1 : 0,
			now,
			now,
			0,
			float32ToBuffer(vec),
		);
		return {
			id,
			scope:          record.scope,
			workspaceId:    record.workspaceId,
			sessionId:      record.sessionId,
			category:       record.category,
			content:        record.content,
			source:         record.source,
			starred:        record.starred ?? false,
			createdAt:      now,
			lastAccessedAt: now,
			accessCount:    0,
		};
	}

	async delete(id: string): Promise<boolean> {
		const db = getDb();
		const r = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
		return r.changes > 0;
	}

	async get(id: string): Promise<MemoryRecord | null> {
		const db = getDb();
		const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
		if (!row) return null;
		return rowToRecord(row);
	}

	async list(filter?: { scope?: MemoryScope; workspaceId?: string; sessionId?: string }): Promise<MemoryRecord[]> {
		const db = getDb();
		const conds: string[] = [];
		const params: any[] = [];
		if (filter?.scope) {
			conds.push('scope = ?');
			params.push(filter.scope);
		}
		if (filter?.workspaceId) {
			conds.push('workspace_id = ?');
			params.push(filter.workspaceId);
		}
		if (filter?.sessionId) {
			conds.push('session_id = ?');
			params.push(filter.sessionId);
		}
		const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
		const rows = db.prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC`).all(...params) as MemoryRow[];
		return rows.map(rowToRecord);
	}

	async search(query: MemoryQuery): Promise<MemorySearchHit[]> {
		const max = query.maxResults ?? 5;
		const minScore = query.minScore ?? 0.05;
		const queryVec = (await this.embedding.embed([query.query]))[0];

		// 候选集：按 scope/workspace/session/category 过滤后再算相似度
		const db = getDb();
		const conds: string[] = [];
		const params: any[] = [];
		if (query.scope === 'global') {
			conds.push("scope = 'global'");
		} else if (query.scope === 'workspace') {
			// scope=workspace 表示"workspace 范围或更高的 global"都参与
			conds.push("(scope = 'global' OR scope = 'workspace')");
		} else if (query.scope === 'session') {
			conds.push("(scope = 'global' OR scope = 'workspace' OR scope = 'session')");
		}
		if (query.workspaceId) {
			conds.push('(workspace_id IS NULL OR workspace_id = ?)');
			params.push(query.workspaceId);
		}
		if (query.sessionId) {
			conds.push('(session_id IS NULL OR session_id = ?)');
			params.push(query.sessionId);
		}
		if (query.category) {
			conds.push('category = ?');
			params.push(query.category);
		}
		const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

		// 拉所有候选（含 embedding），内存里算相似度
		// 100-1000 条规模这开销可接受；将来切 sqlite-vec 时改为 SQL 内 cosine
		const rows = db.prepare(`SELECT * FROM memories ${where}`).all(...params) as MemoryRow[];

		const hits: MemorySearchHit[] = [];
		for (const row of rows) {
			const vec = bufferToFloat32(row.embedding);
			if (!vec) continue;
			const score = cosineSimilarity(queryVec, vec);
			if (score < minScore) continue;
			hits.push({ record: rowToRecord(row), score });
		}
		hits.sort((a, b) => b.score - a.score);
		const top = hits.slice(0, max);

		// 更新 access stats
		if (top.length > 0) {
			const now = Date.now();
			const upd = db.prepare('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?');
			for (const h of top) {
				upd.run(now, h.record.id);
				h.record.lastAccessedAt = now;
				h.record.accessCount += 1;
			}
		}

		return top;
	}

	async setStarred(id: string, starred: boolean): Promise<boolean> {
		const db = getDb();
		const r = db.prepare('UPDATE memories SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id);
		return r.changes > 0;
	}

	async clear(filter?: { scope?: MemoryScope; workspaceId?: string; sessionId?: string }): Promise<number> {
		const db = getDb();
		const conds: string[] = ['starred = 0']; // 标星记忆永不被批量清除
		const params: any[] = [];
		if (filter?.scope) {
			conds.push('scope = ?');
			params.push(filter.scope);
		}
		if (filter?.workspaceId) {
			conds.push('workspace_id = ?');
			params.push(filter.workspaceId);
		}
		if (filter?.sessionId) {
			conds.push('session_id = ?');
			params.push(filter.sessionId);
		}
		const where = `WHERE ${conds.join(' AND ')}`;
		const r = db.prepare(`DELETE FROM memories ${where}`).run(...params);
		return r.changes;
	}
}
