/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolName } from '../types/toolTypes.js';
import {
	getRulesSection,
	getSystemInfoSection,
	getObjectiveSection,
	getToolUseGuidelinesSection,
	getMarkdownFormattingSection,
	getToolUseSection,
	getModesSection,
	getGitSafetyProtocolSection,
	getToolDecisionTreeSection,
	type SystemInfo
} from './sections/index.js';
import { getModeBySlug, DEFAULT_MODE, type Mode } from '../types/modeTypes.js';
import { ISkill } from '../types/skillTypes.js';
import { estimateTokensFromChars } from '../utils/tokenEstimate.js';
import type { McpServerInfo, McpToolIndexEntry } from '../mcp/index.js';

/**
 * B2: MCP Tool Search 模式选项
 *
 * 三种模式（mcpMode）：
 * - 'lazy'（默认）：只暴露 mcp_tool_search/load/unload 三个元工具；MCP 服务器列表 + 工具数量摘要写进 prompt 让模型知道有什么可搜，但不展开 schema
 * - 'eager'：把所有已连接 server 的所有工具完整 schema 写进 prompt（旧行为，适合工具少时）
 * - 'hybrid'：'lazy' 的基础上把 activeMcpTools 集合中的工具完整 schema 也写进 prompt（懒加载已激活集）
 */
export type McpPromptMode = 'lazy' | 'eager' | 'hybrid';

export interface McpPromptOptions {
	/** prompt 拼接策略 */
	mode: McpPromptMode;
	/** 已连接 MCP servers 的运行时信息，用于生成"可搜的能力清单" */
	servers?: McpServerInfo[];
	/** 当前会话激活的 MCP 工具集（hybrid 模式下展开它们的完整 schema） */
	activeTools?: McpToolIndexEntry[];
}

/**
 * 系统提示词生成器
 *
 * 生成顺序（优化后，减少冗余token）：
 * 1. 角色定义
 * 2. Markdown格式化规则
 * 3. 工具调用格式（XML格式规范）
 * 4. 工具使用指南（效率规则、batch、工具选择、attempt_completion、skill）
 * 5. Git安全协议
 * 6. 模式说明
 * 7. 规则
 * 8. 系统信息
 * 9. 目标
 * 10. 自定义指令（模式特定）
 * 11. Steering内容（.maxian/steering/*.md）
 * 12. 诊断信息（LSP自动注入）
 * 13. Skills列表（精简版，仅名称+一句话描述）
 */
export class SystemPromptGenerator {

