/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Codebase Index / Repo Wiki (B4)
 *
 *  对每个工作区维护：
 *  1. 文件树（含每个文件用途的一句话注释 — 由 LLM 推断）
 *  2. 关键 API/类/函数（从 LSP DocumentSymbol 提取，含 signature + docstring）
 *  3. 依赖图（package.json / tsconfig.json paths / import graph）
 *  4. 模块概要（每个 src 子目录一段总结）
 *  5. 架构总结（≤2K tokens markdown，进项目第一轮自动注入 system prompt）
 *
 *  存储：
 *  - 元数据 + 架构 / 模块 / 依赖 → SQLite codebase_index_meta（JSON columns）
 *  - 关键 API + embedding → SQLite codebase_index_apis
 *
 *  查询：
 *  - codebase_search 工具 → 走 API embedding 召回
 *  - 进项目第一轮 → 把架构总结直接拼到 system prompt
 *  - AI 显式 → 调 codebase_index_status 看刷新时间 / 调 codebase_index_refresh 强制重建
 *--------------------------------------------------------------------------------------------*/

import {
	type EmbeddingService,
	KeywordEmbeddingService,
	cosineSimilarity,
} from '../mcp/embeddingService.js';

export type SymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'const' | 'export' | 'other';

export interface CodebaseFileNode {
	path:    string;       // 相对工作区
	purpose: string;       // ≤80 字一句话用途
	loc:     number;       // 行数
	mtime:   number;       // 最后修改时间
}

export interface CodebaseApiEntry {
	id?:         number;            // SQLite 自增（搜索结果时填）
	filePath:    string;
	symbolName:  string;
	symbolKind:  SymbolKind;
	signature?:  string;             // function 签名 / class 头
	docstring?:  string;
	startLine:   number;
	endLine:     number;
	embedding?:  Float32Array;
}

export interface CodebaseModuleSummary {
	dirPath:     string;             // 相对工作区，例 src/server
	summary:     string;             // 该目录干什么的（≤200 字）
	keyFiles:    string[];           // top-3 关键文件路径
}

export interface CodebaseDepsEntry {
	from:  string;                   // 文件路径
	to:    string;                   // 被 import 的模块（npm 名 or 相对路径）
	count: number;                   // 被 import 的次数
}

export interface CodebaseIndexSnapshot {
	workspaceId:    string;
	workspacePath:  string;
	lastIndexedAt:  number;
	fileCount:      number;
	apiCount:       number;
	moduleCount:    number;
	architecture?:  string;          // 架构总结（≤2K tokens markdown）
	tree:           CodebaseFileNode[];
	modules:        CodebaseModuleSummary[];
	deps:           CodebaseDepsEntry[];
}

export interface CodebaseSearchHit {
	entry: CodebaseApiEntry;
	score: number;
}

/**
 * 抽象索引接口 —— core 不依赖具体存储；server 实现 SqliteCodebaseIndex。
 */
export interface ICodebaseIndex {
	/** 进项目时调一次：构建 / 增量刷新索引 */
	rebuild(workspaceId: string, workspacePath: string, opts?: {
		incremental?: boolean;          // 是否增量（仅刷动过的文件）
		onProgress?: (msg: string) => void;
	}): Promise<CodebaseIndexSnapshot>;

	/** 拿当前快照（不存在返回 null） */
	getSnapshot(workspaceId: string): Promise<CodebaseIndexSnapshot | null>;

	/** 自然语言搜索 API（走向量召回） */
	search(workspaceId: string, query: string, maxResults?: number): Promise<CodebaseSearchHit[]>;

