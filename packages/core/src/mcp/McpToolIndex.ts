/*---------------------------------------------------------------------------------------------
 *  Maxian Core — McpToolIndex
 *
 *  作用：
 *    所有已连接 MCP server 的工具元数据集中保存 + 向量索引，供 mcp_tool_search 元工具
 *    做语义检索。AI 默认看不到完整 MCP 工具集（避免主对话 context 爆炸）。
 *    需要时调 mcp_tool_search('query', N)，得到 top-N 候选，再 mcp_tool_load 注册到
 *    ToolRegistry 中，下一轮 LLM 调用就能直接产出 XML 调用。
 *
 *  关键不变量：
 *    - 索引按 (serverName, toolName) 唯一键存储
 *    - server reconnect / config change 时，必须 invalidate 该 server 的所有条目并重建
 *    - 向量计算异步、可失败 —— 失败时 fallback 到 KeywordEmbedding，永不抛错断流
 *--------------------------------------------------------------------------------------------*/

import type { McpTool } from './McpTypes.js';
import {
	type EmbeddingService,
	KeywordEmbeddingService,
	cosineSimilarity,
} from './embeddingService.js';

export interface McpToolIndexEntry {
	/** server 名称（用户在配置里给的 name） */
	serverName: string;
	/** MCP 协议本身定义的工具名（无 mcp_ 前缀） */
	rawToolName: string;
	/** 注册到 ToolRegistry 时使用的全局唯一 id：mcp_<server>_<tool> */
	toolId: string;
	/** 工具描述（用于 search query 匹配） */
	description: string;
	/** 工具入参 schema（透传给 LLM） */
	inputSchema?: McpTool['inputSchema'];
	/** 该 entry 的 embedding（可能 undefined：embed 失败时） */
	embedding?: Float32Array;
	/** 索引时刻（ms 时间戳） */
	indexedAt: number;
}

export interface McpToolSearchHit {
	entry: McpToolIndexEntry;
	score: number;
}

export class McpToolIndex {
	/** key: `${serverName}::${toolName}` → entry */
	private readonly entries: Map<string, McpToolIndexEntry> = new Map();
	/** primary embedding service（外部传入，可能是 OpenAIStyle） */
	private readonly primary: EmbeddingService;
	/** fallback：失败时用 keyword */
	private readonly fallback: KeywordEmbeddingService;
	/** 是否优先使用 fallback（primary 上次失败超阈值时） */
	private fallbackOnly = false;
	private failureCount = 0;
	private static readonly FAILURE_THRESHOLD = 3;

	constructor(opts?: { primary?: EmbeddingService }) {
		this.fallback = new KeywordEmbeddingService();
		this.primary = opts?.primary ?? this.fallback;
	}

	private toKey(serverName: string, toolName: string): string {
		return `${serverName}::${toolName}`;
	}

	/** 当前所有已索引条目数 */
	size(): number {
		return this.entries.size;
	}

	/** 列出某 server 的全部工具 */
	listByServer(serverName: string): McpToolIndexEntry[] {
		const out: McpToolIndexEntry[] = [];
		for (const e of this.entries.values()) {
			if (e.serverName === serverName) out.push(e);
		}
		return out;
	}

	/** 列出全部条目（不限 server） */
	listAll(): McpToolIndexEntry[] {
		return Array.from(this.entries.values());
	}

	/** 通过工具 id（mcp_<server>_<tool>）查找 */
	getByToolId(toolId: string): McpToolIndexEntry | undefined {
		for (const e of this.entries.values()) {
			if (e.toolId === toolId) return e;
		}
		return undefined;
	}

	/**
	 * 添加 / 更新某 server 的工具集。新工具异步算 embedding；旧工具如 description 未变直接保留。
	 *
	 * - 调用前：本 server 旧条目仍在 entries 里
	 * - 调用后：传入的 tools 完全覆盖旧集合（删除新集合不再有的旧工具）
	 *
	 * @returns 受影响（新增/更新/删除）的 toolId 集合
	 */
	async upsertServerTools(
		serverName: string,
		tools: McpTool[],
	): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
		const added: string[] = [];
		const updated: string[] = [];
		const removed: string[] = [];

		// 1. 收集新工具的 key 集，方便对比 old 集
		const incomingKeys = new Set<string>();
		for (const t of tools) incomingKeys.add(this.toKey(serverName, t.name));

		// 2. 删除该 server 不再存在的工具
		for (const [key, entry] of this.entries) {
			if (entry.serverName === serverName && !incomingKeys.has(key)) {
				this.entries.delete(key);
				removed.push(entry.toolId);
			}
		}