	static generate(
		workspaceRoot: string,
		availableTools: ToolName[],
		systemInfo: SystemInfo,
		mode: Mode = DEFAULT_MODE,
		options?: {
			includeStats?: boolean;
			reserveForSkills?: boolean;
			preloadedSkills?: ISkill[];
			diagnosticText?: string | null;
			steeringContent?: string | null;
			memoryContent?: string | null;
			profile?: 'full' | 'lean';
			/** B2: MCP 工具暴露策略 */
			mcp?: McpPromptOptions;
		}
	): string {
		const profile = options?.profile ?? 'full';
		if (profile === 'lean') {
			return this.generateLeanPrompt(workspaceRoot, availableTools, systemInfo, mode, options);
		}

		const sections: string[] = [];

		// 1. 角色定义
		sections.push(this.getRoleDefinition(mode));

		// 2. Markdown格式化规则
		sections.push(getMarkdownFormattingSection());

		// 3. 工具调用格式（XML格式规范）
		sections.push(getToolUseSection());

		// 4. 工具使用指南（合并版：效率规则+batch+工具选择+attempt_completion+skill）
		sections.push(getToolUseGuidelinesSection());

		// 5. Git安全协议
		sections.push(getGitSafetyProtocolSection());

		// 6. 模式说明
		sections.push(getModesSection());

		// 7. 规则
		sections.push(getRulesSection(workspaceRoot));

		// 8. 系统信息
		sections.push(getSystemInfoSection(workspaceRoot, systemInfo));

		// 9. 目标
		sections.push(getObjectiveSection());

		// 10. 自定义指令（如果当前模式有）
		const customInstructions = this.getCustomInstructions(mode);
		if (customInstructions) {
			sections.push(customInstructions);
		}

		// 11. Steering内容（来自 .maxian/steering/*.md）
		if (options?.steeringContent) {
			sections.push(`====

STEERING

以下是团队/项目级别的规范和约定（来自 .maxian/steering/ 配置文件）。这些规范必须优先遵守，如与通用指南冲突，以此为准。

${options.steeringContent}`);
		}

		// 11.5 跨会话记忆内容（来自 .maxian/memory/auto-memory.md）
		if (options?.memoryContent) {
			sections.push(`====

MEMORY

以下是从历史对话中提取的用户偏好、项目约定和常见模式（来自 .maxian/memory/auto-memory.md）。请参考这些记忆信息来更好地理解用户需求和项目背景。

${options.memoryContent}`);
		}

		// 12. 自动诊断信息（来自LSP）
		if (options?.diagnosticText) {
			sections.push(options.diagnosticText);
		}

		// 13. Skills列表（精简版）
		if (options?.reserveForSkills && options?.preloadedSkills && options.preloadedSkills.length > 0) {
			sections.push(this.getSkillsDirectory(options.preloadedSkills));
		}

		// 14. B2: MCP 工具节（按 mode 决定展开多少）
		if (options?.mcp) {
			const mcpSection = this.getMcpSection(options.mcp);
			if (mcpSection) sections.push(mcpSection);
		}

		const prompt = sections.join('\n\n');

		if (options?.includeStats) {
			const chars = prompt.length;
			const estimatedTokens = estimateTokensFromChars(chars);
			console.log(`[SystemPrompt] ${chars} chars ≈ ${estimatedTokens} tokens`);
		}

		return prompt;
	}

	/**
	 * B2: 生成 MCP 工具相关的 system prompt 片段
	 *
	 * - lazy：只列 server 名称 + 每个 server 的工具数量；告诉 LLM "用 mcp_tool_search 找具体工具"
	 * - eager：列出所有已连接 server 的所有工具（完整描述 + 入参概览）
	 * - hybrid：lazy 摘要 + activeTools 完整 schema（已被 mcp_tool_load 激活的）
	 */
	private static getMcpSection(opts: McpPromptOptions): string {
		const connectedServers = (opts.servers ?? []).filter(s => s.isConnected);
		if (connectedServers.length === 0) {
			// 无任何已连接 MCP server → 不输出本节，省 tokens
			return '';
		}

		const lines: string[] = [
			'====',
			'',
			'MCP TOOLS',
			'',
		];

		if (opts.mode === 'eager') {
			// 旧行为：所有工具直接展开
			lines.push('当前已连接的 MCP 服务器及其工具：');
			lines.push('');
			for (const s of connectedServers) {
				lines.push(`### ${s.config.name}`);
				if (s.config.description) lines.push(`*${s.config.description}*`);
				lines.push('');
				for (const t of s.tools) {
					lines.push(`- **mcp_${s.config.name}_${t.name}**: ${t.description ?? '(无描述)'}`);
					if (t.inputSchema?.properties) {
						const props = Object.keys(t.inputSchema.properties).slice(0, 12);
						if (props.length > 0) lines.push(`  参数: ${props.join(', ')}`);
					}
				}
				lines.push('');
			}
			return lines.join('\n').trimEnd();
		}

		// lazy / hybrid 共享前缀
		lines.push('系统已挂载若干 MCP 服务器，但工具描述不直接写进 system prompt（避免 context 膨胀）。');
		lines.push('要使用任意 MCP 工具，按以下流程：');
		lines.push('');
		lines.push('1. 调 `mcp_tool_search` 查询相关工具（自然语言 query）');
		lines.push('2. 收到候选后挑 1-3 个调 `mcp_tool_load` 加入激活集');
		lines.push('3. 下一轮 LLM 调用时这些工具会出现在本节，可直接 XML 调用');
		lines.push('4. 用完可以 `mcp_tool_unload` 释放（一般不必，N 轮未用会自动卸载）');
		lines.push('');
		lines.push('已连接的 MCP 服务器：');
		for (const s of connectedServers) {
			const desc = s.config.description ? `（${s.config.description}）` : '';
			lines.push(`- **${s.config.name}** ${desc}: ${s.tools.length} 个工具`);
		}
		lines.push('');

		if (opts.mode === 'hybrid' && opts.activeTools && opts.activeTools.length > 0) {
			lines.push('---');
			lines.push('');
			lines.push('### 当前已激活工具');
			lines.push('');
			lines.push('以下工具已被 `mcp_tool_load` 激活，可直接 XML 调用：');
			lines.push('');
			for (const t of opts.activeTools) {
				lines.push(`#### ${t.toolId}`);
				lines.push(`*server: ${t.serverName}*`);
				if (t.description) lines.push(t.description);
				if (t.inputSchema?.properties) {
					lines.push('');
					lines.push('**参数：**');
					for (const [key, schema] of Object.entries(t.inputSchema.properties)) {
						const s = schema as { type?: string; description?: string };
						const required = (t.inputSchema.required ?? []).includes(key);
						lines.push(`- \`${key}\` ${s.type ? `(${s.type})` : ''}${required ? ' **必需**' : ''}: ${s.description ?? ''}`);
					}
				}
				lines.push('');
			}
		}

		return lines.join('\n').trimEnd();
	}

