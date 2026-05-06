/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Memory Tools (B3)
 *
 *  显式工具：
 *  - save_memory(scope, category, content)：让 AI / 用户主动保存某条记忆
 *  - recall_memory(query, max_results)：让 AI 显式按 query 召回相关记忆
 *
 *  注意：除了显式工具外，server 端在每轮 LLM 调用前会**自动**召回 top-K 注入 system prompt，
 *  AI 不必显式调 recall_memory 也能感知历史偏好。recall_memory 主要用于 AI 觉得"需要更多上下文"时手动深挖。
 *--------------------------------------------------------------------------------------------*/

import type { ToolDefinition, ToolExecutionContext } from '../tools/toolRegistry.js';
import type { IMemoryStore, MemoryCategory, MemoryScope } from './MemoryStore.js';

export interface MemoryAwareToolContext extends ToolExecutionContext {
	memoryStore?:    IMemoryStore;
	currentWorkspaceId?: string;
}

/** save_memory 工具定义 */
export const SAVE_MEMORY_TOOL: ToolDefinition = {
	name: 'save_memory',
	displayName: '保存记忆',
	description: '把一条偏好/约定/事实保存到跨会话记忆库，下次会自动召回作为上下文。',
	longDescription: `## save_memory

把一段自然语言保存到记忆库；后续会话开始时如果 query 相关，会自动召回注入到 system prompt。

**何时使用：**
- 用户明确表达了一个偏好（如 "我喜欢 Tab 缩进"）
- 项目有一个独特的约定（如 "本项目命名用 kebab-case"）
- 你做出了一个值得记住的判断（如 "这个仓库的 vue 是 3.x 组合式 API"）

**何时不用：**
- 一次性事实（不会跨会话用到的）
- 隐私敏感信息
- 显然能从代码里读出来的事实

**参数：**
- scope (必需): 'global' / 'workspace' / 'session'
  - global：所有项目都召回
  - workspace：仅当前项目召回
  - session：仅本次会话召回（一般用 'workspace' 即可）
- category (必需): 'preference' / 'convention' / 'fact' / 'style' / 'tech-stack' / 'other'
- content (必需): 一段简洁的描述（建议 ≤ 80 字）

**示例：**
\`\`\`xml
<save_memory>
<scope>workspace</scope>
<category>convention</category>
<content>本项目所有变量名用 camelCase，文件名用 kebab-case</content>
</save_memory>
\`\`\``,
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			scope:    { type: 'string', enum: ['global', 'workspace', 'session'], description: '记忆范围' },
			category: { type: 'string', enum: ['preference', 'convention', 'fact', 'style', 'tech-stack', 'other'], description: '分类' },
			content:  { type: 'string', description: '记忆内容（自然语言，简洁）' },
		},
		required: ['scope', 'category', 'content'],
	},
	execute: async (params, context) => {
		const ctx = context as MemoryAwareToolContext;
		const store = ctx.memoryStore;
		if (!store) return '错误：记忆服务未在当前会话挂载';

		const scope    = String(params.scope ?? '') as MemoryScope;
		const category = String(params.category ?? 'other') as MemoryCategory;
		const content  = String(params.content ?? '').trim();
		if (!['global', 'workspace', 'session'].includes(scope)) return `错误：scope 必须是 global/workspace/session，收到 "${scope}"`;
		if (!content) return '错误：content 不能为空';
		if (content.length > 500) return `错误：content 过长（${content.length} 字符）。记忆应当简洁，建议 ≤ 80 字。`;

		try {
			const rec = await store.add({
				scope,
				workspaceId: scope !== 'global' ? ctx.currentWorkspaceId : undefined,
				sessionId:   scope === 'session' ? ctx.sessionId : undefined,
				category,
				content,
				source:  'manual',
				starred: false,
			});
			return `已保存记忆 (id=${rec.id})：[${rec.scope}/${rec.category}] ${rec.content}`;
		} catch (e) {
			return `保存记忆失败：${(e as Error).message}`;
		}
	},
};