		// 3. 找出真正需要 embed 的（新增 / description 变了）
		const needEmbed: { key: string; tool: McpTool }[] = [];
		for (const t of tools) {
			const key = this.toKey(serverName, t.name);
			const old = this.entries.get(key);
			const description = t.description ?? '';
			if (!old) {
				needEmbed.push({ key, tool: t });
				added.push(`mcp_${serverName}_${t.name}`);
			} else if (old.description !== description) {
				needEmbed.push({ key, tool: t });
				updated.push(`mcp_${serverName}_${t.name}`);
			}
			// 同 description 不重 embed，节省调用
		}

		if (needEmbed.length === 0) return { added, updated, removed };

		// 4. 批量 embed（先尝试 primary，整批失败则 fallback）
		const texts = needEmbed.map(({ tool }) =>
			`${tool.name}\n${tool.description ?? ''}`,
		);
		let vectors: Float32Array[] | null = null;
		try {
			if (!this.fallbackOnly && this.primary !== this.fallback) {
				vectors = await this.primary.embed(texts);
				this.failureCount = 0;
			}
		} catch (e) {
			console.warn(`[McpToolIndex] primary embedding service 失败:`, e);
			this.failureCount++;
			if (this.failureCount >= McpToolIndex.FAILURE_THRESHOLD) {
				this.fallbackOnly = true;
				console.warn(`[McpToolIndex] 切换到 fallback (KeywordEmbedding)`);
			}
		}
		if (!vectors) {
			vectors = await this.fallback.embed(texts);
		}

		// 5. 写回 entries
		for (let i = 0; i < needEmbed.length; i++) {
			const { key, tool } = needEmbed[i];
			this.entries.set(key, {
				serverName,
				rawToolName: tool.name,
				toolId:      `mcp_${serverName}_${tool.name}`,
				description: tool.description ?? '',
				inputSchema: tool.inputSchema,
				embedding:   vectors[i],
				indexedAt:   Date.now(),
			});
		}

		return { added, updated, removed };
	}

	/**
	 * 移除某 server 的全部工具（断开 / 禁用时调）
	 */
	removeServer(serverName: string): string[] {
		const removed: string[] = [];
		for (const [key, entry] of this.entries) {
			if (entry.serverName === serverName) {
				this.entries.delete(key);
				removed.push(entry.toolId);
			}
		}
		return removed;
	}

	/** 清空所有条目 */
	clear(): void {
		this.entries.clear();
	}

	/**
	 * 语义搜索：query 转向量后与所有 entry.embedding 算余弦相似度，返回 top-N。
	 *
	 * 当 entry 没 embedding（向量服务失败）时仍然参与排序：用 KeywordEmbedding fallback
	 * 计算 query+entry.description 的相似度，作为退路。
	 *
	 * @param query 自然语言查询，例如 "fetch a webpage" 或 "操作 GitHub PR"
	 * @param maxResults 返回上限
	 * @param scoreThreshold 0..1，低于此分数过滤
	 * @param serverFilter 可选：只搜某些 server（用户白名单）
	 */
	async search(
		query: string,
		maxResults: number = 10,
		scoreThreshold: number = 0.05,
		serverFilter?: string[],
	): Promise<McpToolSearchHit[]> {
		if (this.entries.size === 0) return [];

		// 1. 把 query 转向量（同 primary 服务保持一致）
		let queryVec: Float32Array | null = null;
		try {
			if (!this.fallbackOnly && this.primary !== this.fallback) {
				queryVec = (await this.primary.embed([query]))[0];
			}
		} catch (e) {
			console.warn(`[McpToolIndex] search query embed 失败:`, e);
			this.failureCount++;
		}
		if (!queryVec) {
			queryVec = (await this.fallback.embed([query]))[0];
		}

		// 2. 评分
		const allowedServers = serverFilter ? new Set(serverFilter) : null;
		const hits: McpToolSearchHit[] = [];
		for (const entry of this.entries.values()) {
			if (allowedServers && !allowedServers.has(entry.serverName)) continue;
			let score = 0;
			if (entry.embedding && entry.embedding.length === queryVec.length) {
				score = cosineSimilarity(queryVec, entry.embedding);
			} else {
				// 退路：用 fallback 的小空间 embedding 重新算
				const fallbackQ = await this.fallback.embedOne(query);
				const fallbackD = await this.fallback.embedOne(`${entry.rawToolName}\n${entry.description}`);
				score = cosineSimilarity(fallbackQ, fallbackD);
			}
			if (score >= scoreThreshold) {
				hits.push({ entry, score });
			}
		}

		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, maxResults);
	}
}
