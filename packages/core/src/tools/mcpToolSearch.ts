/*---------------------------------------------------------------------------------------------
 *  Maxian Core — MCP Tool Search/Load/Unload 元工具
 *
 *  解决的问题：
 *  --------------------------------------------------------------------------------
 *  挂 50+ MCP server 时，每个 server 平均暴露 20+ 工具 → 主 system prompt 描述
 *  膨胀到 30K+ tokens，主对话 context 立即被吃光，模型还没读完工具列表就要回答。
 *
 *  解决方案：
 *  --------------------------------------------------------------------------------
 *  - 默认只把 3 个元工具加入 system prompt：
 *      mcp_tool_search   —— 按自然语言查询当前所有 MCP server 的工具
 *      mcp_tool_load     —— 把指定工具加入"激活集"（注入到 ToolRegistry）
 *      mcp_tool_unload   —— 主动卸载（释放 context）
 *  - 工具元数据始终在 McpHub.toolIndex 里持有 + 维护 embedding
 *  - load 后，下一轮 LLM 调用时 SystemPromptGenerator 才把这些工具的完整 schema 写进 prompt
 *
 *  生命周期：
 *  --------------------------------------------------------------------------------
 *  - 自动卸载：N 轮（默认 8）未被 LLM 实际调用 → 自动 unload（由 SessionManager 跟踪）
 *  - 强制卸载：context 压缩触发时 → 一次性卸载所有 sticky=false 的工具
 *  - sticky 标志：load 时可指定 sticky=true 让该工具锁定，不被自动卸载
 *
 *  注意：本模块只定义 ToolDefinition + execute 函数，**不**直接调度。具体的
 *  load/unload 动作通过 ToolExecutionContext 的扩展字段（mcpHub + activeMcpTools）
 *  让 server 端 sessionManager 实施。这样 core 不依赖 server 也能编译。
 *--------------------------------------------------------------------------------------------*/

import type { ToolDefinition, ToolExecutionContext } from './toolRegistry.js';
import type { McpHub } from '../mcp/McpHub.js';
import type { McpToolIndex } from '../mcp/McpToolIndex.js';

/**
 * 扩展的工具执行上下文 —— 增加 mcpHub 引用 + active 工具集合操作
 *
 * server 在创建 context 时把 sessionManager 内的 mcpHub / activeMcpTools 注入进来。
 * 元工具的 execute() 通过 ctx.mcpHub 拿索引，通过 ctx.activeMcpTools 跟踪当前会话已激活集合。
 */
export interface McpAwareToolContext extends ToolExecutionContext {
	mcpHub?: McpHub;
	/** 当前会话的"已激活 MCP 工具" toolId 集合（mcp_<server>_<tool>） */
	activeMcpTools?: Set<string>;
	/** 标记某工具为 sticky（自动卸载时跳过） */
	stickyMcpTools?: Set<string>;
	/** load 后通知 SessionManager 让 ToolRegistry 重新生成 system prompt */
	onMcpToolsChanged?: (active: Set<string>) => void;
}

/**
 * mcp_tool_search 工具
 */