	/** 删除整个工作区的索引（用户清理 / 工作区被移除） */
	delete(workspaceId: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// CodebaseSearch 工具定义（暴露给 LLM）
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolDefinition, ToolExecutionContext } from '../tools/toolRegistry.js';

export interface CodebaseAwareToolContext extends ToolExecutionContext {
	codebaseIndex?:        ICodebaseIndex;
	currentWorkspaceId?:   string;
	/** 当前工作区索引快照（首轮注入 system prompt 用） */
	codebaseSnapshot?:     CodebaseIndexSnapshot | null;
}

export const CODEBASE_INDEX_STATUS_TOOL: ToolDefinition = {
	name: 'codebase_index_status',
	displayName: '索引状态',
	description: '查询当前工作区的代码库索引状态：上次刷新时间、文件/API/模块数量、架构总结摘要。',
	group: 'read',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: { type: 'object', properties: {} },
	execute: async (_params, context) => {
		const ctx = context as CodebaseAwareToolContext;
		if (!ctx.codebaseIndex || !ctx.currentWorkspaceId) {
			return '错误：当前会话没有挂载 Codebase Index 服务';
		}
		const snap = await ctx.codebaseIndex.getSnapshot(ctx.currentWorkspaceId);
		if (!snap) {
			return '当前工作区尚未建立索引。可以让用户在桌面端"工作区设置"里点击"索引项目"，或调 codebase_index_refresh 立即构建。';
		}
		const ago = Math.round((Date.now() - snap.lastIndexedAt) / 1000);
		const lines: string[] = [
			`# 索引状态：${snap.workspacePath}`,
			'',
			`- 上次刷新：${ago < 60 ? ago + 's' : ago < 3600 ? Math.round(ago / 60) + 'm' : Math.round(ago / 3600) + 'h'}前`,
			`- 文件总数：${snap.fileCount}`,
			`- 关键 API：${snap.apiCount}`,
			`- 模块概要：${snap.moduleCount}`,
		];
		if (snap.architecture) {
			lines.push('', '## 架构总结', '', snap.architecture.slice(0, 800) + (snap.architecture.length > 800 ? '\n... (截断)' : ''));
		}
		return lines.join('\n');
	},
};

export const CODEBASE_INDEX_REFRESH_TOOL: ToolDefinition = {
	name: 'codebase_index_refresh',
	displayName: '刷新索引',
	description: '强制重建当前工作区的代码库索引（一般无需调；进项目时自动建，git change 时自动增量）。',
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			incremental: { type: 'boolean', description: 'true=增量（仅扫动过的文件，快），false=全量。默认 true。' },
		},
	},
	execute: async (params, context) => {
		const ctx = context as CodebaseAwareToolContext;
		if (!ctx.codebaseIndex || !ctx.currentWorkspaceId) {
			return '错误：当前会话没有挂载 Codebase Index 服务';
		}
		const incremental = params.incremental !== false;
		try {
			const t0 = Date.now();
			const snap = await ctx.codebaseIndex.rebuild(ctx.currentWorkspaceId, ctx.workspaceRoot, { incremental });
			return `索引${incremental ? '增量刷新' : '全量重建'}完成（${Date.now() - t0}ms）：\n` +
				`- 文件 ${snap.fileCount} / API ${snap.apiCount} / 模块 ${snap.moduleCount}`;
		} catch (e) {
			return `索引刷新失败：${(e as Error).message}`;
		}
	},
};

export const CODEBASE_INDEX_TOOLS: ToolDefinition[] = [
	CODEBASE_INDEX_STATUS_TOOL,
	CODEBASE_INDEX_REFRESH_TOOL,
];

/**
 * 把索引快照拼成 system prompt 注入段（架构 + 关键模块）
 * 注意：限制在 2K tokens 以内（约 8K chars），避免压挤主对话
 */
export function formatCodebaseSnapshotForPrompt(snap: CodebaseIndexSnapshot): string {
	const lines: string[] = [
		'',
		'====',
		'',
		'CODEBASE OVERVIEW（项目知识库索引）',
		'',
	];
	if (snap.architecture) {
		lines.push('## 架构', '');
		lines.push(snap.architecture.slice(0, 4000));
		lines.push('');
	}
	if (snap.modules.length > 0) {
		lines.push('## 关键模块', '');
		for (const m of snap.modules.slice(0, 8)) {
			lines.push(`### \`${m.dirPath}\``);
			lines.push(m.summary.slice(0, 300));
			if (m.keyFiles.length > 0) {
				lines.push(`关键文件：${m.keyFiles.map(f => '`' + f + '`').join('、')}`);
			}
			lines.push('');
		}
	}
	lines.push('（如需具体 API / 类 / 函数，请用 codebase_search 工具）');
	return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 用 keyword embedding 简单算 codebase_search（默认实现，server 端 wraps 实际 store）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 给 server 端 SqliteCodebaseIndex.search 用的 helper：
 * 把 query 转向量后扫一遍 entries 算余弦相似度。
 */
export async function searchEntriesByEmbedding(
	embedding: EmbeddingService,
	query: string,
	entries: CodebaseApiEntry[],
	maxResults: number,
	minScore: number,
): Promise<CodebaseSearchHit[]> {
	const queryVec = (await embedding.embed([query]))[0];
	const hits: CodebaseSearchHit[] = [];
	for (const e of entries) {
		if (!e.embedding) continue;
		const score = cosineSimilarity(queryVec, e.embedding);
		if (score >= minScore) hits.push({ entry: e, score });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, maxResults);
}

export { KeywordEmbeddingService };