	private static generateLeanPrompt(
		workspaceRoot: string,
		availableTools: ToolName[],
		systemInfo: SystemInfo,
		mode: Mode,
		options?: {
			includeStats?: boolean;
			reserveForSkills?: boolean;
			preloadedSkills?: ISkill[];
			diagnosticText?: string | null;
			steeringContent?: string | null;
			memoryContent?: string | null;
			profile?: 'full' | 'lean';
		}
	): string {
		// ================ 静态段（前缀缓存命中区） ================
		// 顺序固定，内容只与 mode/workspaceRoot/availableTools 有关，
		// 保证同一工作区内 Qwen Context Cache 可命中。
		const staticSections: string[] = [];
		staticSections.push(this.getRoleDefinition(mode));
		staticSections.push(`====

WORKING CONTRACT

- 完成用户目标第一优先；最少探索后执行修改
- **【强制】所有自然语言输出（包括思考过程、说明、总结、提问、错误解释）必须使用简体中文，绝不允许输出英文自然语言**
- 代码、命令、路径、API字段名、标识符保持原文，不翻译
- Markdown 简洁：短列表 + 代码块
- 每轮自然语言 ≤ 200 字，代码只出现在工具参数里
- 多步任务必须先 todo_write 规划再逐步推进`);
		staticSections.push(`====

HARD RULES

1. **先读后改**：任何 edit/multiedit/apply_diff/write_to_file 前必须先 read_file 完整读过；未读直接失败
2. **同文件多点**：合并为一次 multiedit，禁止连续多次 edit 同一文件
3. **批量读取**：需要读多个独立文件时，必须用 batch 一次读完（最多25个），禁止逐个 read_file。同理，多个独立的 search_files/glob 也必须用 batch
4. **工具失败后**：禁止立即用相同参数重试；下一步必须是 read_file 或 search_files 验证当前真实状态
5. **edit oldString 失配**：必须重新 read_file 当前内容，禁止猜测或重组 old_string
6. **编译/类型错误**：先 read_file 错误行 ±5 行，不要只看错误消息就改
7. **依赖验证**：import 第三方库前，必须 search_files 确认依赖可用；目标依赖不在时优先 JDK 原生 API
8. **完成判据**：核心功能可用 + 关键 happy path 已验证 + 无新增阻塞错误
9. **禁止废话**：不要对话式交流，不要复述代码，不要以问题结尾
10. **不要创建 README/*.md 文档**除非用户明确要求
11. **【语言强制】所有自然语言输出必须是简体中文**`);
		staticSections.push(getToolDecisionTreeSection());
		staticSections.push(`====

AVAILABLE TOOLS

${availableTools.join(', ')}`);
		staticSections.push(getSystemInfoSection(workspaceRoot, systemInfo));
		staticSections.push(getObjectiveSection());

		// 尾部再次强调中文输出（防止长上下文后模型遗忘）
		staticSections.push(`⚠️ REMINDER: 所有自然语言输出必须使用简体中文。禁止输出英文句子。`);

		const customInstructions = this.getCustomInstructions(mode);
		if (customInstructions) {
			staticSections.push(customInstructions);
		}

		// Skills 列表按 workspace 稳定，放在静态段尾部
		if (options?.reserveForSkills && options?.preloadedSkills && options.preloadedSkills.length > 0) {
			staticSections.push(this.getSkillsDirectory(options.preloadedSkills));
		}

		// ================ 动态段（不参与前缀缓存） ================
		// 每次请求可能不同的内容放这里，放在最后
		const dynamicSections: string[] = [];

		if (options?.steeringContent) {
			dynamicSections.push(`====

STEERING

${this.truncateLongSection(options.steeringContent, 2200)}`);
		}

		if (options?.memoryContent) {
			dynamicSections.push(`====

MEMORY

${this.truncateLongSection(options.memoryContent, 1600)}`);
		}

		if (options?.diagnosticText) {
			dynamicSections.push(this.truncateLongSection(options.diagnosticText, 1200));
		}

		const sections = [...staticSections, ...dynamicSections];

		const prompt = sections.join('\n\n');

		if (options?.includeStats) {
			const chars = prompt.length;
			const estimatedTokens = estimateTokensFromChars(chars);
			console.log(`[SystemPrompt][lean] ${chars} chars ≈ ${estimatedTokens} tokens`);
		}

		return prompt;
	}