export const MCP_TOOL_SEARCH: ToolDefinition = {
	name: 'mcp_tool_search',
	displayName: '搜索 MCP 工具',
	description: '搜索已连接的 MCP 服务器中可用的工具。返回 top-N 个最相关工具的名称、描述、所在 server。后续可调用 mcp_tool_load 加载实际工具。',
	longDescription: `## mcp_tool_search

按自然语言查询所有已连接 MCP server 的工具索引，返回最相关的 top-N 候选。

**何时使用：**
- 用户的需求需要某个外部能力（如 "搜索 Figma 设计稿"、"创建 GitHub issue"）
- 你不确定当前对话中是否有现成工具能完成任务
- 你想了解某个领域有哪些可用 MCP 工具

**何时不用：**
- 任务能用内置工具完成（如读文件、写代码、执行命令） — 不要绕远路调 MCP
- 已经知道具体工具名 — 直接 mcp_tool_load 即可

**重要约束：**
- 这只是搜索，不会让工具变成"可调用"。要执行 MCP 工具，必须先 mcp_tool_load 把它加入激活集。
- 一次搜索建议 \`max_results=5\`；如返回太多，自然语言再细化 query。
- 搜索后选 1-3 个最相关的 mcp_tool_load，避免一次激活过多工具占 context。

**参数：**
- query (必需): 自然语言查询，例如 "fetch a webpage" 或 "操作 GitHub PR" 或 "create a Notion page"
- max_results (可选): 返回上限，默认 5
- server_filter (可选): 只搜某些 server，用 ["server_a","server_b"] 形式

**示例：**
\`\`\`xml
<mcp_tool_search>
<query>fetch a Figma file by ID</query>
<max_results>5</max_results>
</mcp_tool_search>
\`\`\``,
	group: 'mcp',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: '自然语言查询。描述你想要做什么，无需匹配工具名',
			},
			max_results: {
				type: 'number',
				description: '返回结果上限（默认 5，最大 30）',
				default: 5,
			},
			server_filter: {
				type: 'array',
				description: '只在指定 server 中搜索；省略时搜全部',
				items: { type: 'string', description: 'server 名称' },
			},
		},
		required: ['query'],
	},
	execute: async (params, context) => {
		const ctx = context as McpAwareToolContext;
		const hub = ctx.mcpHub;
		if (!hub) {
			return '错误：当前会话没有 MCP Hub 上下文。这是 server 端配置问题，不是工具调用问题。';
		}
		const query = String(params.query ?? '').trim();
		if (!query) return '错误：query 参数不能为空';
		const maxResults = Math.min(Math.max(1, Number(params.max_results) || 5), 30);
		const serverFilter = Array.isArray(params.server_filter)
			? (params.server_filter as unknown[]).map(x => String(x))
			: undefined;

		const hits = await hub.toolIndex.search(query, maxResults, 0.05, serverFilter);
		if (hits.length === 0) {
			return `没有找到与 "${query}" 相关的 MCP 工具。当前已连接 ${hub.getAllServers().filter(s => s.isConnected).length} 个 server，工具索引共 ${hub.toolIndex.size()} 条。`;
		}

		const lines: string[] = [`找到 ${hits.length} 个相关工具：\n`];
		for (let i = 0; i < hits.length; i++) {
			const h = hits[i];
			const score = (h.score * 100).toFixed(1);
			lines.push(`${i + 1}. **${h.entry.toolId}** (相关度 ${score}%)`);
			lines.push(`   - server: ${h.entry.serverName}`);
			lines.push(`   - 描述: ${h.entry.description.slice(0, 200)}${h.entry.description.length > 200 ? '...' : ''}`);
			if (h.entry.inputSchema?.properties) {
				const props = Object.keys(h.entry.inputSchema.properties).slice(0, 8);
				if (props.length > 0) lines.push(`   - 参数: ${props.join(', ')}`);
			}
			lines.push('');
		}
		lines.push('如要使用某个工具，先调用 mcp_tool_load 把它加入激活集，下一轮就能直接 XML 调用。');
		return lines.join('\n');
	},
};

/**
 * mcp_tool_load 工具
 */
export const MCP_TOOL_LOAD: ToolDefinition = {
	name: 'mcp_tool_load',
	displayName: '加载 MCP 工具',
	description: '把一个或多个 MCP 工具加入当前会话的激活集，使其在 system prompt 中可见、可被直接调用。',
	longDescription: `## mcp_tool_load

把通过 mcp_tool_search 找到的工具"激活"——加入当前会话的可用工具集合，下一轮 LLM 调用就能在 system prompt 中看到完整 schema 并直接产出 XML 调用。

**何时使用：**
- 你已用 mcp_tool_search 找到了 1-3 个相关工具
- 准备在接下来的几轮里使用这些工具

**何时不用：**
- 还没确认要用某工具 —— 先 search
- 一次性激活 10+ 个工具 —— 浪费 context，先精挑细选

**生命周期：**
- 默认每个工具最近 8 轮没被实际调用就自动卸载
- 设 sticky=true 可阻止自动卸载（适合"贯穿任务始终需要"的工具）
- 触发上下文压缩时所有 sticky=false 工具都被强制卸载

**参数：**
- tool_names (必需): 要加载的工具完整 id 数组，例如 ["mcp_figma_get_file"]
- sticky (可选): 标记 sticky 不被自动卸载，默认 false

**示例：**
\`\`\`xml
<mcp_tool_load>
<tool_names>["mcp_figma_get_file","mcp_figma_get_node"]</tool_names>
</mcp_tool_load>
\`\`\``,
	group: 'mcp',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			tool_names: {
				type: 'array',
				description: '要加载的工具完整 id（mcp_<server>_<tool> 形式）',
				items: { type: 'string', description: '工具完整 id' },
			},
			sticky: {
				type: 'boolean',
				description: '是否锁定不被自动卸载，默认 false',
				default: false,
			},
		},
		required: ['tool_names'],
	},
	execute: async (params, context) => {
		const ctx = context as McpAwareToolContext;
		const hub = ctx.mcpHub;
		if (!hub) return '错误：当前会话没有 MCP Hub 上下文';

		const raw = params.tool_names;
		const list: string[] = Array.isArray(raw)
			? (raw as unknown[]).map(x => String(x))
			: typeof raw === 'string'
				? (() => { try { return JSON.parse(raw) as string[]; } catch { return [raw]; } })()
				: [];
		if (list.length === 0) return '错误：tool_names 不能为空';

		const sticky = params.sticky === true || params.sticky === 'true';

		const loaded: string[] = [];
		const skipped: { id: string; reason: string }[] = [];
		for (const id of list) {
			const entry = hub.toolIndex.getByToolId(id);
			if (!entry) {
				skipped.push({ id, reason: '工具不在索引中（可能 server 已断开）' });
				continue;
			}
			// 检查 server 仍连接
			const server = hub.getServer(entry.serverName);
			if (!server?.isConnected) {
				skipped.push({ id, reason: `所在 server "${entry.serverName}" 未连接` });
				continue;
			}
			ctx.activeMcpTools?.add(id);
			if (sticky) ctx.stickyMcpTools?.add(id);
			loaded.push(id);
		}

		// 通知 SessionManager 重新生成 system prompt（下一轮带上新工具）
		if (loaded.length > 0 && ctx.activeMcpTools && ctx.onMcpToolsChanged) {
			ctx.onMcpToolsChanged(ctx.activeMcpTools);
		}

		const lines: string[] = [];
		if (loaded.length > 0) {
			lines.push(`已加载 ${loaded.length} 个 MCP 工具${sticky ? '（sticky）' : ''}：`);
			for (const id of loaded) lines.push(`  - ${id}`);
			lines.push('\n下一轮你就能在 system prompt 里看到这些工具的完整 schema，直接 XML 调用即可。');
		}
		if (skipped.length > 0) {
			lines.push('\n以下工具未能加载：');
			for (const { id, reason } of skipped) lines.push(`  - ${id}: ${reason}`);
		}
		return lines.join('\n') || '未加载任何工具';
	},
};