/** recall_memory 工具定义 */
export const RECALL_MEMORY_TOOL: ToolDefinition = {
	name: 'recall_memory',
	displayName: '召回记忆',
	description: '按自然语言查询从记忆库召回相关条目（一般无需手动调，每轮会自动召回 top-K）。',
	longDescription: `## recall_memory

显式按 query 召回相关记忆。一般情况下不必调用 —— 系统会在每轮 LLM 调用前自动召回 top-K 注入 system prompt。
本工具用于 AI 主动觉得"我需要更多关于 X 的上下文"时手动深挖。

**参数：**
- query (必需): 自然语言查询
- max_results (可选): 上限，默认 5
- category (可选): 限定分类（preference/convention/...）`,
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			query:       { type: 'string', description: '自然语言查询' },
			max_results: { type: 'number', description: '上限（默认 5）' },
			category:    { type: 'string', description: '可选：限定分类' },
		},
		required: ['query'],
	},
	execute: async (params, context) => {
		const ctx = context as MemoryAwareToolContext;
		const store = ctx.memoryStore;
		if (!store) return '错误：记忆服务未在当前会话挂载';

		const query = String(params.query ?? '').trim();
		if (!query) return '错误：query 不能为空';
		const maxResults = Math.min(Math.max(1, Number(params.max_results) || 5), 20);
		const category = params.category ? String(params.category) as MemoryCategory : undefined;

		try {
			const hits = await store.search({
				query,
				maxResults,
				category,
				workspaceId: ctx.currentWorkspaceId,
				sessionId:   ctx.sessionId,
			});
			if (hits.length === 0) {
				return `未召回相关记忆。`;
			}
			const lines: string[] = [`召回 ${hits.length} 条记忆：\n`];
			for (let i = 0; i < hits.length; i++) {
				const h = hits[i];
				lines.push(`${i + 1}. [${h.record.scope}/${h.record.category}] ${h.record.content}`);
				lines.push(`   相关度: ${(h.score * 100).toFixed(1)}%`);
			}
			return lines.join('\n');
		} catch (e) {
			return `召回失败：${(e as Error).message}`;
		}
	},
};

export const MEMORY_TOOLS: ToolDefinition[] = [SAVE_MEMORY_TOOL, RECALL_MEMORY_TOOL];

// ─────────────────────────────────────────────────────────────────────────────
// 自动捕获（auto-extraction）逻辑
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 给"小模型"用的 prompt，让它从最近一轮对话提取 0-3 条值得记住的内容。
 * server 端在每轮对话结束后调一次 LLM（小成本），输出 JSON list。
 */
export const AUTO_MEMORY_EXTRACTION_PROMPT = `你是记忆提取助手。从下面这段对话里识别出**值得跨会话保存**的事实/偏好/约定/技术栈信息。

【判断标准】
- 用户明确表达的偏好（"我喜欢 X"、"以后都用 Y"）
- 项目独特的约定（命名风格、目录结构、构建配置）
- 用户告诉你的关键事实（团队规模、部署环境、合规要求）
- AI 验证过的项目技术栈（框架版本、关键库）
- ❌ 不要保存：临时上下文、显然能从代码读出的事实、隐私信息（API key 等）

【输出 JSON】
\`\`\`json
[
  {
    "scope": "workspace" | "global",
    "category": "preference" | "convention" | "fact" | "style" | "tech-stack" | "other",
    "content": "≤80 字的简洁描述"
  }
]
\`\`\`
若无值得记住的内容，返回空数组 \`[]\`。**只输出 JSON，不要任何解释**。

== 对话片段 ==
{{TRANSCRIPT}}
== 结束 ==
`;

/**
 * 解析小模型返回的 JSON（容错：去除可能的 ```json 包裹 + 注释）
 */
export function parseAutoMemoryResult(rawOutput: string): Array<{ scope: MemoryScope; category: MemoryCategory; content: string }> {
	let text = rawOutput.trim();
	// 去 markdown code fence
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) text = fence[1].trim();
	try {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) return [];
		const valid: Array<{ scope: MemoryScope; category: MemoryCategory; content: string }> = [];
		for (const item of parsed) {
			if (typeof item !== 'object' || !item) continue;
			const scope = String(item.scope ?? '');
			const category = String(item.category ?? '');
			const content = String(item.content ?? '').trim();
			if (!['global', 'workspace', 'session'].includes(scope)) continue;
			if (!['preference', 'convention', 'fact', 'style', 'tech-stack', 'other'].includes(category)) continue;
			if (!content || content.length > 500) continue;
			valid.push({
				scope:    scope as MemoryScope,
				category: category as MemoryCategory,
				content,
			});
		}
		return valid;
	} catch {
		return [];
	}
}
