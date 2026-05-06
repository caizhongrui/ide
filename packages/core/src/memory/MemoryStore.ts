/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Auto-Memory Store (B3)
 *
 *  设计目标：
 *  --------------------------------------------------------------------------------
 *  跨会话记忆：自动从历史对话提取用户偏好、项目约定、常见模式，写入向量库；
 *  每轮 LLM 调用前按当前 query embedding 召回 top-K 注入到 system prompt，
 *  让 AI 不必每次重新被告知"我喜欢 Tab 缩进"、"项目用 vue 3 组合式 API"等。
 *
 *  存储：
 *  --------------------------------------------------------------------------------
 *  本接口设计为存储后端可插拔，server 端用 SqliteMemoryStore（基于 better-sqlite3）；
 *  为避免引入 sqlite-vec 编译依赖，向量层用 KeywordEmbedding + naive 内积扫描
 *  （100-1000 条记忆规模，扫描开销可接受 <5ms；更大可后续切 sqlite-vec）。
 *
 *  数据结构：
 *  --------------------------------------------------------------------------------
 *  - id              UUID
 *  - scope           'global' | 'workspace' | 'session'
 *  - workspaceId?    scope=workspace/session 时的归属
 *  - sessionId?      scope=session 时的归属
 *  - category        'preference' | 'convention' | 'fact' | 'style' | 'tech-stack' | 'other'
 *  - content         自然语言描述（"用户偏好 2 空格缩进"等）
 *  - source          'auto'（小模型自动提取）| 'manual'（用户/AI 显式 save_memory）
 *  - starred         用户标星的记忆（永不被自动 GC）
 *  - createdAt       创建时间
 *  - lastAccessedAt  最近召回时间
 *  - accessCount     被召回次数
 *--------------------------------------------------------------------------------------------*/

import {
	type EmbeddingService,
	KeywordEmbeddingService,
	cosineSimilarity,
} from '../mcp/embeddingService.js';

export type MemoryScope    = 'global' | 'workspace' | 'session';
export type MemoryCategory = 'preference' | 'convention' | 'fact' | 'style' | 'tech-stack' | 'other';
export type MemorySource   = 'auto' | 'manual';

export interface MemoryRecord {
	id:             string;
	scope:          MemoryScope;
	workspaceId?:   string;
	sessionId?:     string;
	category:       MemoryCategory;
	content:        string;
	source:         MemorySource;
	starred:        boolean;
	createdAt:      number;
	lastAccessedAt: number;
	accessCount:    number;
}

export interface MemorySearchHit {
	record: MemoryRecord;
	score:  number;
}

export interface MemoryQuery {
	query:        string;
	scope?:       MemoryScope;
	workspaceId?: string;
	sessionId?:   string;
	category?:    MemoryCategory;
	maxResults?:  number;
	minScore?:    number;
}

/**
 * 抽象接口 —— core 不依赖具体存储引擎；server 实现 SQLite 版（参考 SqliteMemoryStore.ts）。
 */
export interface IMemoryStore {
	/** 添加记忆（计算 embedding + 持久化） */
	add(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>): Promise<MemoryRecord>;
	/** 按 id 删除 */
	delete(id: string): Promise<boolean>;
	/** 按 id 查询 */
	get(id: string): Promise<MemoryRecord | null>;
	/** 按 scope 列出所有记忆（不计算相似度） */
	list(filter?: { scope?: MemoryScope; workspaceId?: string; sessionId?: string }): Promise<MemoryRecord[]>;
	/** 语义搜索（返回 top-K，按相似度降序） */
	search(query: MemoryQuery): Promise<MemorySearchHit[]>;
	/** 标星 / 取消 */
	setStarred(id: string, starred: boolean): Promise<boolean>;
	/** 清空指定 scope */
	clear(filter?: { scope?: MemoryScope; workspaceId?: string; sessionId?: string }): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory 实现（单元测试 / 开发态用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 内存存储 + KeywordEmbedding 朴素扫描实现。
 * 不持久化，进程重启即丢失。Server 端应使用 SqliteMemoryStore。
 */
export class InMemoryMemoryStore implements IMemoryStore {
	private records: Map<string, MemoryRecord & { embedding: Float32Array }> = new Map();
	private readonly embedding: EmbeddingService;