/**
 * mcp_tool_unload 工具
 */
export const MCP_TOOL_UNLOAD: ToolDefinition = {
	name: 'mcp_tool_unload',
	displayName: '卸载 MCP 工具',
	description: '从当前会话的激活集中移除指定 MCP 工具，释放 context tokens。',
	longDescription: `## mcp_tool_unload

主动从激活集中卸载工具。一般无需手动调用 —— 自动生命周期会处理；
但当你确定后续不再使用某些工具时，主动卸载能释放 context tokens 给后续对话。

**参数：**
- tool_names (必需): 要卸载的工具 id 数组，或 "*" 卸载全部

**示例：**
\`\`\`xml
<mcp_tool_unload>
<tool_names>["mcp_figma_get_file"]</tool_names>
</mcp_tool_unload>
\`\`\``,
	group: 'mcp',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			tool_names: {
				type: 'array',
				description: '要卸载的工具 id 数组；可传 ["*"] 卸载全部',
				items: { type: 'string', description: '工具完整 id 或 "*"' },
			},
		},
		required: ['tool_names'],
	},
	execute: async (params, context) => {
		const ctx = context as McpAwareToolContext;
		const active = ctx.activeMcpTools;
		if (!active) return '错误：当前会话没有 MCP 激活集合';

		const raw = params.tool_names;
		const list: string[] = Array.isArray(raw)
			? (raw as unknown[]).map(x => String(x))
			: typeof raw === 'string'
				? (() => { try { return JSON.parse(raw) as string[]; } catch { return [raw]; } })()
				: [];
		if (list.length === 0) return '错误：tool_names 不能为空';

		// 通配卸载
		if (list.length === 1 && list[0] === '*') {
			const before = active.size;
			active.clear();
			ctx.stickyMcpTools?.clear();
			ctx.onMcpToolsChanged?.(active);
			return `已卸载全部 ${before} 个 MCP 工具`;
		}

		const unloaded: string[] = [];
		const notFound: string[] = [];
		for (const id of list) {
			if (active.delete(id)) {
				ctx.stickyMcpTools?.delete(id);
				unloaded.push(id);
			} else {
				notFound.push(id);
			}
		}
		if (unloaded.length > 0) ctx.onMcpToolsChanged?.(active);

		const lines: string[] = [];
		if (unloaded.length > 0) {
			lines.push(`已卸载 ${unloaded.length} 个工具：`);
			for (const id of unloaded) lines.push(`  - ${id}`);
		}
		if (notFound.length > 0) {
			lines.push('\n未在激活集中（可能已自动卸载）：');
			for (const id of notFound) lines.push(`  - ${id}`);
		}
		return lines.join('\n') || '未卸载任何工具';
	},
};

/**
 * 一次性注册三个 MCP 元工具到给定 ToolRegistry。
 * server 端启动时调用：registerMcpMetaTools(globalToolRegistry)。
 */
export function registerMcpMetaTools(registry: {
	registerAll(defs: ToolDefinition[]): { success: string[]; failed: string[] };
}): { success: string[]; failed: string[] } {
	return registry.registerAll([MCP_TOOL_SEARCH, MCP_TOOL_LOAD, MCP_TOOL_UNLOAD]);
}
