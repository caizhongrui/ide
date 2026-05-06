/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Builtin Sub-agent Definitions（B1）
 *
 *  内置 4 个开箱即用的子代理类型 + 用户可在 .maxian/agents/<name>.md 自定义。
 *
 *  与 Batch 的区别：
 *  --------------------------------------------------------------------------------
 *  Batch  = 用户派活给系统（一次提交一组任务，按调度执行）
 *  Sub-agents = 主代理派活给自己（任务执行过程中主动 fork 出独立上下文做某子任务）
 *
 *  隔离层：
 *  --------------------------------------------------------------------------------
 *  - sessionId       独立 → 独立 context window，主代理只看到 final summary
 *  - tool whitelist  独立 → e.g. explore 只能读不能写
 *  - workspace       默认共享主代理工作区；isolation='worktree' 时自动 git worktree add
 *--------------------------------------------------------------------------------------------*/

/**
 * 子代理隔离层级
 * - 'inherit'   ：直接共享主代理工作区（默认）
 * - 'worktree'  ：自动 git worktree add 到独立分支，子代理在该 worktree 工作；完成后自动清理
 *                 （非 git 仓库或工作区 dirty 时自动降级到 inherit）
 */
export type SubagentIsolation = 'inherit' | 'worktree';

/** 子代理类型定义 */
export interface SubagentDefinition {
	/** 类型唯一标识（小写蛇形或破折号；自定义时不能与 builtin 冲突） */
	name: string;
	/** 一句话标签（给用户/UI 展示） */
	displayName: string;
	/** 详细描述（在 task 工具的 enum description 里展示给 LLM） */
	description: string;
	/** 该子代理的 mode（决定 system prompt 主体） */
	mode: 'code' | 'ask' | 'plan' | 'explore' | 'review';
	/**
	 * 工具白名单 — 子代理仅能调这些工具。
	 * - undefined：不限制（继承父 mode 的工具集）
	 * - 数组：精确匹配（包含 'mcp_*' / 'mcp_tool_search' 等模式）
	 */
	toolWhitelist?: string[];
	/** 默认的隔离策略（用户在 task() 调用时可以覆盖） */
	defaultIsolation: SubagentIsolation;
	/** 默认是否后台执行（仅 background=true 才进 SubagentManager 编排面板） */
	defaultBackground: boolean;
	/** 系统提示词补充（贴到 user 消息前的 instruction） */
	promptHeader: string;
	/** 是否可在 plan 模式下被父代理派发（防止只读 mode 的代理也能 fork build 子代理） */
	allowedFromModes?: ('code' | 'ask' | 'plan' | 'explore' | 'review')[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Builtin 4 个子代理类型（K11 ADR-007 B1 要求）
// ─────────────────────────────────────────────────────────────────────────────

/** general-purpose: 平衡型，全工具可用，适合"先探索后修改"类的复合任务 */
export const SUBAGENT_GENERAL_PURPOSE: SubagentDefinition = {
	name: 'general-purpose',
	displayName: '通用代理',
	description: '适合复合任务：先探索代码库、再做小幅修改、最后写测试。拥有完整工具集。',
	mode: 'code',
	defaultIsolation: 'inherit',
	defaultBackground: false,
	promptHeader:
`你是一个独立工作的子代理，被父代理派来完成一个聚焦的子任务。

【硬性要求】
- 必须用 attempt_completion 工具结束任务（result 字段是 ≤ 200 字摘要，会成为父代理唯一可见的输出）
- 不要做任务之外的改动；不要主动 fork 进一步的子代理
- 不要询问用户，遇到模糊点：先做最合理的解释，并在 attempt_completion 的 result 里说明你的假设
- 中文输出（result / 思考过程）
`,
};

/** code-reviewer: 只读模式，针对 PR / 代码片段给出可执行的 review 评论 */
export const SUBAGENT_CODE_REVIEWER: SubagentDefinition = {
	name: 'code-reviewer',
	displayName: '代码审查',
	description: '只读模式，对指定文件 / git diff 做代码审查，给出 must-fix / suggested 评论。绝不写代码。',
	mode: 'review',
	toolWhitelist: [
		'read_file', 'search_files', 'list_files', 'grep', 'glob', 'ls',
		'lsp', 'lsp_diagnostics', 'lsp_definition', 'lsp_references',
		'attempt_completion',
	],
	defaultIsolation: 'inherit',
	defaultBackground: false,
	promptHeader:
`你是代码审查代理，**只读**工作。

【输出格式】
attempt_completion.result 必须是结构化 review：

# 审查结论
- 总体评价：通过 / 需修改 / 严重问题
- 复杂度评估
- 安全/性能风险

# Must-fix（按优先级）
1. **<文件路径>:<行号>** — <问题> — <建议修法>
2. ...

# Suggested（可选优化）
1. ...

# 通过项
- ✓ <做得好的地方>

【约束】
- 评论必须**指向具体行号**，不要泛泛而谈
- 同一问题在多处出现 → 合并为一个评论 + 列出所有出现位置
- 中文输出
- 不能调用 edit/write 等修改工具（系统会拒绝）
`,
	allowedFromModes: ['code', 'plan', 'explore', 'review'],
};

/** code-explorer: 只读 + 搜索强化，专门用于"快速理解陌生代码库结构" */
export const SUBAGENT_CODE_EXPLORER: SubagentDefinition = {
	name: 'code-explorer',
	displayName: '代码探索',
	description: '只读模式，专门用于回答"这个项目/模块是怎么工作的"。返回结构化总结：架构 / 关键文件 / 数据流。',
	mode: 'explore',
	toolWhitelist: [
		'read_file', 'search_files', 'list_files', 'grep', 'glob', 'ls',
		'lsp', 'lsp_definition', 'lsp_references', 'lsp_type_definition',
		'codebase_search',
		'attempt_completion',
	],
	defaultIsolation: 'inherit',
	defaultBackground: false,
	promptHeader:
`你是代码探索代理，专门用于快速理解陌生代码 / 模块。**只读**。

【输出格式】
attempt_completion.result：

# 概述
<2-3 句话说清楚这块代码做什么 / 在系统中扮演什么角色>

# 关键文件
- \`<path>\`: <一句话作用>
- ...

# 数据流 / 调用链
<最多 5 步，从入口到出口；用 file:line 精确定位>

# 重要数据结构
<列出 2-3 个核心 type/class/interface 及用途>

# 待研究 / 不确定
- <如果有判断不准的地方诚实列出来，让父代理决定要不要再深挖>

【约束】
- 不要复制大段源码到 result（父代理 context 有限）—— 用 file:line 引用
- 中文输出
`,
};

/** test-writer: 完整工具，但被强 prompt 约束只动测试文件 */
export const SUBAGENT_TEST_WRITER: SubagentDefinition = {
	name: 'test-writer',
	displayName: '测试编写',
	description: '完整工具集，专门用于给指定函数 / 模块编写单元测试。读源码 → 设计 case → 写测试文件 → 跑测试。',
	mode: 'code',
	toolWhitelist: [
		'read_file', 'search_files', 'list_files', 'grep', 'glob', 'ls',
		'write_to_file', 'edit', 'multieditTool',
		'execute_command', 'bash',
		'lsp',
		'attempt_completion',
	],
	defaultIsolation: 'inherit',
	defaultBackground: false,
	promptHeader:
`你是测试编写代理，专门给指定的函数 / 模块编写单元测试。

【流程】
1. read_file 看待测目标的实现
2. 推断关键 cases（happy path + 边界 + 错误路径）
3. 找现有同目录测试文件作为风格参考（vitest / jest / pytest 等）
4. 在合适位置写测试文件（不存在就创建，存在就 edit 追加）
5. 跑测试验证通过
6. attempt_completion 报告结果

【硬性要求】
- 不能改动**生产代码**（仅在 test 目录 / *.test.ts / *.spec.ts 等测试文件里写）
- 测试必须能跑过（如果失败要在 result 里诚实说明）
- 中文输出 result
`,
};

/** 全部 builtin 子代理 */
export const BUILTIN_SUBAGENTS: SubagentDefinition[] = [
	SUBAGENT_GENERAL_PURPOSE,
	SUBAGENT_CODE_REVIEWER,
	SUBAGENT_CODE_EXPLORER,
	SUBAGENT_TEST_WRITER,
];

/** 按 name 查找 builtin（不存在返回 undefined） */
export function getBuiltinSubagent(name: string): SubagentDefinition | undefined {
	return BUILTIN_SUBAGENTS.find(s => s.name === name);
}

/** 列出所有 builtin name（用于工具 description 里的 enum） */
export function listBuiltinSubagentNames(): string[] {
	return BUILTIN_SUBAGENTS.map(s => s.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// 兼容映射 —— 老的 explore/build/review 名仍然支持
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 老 subagent_type 名 → 新 builtin 名映射
 * 防止已有调用代码 / prompt / Skills 引用了老名导致无法路由
 */
export const LEGACY_SUBAGENT_ALIASES: Record<string, string> = {
	'explore':  'code-explorer',
	'search':   'code-explorer',
	'research': 'code-explorer',
	'build':    'general-purpose',
	'review':   'code-reviewer',
	'pr-review':'code-reviewer',
	'test':     'test-writer',
	'tests':    'test-writer',
};

/** 把可能的别名解析成 builtin name；找不到 builtin 也找不到自定义时返回 undefined */
export function resolveSubagentName(input: string, customNames: string[] = []): string | undefined {
	if (BUILTIN_SUBAGENTS.some(s => s.name === input)) return input;
	if (LEGACY_SUBAGENT_ALIASES[input]) return LEGACY_SUBAGENT_ALIASES[input];
	if (customNames.includes(input)) return input;
	return undefined;
}
