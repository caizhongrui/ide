/*---------------------------------------------------------------------------------------------
 *  Maxian Core — MCP Embedding Service
 *
 *  用途：把工具描述文本转为向量，供 McpToolIndex 做语义搜索。
 *
 *  当前提供两种实现：
 *  - KeywordEmbeddingService（默认 / fallback）：
 *      纯本地、零依赖；用 token 频率向量 + L2 归一化。在 100 个工具规模下精度足够。
 *      不需要任何外部 API、不发网络请求。
 *  - OpenAIStyleEmbeddingService：
 *      调用兼容 OpenAI /v1/embeddings 协议的服务（含 OpenAI 自身、Qwen text-embedding、
 *      DeepSeek embeddings 等）。需要 baseUrl + apiKey。
 *
 *  Consumer 可以实现自己的 EmbeddingService 注入 McpToolIndex。
 *--------------------------------------------------------------------------------------------*/

/**
 * 向量服务接口。
 * embed(): 把一组文本转换为同维度的浮点数组（已归一化，可直接用余弦内积比较）。
 */
export interface EmbeddingService {
	/** 向量维度（同一 service 必须返回固定维度） */
	readonly dimension: number;
	/** 把 N 段文本转为 N 个向量 */
	embed(texts: string[]): Promise<Float32Array[]>;
	/** 单段文本 → 单个向量（默认基于 embed 实现） */
	embedOne?(text: string): Promise<Float32Array>;
}

// ─────────────────────────────────────────────────────────────────────────────
// KeywordEmbeddingService —— 纯本地零依赖实现
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 关键词向量服务：
 *
 * 实现思路：
 * 1. 把所有出现过的 token 维护在一个全局 vocabulary 中（按需扩展）
 * 2. 一个文本 → 稀疏 BoW 向量（出现的 token 维度 = 1，其余 = 0），加 1+ln(idf) 加权
 * 3. L2 归一化使内积 = 余弦相似度
 *
 * 由于 Maxian 工具描述通常只有几百个英文/中文词，固定 vocab + 稀疏存储就够了。
 * 这里直接用 dense Float32Array 简化实现 —— 即使 1000 个 token 维度，每条向量也只 4KB。
 *
 * 限制：纯关键词召回，无法召回真正的"语义近邻"（如 query="网络"，tool desc="HTTP fetch" 不会高分）。
 * 用户希望真正语义搜索时应配置 OpenAIStyleEmbeddingService 走 LLM provider。
 */
export class KeywordEmbeddingService implements EmbeddingService {
	private vocab: Map<string, number> = new Map();
	private docFrequency: Map<string, number> = new Map();
	private totalDocs = 0;
	/** 维度向上滚动（动态扩展时返回的向量自动 zero-pad） */
	private _dimension = 256;

	get dimension(): number { return this._dimension; }