	constructor(embedding?: EmbeddingService) {
		this.embedding = embedding ?? new KeywordEmbeddingService();
	}

	async add(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>): Promise<MemoryRecord> {
		const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const vec = (await this.embedding.embed([record.content]))[0];
		const now = Date.now();
		const rec: MemoryRecord = {
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
		this.records.set(id, { ...rec, embedding: vec });
		return rec;
	}

	async delete(id: string): Promise<boolean> {
		return this.records.delete(id);
	}

	async get(id: string): Promise<MemoryRecord | null> {
		const r = this.records.get(id);
		if (!r) return null;
		const { embedding, ...rec } = r;
		void embedding;
		return rec;
	}

	async list(filter?: { scope?: MemoryScope; workspaceId?: string; sessionId?: string }): Promise<MemoryRecord[]> {
		const out: MemoryRecord[] = [];
		for (const r of this.records.values()) {
			if (filter?.scope && r.scope !== filter.scope) continue;
			if (filter?.workspaceId && r.workspaceId !== filter.workspaceId) continue;
			if (filter?.sessionId && r.sessionId !== filter.sessionId) continue;
			const { embedding, ...rec } = r;
			void embedding;
			out.push(rec);
		}
		out.sort((a, b) => b.createdAt - a.createdAt);
		return out;
	}

	async search(query: MemoryQuery): Promise<MemorySearchHit[]> {
		const max = query.maxResults ?? 5;
		const minScore = query.minScore ?? 0.05;
		const queryVec = (await this.embedding.embed([query.query]))[0];

		const hits: MemorySearchHit[] = [];
		for (const r of this.records.values()) {
			if (query.scope && r.scope !== query.scope) {
				// scope 'global' + 当前 workspace 的 workspace-scoped 记忆都应该参与；这里用宽松匹配
				if (!(query.scope === 'global' && r.scope === 'global'
					|| query.scope === 'workspace' && (r.scope === 'workspace' || r.scope === 'global'))) {
					continue;
				}
			}
			if (query.workspaceId && r.workspaceId && r.workspaceId !== query.workspaceId) continue;
			if (query.sessionId && r.sessionId && r.sessionId !== query.sessionId) continue;
			if (query.category && r.category !== query.category) continue;
			const score = cosineSimilarity(queryVec, r.embedding);
			if (score >= minScore) {
				const { embedding, ...rec } = r;
				void embedding;
				hits.push({ record: rec, score });
			}
		}
		hits.sort((a, b) => b.score - a.score);
		// 更新 access stats
		const top = hits.slice(0, max);
		for (const h of top) {
			const stored = this.records.get(h.record.id);
			if (stored) {
				stored.lastAccessedAt = Date.now();
				stored.accessCount++;
			}
		}
		return top;
	}

	async setStarred(id: string, starred: boolean): Promise<boolean> {
		const r = this.records.get(id);
		if (!r) return false;
		r.starred = starred;
		return true;
	}

	async clear(filter?: { scope?: MemoryScope; workspaceId?: string; sessionId?: string }): Promise<number> {
		let removed = 0;
		for (const [id, r] of this.records) {
			if (filter?.scope && r.scope !== filter.scope) continue;
			if (filter?.workspaceId && r.workspaceId !== filter.workspaceId) continue;
			if (filter?.sessionId && r.sessionId !== filter.sessionId) continue;
			if (r.starred) continue; // 标星的不被批量清除
			this.records.delete(id);
			removed++;
		}
		return removed;
	}
}