	private static truncateLongSection(text: string, maxChars: number): string {
		const normalized = text.trim();
		if (normalized.length <= maxChars) {
			return normalized;
		}
		return `${normalized.slice(0, maxChars)}\n\n[truncated]`;
	}

	/**
	 * Skills列表（精简版）
	 * 只列出名称，触发逻辑已在 toolUseGuidelines 中说明
	 */
	private static getSkillsDirectory(allSkills: ISkill[]): string {
		const skillNames = allSkills
			.slice(0, 30)
			.map((skill: any) => `${skill.slug}: ${skill.description}`)
			.join('\n');

		return `====

AVAILABLE SKILLS

仅在明确需要某个领域的最佳实践、检查清单或专业流程时，才调用 skill 工具（见 TOOL USE GUIDELINES 中的 skill 使用规则）。

可用Skills（共${allSkills.length}个）：
${skillNames}`;
	}

	private static getRoleDefinition(mode: Mode): string {
		const modeConfig = getModeBySlug(mode);
		const languageConstraint = `【输出语言强约束 — 不可违反】
- 所有自然语言输出（包括思考过程、说明、分析、总结、提问、错误解释、进度描述）**必须使用简体中文**。
- 严禁输出任何英文句子或英文段落，包括思考链（reasoning_content）阶段。
- 仅代码、命令、路径、API字段名、变量名、标识符保持英文原文，不翻译。
- 仅当用户明确要求时才切换语言。`;

		if (!modeConfig) {
			return `你是码弦（Maxian），一个智能AI编程助手，专门帮助用户完成软件开发任务。\n\n${languageConstraint}`;
		}
		return `${modeConfig.roleDefinition}\n\n${languageConstraint}`;
	}

	private static getCustomInstructions(mode: Mode): string | null {
		const modeConfig = getModeBySlug(mode);
		if (!modeConfig || !modeConfig.customInstructions) {
			return null;
		}

		return `====

CUSTOM INSTRUCTIONS

${modeConfig.customInstructions}`;
	}
}