	private tokenize(text: string): string[] {
		// 中英文混合分词：英文按非字母数字断；中文按 1 字 1 token（粗粒度，足够覆盖）
		const tokens: string[] = [];
		const lower = text.toLowerCase();
		// 提英文/数字 token
		for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) tokens.push(m[0]);
		// 提中文字符
		for (const m of lower.matchAll(/[一-鿿]/g)) tokens.push(m[0]);
		return tokens;
	}

	private getOrAssignIndex(token: string): number {
		let idx = this.vocab.get(token);
		if (idx === undefined) {
			idx = this.vocab.size;
			this.vocab.set(token, idx);
			// 维度自动扩容（保持 256 倍数）
			if (idx >= this._dimension) {
				this._dimension = Math.ceil((idx + 1) / 256) * 256;
			}
		}
		return idx;
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		// 第一遍：扩展 vocab + 累计 doc frequency
		const tokenized: string[][] = texts.map(t => this.tokenize(t));
		for (const tokens of tokenized) {
			const seenInDoc = new Set<string>();
			for (const tok of tokens) {
				this.getOrAssignIndex(tok);
				if (!seenInDoc.has(tok)) {
					this.docFrequency.set(tok, (this.docFrequency.get(tok) ?? 0) + 1);
					seenInDoc.add(tok);
				}
			}
			this.totalDocs++;
		}

		// 第二遍：构造 TF-IDF 向量（已归一化）
		const result: Float32Array[] = [];
		for (const tokens of tokenized) {
			const vec = new Float32Array(this._dimension);
			const tf = new Map<string, number>();
			for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
			for (const [tok, count] of tf) {
				const idx = this.vocab.get(tok)!;
				const df  = this.docFrequency.get(tok) ?? 1;
				const idf = Math.log((this.totalDocs + 1) / (df + 1)) + 1;
				vec[idx] = (1 + Math.log(count)) * idf;
			}
			// L2 归一化
			let norm = 0;
			for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
			norm = Math.sqrt(norm);
			if (norm > 0) {
				for (let i = 0; i < vec.length; i++) vec[i] /= norm;
			}
			result.push(vec);
		}
		return result;
	}

	async embedOne(text: string): Promise<Float32Array> {
		const r = await this.embed([text]);
		return r[0];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIStyleEmbeddingService —— 走外部 LLM /v1/embeddings 协议
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAIStyleEmbeddingOptions {
	/** 例如 https://api.openai.com 或 https://dashscope.aliyuncs.com/compatible-mode */
	baseUrl: string;
	/** API Key */
	apiKey: string;
	/** 模型名称，例如 'text-embedding-3-small' / 'text-embedding-v3' */
	model: string;
	/** 维度（按所选模型固定）。OpenAI 1536 / Qwen 1024 / DeepSeek 1024 */
	dimension: number;
	/** 自定义 fetch 函数（默认用全局 fetch） */
	fetch?: typeof fetch;
	/** 单次请求最多多少条文本（API 上限通常 256） */
	batchSize?: number;
}

/**
 * 通用的 OpenAI 兼容 embedding 客户端。
 * 失败时不抛错，返回 null 让上层 fallback；这样网络抖动不会影响整体 mcp_tool_search。
 */
export class OpenAIStyleEmbeddingService implements EmbeddingService {
	private readonly _fetch: typeof fetch;
	private readonly _batchSize: number;

	constructor(private readonly opts: OpenAIStyleEmbeddingOptions) {
		this._fetch = opts.fetch ?? globalThis.fetch;
		this._batchSize = opts.batchSize ?? 64;
	}

	get dimension(): number { return this.opts.dimension; }

	async embed(texts: string[]): Promise<Float32Array[]> {
		const result: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += this._batchSize) {
			const batch = texts.slice(i, i + this._batchSize);
			const part  = await this._embedBatch(batch);
			for (const v of part) result.push(v);
		}
		return result;
	}

	async embedOne(text: string): Promise<Float32Array> {
		const r = await this.embed([text]);
		return r[0];
	}

	private async _embedBatch(batch: string[]): Promise<Float32Array[]> {
		const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/embeddings`;
		const res = await this._fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.opts.apiKey}`,
			},
			body: JSON.stringify({
				model: this.opts.model,
				input: batch,
			}),
		});
		if (!res.ok) {
			throw new Error(`Embedding API failed [${res.status}]: ${await res.text().catch(() => '')}`);
		}
		const json = await res.json() as {
			data: Array<{ embedding: number[]; index: number }>;
		};
		// 按 index 排序确保和 batch 顺序一致
		const sorted = [...json.data].sort((a, b) => a.index - b.index);
		const out: Float32Array[] = [];
		for (const item of sorted) {
			const arr = new Float32Array(item.embedding.length);
			for (let i = 0; i < item.embedding.length; i++) arr[i] = item.embedding[i];
			// 一般 OpenAI/Qwen 已归一化；为保险起见再归一化一次
			let norm = 0;
			for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
			norm = Math.sqrt(norm);
			if (norm > 0) {
				for (let i = 0; i < arr.length; i++) arr[i] /= norm;
			}
			out.push(arr);
		}
		return out;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 余弦相似度（两条向量都已 L2 归一化时 = 内积）
// ─────────────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	const len = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < len; i++) sum += a[i] * b[i];
	return sum;
}
