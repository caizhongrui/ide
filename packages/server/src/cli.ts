#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Maxian Server — CLI Entry
 *
 *  供 Tauri sidecar 调用的独立可执行入口。
 *  启动参数来自环境变量 / 命令行标志；AI 代理凭据从
 *  ~/Library/Application Support/tianhe-lingyu/config.json 读取（或环境变量覆盖）。
 *
 *  Agent 循环：
 *    用户消息 → AI（携带工具定义） → 收集 tool_use 块 → 执行工具 → 将结果塞回历史
 *    → 再次调用 AI → … → AI 停止调用工具 → 完成
 *
 *  支持工具：read_file / write_to_file / edit / search_files / list_files / execute_command
 *--------------------------------------------------------------------------------------------*/

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { bootstrap } from './bootstrap.js';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
// @lydell/node-pty 仅在集成终端 WebSocket 被使用时才加载。
// ⚠️ 关键约束：
//   1. Bun --compile 后的 sidecar 二进制是纯 ESM，没有全局 `require`，所以 Function 构造器拿不到。
//      解决方案：用 node:module 的 createRequire(import.meta.url) 显式构造 require 函数。
//   2. 字符串拼接 'mod' 包名避开 Bun/esbuild 静态分析器，保证它不会尝试把 node-pty
//      bundling 进单文件二进制（node-pty 含原生模块，bundler 处理会失败）。
//   3. 二进制本身不含 node-pty；运行时从相邻 node_modules 解析（Tauri sidecar 模式可用，
//      纯 CLI 模式需要用户额外 npm i）。找不到时返回友好错误，其他功能不受影响。
type PtyModule = typeof import('@lydell/node-pty');
let __ptyModuleCache: PtyModule | null = null;
async function loadPty(): Promise<PtyModule> {
	if (__ptyModuleCache) return __ptyModuleCache;
	const pkgName = ['@lydell', 'node-pty'].join('/');   // 拆字符串防止 bundler 识别

	// Tauri sidecar 模式下 Bun --compile 的 binary 启动时，process.execPath 不指向自身（指向
	// 父进程 maxian-desktop），所以必须用多锚点尝试 maxian-deps 目录。
	// 优先级：MAXIAN_PTY_DEPS（桌面 Rust 显式传入；可能是 maxian-deps 目录本身或其父目录）
	//        → argv[0] dir → execPath dir → cwd → import.meta.url
	const candidateAnchors: string[] = [];
	const addAnchorFor = (dir: string): void => {
		// 直接把 dir 当 maxian-deps 目录（dir 末尾是 maxian-deps）
		candidateAnchors.push(`file://${path.join(dir, 'package.json')}`);
		// 或 dir 是 maxian-deps 的父目录
		candidateAnchors.push(`file://${path.join(dir, 'maxian-deps', 'package.json')}`);
	};
	const env = process.env['MAXIAN_PTY_DEPS'];
	if (env) addAnchorFor(env);
	try { addAnchorFor(path.dirname(process.argv[0])); } catch { /* ignore */ }
	try { addAnchorFor(path.dirname(process.execPath)); } catch { /* ignore */ }
	try { addAnchorFor(process.cwd()); } catch { /* ignore */ }
	// 终极兜底：cli 自己的位置（dev tsc 模式下能命中 server/node_modules）
	candidateAnchors.push(import.meta.url);

	const { createRequire } = await import('node:module');
	const errors: string[] = [];
	for (const anchor of candidateAnchors) {
		try {
			const req = createRequire(anchor);
			const mod = req(pkgName) as PtyModule;
			__ptyModuleCache = mod;
			console.log(`[Terminal] @lydell/node-pty 加载成功 (anchor=${anchor})`);
			return __ptyModuleCache;
		} catch (e) {
			errors.push(`  ${anchor}: ${(e as Error).message.split('\n')[0]}`);
		}
	}

	// 最后尝试全局 require
	const globalRequire = (globalThis as any).require;
	if (typeof globalRequire === 'function') {
		try {
			const mod = globalRequire(pkgName) as PtyModule;
			__ptyModuleCache = mod;
			return __ptyModuleCache;
		} catch (e) {
			errors.push(`  globalThis.require: ${(e as Error).message.split('\n')[0]}`);
		}
	}

	throw new Error(`无法加载 @lydell/node-pty。尝试过：\n${errors.join('\n')}`);
}
import { getDb } from './database.js';
import { AiProxyHandler } from '@maxian/core/api/aiproxy';
import { buildRepoMapDigest } from './repoMapDigest.js';
import { getSceneModel, getSceneDefaultModel } from './sceneModelCache.js';
import { registerSceneModelsRoute, prefetchSceneModels } from './routes/sceneModels.js';
import {
	readFileTool,
	writeToFileTool,
	searchFilesTool,
	listFilesTool,
	executeCommandTool,
	MemoryFileContextTracker,
} from '@maxian/core/tools';
import {
	executeEdit,
	formatEditResponse,
	executeMultiedit,
	formatMultieditResponse,
	executeTodoWrite,
	formatTodoWriteList,
	htmlToMarkdown,
	validateUrl,
	processResponse,
} from '@maxian/core/tools';
// 新工具（对标 OpenCode）
import {
	Truncate,
	bashTool, formatBashResult, detectDangerousCommand,
	grepTool, formatGrepResult,
	globTool, formatGlobResult,
	lsTool,   formatLsResult,
	applyPatchTool, formatApplyPatchResult,
	formatLspResult,
	formatQuestionResult,
	formatPlanExitResult,
	formatTaskResult,
	ToolRepetitionDetector,
} from '@maxian/core/tools';
import type {
	IBashToolParams, IGrepToolParams, IGlobToolParams, ILsToolParams,
	IApplyPatchParams, ILspToolParams, ILspToolResult, IQuestionToolParams, IPlanExitParams,
	ITaskToolParams, ITaskToolResult,
} from '@maxian/core/tools';
import { LSP } from './lsp/index.js';
import { loadAllPlugins, triggerPluginHook, type PluginToolDef, type LoadedPlugin } from './pluginLoader.js';
import { compactIfNeeded, forceCompact, CONTEXT_WINDOW } from './contextCompaction.js';
import { loadProjectConfig, loadCustomAgents, loadCustomCommands } from './projectConfig.js';
import { runHookCommand, formatHookResult } from './hookRunner.js';
import type { IToolContext } from '@maxian/core/tools';
import type {
	IConfiguration,
	IWorkspace,
	IFileSystem,
	ITerminal,
	IStorage,
	IAuthProvider,
	IMessageBus,
	MaxianPlatform,
} from '@maxian/core';
import type { IToolExecutor } from '@maxian/core/tools';
import { getTodoWriteList, repairTruncatedJson } from '@maxian/core/tools';   // 自动续跑 + 工具参数截断修复(B2)
import type { MessageParam, ToolDefinition, ContentBlock } from '@maxian/core/api';

// ─── CLI 参数 ─────────────────────────────────────────────────────────────────

interface CliOptions {
	port: number;
	host: string;
	username?: string;
	password?: string;
	cors: boolean;
}

function parseCliArgs(): CliOptions {
	const { values } = parseArgs({
		options: {
			port:     { type: 'string',  short: 'p', default: '51847' },
			host:     { type: 'string',  short: 'h', default: '127.0.0.1' },
			username: { type: 'string',  short: 'u' },
			password: { type: 'string' },
			cors:     { type: 'boolean', default: false },
		},
		strict: false,
	});

	return {
		port:     parseInt((values.port as string) ?? '51847', 10),
		host:     (values.host as string) ?? '127.0.0.1',
		username: (values.username as string) ?? process.env['MAXIAN_SERVER_USERNAME'],
		password: (values.password as string) ?? process.env['MAXIAN_SERVER_PASSWORD'],
		cors:     !!values.cors,
	};
}

// ─── AI 配置 ──────────────────────────────────────────────────────────────────

type AiConfig =
	| { type: 'proxy';    apiUrl: string; username: string; password: string; businessCode?: string; flashBusinessCode?: string }
	| { type: 'anthropic'; apiKey: string; model: string; baseUrl: string };

/** 从环境变量 / IDE 存储读取 AI 配置，依次尝试：Anthropic → 代理 */
function loadAiConfig(): AiConfig | null {
	// 1. Anthropic API Key
	const anthropicKey = process.env['ANTHROPIC_API_KEY'];
	if (anthropicKey) {
		const model   = process.env['ANTHROPIC_MODEL']    || 'claude-sonnet-4-6';
		const baseUrl  = process.env['ANTHROPIC_BASE_URL'] || 'https://api.anthropic.com';
		console.log(`[Maxian CLI] 使用 Anthropic API (${model})`);
		return { type: 'anthropic', apiKey: anthropicKey, model, baseUrl };
	}

	// 2. 环境变量代理
	const apiUrl  = process.env['MAXIAN_AI_API_URL'];
	const aiUser  = process.env['MAXIAN_AI_USERNAME'];
	const aiPass  = process.env['MAXIAN_AI_PASSWORD'];
	if (apiUrl && aiUser && aiPass) {
		return { type: 'proxy', apiUrl, username: btoa(aiUser), password: btoa(aiPass) };
	}

	// 3. 从 IDE 配置文件读取代理凭据
	const configPaths = [
		path.join(os.homedir(), 'Library', 'Application Support', 'tianhe-lingyu', 'config.json'),
		path.join(os.homedir(), '.maxian', 'config.json'),
	];

	for (const cfgPath of configPaths) {
		try {
			const raw  = readFileSync(cfgPath, 'utf8');
			const cfg  = JSON.parse(raw);
			const baseURL:  string = cfg?.serverConfig?.baseURL || cfg?.auth?.baseURL;
			const email:    string = cfg?.auth?.email || cfg?.lastUsername;
			const password: string = cfg?.auth?.password;
			if (baseURL && email && password) {
				// 优先读配置文件中的 businessCode，若无则默认使用 IDE_CHAT_CODE
				const businessCode: string =
					cfg?.serverConfig?.businessCode ||
					cfg?.auth?.businessCode ||
					cfg?.businessCode ||
					'IDE_CHAT_CODE';
				const flashBusinessCode: string | undefined =
					cfg?.serverConfig?.flashBusinessCode ||
					cfg?.auth?.flashBusinessCode ||
					cfg?.flashBusinessCode;
				console.log(`[Maxian CLI] AI 代理配置已从 ${cfgPath} 加载 (businessCode=${businessCode})`);
				return {
					type: 'proxy',
					apiUrl: baseURL,
					username: btoa(email),
					password: btoa(password),
					businessCode,
					flashBusinessCode,
				};
			}
		} catch { /* ignore */ }
	}

	console.warn('[Maxian CLI] 未找到任何 AI 配置，运行 Echo 模式');
	return null;
}

// ─── 工具上下文 ────────────────────────────────────────────────────────────────

/**
 * Node.js 版工具执行上下文，供 Agent 循环使用。
 * 每个 Agent 会话共用一个实例（内存文件追踪）。
 *
 * B2: 同时承载 McpHub 引用 + 当前会话的 MCP 工具激活集合，
 * 让 mcp_tool_search/load/unload 元工具能直接用 ctx.mcpHub / ctx.activeMcpTools。
 */
class NodeToolContext implements IToolContext {
	readonly workspacePath: string;
	readonly fileContextTracker: MemoryFileContextTracker;
	didEditFile = false;
	readonly sessionId?: string;
	/**
	 * K8d 收尾：平台能力容器。
	 * 由 runAgentLoop 在创建 ctx 后立即注入（包含 NodeTerminal / NodeFileSystem 等），
	 * bashTool / executeCommandTool / platformFs 等通过 ctx.platform.* 访问宿主能力。
	 *
	 * 接口里声明为 readonly（IToolContext.platform），这里在 class 上放宽为可写以便
	 * runAgentLoop 一次性注入（构造时尚不知道 sessionManager 上的 messageBus）。
	 */
	platform?: MaxianPlatform;
	/** B2: 全局 MCP Hub 引用（由 sessionManager 提供） */
	mcpHub?: import('@maxian/core/mcp').McpHub;
	/** B2: 当前会话已激活的 MCP 工具集（toolId 形式：mcp_<server>_<tool>） */
	activeMcpTools?: Set<string>;
	/** B2: sticky 集合，标记不被自动卸载的工具 */
	stickyMcpTools?: Set<string>;
	/** B2: load/unload 后让 SessionManager 重建 system prompt 的 hook */
	onMcpToolsChanged?: (active: Set<string>) => void;
	/** B2: MCP 工具最近一次被实际调用的轮次（自动卸载用） */
	mcpToolLastUsedTurn?: Map<string, number>;
	/** B2: 当前轮次计数（每个 LLM round 递增） */
	currentTurn?: number;
	/** B3: 记忆 Store（save_memory/recall_memory 元工具读取） */
	memoryStore?: import('@maxian/core/memory').IMemoryStore;
	/** B3: 当前 workspaceId（解析 scope=workspace/session 时用） */
	currentWorkspaceId?: string;
	/** B4: 代码库索引（codebase_search / codebase_index_status / codebase_index_refresh 用） */
	codebaseIndex?: import('@maxian/core/codebase-index').ICodebaseIndex;

	constructor(workspacePath: string, sessionId?: string) {
		this.workspacePath    = workspacePath;
		this.fileContextTracker = new MemoryFileContextTracker();
		this.sessionId        = sessionId;
	}
}

// ─── 工具定义（供 AiProxyHandler 传给大模型） ──────────────────────────────────

const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: 'read_file',
		description: '读取指定文件的内容，支持指定起始/结束行。适合查看代码、配置文件等。',
		parameters: {
			type: 'object',
			properties: {
				path:       { type: 'string', description: '文件路径（相对于工作区或绝对路径）' },
				start_line: { type: 'number', description: '起始行号（可选，从 1 开始）' },
				end_line:   { type: 'number', description: '结束行号（可选）' },
			},
			required: ['path'],
		},
	},
	{
		name: 'write_to_file',
		description: '创建新文件或完全覆盖写入文件内容。适合创建新文件或大幅重写文件。',
		parameters: {
			type: 'object',
			properties: {
				path:    { type: 'string', description: '文件路径（相对或绝对）' },
				content: { type: 'string', description: '文件完整内容' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'edit',
		description: '精确替换文件中的指定文本片段。适合小范围修改，比 write_to_file 更安全。修改前无需先 read_file，工具会自动读取。',
		parameters: {
			type: 'object',
			properties: {
				path:        { type: 'string',  description: '文件路径' },
				old_string:  { type: 'string',  description: '要查找并替换的原始文本（包含足够上下文以唯一定位）' },
				new_string:  { type: 'string',  description: '替换后的新文本' },
				replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false' },
			},
			required: ['path', 'new_string'],
		},
	},
	{
		name: 'search_files',
		description: '在目录中用正则表达式搜索文件内容，返回匹配行及上下文。',
		parameters: {
			type: 'object',
			properties: {
				path:         { type: 'string', description: '搜索目录（相对或绝对）' },
				regex:        { type: 'string', description: '正则表达式' },
				file_pattern: { type: 'string', description: '文件名过滤模式，如 *.ts' },
			},
			required: ['path', 'regex'],
		},
	},
	{
		name: 'list_files',
		description: '列出目录中的文件和子目录，支持递归。',
		parameters: {
			type: 'object',
			properties: {
				path:      { type: 'string',  description: '目录路径（相对或绝对）' },
				recursive: { type: 'boolean', description: '是否递归列出子目录，默认 false' },
			},
			required: ['path'],
		},
	},
	{
		name: 'execute_command',
		description: '在工作区目录中执行 shell 命令（如 npm install、git status、tsc 等）。',
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: '要执行的命令' },
				cwd:     { type: 'string', description: '自定义工作目录（可选，默认为工作区根目录）' },
			},
			required: ['command'],
		},
	},
	{
		name: 'multiedit',
		description: '在单个文件中执行多处编辑操作（原子性：全部成功或全部不执行）。适合同时修改同一文件的多个位置。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '文件路径' },
				edits: {
					type: 'array',
					description: '编辑操作列表（按顺序执行，每个基于前一个结果）',
					items: {
						type: 'object',
						properties: {
							oldString:  { type: 'string',  description: '要替换的原始文本（精确匹配）' },
							newString:  { type: 'string',  description: '替换后的新文本' },
							replaceAll: { type: 'boolean', description: '是否替换所有匹配项，默认 false' },
						},
						required: ['oldString', 'newString'],
					},
				},
			},
			required: ['path', 'edits'],
		},
	},
	{
		name: 'todo_write',
		description: '创建或更新当前任务的 TODO 列表。多步任务开始前必须先规划。每次调用全量替换当前 TODO 列表。',
		parameters: {
			type: 'object',
			properties: {
				todos: {
					type: 'array',
					description: 'TODO 项目列表（全量替换）',
					items: {
						type: 'object',
						properties: {
							id:         { type: 'string', description: '唯一标识符（如 "1", "task-1"）' },
							content:    { type: 'string', description: '任务内容（祈使句形式，如 "修改登录样式"）' },
							status:     { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '任务状态' },
							activeForm: { type: 'string', description: '进行时形式（如 "正在修改登录样式"）' },
						},
						required: ['id', 'content', 'status', 'activeForm'],
					},
				},
			},
			required: ['todos'],
		},
	},
	{
		name: 'web_fetch',
		description: '获取网页内容并转换为 Markdown 格式。适合查看在线文档、API 参考、技术文章。',
		parameters: {
			type: 'object',
			properties: {
				url:    { type: 'string', description: '要获取的 URL（必须是 http 或 https）' },
				prompt: { type: 'string', description: '提取内容的提示词（可选，指示关注哪些内容）' },
			},
			required: ['url'],
		},
	},
	{
		name: 'load_skill',
		description: '从工作区 .maxian/skills/ 或 .claude/skills/ 目录加载专业领域技能文档。用于获取特定技术领域的专业指导。',
		parameters: {
			type: 'object',
			properties: {
				skill_name: { type: 'string', description: '技能名称（文件名，不含 .md 扩展名）或 list 列出所有技能' },
			},
			required: ['skill_name'],
		},
	},
	// ── 新增工具（对标 OpenCode） ────────────────────────────────────────
	{
		name: 'bash',
		description: '在 shell 中执行命令（比 execute_command 更强：支持超时、后台执行、危险命令检测）。输出过大会自动截断写盘。',
		parameters: {
			type: 'object',
			properties: {
				command:     { type: 'string', description: '要执行的 shell 命令' },
				timeout:     { type: 'number', description: '超时毫秒数（默认 120000，最大 600000）' },
				cwd:         { type: 'string', description: '工作目录（相对或绝对，默认工作区根）' },
				background:  { type: 'boolean', description: '后台执行不等完成，返回 PID' },
				description: { type: 'string', description: '简短描述，用于审批对话框' },
			},
			required: ['command'],
		},
	},
	{
		name: 'grep',
		description: '用 ripgrep 进行正则跨文件搜索，比 search_files 更快更强，支持 glob / 文件类型过滤、上下文行、大小写不敏感。',
		parameters: {
			type: 'object',
			properties: {
				pattern:    { type: 'string', description: '正则表达式（必填）' },
				path:       { type: 'string', description: '搜索起始目录' },
				include:    { type: 'string', description: 'glob 过滤，如 "*.ts" 或 "src/**/*.tsx"' },
				type:       { type: 'string', description: '文件类型，如 "js" "py" "rust"' },
				ignoreCase: { type: 'boolean', description: '大小写不敏感' },
				context:    { type: 'number', description: '上下文行数' },
				limit:      { type: 'number', description: '最多返回行数（默认 500）' },
				outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: '输出模式' },
			},
			required: ['pattern'],
		},
	},
	{
		name: 'glob',
		description: '按 glob 模式匹配文件，结果按 mtime 降序（最近修改优先）。',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"' },
				path:    { type: 'string', description: '起始目录' },
				limit:   { type: 'number', description: '最多返回数（默认 200）' },
			},
			required: ['pattern'],
		},
	},
	{
		name: 'ls',
		description: '列出目录内容（含文件类型/大小/修改时间），可递归。',
		parameters: {
			type: 'object',
			properties: {
				path:       { type: 'string', description: '目标目录（默认 "."）' },
				showHidden: { type: 'boolean', description: '显示 . 开头的隐藏文件' },
				recursive:  { type: 'boolean', description: '递归列出（最多 5 层）' },
			},
		},
	},
	{
		name: 'apply_patch',
		description: '应用 unified diff 补丁。支持多文件、新建、删除。任一 hunk 失败整体回滚。比 multiedit 更适合跨文件协调修改。',
		parameters: {
			type: 'object',
			properties: {
				patch: { type: 'string', description: '标准 unified diff 文本（--- / +++ / @@ 头部）' },
			},
			required: ['patch'],
		},
	},
	{
		name: 'lsp',
		description: 'Language Server Protocol 操作：查询类（跳转定义/引用/悬停/符号/诊断）+ 编辑类（rename 重命名、codeAction 代码操作、formatDocument 格式化、organizeImports 整理 import）。需本地已装语言服务器。',
		parameters: {
			type: 'object',
			properties: {
				operation: {
					type: 'string',
					enum: ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls', 'diagnostics', 'rename', 'codeAction', 'formatDocument', 'organizeImports'],
					description: 'LSP 操作类型',
				},
				filePath:  { type: 'string', description: '文件路径（除 workspaceSymbol 外必需）' },
				line:      { type: 'number', description: '行号（1-based，编辑器显示值）' },
				character: { type: 'number', description: '列号（1-based）' },
				query:     { type: 'string', description: 'workspaceSymbol 查询字符串' },
				newName:   { type: 'string', description: 'rename 新名字（仅 operation=rename 时需要）' },
				codeActionKind: { type: 'string', description: 'codeAction 类型：quickfix / refactor / source（可选）' },
			},
			required: ['operation'],
		},
	},
	{
		name: 'question',
		description: `向用户提问以获取澄清。【调用规则 — 严格遵守】

【必须用此工具的场景】
- 任何时候你需要用户回答问题
- 多选场景（"你想要 A 还是 B？"）
- 含有问号、想让用户做决定的语句

【绝对禁止】
- 禁止在 chat content 里输出"你想要 A 还是 B？"这种问句——用户看不到对话框，会以为是你的废话
- 禁止说"我应该先问用户..."——直接调本工具
- 禁止把多个问题塞在一段 markdown 里再发问。一次问一个，或用 multi:true + options 多选

【正确用法】
- question 字段：一句具体的问题
- options 字段：给 3-5 个常见选项让用户一键选（可选）
- chat content：可以为空，或一句"等待你的回答"

【调用后】
- 工具会挂起等待用户回答（最多 10 分钟）
- 返回 \`[用户回答: <内容>]\` → 根据回答继续
- 返回 \`[用户取消提问]\` → 立即停止，本轮结束

**只在信息缺失无法继续时使用**；能自行推断的不要问。`,
		parameters: {
			type: 'object',
			properties: {
				question: { type: 'string', description: '一句具体的问题（不是大段说明）' },
				options:  { type: 'array', items: { type: 'string' }, description: '可选：3-5 个预设选项让用户一键选' },
				multi:    { type: 'boolean', description: '是否多选' },
			},
			required: ['question'],
		},
	},
	{
		name: 'plan_exit',
		description: `输出一个完整的实施计划等待用户确认。【调用规则 — 严格遵守】

【必须用此工具的场景】
- Plan 模式：完成规划后必须调一次（不调 = 用户没法切到 Code 模式 = 任务卡死）
- Code 模式 + 大任务：见 PLAN-FIRST 清单（新增功能/跨多文件/重构/不确定方案）

【绝对禁止】
- 禁止把计划用 markdown 文本直接输出在 chat content 里
- 禁止说"我将使用 plan_exit"——直接调用本工具，不要描述它
- 禁止只调一次后又在 content 里复述一遍计划

【正确用法】
- summary 字段：1-3 句话讲清"做什么 / 为什么 / 影响范围"
- steps 字段：完整的 markdown 结构（## 文件清单、## 步骤 1/2/3、## 风险）
- chat content：可以为空，或最多一句"已生成计划，请在弹窗中确认"

【调用后】
- 工具会挂起等待用户响应（最多 10 分钟）
- 返回 \`[用户已同意...]\` → 切换到 Code 模式开始执行
- 返回 \`[用户拒绝当前计划: <反馈>]\` → 根据反馈重新规划再调一次
- 返回 \`[任务已被用户取消...]\` → 立即停止所有动作，本轮结束，不要再调任何工具`,
		parameters: {
			type: 'object',
			properties: {
				summary: { type: 'string', description: '1-3 句话的计划摘要（给用户在对话框看的）' },
				steps:   { type: 'string', description: '详细步骤的完整 markdown（## 文件清单 / ## 步骤 / ## 风险 等。这里写得越完整，用户越容易确认）' },
			},
			required: ['summary'],
		},
	},
	{
		name: 'task',
		description: `派发一个独立上下文的子代理完成特定子任务（B1 完整版）。
内置 4 种 subagent_type：
- general-purpose：复合任务（探索+小幅修改+测试），完整工具集
- code-reviewer：只读，对指定文件/diff 做代码审查
- code-explorer：只读+搜索强化，回答"这块代码怎么工作"
- test-writer：完整工具，专门写单元测试

老别名仍兼容：explore→code-explorer, build→general-purpose, review→code-reviewer, test→test-writer。
也支持 .maxian/agents/<name>.md 自定义 agent。

isolation: 'worktree' 时自动 git worktree 隔离（非 git 仓库或脏树会降级 inherit）。
background: true 时立即返回 task_id，主代理继续工作；适合并行多个独立子任务。`,
		parameters: {
			type: 'object',
			properties: {
				prompt:        { type: 'string', description: '给子代理的任务描述（聚焦、可执行）' },
				subagent_type: { type: 'string', description: '子代理类型 / 自定义 agent 名 / 老别名' },
				description:   { type: 'string', description: '简短标签（给用户/编排面板展示）' },
				isolation:     { type: 'string', enum: ['inherit', 'worktree'], description: 'inherit=共享父工作区（默认）；worktree=独立 git worktree' },
				background:    { type: 'boolean', description: 'true=立即返回 task_id 不等结果；false=等子代理完成（默认 false）' },
			},
			required: ['prompt', 'subagent_type'],
		},
	},
	// B2: MCP Tool Search 元工具（懒加载 + 完整生命周期）
	// 默认始终暴露给 LLM，让它在用户挂了 MCP server 时能动态查询/激活工具
	{
		name: 'mcp_tool_search',
		description: '搜索已连接的 MCP 服务器中可用的工具。返回 top-N 个相关工具的描述。挂载多个 MCP server 时，工具不会全部塞进 system prompt，而是通过本工具按需查找。',
		parameters: {
			type: 'object',
			properties: {
				query:         { type: 'string', description: '自然语言查询（例如 "fetch a webpage" 或 "操作 Figma 文件"）' },
				max_results:   { type: 'number', description: '返回上限（默认 5，最大 30）' },
				server_filter: { type: 'array',  items: { type: 'string' }, description: '只搜某些 server 名称' },
			},
			required: ['query'],
		},
	},
	{
		name: 'mcp_tool_load',
		description: '把一个或多个 MCP 工具加入当前会话的激活集，让它们出现在 system prompt 里可被直接 XML 调用。只在已通过 mcp_tool_search 找到候选后调用。',
		parameters: {
			type: 'object',
			properties: {
				tool_names: { type: 'array', items: { type: 'string' }, description: '工具完整 id 数组（mcp_<server>_<tool> 形式）' },
				sticky:     { type: 'boolean', description: '锁定不被自动卸载，默认 false' },
			},
			required: ['tool_names'],
		},
	},
	{
		name: 'mcp_tool_unload',
		description: '主动从激活集中移除指定 MCP 工具，释放 context tokens。一般无需手动调（自动生命周期会卸载未使用的工具）。',
		parameters: {
			type: 'object',
			properties: {
				tool_names: { type: 'array', items: { type: 'string' }, description: '工具 id 数组；["*"] 表示卸载全部' },
			},
			required: ['tool_names'],
		},
	},
	// B3: Auto-Memory 显式工具
	{
		name: 'save_memory',
		description: '把一条偏好/约定/事实保存到跨会话记忆库。每轮对话开始时系统会自动召回相关记忆注入 prompt，无需手动调用。仅在用户明确表达偏好/项目独特约定/重要事实时调用。',
		parameters: {
			type: 'object',
			properties: {
				scope:    { type: 'string', enum: ['global', 'workspace', 'session'], description: 'global=所有项目都召回；workspace=仅当前项目；session=仅本次会话' },
				category: { type: 'string', enum: ['preference', 'convention', 'fact', 'style', 'tech-stack', 'other'], description: '分类' },
				content:  { type: 'string', description: '记忆内容（≤80 字简洁描述）' },
			},
			required: ['scope', 'category', 'content'],
		},
	},
	{
		name: 'recall_memory',
		description: '按自然语言查询召回相关记忆。一般无需手动调（每轮自动召回 top-K）；显式深挖时使用。',
		parameters: {
			type: 'object',
			properties: {
				query:       { type: 'string', description: '自然语言查询' },
				max_results: { type: 'number', description: '上限（默认 5）' },
				category:    { type: 'string', description: '可选：限定分类' },
			},
			required: ['query'],
		},
	},
	// B4: Codebase Index 工具
	{
		name: 'codebase_search',
		description: '从当前工作区的代码库索引中按自然语言搜索 API/类/函数。返回匹配的符号位置 + 签名 + 文档摘要。比 grep 更适合"找做某事的函数"类的语义查询。',
		parameters: {
			type: 'object',
			properties: {
				query:       { type: 'string', description: '自然语言查询，例如 "处理用户登录的函数" 或 "数据库连接相关的类"' },
				max_results: { type: 'number', description: '返回上限（默认 10）' },
			},
			required: ['query'],
		},
	},
	{
		name: 'codebase_index_status',
		description: '查询当前工作区的代码库索引状态：刷新时间 / 文件数 / API 数 / 架构总结。',
		parameters: { type: 'object', properties: {} },
	},
	{
		name: 'codebase_index_refresh',
		description: '强制重建当前工作区的代码库索引（增量或全量）。一般无需手动调，进项目时自动建。',
		parameters: {
			type: 'object',
			properties: {
				incremental: { type: 'boolean', description: 'true=增量；false=全量。默认 true' },
			},
		},
	},
	// B5: 浏览器预览工具
	{
		name: 'browser_open',
		description: '在桌面端内嵌浏览器中打开 URL。仅允许 127.0.0.1/localhost/.local；其它需用户手动授权。',
		parameters: {
			type: 'object',
			properties: { url: { type: 'string', description: '要打开的 URL' } },
			required: ['url'],
		},
	},
	{
		name: 'browser_screenshot',
		description: '截取当前内嵌浏览器的可见区域。返回 base64 PNG，多模态 LLM 可解读视觉效果。',
		parameters: { type: 'object', properties: {} },
	},
	{
		name: 'browser_console_logs',
		description: '读取内嵌浏览器最近 N 条控制台日志。',
		parameters: { type: 'object', properties: { max_entries: { type: 'number' } } },
	},
	{
		name: 'browser_network_requests',
		description: '读取内嵌浏览器最近 N 个 HTTP 请求。',
		parameters: { type: 'object', properties: { max_entries: { type: 'number' } } },
	},
	{
		name: 'browser_click',
		description: '点击内嵌浏览器中的元素（CSS selector）。',
		parameters: {
			type: 'object',
			properties: { selector: { type: 'string' } },
			required: ['selector'],
		},
	},
	{
		name: 'browser_fill',
		description: '往内嵌浏览器的 input/textarea 元素填值。',
		parameters: {
			type: 'object',
			properties: { selector: { type: 'string' }, value: { type: 'string' } },
			required: ['selector', 'value'],
		},
	},
	{
		name: 'browser_eval',
		description: '在内嵌浏览器页面执行 JavaScript 表达式。',
		parameters: {
			type: 'object',
			properties: { script: { type: 'string' } },
			required: ['script'],
		},
	},
	{
		name: 'browser_wait_for',
		description: '等待 CSS selector 在内嵌浏览器页面出现（异步 SPA 加载场景）。',
		parameters: {
			type: 'object',
			properties: { selector: { type: 'string' }, timeout_ms: { type: 'number' } },
			required: ['selector'],
		},
	},
];

// ─── 文件快照辅助 ──────────────────────────────────────────────────────────────

type FileChangeAction = 'created' | 'modified' | 'deleted';

/**
 * 在写入/编辑文件前，将当前内容保存到 file_snapshots 表。
 * 如果文件不存在则保存空内容（标记为 'created'，撤销 = 删除文件）。
 *
 * action: 'created' = 文件之前不存在；'modified' = 文件存在被改；'deleted' = 文件被删除
 */
function saveFileSnapshot(sessionId: string, absolutePath: string, action: FileChangeAction = 'modified'): void {
	try {
		const exists = fs.existsSync(absolutePath);
		const content = exists ? fs.readFileSync(absolutePath, 'utf8') : '';
		// 实际 action：如果调用方传了 'modified' 但文件不存在，自动校正为 'created'
		const realAction: FileChangeAction = action === 'modified' && !exists ? 'created' : action;
		const db = getDb();
		db.prepare(
			'INSERT INTO file_snapshots (session_id, path, content, action, created_at) VALUES (?, ?, ?, ?, ?)'
		).run(sessionId, absolutePath, content, realAction, Date.now());
	} catch (e) {
		console.warn('[Snapshot] 保存快照失败:', (e as Error).message);
	}
}

// ─── 工具执行器 ────────────────────────────────────────────────────────────────

/**
 * 执行单个工具调用，返回结果字符串。
 * edit 工具会先读取文件内容，再计算替换结果并写回。
 *
 * emitEvent: 可选的 SSE 事件发射函数，用于发送 file_changed 等事件
 */
/**
 * 🛡 Stale-overwrite 检测（v0.2.10）
 *
 * 问题背景：
 *   FileTime.assert 只能检测"没读"或"读完后被外部改过"，但无法检测
 *   "AI 读了文件、看到了用户的手改，但继续用它脑子里的旧版本 write_to_file 覆盖"。
 *
 * 检测逻辑：
 *   - 对比 old（磁盘当前内容）vs new（AI 要写入的内容）
 *   - 计算行集合差：removed = oldLines - newLines, added = newLines - oldLines
 *   - 如果 removed 远大于 added（疑似"只删不加"的整体重写）→ 判定为陈旧覆盖嫌疑
 *   - 阈值：removed > 10 行 且 removed > added * 2（至少删除 10 行且至少是新增的 2 倍）
 *
 * 误报情况：
 *   - 正常的大范围重构（比如删掉一整个废弃函数）
 *   - AI 根据用户要求整体重写文件
 *   → 这类场景 AI 会在回复里明确提到"整体重写"，用户能看到意图；
 *     必要时通过 edit 分段完成即可
 *
 * 放行情况：
 *   - 新增行数 ≥ 删除行数：显然不是"陈旧覆盖"
 *   - 删除行数 < 10：改动太小，不值得拦
 *   - 空白行/注释差异：按内容去重会自然相抵
 */
function detectStaleOverwrite(
	oldContent: string,
	newContent: string,
	filePath: string,
): { block: boolean; message: string } {
	// 快速短路：new 更长 → 显然是在加内容，放行
	if (newContent.length >= oldContent.length * 0.9) {
		return { block: false, message: '' };
	}

	const oldLines = oldContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
	const newLines = newContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);

	// 小文件不拦（噪音大）
	if (oldLines.length < 15) {
		return { block: false, message: '' };
	}

	const newSet = new Set(newLines);
	const oldSet = new Set(oldLines);
	const removed = oldLines.filter(l => !newSet.has(l)).length;
	const added   = newLines.filter(l => !oldSet.has(l)).length;

	// 核心判定：删除行数 > 10 且 > 新增行数的 2 倍
	if (removed > 10 && removed > added * 2) {
		return {
			block: true,
			message:
`🚫 write_to_file 被拦截：检测到"陈旧覆盖"嫌疑

目标文件：${filePath}
- 磁盘当前非空行数：${oldLines.length}
- 你要写入的非空行数：${newLines.length}
- 你的新内容相比磁盘**删除了 ${removed} 行**，仅新增 ${added} 行

这通常表示你**没有基于文件最新内容构造 write_to_file**，而是用了脑子里的旧版本
整体覆盖。结果会删除用户（或其他 AI）在外部对这个文件做的修改。

【正确做法】
1. **局部修改请用 edit / multiedit 工具**——精确定位 old_string 替换为 new_string
   不要用 write_to_file 整体重写已存在文件
2. 如果确实需要整体重写（比如用户明确要求"重新写一遍"），先 read_file 确认
   当前完整内容，把用户的所有改动融合进你的新版本后再 write_to_file

禁止原参数重试 write_to_file。必须改用 edit/multiedit，或者先重新 read_file
确认当前完整内容后再决定策略。`
		};
	}

	return { block: false, message: '' };
}

/**
 * 工具输出按时窗合并器（K-PerfA）
 *
 * mvn / npm install / build 这类长命令会在 1 秒内产生几百-上千条 stdout 行,
 * 之前是每条都立刻 emit 一次 'tool_output_chunk' SSE 事件,导致：
 *   1. sidecar 单事件循环排队上千个 emitEvent → JSON.stringify → SSE write
 *   2. 前端 setMessages 高频触发 → messages 数组重建 → SharedChatMessage 转换 → reconciliation
 * 多会话并发时 CPU 占用直接拉满。
 *
 * 这里加一层缓冲：
 *   - 100ms 时窗内的所有 chunk 攒起来,合并为单条 SSE 事件
 *   - 或者 buffer 累积到 8KB 时立即 flush（突发输出不延迟太久）
 *   - 命令结束前调用方必须 await flush() 把残留 buffer 发出去
 *
 * 多个 chunk 合并不影响前端展示——liveOutput 区只看尾部，丢中间合并损失语义为零。
 */
interface BufferedOutputSink {
	sink: (chunk: string, kind: 'stdout' | 'stderr') => void;
	flush: () => Promise<void>;
}

function createBufferedToolOutputSink(opts: {
	sessionId:  string;
	toolUseId:  string;
	toolName:   string;
	emitEvent:  (event: Record<string, unknown>) => Promise<void>;
	flushIntervalMs?: number;     // 默认 100ms
	flushThresholdBytes?: number; // 默认 8KB
}): BufferedOutputSink {
	const interval  = opts.flushIntervalMs ?? 100;
	const threshold = opts.flushThresholdBytes ?? 8 * 1024;

	let stdoutBuf = '';
	let stderrBuf = '';
	let timer: ReturnType<typeof setTimeout> | null = null;

	const doFlush = async () => {
		if (timer) { clearTimeout(timer); timer = null; }
		const so = stdoutBuf; stdoutBuf = '';
		const se = stderrBuf; stderrBuf = '';
		// 同一时窗内若 stdout 和 stderr 都有,各发一条
		if (so) {
			try {
				await opts.emitEvent({
					type:      'tool_output_chunk',
					sessionId: opts.sessionId,
					toolUseId: opts.toolUseId,
					toolName:  opts.toolName,
					kind:      'stdout',
					chunk:     so,
				});
			} catch { /* ignore */ }
		}
		if (se) {
			try {
				await opts.emitEvent({
					type:      'tool_output_chunk',
					sessionId: opts.sessionId,
					toolUseId: opts.toolUseId,
					toolName:  opts.toolName,
					kind:      'stderr',
					chunk:     se,
				});
			} catch { /* ignore */ }
		}
	};

	const scheduleFlush = () => {
		if (timer) return;
		timer = setTimeout(() => { void doFlush(); }, interval);
	};

	return {
		sink(chunk, kind) {
			if (!chunk) return;
			if (kind === 'stdout') stdoutBuf += chunk;
			else                    stderrBuf += chunk;
			if (stdoutBuf.length + stderrBuf.length >= threshold) {
				void doFlush();   // 满即冲,不等定时器
			} else {
				scheduleFlush();
			}
		},
		async flush() {
			await doFlush();
		},
	};
}

async function executeToolCall(
	ctx: NodeToolContext,
	name: string,
	params: Record<string, unknown>,
	emitEvent?: (event: Record<string, unknown>) => Promise<void>,
	toolUseId?: string,
): Promise<string> {
	// 把 toolUseId 透传给需要的 case（例如 bash 的流式输出）
	if (toolUseId) (params as any).__toolUseId = toolUseId;
	try {
		let result: unknown;
		switch (name) {
			case 'read_file': {
				result = await readFileTool(ctx, params);
				break;
			}
			case 'write_to_file': {
				// 快照：写前保存原始内容
				const wFilePath = params.path as string;
				const wAbsPath = path.isAbsolute(wFilePath)
					? wFilePath
					: path.resolve(ctx.workspacePath, wFilePath);
				const wIsNew = !fs.existsSync(wAbsPath);

				// FileTime.assert：覆盖已存在的文件前，验证 AI 读过且未被外部改过
				if (ctx.sessionId && !wIsNew) {
					try {
						const { FileTime } = await import('@maxian/core/file/FileTime');
						await FileTime.assert(ctx.sessionId, wAbsPath);
					} catch (e) {
						return `Error: ${(e as Error).message}`;
					}
				}

				// 🛡 Stale-overwrite 检测（v0.2.10）：
				// FileTime 只能检测"没读"或"读完后磁盘被改过"，不能检测
				// "AI 读了但无视新内容，用它脑子里的旧内容覆盖"的场景。
				// 对已存在文件，比较 new_content vs 磁盘当前内容：
				//   - 如果新内容**删除的行数明显大于新增**，判定为"陈旧覆盖"嫌疑 → 拒绝
				//   - 提示 AI 用 edit 做局部修改而非整体重写
				if (!wIsNew) {
					const newContent = String(params.content ?? '');
					try {
						const oldContent = fs.readFileSync(wAbsPath, 'utf8');
						const safety = detectStaleOverwrite(oldContent, newContent, wFilePath);
						if (safety.block) {
							return `Error: ${safety.message}`;
						}
					} catch { /* 读失败就放行，不挡正常流程 */ }
				}

				if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, wAbsPath);
				result = await writeToFileTool(ctx, params);
				ctx.didEditFile = true;
				// 通知前端文件变更
				if (emitEvent) {
					await emitEvent({
						type: 'file_changed',
						sessionId: ctx.sessionId,
						path: wAbsPath,
						action: wIsNew ? 'created' : 'modified',
					});
				}
				break;
			}
			case 'edit': {
				const filePath = params.path as string;
				const absolutePath = path.isAbsolute(filePath)
					? filePath
					: path.resolve(ctx.workspacePath, filePath);

				// FileTime.assert：修改已存在的文件前，验证 AI 读过且文件未被外部改过
				//（新建文件场景 content === null，跳过检查）
				let content: string | null = null;
				try { content = fs.readFileSync(absolutePath, 'utf8'); } catch { /* 文件不存在 */ }

				if (ctx.sessionId && content !== null) {
					try {
						const { FileTime } = await import('@maxian/core/file/FileTime');
						await FileTime.assert(ctx.sessionId, absolutePath);
					} catch (e) {
						return `Error: ${(e as Error).message}`;
					}
				}

				// 【行尾符保留】检测原文件用 \r\n 还是 \n，写回时保持一致
				const hadCRLF = content !== null && /\r\n/.test(content);

				if (ctx.sessionId && content !== null) saveFileSnapshot(ctx.sessionId, absolutePath);
				const isNewFile = content === null;

				const editResult = executeEdit(content, params as unknown as Parameters<typeof executeEdit>[1]);
				if (editResult.success && editResult.newContent !== undefined) {
					let finalContent = editResult.newContent;
					// 如果原文件用 CRLF，且新内容是 LF，转回 CRLF
					if (hadCRLF && !/\r\n/.test(finalContent)) {
						finalContent = finalContent.replace(/\r?\n/g, '\r\n');
					}
					fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
					fs.writeFileSync(absolutePath, finalContent, 'utf8');
					ctx.didEditFile = true;
					ctx.fileContextTracker.trackFileWrite(absolutePath);
					// FileTime：写入后刷新基线，避免后续连续 edit 误判"外部修改"
					if (ctx.sessionId) {
						try {
							const { FileTime } = await import('@maxian/core/file/FileTime');
							await FileTime.read(ctx.sessionId, absolutePath);
						} catch { /* ignore */ }
					}
					if (emitEvent) {
						await emitEvent({
							type: 'file_changed',
							sessionId: ctx.sessionId,
							path: absolutePath,
							action: isNewFile ? 'created' : 'modified',
						});
					}
				}
				let resp = formatEditResponse(editResult, params.new_string as string);

				// 【编辑后 diagnostic 摘要】如果 LSP 可用，跑一次诊断，取前 20 条 error/warning
				if (editResult.success) {
					try {
						const diags = await LSP.diagnostics(absolutePath, ctx.workspacePath);
						if (diags && diags.length > 0) {
							const filtered = diags
								.filter((d: any) => (d.severity ?? 1) <= 2)   // 1=Error, 2=Warning
								.slice(0, 20);
							if (filtered.length > 0) {
								const lines = filtered.map((d: any) => {
									const sev = d.severity === 1 ? '❌ Error' : '⚠️ Warning';
									const line = (d.range?.start?.line ?? 0) + 1;
									const col  = (d.range?.start?.character ?? 0) + 1;
									return `  ${sev} [${line}:${col}] ${d.message}`;
								}).join('\n');
								resp += `\n\n📋 LSP 诊断（前 ${filtered.length} 条 error/warning）：\n${lines}`;
							} else {
								resp += `\n\n✓ LSP 诊断：无 error/warning`;
							}
						}
					} catch { /* LSP 不可用则忽略 */ }
				}

				return resp;
			}
			case 'multiedit': {
				const mFilePath = params.path as string;
				const mAbsPath = path.isAbsolute(mFilePath)
					? mFilePath
					: path.resolve(ctx.workspacePath, mFilePath);

				let mContent: string | null = null;
				try { mContent = fs.readFileSync(mAbsPath, 'utf8'); } catch { /* 文件不存在 */ }

				if (mContent === null) {
					return `Error: 文件不存在: ${mFilePath}`;
				}

				// FileTime.assert：验证 AI 读过且文件未被外部改过
				if (ctx.sessionId) {
					try {
						const { FileTime } = await import('@maxian/core/file/FileTime');
						await FileTime.assert(ctx.sessionId, mAbsPath);
					} catch (e) {
						return `Error: ${(e as Error).message}`;
					}
				}

				// 快照
				if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, mAbsPath);

				const edits = params.edits as Array<{ oldString: string; newString: string; replaceAll?: boolean }>;
				const multieditResult = executeMultiedit(mContent, edits);
				if (multieditResult.success && multieditResult.finalContent !== undefined) {
					fs.writeFileSync(mAbsPath, multieditResult.finalContent, 'utf8');
					ctx.didEditFile = true;
					ctx.fileContextTracker.trackFileWrite(mAbsPath);
					if (ctx.sessionId) {
						try {
							const { FileTime } = await import('@maxian/core/file/FileTime');
							await FileTime.read(ctx.sessionId, mAbsPath);
						} catch { /* ignore */ }
					}
					if (emitEvent) {
						await emitEvent({
							type: 'file_changed',
							sessionId: ctx.sessionId,
							path: mAbsPath,
							action: 'modified',
						});
					}
				}
				const multieditResponse = formatMultieditResponse(multieditResult, mFilePath);
				return typeof multieditResponse === 'string' ? multieditResponse : JSON.stringify(multieditResponse);
			}
			case 'todo_write': {
				const sessionId = ctx.sessionId ?? 'global';
				const todoResult = executeTodoWrite(sessionId, params.todos);
				if (todoResult.success) {
					// 推送 todos 列表更新事件到前端（用于 Todo 跟踪面板）
					if (emitEvent && ctx.sessionId) {
						await emitEvent({
							type: 'todos_updated',
							sessionId: ctx.sessionId,
							todos: todoResult.todos,
						});
					}
					return formatTodoWriteList(todoResult.todos);
				}
				return `Error: ${todoResult.message}`;
			}
			case 'web_fetch': {
				const fetchUrl = params.url as string;
				const validation = validateUrl(fetchUrl);
				if (!validation.valid) {
					return `Error: ${validation.error}`;
				}
				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), 30000);
					const res = await fetch(fetchUrl, {
						signal: controller.signal,
						headers: {
							'User-Agent': 'Mozilla/5.0 (compatible; MaxianIDE/1.0)',
							'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						},
						redirect: 'follow',
					});
					clearTimeout(timeout);
					const contentType = res.headers.get('content-type') ?? '';
					const text = await res.text();
					const fetchResult = processResponse(fetchUrl, text, contentType, {
						url: fetchUrl,
						prompt: params.prompt as string | undefined,
					});
					if (fetchResult.success && fetchResult.content) {
						const title = fetchResult.metadata?.title ? `# ${fetchResult.metadata.title}\n\n` : '';
						return `${title}${fetchResult.content}`;
					}
					return `Error: ${fetchResult.error ?? '获取失败'}`;
				} catch (e) {
					return `Error: web_fetch 失败: ${(e as Error).message}`;
				}
			}
			case 'search_files': {
				result = await searchFilesTool(ctx, params);
				break;
			}
			case 'list_files': {
				result = await listFilesTool(ctx, params);
				break;
			}
			case 'execute_command': {
				// 流式输出（K-PerfA：加 100ms 时窗合并,降低高频 chunk 风暴）
				const toolUseIdEx = (params as any).__toolUseId as string | undefined;
				const bufferedEx  = (toolUseIdEx && emitEvent && ctx.sessionId)
					? createBufferedToolOutputSink({
						sessionId: ctx.sessionId,
						toolUseId: toolUseIdEx,
						toolName:  'execute_command',
						emitEvent,
					})
					: null;
				const sinkEx = bufferedEx
					? (chunk: string, kind: 'stdout' | 'stderr') => bufferedEx.sink(chunk, kind)
					: undefined;
				// 开始横幅（直接 emit,不走 buffer,确保用户立刻看到命令）
				if (toolUseIdEx && emitEvent) {
					try {
						await emitEvent({
							type:      'tool_output_chunk',
							sessionId: ctx.sessionId,
							toolUseId: toolUseIdEx,
							toolName:  'execute_command',
							kind:      'stdout',
							chunk:     `$ ${(params as any).command}\n`,
						});
					} catch { /* ignore */ }
				}
				result = await executeCommandTool(ctx, params, sinkEx);
				// 结束前先 flush buffer,把残留输出推完
				if (bufferedEx) await bufferedEx.flush();
				// 结束横幅
				if (toolUseIdEx && emitEvent) {
					try {
						await emitEvent({
							type:      'tool_output_chunk',
							sessionId: ctx.sessionId,
							toolUseId: toolUseIdEx,
							toolName:  'execute_command',
							kind:      'stdout',
							chunk:     `\n[命令结束]\n`,
							final:     true,
						});
					} catch { /* ignore */ }
				}
				break;
			}
		case 'load_skill': {
				const skillName = params.skill_name as string;
				const skillDirs = [
					path.join(ctx.workspacePath, '.maxian', 'skills'),
					path.join(ctx.workspacePath, '.claude', 'skills'),
					path.join(os.homedir(), '.maxian', 'skills'),
					path.join(os.homedir(), '.claude', 'skills'),
				];

				// 扫描：支持
				//   1) 平铺 <name>.md
				//   2) 目录型 <name>/SKILL.md（或 skill.md / README.md）
				//   3) 分类目录 <category>/<name>.md —— K11d 新增，用于 maxian-builtin/* 等分组场景
				const scanSkills = (dir: string, allowRecurse: boolean = true): Array<{ name: string; abs: string }> => {
					const out: Array<{ name: string; abs: string }> = [];
					if (!fs.existsSync(dir)) return out;
					let entries: string[];
					try { entries = fs.readdirSync(dir); } catch { return out; }
					for (const entry of entries) {
						if (entry.startsWith('.')) continue;
						const absEntry = path.join(dir, entry);
						let stat: fs.Stats;
						try { stat = fs.statSync(absEntry); } catch { continue; }
						if (stat.isFile() && entry.endsWith('.md')) {
							out.push({ name: entry.slice(0, -3), abs: absEntry });
						} else if (stat.isDirectory()) {
							let matched = false;
							for (const c of ['SKILL.md', 'skill.md', 'README.md']) {
								const abs = path.join(absEntry, c);
								if (fs.existsSync(abs)) { out.push({ name: entry, abs }); matched = true; break; }
							}
							if (!matched && allowRecurse) {
								const inner = scanSkills(absEntry, false);
								for (const it of inner) out.push(it);
							}
						}
					}
					return out;
				};

				if (skillName === 'list') {
					const skillList: string[] = [];
					const seenNames = new Set<string>();
					for (const dir of skillDirs) {
						for (const { name, abs } of scanSkills(dir)) {
							if (seenNames.has(name)) continue;
							seenNames.add(name);
							skillList.push(`${name} (${abs})`);
						}
					}
					return skillList.length > 0
						? `可用技能列表：\n${skillList.map(s => `- ${s}`).join('\n')}`
						: '没有找到任何技能。请在 .maxian/skills/、.claude/skills/ 或 ~/.claude/skills/ 创建（目录型 <name>/SKILL.md 或平铺 <name>.md）。';
				}
				for (const dir of skillDirs) {
					for (const { name, abs } of scanSkills(dir)) {
						if (name === skillName) {
							const content = fs.readFileSync(abs, 'utf8');
							return `## 技能: ${skillName}\n\n来源: ${abs}\n\n${content}`;
						}
					}
				}
				return `Error: 技能 "${skillName}" 未找到。使用 skill_name: "list" 查看所有可用技能。`;
			}
			// ── 新增工具 dispatch（对标 OpenCode） ─────────────────────────
			case 'bash': {
				const bp = params as unknown as IBashToolParams;
				const danger = detectDangerousCommand(bp.command);
				if (danger) {
					return `Error: 拒绝执行危险命令（${danger}）。请调整为更安全的命令。`;
				}
				// 流式输出（K-PerfA：加 100ms 时窗合并）
				const toolUseId  = (params as any).__toolUseId as string | undefined;
				const bufferedB  = (toolUseId && emitEvent && ctx.sessionId)
					? createBufferedToolOutputSink({
						sessionId: ctx.sessionId,
						toolUseId,
						toolName:  'bash',
						emitEvent,
					})
					: null;
				const sink = bufferedB
					? (chunk: string, kind: 'stdout' | 'stderr') => bufferedB.sink(chunk, kind)
					: undefined;
				// 开始横幅（直接 emit,不走 buffer）
				if (toolUseId && emitEvent) {
					try {
						await emitEvent({
							type:      'tool_output_chunk',
							sessionId: ctx.sessionId,
							toolUseId,
							toolName:  'bash',
							kind:      'stdout',
							chunk:     `$ ${bp.command}\n`,
						});
					} catch { /* ignore */ }
				}
				const r = await bashTool(ctx, bp, sink);
				// 结束前 flush buffer
				if (bufferedB) await bufferedB.flush();
				// 结束横幅
				if (toolUseId && emitEvent) {
					try {
						const tail = r.timedOut ? `\n[超时被杀]\n` : `\n[exit=${r.exitCode}]\n`;
						await emitEvent({
							type:      'tool_output_chunk',
							sessionId: ctx.sessionId,
							toolUseId,
							toolName:  'bash',
							kind:      'stdout',
							chunk:     tail,
							final:     true,
						});
					} catch { /* ignore */ }
				}
				const text = formatBashResult(r, bp);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'grep': {
				const gp = params as unknown as IGrepToolParams;
				const r = await grepTool(ctx, gp);
				const text = formatGrepResult(r, gp);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'glob': {
				const gp = params as unknown as IGlobToolParams;
				const r = await globTool(ctx, gp);
				const text = await formatGlobResult(r, gp);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'ls': {
				const lp = params as unknown as ILsToolParams;
				const r = await lsTool(ctx, lp);
				const text = formatLsResult(r);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'apply_patch': {
				const ap = params as unknown as IApplyPatchParams;
				// 为即将被修改的文件保存快照
				if (ctx.sessionId && ap.patch) {
					const fileMatches = ap.patch.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)(?:\s+.*)?$/gm);
					if (fileMatches) {
						const files = new Set<string>();
						for (const m of fileMatches) {
							const match = m.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)(?:\s+.*)?$/);
							if (match && match[1] !== '/dev/null') files.add(match[1]);
						}
						for (const f of files) {
							const abs = path.isAbsolute(f) ? f : path.resolve(ctx.workspacePath, f);
							saveFileSnapshot(ctx.sessionId, abs);
						}
					}
				}
				const r = await applyPatchTool(ctx, ap);
				// 通知前端文件变更
				if (emitEvent && r.success) {
					for (const p of r.filesCreated) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: p, action: 'created' });
					for (const p of r.filesChanged) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: p, action: 'modified' });
					for (const p of r.filesDeleted) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: p, action: 'deleted' });
				}
				return formatApplyPatchResult(r);
			}
			case 'lsp': {
				const lp = params as unknown as ILspToolParams;
				const op = lp.operation;
				const filePath = lp.filePath
					? (path.isAbsolute(lp.filePath) ? lp.filePath : path.resolve(ctx.workspacePath, lp.filePath))
					: '';
				let title: string = op;
				let output = '';
				let metadata: any = null;
				try {
					switch (op) {
						case 'goToDefinition': {
							if (!filePath || !lp.line || !lp.character) return `Error: goToDefinition 需要 filePath/line/character`;
							const r = await LSP.definition({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `goToDefinition ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r.length === 0 ? '没有找到定义' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'findReferences': {
							if (!filePath || !lp.line || !lp.character) return `Error: findReferences 需要 filePath/line/character`;
							const r = await LSP.references({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `findReferences ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r.length === 0 ? '没有找到引用' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'hover': {
							if (!filePath || !lp.line || !lp.character) return `Error: hover 需要 filePath/line/character`;
							const r = await LSP.hover({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `hover ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r ? JSON.stringify(r, null, 2) : '无悬停信息';
							metadata = r;
							break;
						}
						case 'documentSymbol': {
							if (!filePath) return `Error: documentSymbol 需要 filePath`;
							const r = await LSP.documentSymbol(filePath, ctx.workspacePath);
							title = `documentSymbol ${lp.filePath}`;
							output = r.length === 0 ? '文件无符号' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'workspaceSymbol': {
							const anyFile = filePath || ctx.workspacePath;
							const r = await LSP.workspaceSymbol(lp.query ?? '', anyFile, ctx.workspacePath);
							title = `workspaceSymbol "${lp.query ?? ''}"`;
							output = r.length === 0 ? '无匹配符号' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'goToImplementation': {
							if (!filePath || !lp.line || !lp.character) return `Error: goToImplementation 需要 filePath/line/character`;
							const r = await LSP.implementation({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `goToImplementation ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r.length === 0 ? '没有找到实现' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'prepareCallHierarchy': {
							if (!filePath || !lp.line || !lp.character) return `Error: prepareCallHierarchy 需要 filePath/line/character`;
							const r = await LSP.prepareCallHierarchy({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `prepareCallHierarchy ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r.length === 0 ? '无 call hierarchy' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'diagnostics': {
							if (!filePath) return `Error: diagnostics 需要 filePath`;
							const r = await LSP.diagnostics(filePath, ctx.workspacePath);
							title = `diagnostics ${lp.filePath}`;
							output = r.length === 0 ? '无诊断' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'incomingCalls':
						case 'outgoingCalls':
							return `Error: ${op} 需要先通过 prepareCallHierarchy 获取 CallHierarchyItem 再在客户端侧调用（当前 agent 工具未实现持久化）`;

						case 'rename': {
							if (!filePath || !lp.line || !lp.character || !lp.newName) return `Error: rename 需要 filePath/line/character/newName`;
							// 保存所有可能受影响的文件快照（仅针对当前文件；跨文件 rename 暂不预快照）
							if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, filePath);
							const edit = await LSP.rename({ file: filePath, line: lp.line, character: lp.character }, lp.newName, ctx.workspacePath);
							if (!edit) return `Error: 无法重命名（可能不是有效符号位置）`;
							const changed = await LSP.applyWorkspaceEdit(edit);
							title = `rename "${lp.newName}"`;
							output = `✓ 已重命名。修改了 ${changed.length} 个文件：\n${changed.map(f => `- ${f}`).join('\n')}`;
							metadata = { changed };
							// 通知前端
							if (emitEvent) {
								for (const f of changed) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: f, action: 'modified' });
							}
							ctx.didEditFile = changed.length > 0;
							break;
						}
						case 'codeAction': {
							if (!filePath || !lp.line || !lp.character) return `Error: codeAction 需要 filePath/line/character`;
							const actions = await LSP.codeAction({ file: filePath, line: lp.line, character: lp.character }, lp.codeActionKind, ctx.workspacePath);
							title = `codeAction ${lp.codeActionKind ?? 'any'} ${lp.filePath}:${lp.line}:${lp.character}`;
							output = actions.length === 0
								? '无可用代码操作'
								: '可用操作：\n' + actions.map((a, i) => `  ${i + 1}. ${a.title}${a.kind ? ` [${a.kind}]` : ''}`).join('\n')
									+ '\n\n⚠️ 代码操作仅列出可用项，未自动应用。若需应用，请根据 title 用 edit/apply_patch 手动实现。';
							metadata = actions;
							break;
						}
						case 'formatDocument': {
							if (!filePath) return `Error: formatDocument 需要 filePath`;
							if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, filePath);
							const edits = await LSP.formatDocument(filePath, ctx.workspacePath);
							if (edits.length === 0) {
								title = `formatDocument ${lp.filePath}`;
								output = '无格式化变更（文件已符合规则）';
								metadata = [];
							} else {
								await LSP.applyTextEdits(filePath, edits);
								title = `formatDocument ${lp.filePath}`;
								output = `✓ 已格式化。应用 ${edits.length} 处变更。`;
								metadata = { edits: edits.length };
								if (emitEvent) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: filePath, action: 'modified' });
								ctx.didEditFile = true;
							}
							break;
						}
						case 'organizeImports': {
							if (!filePath) return `Error: organizeImports 需要 filePath`;
							if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, filePath);
							const actions = await LSP.organizeImports(filePath, ctx.workspacePath);
							let appliedCount = 0;
							for (const a of actions) {
								if (a?.edit) {
									const chg = await LSP.applyWorkspaceEdit(a.edit);
									appliedCount += chg.length;
								}
							}
							title = `organizeImports ${lp.filePath}`;
							output = appliedCount > 0 ? `✓ 已整理 import（修改 ${appliedCount} 文件）` : '无 import 需要整理';
							metadata = { applied: appliedCount };
							if (appliedCount > 0 && emitEvent) {
								await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: filePath, action: 'modified' });
								ctx.didEditFile = true;
							}
							break;
						}

						default:
							return `Error: 未知 LSP 操作 "${op}"`;
					}
				} catch (e) {
					return `LSP 调用失败: ${(e as Error).message}`;
				}
				const result: ILspToolResult = { operation: op, title, output, metadata };
				const text = formatLspResult(result);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'question': {
				const qp = params as unknown as IQuestionToolParams;
				if (emitEvent && ctx.sessionId) {
					await emitEvent({
						type:      'question_request',
						sessionId: ctx.sessionId,
						question:  qp.question,
						options:   qp.options ?? [],
						multi:     qp.multi ?? false,
					});
				}
				const waitFn = (globalThis as any).__maxianWaitForQuestion as (sid: string, timeout: number) => Promise<any>;
				if (!waitFn || !ctx.sessionId) return '[question 工具需要会话 ID，当前会话无效]';
				try {
					const answer = await waitFn(ctx.sessionId, 600000);
					return formatQuestionResult({
						answer:    answer.answer ?? '',
						selected:  answer.selected,
						cancelled: answer.cancelled,
					});
				} catch {
					return `[用户未在 10 分钟内回答问题，请根据已有上下文继续]`;
				}
			}
			case 'plan_exit': {
				const pp = params as unknown as IPlanExitParams;
				if (emitEvent && ctx.sessionId) {
					await emitEvent({
						type:      'plan_exit_request',
						sessionId: ctx.sessionId,
						summary:   pp.summary,
						steps:     pp.steps ?? '',
					});
				}
				const waitFn = (globalThis as any).__maxianWaitForPlanExit as (sid: string, timeout: number) => Promise<any>;
				if (!waitFn || !ctx.sessionId) return '[plan_exit 工具需要会话 ID]';
				try {
					const r = await waitFn(ctx.sessionId, 600000);
					return formatPlanExitResult(r);
				} catch {
					return `[用户未在 10 分钟内响应，默认保持 Plan 模式]`;
				}
			}
			case 'task': {
				const tp = params as unknown as ITaskToolParams & { isolation?: 'inherit' | 'worktree'; background?: boolean | string };
				// 调用主 agent loop 的子任务派发（在 cli.ts 初始化时注入）
				if (!(globalThis as any).__maxianSpawnSubAgent) {
					return `Error: 子 Agent 派发未初始化`;
				}
				try {
					const bg = tp.background === true || tp.background === 'true';
					const r: ITaskToolResult = await (globalThis as any).__maxianSpawnSubAgent({
						parentSessionId: ctx.sessionId,
						workspacePath:   ctx.workspacePath,
						prompt:          tp.prompt,
						subagentType:    tp.subagent_type,
						description:     tp.description,
						isolation:       tp.isolation,
						background:      bg,
					});
					const text = formatTaskResult(r, tp);
					const truncated = Truncate.output(text, {}, false);  // task 内部已经是聚合的文本
					return truncated.content;
				} catch (e) {
					return formatTaskResult({ output: '', success: false, error: (e as Error).message }, tp);
				}
			}
			default: {
				// B5: 浏览器预览工具（桌面端 Tauri 通过 globalThis.__maxianBrowserController 注入实现）
				const browserToolNames = new Set([
					'browser_open', 'browser_screenshot', 'browser_console_logs',
					'browser_network_requests', 'browser_click', 'browser_fill',
					'browser_eval', 'browser_wait_for',
				]);
				if (browserToolNames.has(name)) {
					const ctrl = (globalThis as any).__maxianBrowserController as
						| import('@maxian/core/browser').IBrowserController
						| undefined;
					if (!ctrl) {
						return `错误：浏览器控制器未挂载。请确认在桌面端 Tauri 运行 sidecar，且已开启"浏览器预览"窗口。Web/CLI/IDE 模式不支持本组工具。`;
					}
					try {
						const browserMod = await import('@maxian/core/browser');
						let def: import('@maxian/core/tools').ToolDefinition | undefined;
						switch (name) {
							case 'browser_open':              def = browserMod.BROWSER_OPEN_TOOL; break;
							case 'browser_screenshot':        def = browserMod.BROWSER_SCREENSHOT_TOOL; break;
							case 'browser_console_logs':      def = browserMod.BROWSER_CONSOLE_LOGS_TOOL; break;
							case 'browser_network_requests':  def = browserMod.BROWSER_NETWORK_REQUESTS_TOOL; break;
							case 'browser_click':             def = browserMod.BROWSER_CLICK_TOOL; break;
							case 'browser_fill':              def = browserMod.BROWSER_FILL_TOOL; break;
							case 'browser_eval':              def = browserMod.BROWSER_EVAL_TOOL; break;
							case 'browser_wait_for':          def = browserMod.BROWSER_WAIT_FOR_TOOL; break;
						}
						if (!def?.execute) return `Error: 工具 ${name} 未实现 execute`;
						const browserCtx = {
							workspaceRoot:     ctx.workspacePath,
							sessionId:         ctx.sessionId ?? '',
							browserController: ctrl,
						};
						const res = await def.execute(params, browserCtx as any);
						const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
						// browser_screenshot 返回的是包含 base64 的 JSON，让 truncate 不截断（避免破坏 base64）
						if (name === 'browser_screenshot') {
							return text;
						}
						return Truncate.output(text, {}, true).content;
					} catch (e) {
						return `Error executing ${name}: ${(e as Error).message}`;
					}
				}

				// B4: Codebase Index 工具
				if (name === 'codebase_search' || name === 'codebase_index_status' || name === 'codebase_index_refresh') {
					try {
						if (!ctx.codebaseIndex || !ctx.currentWorkspaceId) {
							return '错误：当前会话没有挂载 Codebase Index 服务';
						}
						const idx = ctx.codebaseIndex;
						if (name === 'codebase_search') {
							const q = String(params.query ?? '').trim();
							if (!q) return '错误：query 不能为空';
							const max = Math.min(Math.max(1, Number(params.max_results) || 10), 50);
							const hits = await idx.search(ctx.currentWorkspaceId, q, max);
							if (hits.length === 0) return `未召回相关 API。索引中可能没有匹配的代码符号；可尝试用 grep / search_files 文本搜索作补充。`;
							const lines: string[] = [`找到 ${hits.length} 个符号：\n`];
							for (let i = 0; i < hits.length; i++) {
								const h = hits[i];
								lines.push(`${i + 1}. **${h.entry.symbolName}** (${h.entry.symbolKind}, 相关度 ${(h.score * 100).toFixed(1)}%)`);
								lines.push(`   - ${h.entry.filePath}:${h.entry.startLine}`);
								if (h.entry.signature) lines.push(`   - signature: \`${h.entry.signature.slice(0, 200)}\``);
								if (h.entry.docstring) lines.push(`   - doc: ${h.entry.docstring.slice(0, 200)}`);
								lines.push('');
							}
							return lines.join('\n');
						}
						if (name === 'codebase_index_status') {
							const { CODEBASE_INDEX_STATUS_TOOL } = await import('@maxian/core/codebase-index');
							if (!CODEBASE_INDEX_STATUS_TOOL.execute) return 'Error: 工具未实现 execute';
							const cbCtx = {
								workspaceRoot:      ctx.workspacePath,
								sessionId:          ctx.sessionId ?? '',
								codebaseIndex:      idx,
								currentWorkspaceId: ctx.currentWorkspaceId,
							};
							const res = await CODEBASE_INDEX_STATUS_TOOL.execute({}, cbCtx as any);
							return Truncate.output(typeof res === 'string' ? res : JSON.stringify(res), {}, true).content;
						}
						if (name === 'codebase_index_refresh') {
							const { CODEBASE_INDEX_REFRESH_TOOL } = await import('@maxian/core/codebase-index');
							if (!CODEBASE_INDEX_REFRESH_TOOL.execute) return 'Error: 工具未实现 execute';
							const cbCtx = {
								workspaceRoot:      ctx.workspacePath,
								sessionId:          ctx.sessionId ?? '',
								codebaseIndex:      idx,
								currentWorkspaceId: ctx.currentWorkspaceId,
							};
							const res = await CODEBASE_INDEX_REFRESH_TOOL.execute(params, cbCtx as any);
							return Truncate.output(typeof res === 'string' ? res : JSON.stringify(res), {}, true).content;
						}
					} catch (e) {
						return `Error executing ${name}: ${(e as Error).message}`;
					}
				}

				// B3: 记忆元工具（save_memory / recall_memory）
				if (name === 'save_memory' || name === 'recall_memory') {
					try {
						const memMod = await import('@maxian/core/memory');
						const def = name === 'save_memory' ? memMod.SAVE_MEMORY_TOOL : memMod.RECALL_MEMORY_TOOL;
						if (!def.execute) return `Error: ${name} 工具未实现 execute`;
						const memCtx = {
							workspaceRoot:      ctx.workspacePath,
							sessionId:          ctx.sessionId ?? '',
							memoryStore:        ctx.memoryStore,
							currentWorkspaceId: ctx.currentWorkspaceId,
						};
						const res = await def.execute(params, memCtx as any);
						const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
						return Truncate.output(text, {}, true).content;
					} catch (e) {
						return `Error executing ${name}: ${(e as Error).message}`;
					}
				}

				// B2: MCP 元工具（mcp_tool_search / mcp_tool_load / mcp_tool_unload）
				if (name === 'mcp_tool_search' || name === 'mcp_tool_load' || name === 'mcp_tool_unload') {
					try {
						const { MCP_TOOL_SEARCH, MCP_TOOL_LOAD, MCP_TOOL_UNLOAD } = await import('@maxian/core/tools');
						const def = name === 'mcp_tool_search' ? MCP_TOOL_SEARCH
							: name === 'mcp_tool_load'   ? MCP_TOOL_LOAD
							: MCP_TOOL_UNLOAD;
						if (!def.execute) return `Error: ${name} 工具未实现 execute`;
						// 构造 McpAwareToolContext —— ctx 已带 mcpHub / activeMcpTools / sticky / onMcpToolsChanged
						const mcpCtx = {
							workspaceRoot:   ctx.workspacePath,
							sessionId:       ctx.sessionId ?? '',
							mcpHub:          ctx.mcpHub,
							activeMcpTools:  ctx.activeMcpTools,
							stickyMcpTools:  ctx.stickyMcpTools,
							onMcpToolsChanged: ctx.onMcpToolsChanged,
						};
						const res = await def.execute(params, mcpCtx as any);
						const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
						return Truncate.output(text, {}, true).content;
					} catch (e) {
						return `Error executing ${name}: ${(e as Error).message}`;
					}
				}

				// B2: 真正调度 MCP server 上的工具（name 形如 mcp_<server>_<tool>）
				if (name.startsWith('mcp_') && ctx.mcpHub) {
					// 从 toolIndex 反查 (server, raw tool name)；avoid 简单字符串切分（server 名可能含下划线）
					const entry = ctx.mcpHub.toolIndex.getByToolId(name);
					if (!entry) {
						return `Error: MCP 工具 "${name}" 不在索引中。可能 server 已断开或工具已被移除。请用 mcp_tool_search 重新查找。`;
					}
					if (!ctx.activeMcpTools?.has(name)) {
						return `Error: MCP 工具 "${name}" 未激活。先用 mcp_tool_load 把它加入激活集，下一轮再调用。`;
					}
					try {
						// 记录 last used turn
						if (ctx.mcpToolLastUsedTurn !== undefined && ctx.currentTurn !== undefined) {
							ctx.mcpToolLastUsedTurn.set(name, ctx.currentTurn);
						}
						const callRes = await ctx.mcpHub.callTool(entry.serverName, entry.rawToolName, params);
						if (callRes.isError) {
							const errText = (callRes.content ?? []).map(c => c.text ?? '').join('\n');
							return `MCP 工具调用失败：${errText || '(无错误信息)'}`;
						}
						// 把多个 content item 拼成纯文本（过滤 image 等非文本类型）
						const textChunks = (callRes.content ?? [])
							.map(c => {
								if (c.type === 'text') return c.text ?? '';
								if (c.type === 'image') return `[image: ${c.mimeType ?? 'unknown'}, ${(c.data ?? '').length} bytes base64]`;
								if (c.type === 'resource') return `[resource: ${c.resource?.uri ?? c.uri ?? ''}]`;
								if (c.type === 'resource_link') return `[resource_link: ${c.uri ?? ''}]`;
								return '';
							})
							.filter(t => t.length > 0)
							.join('\n');
						const truncated = Truncate.output(textChunks || '(空响应)', {}, true);
						return truncated.content;
					} catch (e) {
						return `Error executing MCP tool ${name}: ${(e as Error).message}`;
					}
				}

				// 尝试插件工具
				const pluginMap: Map<string, PluginToolDef> | undefined = (globalThis as any).__maxianPluginTools;
				const plugin = pluginMap?.get(name);
				if (plugin) {
					try {
						const res = await plugin.execute(params, ctx);
						const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
						return Truncate.output(text, {}, true).content;
					} catch (e) {
						return `Error executing plugin tool ${name}: ${(e as Error).message}`;
					}
				}
				return `Error: Unknown tool "${name}"`;
			}
		}
		return typeof result === 'string' ? result : JSON.stringify(result);
	} catch (e) {
		return `Error executing ${name}: ${(e as Error).message}`;
	}
}

// ─── 平台实现 ──────────────────────────────────────────────────────────────────

async function createDefaultPlatform() {
	const config: IConfiguration = {
		getValue<T>(key: string, defaultValue?: T): T | undefined {
			const env = process.env['MAXIAN_' + key.toUpperCase().replace(/\./g, '_')];
			if (env !== undefined) {
				try { return JSON.parse(env) as T; } catch { return env as unknown as T; }
			}
			return defaultValue as T | undefined;
		},
		async updateValue(_key: string, _value: unknown) {},
	};

	const cwd = process.cwd();
	const workspace: IWorkspace = {
		getRootPath:    () => cwd,
		getRootPaths:   () => [cwd],
		isInWorkspace:  (p: string) => p.startsWith(cwd),
		toRelativePath: (p: string) => (p.startsWith(cwd) ? p.slice(cwd.length + 1) : p),
		getName:        () => cwd.split('/').pop() || 'workspace',
	};

	const toolExecutor: IToolExecutor = {
		executeTool:      async () => 'Tool execution is handled by the Agent loop in cli.ts',
		isToolAvailable:  () => true,
		getAvailableTools: () => AGENT_TOOL_DEFINITIONS.map(t => t.name as any),
	};

	// K8d: 注入真实的 NodeTerminal 实现，替换原来的 stub。
	// bashTool / executeCommandTool 现在通过 ctx.platform.terminal 调用，不再直接 import child_process。
	const { NodeTerminal } = await import('@maxian/core/adapters/NodeTerminal');
	const terminal: ITerminal = new NodeTerminal();

	// K8d 收尾：注入真实的 NodeFileSystem 替换原来的 stub。
	// 让 ctx.platform.fs 在 executeCommandTool 等位置可以做存在性预检查。
	const { NodeFileSystem } = await import('@maxian/core/adapters/NodeFileSystem');
	const fs: IFileSystem = new NodeFileSystem(cwd);

	// IStorage / IAuthProvider 当前 server 还没有真实实现（不属于核心 agent 工具链），
	// 暂时保留 stub —— core 工具不会从 ctx.platform.storage / .auth 取值。
	const storage = {} as IStorage;
	const auth    = {} as IAuthProvider;

	// 简易内存 IMessageBus（core 工具目前不会通过 ctx.platform.messageBus 主动 emit；
	// 真正的 SSE 广播走 sessionManager.emitEvent）。
	const messageBus: IMessageBus = {
		emit:      () => {},
		onCommand: () => ({ dispose() {} }),
	};

	// 装配完整 MaxianPlatform（工具层 ctx.platform 用）。
	const { createNodePlatform } = await import('@maxian/core/adapters/NodePlatform');
	const toolPlatform: MaxianPlatform = createNodePlatform({
		fs, terminal, workspace, messageBus, config, storage, auth,
		workspaceRoot: cwd,
	});

	return {
		config,
		workspace,
		fs,
		terminal,
		storage,
		auth,
		toolExecutor,
		toolPlatform,
	};
}

// ─── 主函数 ────────────────────────────────────────────────────────────────────

async function main() {
	const opts      = parseCliArgs();
	const platform  = await createDefaultPlatform();
	const aiConfig  = loadAiConfig();

	// 初始化数据库驱动（按运行时选 bun:sqlite 或 better-sqlite3）
	const { initDb } = await import('./database.js');
	await initDb();

	// 加载持久化数据
	const { WorkspaceManager } = await import('./workspaceManager.js');
	const { SessionManager }   = await import('./sessionManager.js');
	const [workspaceManager, sessionManager] = await Promise.all([
		WorkspaceManager.load(),
		SessionManager.load(),
	]);

	// K-Watcher：把工作区文件系统变化广播给所有订阅了这个工作区的 SSE 客户端，
	// 客户端可以增量 patch @ 引用的文件缓存。
	workspaceManager.subscribeFileChanges((change) => {
		void sessionManager.broadcastToWorkspace(change.workspacePath, {
			type:        'workspace_files_changed',
			workspaceId: change.workspaceId,
			added:       change.added,
			removed:     change.removed,
		});
	});

	const { server, listener } = await bootstrap({
		sessionManager,
		workspaceManager,
		platform: {
			config:    platform.config,
			workspace: platform.workspace,
			fs:        platform.fs,
			terminal:  platform.terminal,
			storage:   platform.storage,
			auth:      platform.auth,
		},
		toolExecutor: platform.toolExecutor,
		listen: {
			port:     opts.port,
			hostname: opts.host,
			username: opts.username,
			password: opts.password,
		},
		cors: opts.cors,
	});

	// K-MultiModel (v0.2.25)：注册 /scene-models/:code 透传路由 + 启动预热缓存。
	// 客户端 ModelSelector 拉清单走这个路由；getAiHandler 也按 (uiMode 对应 businessCode,
	// session.model) 查 sceneModelCache 拿 supportVision 等 meta 给 AiProxyHandler。
	registerSceneModelsRoute(server.app, {
		getAiConfig: () => {
			const rt = server.getAiConfig();
			if (rt) return { apiUrl: rt.apiUrl, username: rt.username, password: rt.password };
			if (aiConfig && aiConfig.type === 'proxy') {
				return { apiUrl: aiConfig.apiUrl, username: aiConfig.username, password: aiConfig.password };
			}
			return null;
		},
	});
	// fire-and-forget 预热两个常用 businessCode，让首次 AI 调用时 sceneModelCache 已就绪
	void (async () => {
		const cfg = server.getAiConfig() ?? (aiConfig && aiConfig.type === 'proxy' ? {
			apiUrl: aiConfig.apiUrl, username: aiConfig.username, password: aiConfig.password,
		} : null);
		if (cfg) {
			await prefetchSceneModels('IDE_CHAT_CODE', cfg);
			await prefetchSceneModels('IDE_CHAT_ASK',  cfg);
		}
	})();

	// ─── 集成终端 WebSocket 服务 ──────────────────────────────────────────────

	/**
	 * 通过将 WebSocketServer 附加到底层 HTTP server 实现终端功能。
	 * 协议：
	 *  客户端 → 服务端：
	 *    - JSON { type: 'resize', cols: number, rows: number } — 调整 PTY 大小
	 *    - 其他任意字符串 — 作为 stdin 发送到 PTY
	 *  服务端 → 客户端：
	 *    - JSON { type: 'ready', id: string } — 终端就绪（首次连接时）
	 *    - 普通字符串 — PTY stdout/stderr 输出
	 */
	const wss = new WebSocketServer({ noServer: true });
	/** termId → IPty 进程（用 any 避免顶层静态引用 pty 模块） */
	const ptyProcesses = new Map<string, import('@lydell/node-pty').IPty>();

	/** 从 HTTP server 拦截 /terminal WebSocket 升级请求 */
	listener.httpServer.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', `http://localhost`);
		if (!url.pathname.startsWith('/terminal')) {
			socket.destroy();
			return;
		}
		// 简单 Basic Auth 验证（复用 HTTP server 的认证凭据）
		const auth = req.headers['authorization'];
		const queryAuth = url.searchParams.get('auth');
		let authed = false;
		const expectedB64 = Buffer.from(`${opts.username ?? 'maxian'}:${opts.password ?? ''}`).toString('base64');
		if (auth) {
			const b64 = auth.replace(/^Basic\s+/i, '');
			authed = b64 === expectedB64;
		}
		if (!authed && queryAuth) {
			authed = queryAuth === expectedB64;
		}
		if (!authed && !opts.password) {
			// 若服务器无密码要求，允许无认证连接
			authed = true;
		}
		if (!authed) {
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket as any, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	});

	wss.on('connection', async (ws: WebSocket, req: import('node:http').IncomingMessage) => {
		const url = new URL(req.url ?? '/', `http://localhost`);
		const cwd = url.searchParams.get('cwd') ?? process.cwd();
		const termId = url.searchParams.get('id') ?? Math.random().toString(36).slice(2);

		// 使用用户默认 shell
		const shell = process.env['SHELL'] ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
		const cols = parseInt(url.searchParams.get('cols') ?? '120', 10);
		const rows = parseInt(url.searchParams.get('rows') ?? '30', 10);

		// 懒加载 pty（参见文件顶部 loadPty 说明）
		let pty: PtyModule;
		try {
			pty = await loadPty();
		} catch (e) {
			console.error('[Terminal] 加载 @lydell/node-pty 失败:', e);
			try { ws.send(JSON.stringify({ type: 'error', message: 'PTY 模块不可用: ' + (e as Error).message })); } catch {}
			try { ws.close(); } catch {}
			return;
		}

		let ptyProcess: ReturnType<typeof pty.spawn> | null = null;
		try {
			ptyProcess = pty.spawn(shell, [], {
				name: 'xterm-256color',
				cols,
				rows,
				cwd,
				env: {
					...process.env,
					// 强制 UTF-8 locale，确保 ls/grep 等命令能正确显示中文文件名。
					// Tauri GUI 进程不继承 shell 环境，process.env.LANG 可能为空或错误值，
					// 必须显式覆盖 LANG + LC_ALL + LC_CTYPE，且必须使用完整 locale 名称（en_US.UTF-8），
					// 仅设置 'UTF-8' 是无效的 locale 值。
					LANG:     'en_US.UTF-8',
					LC_ALL:   'en_US.UTF-8',
					LC_CTYPE: 'en_US.UTF-8',
					TERM:     'xterm-256color',
				} as Record<string, string>,
			});
		} catch (err) {
			console.error('[Terminal] PTY spawn 失败:', err);
			ws.send(JSON.stringify({ type: 'error', message: String(err) }));
			ws.close();
			return;
		}

		ptyProcesses.set(termId, ptyProcess);
		console.log(`[Terminal] 新终端 ${termId} (pid=${ptyProcess.pid}, shell=${shell}, cwd=${cwd})`);

		// 发送就绪信号
		ws.send(JSON.stringify({ type: 'ready', id: termId, pid: ptyProcess.pid }));

		// PTY → WebSocket（输出）
		// @lydell/node-pty 默认 encoding='utf8'，onData 返回已解码的 Unicode 字符串。
		// 用 Buffer.from(data, 'utf8') 将 Unicode 字符串重新编码为 UTF-8 字节，
		// 以二进制帧发送，前端以 Uint8Array 写入 xterm.js，中文等多字节字符正确显示。
		ptyProcess.onData((data: string) => {
			if (ws.readyState === 1 /* OPEN */) {
				ws.send(Buffer.from(data, 'utf8'));
			}
		});

		ptyProcess.onExit(({ exitCode }) => {
			console.log(`[Terminal] 终端 ${termId} 退出 (exitCode=${exitCode})`);
			ptyProcesses.delete(termId);
			if (ws.readyState === 1) {
				ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
				ws.close();
			}
		});

		// WebSocket → PTY（输入）
		ws.on('message', (data: Buffer | string) => {
			const msg = data.toString();
			try {
				const parsed = JSON.parse(msg);
				if (parsed.type === 'resize' && ptyProcess) {
					const c = Math.max(1, parsed.cols ?? 80);
					const r = Math.max(1, parsed.rows ?? 24);
					ptyProcess.resize(c, r);
					return;
				}
			} catch { /* 非 JSON → 直接作为输入 */ }
			ptyProcess?.write(msg);
		});

		ws.on('close', () => {
			console.log(`[Terminal] WebSocket 关闭，终止 PTY ${termId}`);
			ptyProcesses.delete(termId);
			try { ptyProcess?.kill(); } catch { /* ignore */ }
		});

		ws.on('error', (err) => {
			console.error(`[Terminal] WebSocket 错误 (${termId}):`, err);
		});
	});

	// ─── 会话 API 历史（in-memory，key: sessionId） ──────────────────────────
	const sessionHistories = new Map<string, MessageParam[]>();

	// ─── 模拟模式辅助函数 ─────────────────────────────────────────────────────

	async function streamMock(sessionId: string, text: string) {
		const delay  = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
		const tokens = text.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[^\u4e00-\u9fa5a-zA-Z0-9]/g) ?? [text];
		for (const token of tokens) {
			await server.sessionManager.emitEvent(sessionId, {
				type: 'assistant_message', sessionId, content: token, isPartial: true,
			});
			await delay(30 + Math.random() * 40);
		}
	}

	function mockReply(userMsg: string): string {
		const replies = [
			`好的，我理解你想要"${userMsg.slice(0, 20)}${userMsg.length > 20 ? '…' : ''}"。\n\n这是一个很好的问题！让我来帮你分析一下：\n\n1. 首先，我们需要明确需求范围\n2. 然后，制定合理的实现方案\n3. 最后，逐步完成并验证结果\n\n请告诉我更多细节，我可以提供更具体的帮助。`,
			`收到！关于"${userMsg.slice(0, 15)}${userMsg.length > 15 ? '…' : ''}"，我有以下建议：\n\n\`\`\`typescript\n// 示例代码\nfunction solution() {\n  // TODO: 根据需求实现\n  return '完成';\n}\n\`\`\`\n\n如需调整，请随时告知。`,
		];
		return replies[Math.floor(Math.random() * replies.length)];
	}

	// ─── 获取 AI Handler（优先运行时配置 → 静态配置 → null） ─────────────────

	// Handler 复用池：按 (uiMode + businessCode + apiUrl) 缓存同一个实例，
	// 避免每次请求都 new 掉跨请求的 prompt 缓存哈希/命中统计。
	const __aiHandlerCache = new Map<string, AiProxyHandler>();

	/**
	 * 活跃 LLM 流注册表：sessionId → 当前正在 createMessage 的 handler。
	 * 用于"思考过程中点取消"立刻 abort fetch，而不是等下一块 chunk 到达才检测。
	 *
	 * 写入：进入 for-await 前 set
	 * 清除：for-await 退出（finally）
	 * 读取：sessionManager.onCancel 注册的全局 hook → 立即调 stopCurrentRequest()
	 */
	const __activeStreamHandlers = new Map<string, AiProxyHandler>();

	// 注册全局取消 hook：用户点 stop 时立刻 abort 当前 active handler 的 fetch
	server.sessionManager.onCancel(async (sessionId: string) => {
		const h = __activeStreamHandlers.get(sessionId);
		if (h) {
			console.log(`[Cancel] 主动 abort session ${sessionId} 的活跃 LLM 流`);
			try { await h.stopCurrentRequest(); } catch (e) {
				console.warn('[Cancel] stopCurrentRequest 失败:', (e as Error).message);
			}
		}
	});
	function getAiHandler(uiMode?: string, sessionModel?: string | null): AiProxyHandler | null {
		const defaultCode = uiMode === 'chat' ? 'IDE_CHAT_ASK' : 'IDE_CHAT_CODE';
		// K-MultiModel：拿 meta —— 用户选了就按 model 查；没选就 fallback 到场景的默认模型
		// （isDefault=1 那行），让 supportsVision 等元数据跟前端 UI 显示的"(默认)" 一致，
		// 避免前端隐藏图片按钮但 sidecar 仍乐观不降级历史图片导致上游 400。
		const meta = sessionModel
			? getSceneModel(defaultCode, sessionModel)
			: getSceneDefaultModel(defaultCode);
		// K-MultiModel：每次取 handler 都打一行——明确告诉日志读者本次会话用哪个模型
		const modelLogPart = sessionModel
			? `model=${sessionModel} (provider=${meta?.provider ?? 'unknown'}, supportsVision=${meta ? !!meta.supportVision : '?'})`
			: `model=(用户未选，默认=${meta?.model ?? 'unknown'}, provider=${meta?.provider ?? 'unknown'}, supportsVision=${meta ? !!meta.supportVision : '?'})`;

		// 1. 运行时动态配置
		const runtimeCfg = server.getAiConfig();
		if (runtimeCfg) {
			const bizCode = (runtimeCfg as any).businessCode ?? defaultCode;
			// K-MultiModel：cache key 加 sessionModel 维度（不同 model 走不同 handler 实例，
			// supportsVision config 不会串）
			const cacheKey = `rt|${runtimeCfg.apiUrl}|${runtimeCfg.username}|${bizCode}|${sessionModel ?? ''}`;
			const cached = __aiHandlerCache.get(cacheKey);
			if (cached) {
				console.log(`[AiHandler] 复用 handler: businessCode=${bizCode}, ${modelLogPart}`);
				return cached;
			}
			const h = new AiProxyHandler({
				apiUrl:            runtimeCfg.apiUrl,
				username:          runtimeCfg.username,
				password:          runtimeCfg.password,
				businessCode:      bizCode,
				flashBusinessCode: (runtimeCfg as any).flashBusinessCode ?? undefined,
				selectedModel:     sessionModel ?? undefined,
				// 默认乐观：清单里没找到 alias 时不主动降级（已知不支持视觉时才降）
				supportsVision:    meta ? !!meta.supportVision : true,
			});
			__aiHandlerCache.set(cacheKey, h);
			console.log(`[AiHandler] 新建 handler: businessCode=${bizCode}, ${modelLogPart}`);
			return h;
		}
		// 2. 启动时静态配置
		if (aiConfig && aiConfig.type === 'proxy') {
			const bizCode = uiMode === 'chat' ? 'IDE_CHAT_ASK' : (aiConfig.businessCode ?? 'IDE_CHAT_CODE');
			const cacheKey = `st|${aiConfig.apiUrl}|${aiConfig.username}|${bizCode}|${sessionModel ?? ''}`;
			const cached = __aiHandlerCache.get(cacheKey);
			if (cached) {
				console.log(`[AiHandler] 复用 handler (static): businessCode=${bizCode}, ${modelLogPart}`);
				return cached;
			}
			const h = new AiProxyHandler({
				apiUrl:            aiConfig.apiUrl,
				username:          aiConfig.username,
				password:          aiConfig.password,
				businessCode:      bizCode,
				flashBusinessCode: aiConfig.flashBusinessCode ?? undefined,
				selectedModel:     sessionModel ?? undefined,
				supportsVision:    meta ? !!meta.supportVision : true,
			});
			__aiHandlerCache.set(cacheKey, h);
			console.log(`[AiHandler] 新建 handler (static): businessCode=${bizCode}, ${modelLogPart}`);
			return h;
		}
		return null;
	}

	// ─── AI 调用日志推送（对标码弦 IDE /ai/call-log） ────────────────────────

	function formatDate(d: Date): string {
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	}

	async function pushAiCallLog(opts: {
		sessionId:      string;
		uiMode:         string;         // 'chat' | 'code'
		userContent:    string;
		responseText:   string;
		inputTokens:    number;
		outputTokens:   number;
		toolCallsCount: number;
		durationMs:     number;
		status:         'success' | 'failed' | 'aborted';
		errorMessage?:  string;
	}): Promise<void> {
		// 只在有代理配置时推送
		const cfg = server.getAiConfig() ?? (aiConfig?.type === 'proxy' ? aiConfig : null);
		if (!cfg || (cfg as any).type !== 'proxy') return;
		const proxyCfg = cfg as { apiUrl: string; username: string; password: string };
		const baseUrl = proxyCfg.apiUrl.replace(/\/+$/, '');
		const logUrl  = `${baseUrl}/ai/call-log`;

		const businessCode = opts.uiMode === 'chat' ? 'IDE_CHAT_ASK' : 'IDE_CHAT_CODE';
		const now = new Date();
		const startTime = new Date(now.getTime() - opts.durationMs);

		const body = {
			traceId:          opts.sessionId,
			userEmail:        proxyCfg.username,
			provider:         'proxy',
			model:            businessCode,
			operation:        opts.uiMode === 'chat' ? 'chat' : 'agent',
			mode:             businessCode,
			inputTokens:      opts.inputTokens,
			outputTokens:     opts.outputTokens,
			inputCost:        null,
			outputCost:       null,
			durationMs:       opts.durationMs,
			firstTokenMs:     null,
			status:           opts.status,
			errorCode:        null,
			errorMessage:     opts.errorMessage ?? null,
			requestSummary:   opts.userContent.slice(0, 200),
			responseSummary:  opts.responseText.slice(0, 200),
			hasTools:         opts.toolCallsCount > 0,
			toolCallsCount:   opts.toolCallsCount,
			clientIp:         null,
			startTime:        formatDate(startTime),
			endTime:          formatDate(now),
		};

		try {
			const res = await fetch(logUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (res.ok) {
				console.log(`[AILog] 日志推送成功 (${businessCode}, ${opts.inputTokens}+${opts.outputTokens} tokens)`);
			} else {
				console.warn(`[AILog] 日志推送失败: ${res.status}`);
			}
		} catch (e) {
			console.warn('[AILog] 日志推送异常:', (e as Error).message);
		}
	}

	// ─── 心跳服务（对标码弦 IDE HeartbeatService） ────────────────────────────
	/**
	 * 每 60 秒 POST 到 {apiUrl}/knowledge/userOnline/heartbeat，
	 * 报告当前客户端的在线状态。
	 * 启动条件：AI 代理配置就绪（登录后）。
	 * 停止条件：进程退出 / 代理配置清除。
	 */
	const HEARTBEAT_INTERVAL_MS = 60 * 1000;
	const HEARTBEAT_APP_VERSION  = '0.1.0';
	const HEARTBEAT_IDE_TYPE     = 'Maxian Desktop';
	const HEARTBEAT_CLIENT_ID    = randomUUID();

	function detectOsType(): string {
		const p = process.platform;
		if (p === 'darwin') return 'macOS';
		if (p === 'win32')  return 'Windows';
		if (p === 'linux')  return 'Linux';
		return p;
	}

	let heartbeatTimer: NodeJS.Timeout | undefined;
	let heartbeatRunning = false;

	/**
	 * 把存储的 username 还原成明文。
	 *
	 * maxian 配置里的 username 是 Base64 编码（chat/completions 接口约定需要 base64
	 * 字段，所以登录后把明文 base64 一次存起来）。但心跳接口 /knowledge/userOnline/heartbeat
	 * 期望明文 username，否则 web 端在线用户面板显示一串 Base64 乱码而不是邮箱/用户名。
	 *
	 * 兼容历史：万一某些情况下 username 不是合法 base64，直接 fallback 原值。
	 */
	function decodeUsernameForHeartbeat(rawUsername: string): string {
		if (!rawUsername) return rawUsername;
		try {
			const decoded = Buffer.from(rawUsername, 'base64').toString('utf8');
			// 防御：base64 解码可能成功但内容不是有效 UTF-8（出现替换字符）→ fallback
			if (!decoded || decoded.includes('�')) return rawUsername;
			// 防御：解码结果再 base64 一次跟原值不匹配，说明原值不是合法 base64 → fallback
			const reEncoded = Buffer.from(decoded, 'utf8').toString('base64');
			if (reEncoded !== rawUsername && reEncoded !== rawUsername + '=' && reEncoded.replace(/=+$/, '') !== rawUsername.replace(/=+$/, '')) {
				return rawUsername;
			}
			return decoded;
		} catch {
			return rawUsername;
		}
	}

	async function sendHeartbeat(): Promise<void> {
		// 优先用运行时配置（登录后动态设置），否则用 CLI 静态配置
		const cfg = server.getAiConfig() ?? (aiConfig?.type === 'proxy' ? aiConfig : null);
		if (!cfg) {
			// 未登录 / 无代理配置：静默跳过
			return;
		}
		const proxyCfg = cfg as { apiUrl: string; username: string; password: string };
		if (!proxyCfg.apiUrl || !proxyCfg.username) return;

		const baseUrl = proxyCfg.apiUrl.replace(/\/+$/, '');
		const url = `${baseUrl}/knowledge/userOnline/heartbeat`;

		// userName 字段后端要明文（web 端在线用户面板直接展示这个值）
		const plainUserName = decodeUsernameForHeartbeat(proxyCfg.username);
		const body = {
			userName:      plainUserName,
			clientId:      HEARTBEAT_CLIENT_ID,
			pluginVersion: HEARTBEAT_APP_VERSION,
			ideType:       HEARTBEAT_IDE_TYPE,
			osType:        detectOsType(),
		};

		try {
			const res = await fetch(url, {
				method:  'POST',
				headers: { 'Content-Type': 'application/json;charset=UTF-8' },
				body:    JSON.stringify(body),
			});
			if (res.ok) {
				console.log(`[Heartbeat] 在线心跳 → ${plainUserName}`);
			} else {
				console.warn(`[Heartbeat] 状态码异常: ${res.status}`);
			}
		} catch (e) {
			console.warn('[Heartbeat] 发送失败:', (e as Error).message);
		}
	}

	function startHeartbeat(): void {
		if (heartbeatRunning) return;
		heartbeatRunning = true;
		// 立即发送一次
		void sendHeartbeat();
		heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
		console.log(`[Heartbeat] 启动（${HEARTBEAT_INTERVAL_MS / 1000}s 间隔, clientId=${HEARTBEAT_CLIENT_ID.slice(0, 8)}…）`);
	}

	function stopHeartbeat(): void {
		if (!heartbeatRunning) return;
		heartbeatRunning = false;
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
		console.log('[Heartbeat] 停止');
	}

	// 监听代理配置变更：配置生效 → 启动；配置清除 → 停止
	server.onAiConfigChanged((cfg) => {
		if (cfg) startHeartbeat();
		else stopHeartbeat();
	});

	// ─── 注册全局辅助（question / plan_exit / task 工具用） ─────────────────
	(globalThis as any).__maxianWaitForQuestion = (sid: string, timeout: number) =>
		server.sessionManager.waitForQuestionAnswer(sid, timeout);
	(globalThis as any).__maxianWaitForPlanExit = (sid: string, timeout: number) =>
		server.sessionManager.waitForPlanExit(sid, timeout);
	// B5: 浏览器桥接控制器（让 browser_* 工具能拿到）
	(globalThis as any).__maxianBrowserController = server.sessionManager.browserController;
	// /compact 命令入口
	(globalThis as any).__maxianForceCompact = async (sid: string) => {
		const session = server.sessionManager.getSession(sid);
		if (!session) throw new Error('session not found');
		const wsPath = server.sessionManager.getWorkspacePath(sid) ?? process.cwd();
		const uiMode = session.uiMode ?? 'code';
		const history = await server.sessionManager.loadHistory(sid);
		const handler = getAiHandler(uiMode, session.model);
		const systemLen = 4000 + (loadProjectInstructions(wsPath).length) + (loadAvailableSkills(wsPath).length);

		// 估算当前 token + 通知前端开始
		const { estimateHistoryTokens, COMPACT_L2_THRESHOLD } = await import('./contextCompaction.js');
		const currentTokens = estimateHistoryTokens(history as any, systemLen);
		await server.sessionManager.emitEvent(sid, {
			type: 'context_compacting',
			sessionId: sid,
			tokensCurrent: currentTokens,
			willLevel2:    currentTokens >= COMPACT_L2_THRESHOLD || !!handler,  // 手动触发默认走 L2
			manual:        true,
		} as any);

		try {
			const report = await forceCompact(history as any, systemLen, handler);
			await server.sessionManager.saveHistory(sid, report.compactedHistory as any);
			await server.sessionManager.emitEvent(sid, {
				type: 'context_compacted',
				sessionId: sid,
				level: report.level,
				tokensBefore: report.tokensBefore,
				tokensAfter:  report.tokensAfter,
				prunedTools:  report.prunedTools,
				summarizedMsgs: report.summarizedMsgs,
				manual: true,
			} as any);
			return {
				level: report.level,
				tokensBefore: report.tokensBefore,
				tokensAfter:  report.tokensAfter,
				prunedTools:  report.prunedTools,
				summarizedMsgs: report.summarizedMsgs,
			};
		} catch (e) {
			// 失败也要通知前端收尾
			await server.sessionManager.emitEvent(sid, {
				type: 'context_compacted',
				sessionId: sid,
				level: 0,
				tokensBefore: currentTokens,
				tokensAfter:  currentTokens,
				prunedTools:  0,
				summarizedMsgs: 0,
				manual: true,
				error: (e as Error).message,
			} as any);
			throw e;
		}
	};

	// ─── 加载用户插件（#11 Plugin 系统） ────────────────────────────────
	const pluginTools = new Map<string, PluginToolDef>();
	const loadedPlugins: LoadedPlugin[] = [];
	try {
		const plugins = await loadAllPlugins();
		for (const p of plugins) {
			if (p.error) {
				console.warn(`[Plugin] 加载 ${p.name} 失败: ${p.error}`);
				continue;
			}
			const hookCount = p.hooks ? Object.keys(p.hooks).length : 0;
			console.log(`[Plugin] 已加载 ${p.name}@${p.version} (${p.tools.length} 工具, ${hookCount} hook)`);
			loadedPlugins.push(p);
			for (const t of p.tools) {
				if (pluginTools.has(t.name)) {
					console.warn(`[Plugin] 工具 ${t.name} 重名，跳过（来自 ${p.name}）`);
					continue;
				}
				pluginTools.set(t.name, t);
				AGENT_TOOL_DEFINITIONS.push({
					name:        t.name,
					description: t.description,
					parameters:  t.parameters,
				});
			}
		}
	} catch (e) {
		console.warn('[Plugin] 插件加载异常:', (e as Error).message);
	}
	(globalThis as any).__maxianPluginTools = pluginTools;
	(globalThis as any).__maxianPlugins    = loadedPlugins;
	(globalThis as any).__maxianTriggerHook = async (event: string, ctx: any) =>
		triggerPluginHook(loadedPlugins, event as any, ctx);

	// 启动时清理一次旧截断文件，之后每 1 小时清理
	try { Truncate.cleanup(); } catch { /* ignore */ }
	setInterval(() => { try { Truncate.cleanup(); } catch { /* ignore */ } }, 3600_000);

	// 启动时若已有静态 aiConfig（CLI/环境变量传入），立即启动
	if (aiConfig && aiConfig.type === 'proxy') {
		startHeartbeat();
	}

	/** Anthropic 直连流式调用（不走代理） */
	async function* callAnthropic(
		messages: MessageParam[],
	): AsyncGenerator<string> {
		if (!aiConfig || aiConfig.type !== 'anthropic') return;
		const cfg = aiConfig;
		const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': cfg.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model:      cfg.model,
				max_tokens: 8192,
				stream:     true,
				system:     '你是码弦 AI 助手，帮助用户完成编程任务。请用中文回复。',
				messages:   messages.map(m => ({
					role:    m.role,
					content: typeof m.content === 'string' ? m.content : m.content,
				})),
			}),
		});

		if (!res.ok) {
			const t = await res.text().catch(() => '');
			throw new Error(`Anthropic API ${res.status}: ${t}`);
		}

		const reader  = res.body!.getReader();
		const decoder = new TextDecoder();
		let buf = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data:')) continue;
				const data = line.slice(5).trim();
				if (data === '[DONE]' || !data) continue;
				try {
					const evt = JSON.parse(data);
					if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
						yield evt.delta.text as string;
					}
				} catch { /* skip */ }
			}
		}
	}

	// ─── Agent 循环 ─────────────────────────────────────────────────────────────

	/**
	 * 完整的 Agent 循环：
	 *   1. 调用 AI（携带工具定义）
	 *   2. 收集文本块 → 实时推送到前端
	 *   3. 收集 tool_use 块（完整的，非 partial）
	 *   4. 无工具调用 → 结束
	 *   5. 有工具调用 → 执行工具，将结果追加到历史，继续循环
	 */
	// ── AGENTS.md / CLAUDE.md 自动加载（向上找 + 全局路径） ─────────────
	/**
	 * 生成当前平台信息注入到系统提示词。
	 * 让 AI 生成 shell 命令时避开平台不兼容的调用（ls vs dir, && 语法等）。
	 * Windows 下如果探测到 Git Bash，会告诉 AI 可以用 unix 语法；否则提示只能用 cmd/PowerShell。
	 */
	function formatPlatformInfo(): string {
		const plat = process.platform;
		let osLabel: string;
		let shellHint: string;
		if (plat === 'darwin') {
			osLabel = 'macOS';
			shellHint = '默认 shell: zsh / bash，支持标准 Unix 命令（ls/grep/cat/find/sed 等）和 && 链式';
		} else if (plat === 'linux') {
			osLabel = 'Linux';
			shellHint = '默认 shell: bash，支持标准 Unix 命令和 && 链式';
		} else if (plat === 'win32') {
			// 检测是否装有 Git Bash（与工具执行端的探测逻辑保持一致）
			const gitBashPaths = [
				'C:\\Program Files\\Git\\bin\\bash.exe',
				'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
			];
			const hasGitBash = gitBashPaths.some(p => { try { return fs.existsSync(p); } catch { return false; } });
			osLabel = 'Windows';
			shellHint = hasGitBash
				? '检测到 Git Bash，execute_command / bash 工具已**自动路由到 bash**，可直接使用 Unix 命令（ls/cat/grep/&& 等）。路径分隔符用正斜杠或反斜杠均可。'
				: '**未检测到 Git Bash**，execute_command 将退回 PowerShell / cmd.exe 执行。请优先使用**PowerShell 语法**（Get-ChildItem、Get-Content、`;` 分隔命令代替 `&&`），避免 `ls/cat/grep/rm -rf` 等 Unix 命令。';
		} else {
			osLabel = plat;
			shellHint = '未知平台';
		}
		return `操作系统：${osLabel}\n${shellHint}`;
	}

	function loadProjectInstructions(workspacePath: string): string {
		const candidates: string[] = [];
		const targets = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

		// 项目：从 workspacePath 向上找
		let dir = workspacePath;
		const seen = new Set<string>();
		while (dir && dir !== '/' && !seen.has(dir)) {
			seen.add(dir);
			for (const t of targets) {
				const p = path.join(dir, t);
				if (fs.existsSync(p)) candidates.push(p);
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		// 全局：~/.maxian/AGENTS.md 或 ~/.claude/CLAUDE.md
		const globalPaths = [
			path.join(os.homedir(), '.maxian', 'AGENTS.md'),
			path.join(os.homedir(), '.claude', 'CLAUDE.md'),
			path.join(os.homedir(), '.claude', 'AGENTS.md'),
		];
		for (const p of globalPaths) {
			if (fs.existsSync(p)) candidates.push(p);
		}

		if (candidates.length === 0) return '';
		const parts: string[] = [];
		const addedFiles = new Set<string>();
		for (const p of candidates) {
			if (addedFiles.has(p)) continue;
			addedFiles.add(p);
			try {
				const content = fs.readFileSync(p, 'utf8');
				if (content.trim().length === 0) continue;
				parts.push(`<!-- 来自 ${p} -->\n${content.trim()}`);
			} catch { /* ignore */ }
		}
		if (parts.length === 0) return '';
		return '\n\n====\n\nPROJECT INSTRUCTIONS（项目约束，优先级高于默认提示）\n\n' + parts.join('\n\n---\n\n');
	}

	// ── Skills 列表预注入（支持目录型 <name>/SKILL.md 和平铺 <name>.md） ──
	function loadAvailableSkills(workspacePath: string): string {
		const dirs = [
			{ path: path.join(workspacePath, '.maxian', 'skills'), source: '项目 .maxian' },
			{ path: path.join(workspacePath, '.claude', 'skills'), source: '项目 .claude' },
			{ path: path.join(os.homedir(), '.maxian', 'skills'), source: '用户 ~/.maxian' },
			{ path: path.join(os.homedir(), '.claude', 'skills'), source: '用户 ~/.claude' },
		];

		interface Skill { name: string; description: string; source: string }
		const seen = new Set<string>();
		const skills: Skill[] = [];

		const scanSkillEntries = (dir: string, allowRecurse: boolean = true): Array<{ name: string; abs: string }> => {
			const out: Array<{ name: string; abs: string }> = [];
			if (!fs.existsSync(dir)) return out;
			let entries: string[];
			try { entries = fs.readdirSync(dir); } catch { return out; }
			for (const entry of entries) {
				if (entry.startsWith('.')) continue;  // K11d：跳过 .maxian-bundled-installed-vN 等标志位
				const absEntry = path.join(dir, entry);
				let stat: fs.Stats;
				try { stat = fs.statSync(absEntry); } catch { continue; }  // statSync 跟随符号链接
				if (stat.isFile() && entry.endsWith('.md')) {
					out.push({ name: entry.slice(0, -3), abs: absEntry });
				} else if (stat.isDirectory()) {
					let matched = false;
					for (const c of ['SKILL.md', 'skill.md', 'README.md']) {
						const abs = path.join(absEntry, c);
						if (fs.existsSync(abs)) { out.push({ name: entry, abs }); matched = true; break; }
					}
					// K11d：分类目录（如 maxian-builtin/）递归一层把里面的 .md 当 skill
					if (!matched && allowRecurse) {
						const inner = scanSkillEntries(absEntry, false);
						for (const it of inner) out.push(it);
					}
				}
			}
			return out;
		};

		for (const { path: dir, source } of dirs) {
			for (const { name, abs } of scanSkillEntries(dir)) {
				if (seen.has(name)) continue;
				seen.add(name);
				let description = '';
				let finalName = name;
				try {
					const raw = fs.readFileSync(abs, 'utf8');
					if (raw.startsWith('---\n')) {
						const end = raw.indexOf('\n---\n', 4);
						if (end > 0) {
							const fm = raw.slice(4, end);
							const dm = fm.match(/^description:\s*(.+)$/m);
							const nm = fm.match(/^name:\s*(.+)$/m);
							if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
							if (nm) finalName = nm[1].trim().replace(/^["']|["']$/g, '');
						}
					}
					if (!description) {
						const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
						const firstLine = body.split('\n').find(l => l.trim() && !l.startsWith('#'));
						if (firstLine) description = firstLine.trim().slice(0, 120);
					}
				} catch { /* ignore */ }
				skills.push({ name: finalName, description, source });
			}
		}

		if (skills.length === 0) return '';
		const lines = skills.map(s => `- **${s.name}** (${s.source}): ${s.description || '无描述'}`).join('\n');
		return `\n\n====\n\nAVAILABLE SKILLS（可用技能 — 行动前必须先对照）\n\n下面每条是一个可用 \`load_skill\` 加载的专业技能，名称后**括号里是来源、冒号后是它的适用场景**：\n\n${lines}\n\n**强制纪律（通用，不针对某个具体技能）**：\n- **任何任务动手前，先扫一遍上面这张表**。只要某条技能的「适用场景」跟当前任务沾边（哪怕只有几分可能），就**先 \`load_skill\` 加载它、按它的方法论去做**，再开始写代码 / 调用其他工具 / 输出计划。\n- "怎么做"类任务尤其要先查表，例如：需求模糊待澄清、排查 bug、写测试、做实施计划、代码审查、分支收尾——**别凭直觉硬上**，这些通常都有对应技能。\n- 一个任务可能先后用到多个技能（如先澄清需求 → 再做计划 → 最后验证），按需逐个加载。\n- ⚠️ 判断"该不该加载"**完全依据每条自己的「适用场景」描述**——这条规则对**以后新增的任何技能同样生效**，无需在别处逐一点名。拿不准就 load 一下看看，加载是廉价的。`;
	}

	// ═════════════════════════════════════════════════════════════════════
	// E. Prompt 静态/动态分离：让 Anthropic prompt caching & DashScope 前缀缓存命中
	// ═════════════════════════════════════════════════════════════════════

	/** 静态 prompt 段（只依赖 mode，哈希稳定，可被 LLM 缓存）*/
	// 共享尾部语言提醒：长 prompt + 大量英文工具结果会让模型遗忘开头语言锚，
	// 在每个静态 prompt 末尾再次强约束（参考 SystemPromptGenerator.generateLeanPrompt 的设计）。
	const LANG_TAIL_REMINDER = `\n\n====\n\n⚠️ 输出语言收尾强约束（绝对不可违反）\n\n- 所有自然语言输出（说明、分析、思考、reasoning_content、总结、错误解释、追问）必须使用简体中文\n- 严禁输出任何英文句子或英文段落，包括思考阶段（reasoning_content）\n- 工具结果中如果是英文代码 / 英文 stderr / 英文路径，**保留原文不翻译**，但你对它的解读必须用中文\n- 即便用户是用英文提问，你也必须用简体中文回答`;

	const STATIC_PROMPT_EXPLORE = `【语言】简体中文输出。代码/路径/标识符保持原文。

你是码弦代码探索专家，专门高效导航和搜索代码库。

## 你的能力
- 用 glob/search_files 快速按模式匹配文件
- 用 grep 用正则搜索文件内容
- 用 read_file 读取并分析文件内容

## 执行原则
- 用 glob 做宽泛文件模式匹配
- 用 grep 带正则的内容搜索
- 用 read_file 明确已知路径时直接读
- 返回**绝对路径**，结论要清晰简洁
- **禁止任何文件修改**（只读 agent）
- 完成后简短总结发现`;

	const STATIC_PROMPT_PLAN = `【语言规定】你只能用简体中文输出自然语言。所有说明、分析、总结、错误提示必须是简体中文。代码/命令/路径/标识符保持原文。

你是码弦 AI 计划助手（Plan 模式），**只输出实现计划，不执行任何文件操作**。

====

PLAN MODE RULES

1. **只规划，不执行**：严禁调用任何文件写入工具（write_to_file、edit、multiedit）
2. 可以使用只读工具（read_file、search_files、list_files）了解代码结构
3. 输出一个结构化的 Markdown 实现计划：
   - 背景分析（要解决的问题）
   - 文件变更清单（哪些文件需要改、改什么）
   - 分步实现步骤（编号列表，每步一句话）
   - 潜在风险和注意事项
4. 计划完成后，用户可点击"开始执行"切换到 Code 模式实际执行

只读工具：read_file, search_files, list_files`;

	const STATIC_PROMPT_CHAT = `【语言规定】你只能用简体中文输出自然语言。所有说明、分析、总结、错误提示必须是简体中文。代码/命令/路径/标识符保持原文。

你是码弦 AI 助手，负责回答编程相关问题、解释概念、进行代码审查。

====

WORKING CONTRACT

- 完成用户目标第一优先；最少探索后执行修改
- **【强制】输出语言：简体中文。任何英文自然语言句子一律违规**
- 代码、命令、路径、API字段名、标识符保持原文，不翻译
- Markdown 简洁：短列表 + 代码块
- 每轮自然语言 ≤ 200 字，代码只出现在工具参数里

====

OBJECTIVE

你是一个问答助手，以对话方式帮助用户：
- 解释代码逻辑、架构设计、技术概念
- 回答编程问题，提供示例代码（在聊天中展示，不操作文件）
- 代码审查、错误分析、性能建议

====

FOLLOWUP SUGGESTIONS（可选）

在完整回答结束后，如果有自然的追问方向，可在**最末尾**输出最多 3 条简短追问建议：
\`\`\`
<<<FOLLOWUP>>>
- 追问 1
- 追问 2
- 追问 3
\`\`\`
该区块会被前端自动抽取并显示为"建议追问"按钮。如果回答已经完整、无需追问，不要输出此区块。`;

	const STATIC_PROMPT_CODE = `【语言规定】你只能用简体中文输出自然语言。所有说明、分析、总结、错误提示必须是简体中文。代码/命令/路径/标识符保持原文。

你是码弦 AI 编程助手（agent 模式），可以直接操作文件系统完成编程任务。

====

WORKING CONTRACT

- 完成用户目标第一优先；最少探索后执行修改
- **【强制】输出语言：简体中文。任何英文自然语言句子一律违规**
- 代码、命令、路径、API字段名、标识符保持原文，不翻译
- Markdown 简洁：短列表 + 代码块
- 每轮自然语言 ≤ 200 字，代码只出现在工具参数里

====

HARD RULES

1. **【语言】所有自然语言必须是简体中文**——思考过程、分析、说明、总结、错误解释——英文句子即为违规
2. **先读后改**：任何 edit/write_to_file 前必须先 read_file 完整读过；未读直接失败
3. **🔥 修改已存在文件一律用 edit / multiedit**，**严禁** write_to_file 整体覆盖：
   - write_to_file 仅用于**新建文件**，或用户**明确要求"整体重写"**
   - 即使你自认为要大改，也**必须分段用 edit**——因为整体覆盖会把用户在外部（其他 IDE）或同会话前几轮的手改全删掉
   - 系统会对"write_to_file 删除远多于新增"的调用自动拦截
4. **并行只读**：需要读多个无依赖文件时，**必须在同一轮同时调用**，禁止逐个顺序读取
5. **工具失败后**：禁止立即用相同参数重试；下一步必须是 read_file 或 search_files 验证当前真实状态
6. **编译/类型错误**：先 read_file 错误行 ±5 行，不要只看错误消息就改
7. **禁止废话**：不要复述将要写的代码，不要以问题结尾
8. **🔥 todo 收尾强制**：准备结束本轮、**不再调用任何工具**（停止调用工具即视为任务完成）之前，必须先用一次 todo_write 把所有 todo 项目处理完毕：
   - 真做完了的 → status = "completed"
   - 决定不做（用户没要求/不必要/超出范围）→ **从 todo 列表中移除该项**：todo_write 是全量替换，下次不包含它即可。⚠️ status 只有 \`pending\` / \`in_progress\` / \`completed\` 三个合法值，**没有 cancelled**，写 "cancelled" 会被直接拒绝、本轮工具失败
   - **不允许**留任何 in_progress 或 pending 的项目就停止调用工具、结束本轮
   - 否则前端会显示 "X/Y（AI 提前结束，N 项未完成）"，用户视为任务失败
   - **🔥 执行纪律（防空转 / 防反复规划）**：3 步以上任务只需 todo_write 规划**一次**，之后**严禁反复"重新了解项目 / 重新规划"**；严格按清单顺序逐项推进——开始某项**前**先 todo_write 标它 in_progress（同时只能 1 个 in_progress），做完**立刻**标 completed 再开下一项；每轮系统会在 \`<current_todos>\` 里给你实时进度，以它为准照着往下做；**禁止连续多轮只 read_file/list_files 探索而不 edit/write**——缺什么读什么，读完立即动手改

9. **🔥 完成前必须验证（Verify-before-done）**：声明任务"完成 / 修好 / done / 实现完毕"之前，必须满足以下至少一项作为客观证据：
   - **a) PostToolUse hook 全过**：edit/write 后 .maxian/config.json 配置的 hook（如 tsc --noEmit）退出码 0
   - **b) 显式跑过验证命令**：最近 1 轮内有 bash 或 execute_command 工具调用，结果显示 PASS（typecheck/build/test/lint 任一通过）
   - **c) 任务范围内 todos 全 completed**（决定不做的项已从列表移除；且任务不涉及代码运行验证）
   - 都不满足 → **不要**说"完成了"，要么自己跑验证，要么明确告知用户"已写完未验证，建议你跑一次 X"
   - 严禁"我已经修好了"+ 实际没跑过 build/test 这种假完成

10. **🔥 负面断言先验证**：在说"X 不存在 / 没有这个文件 / 找不到这个函数 / 没有定义 / 项目里没有"之前，**必须先用 search_files（regex）或 glob 或 list_files 实际查过**；严禁凭记忆或猜测下负面结论。未经验证的负面断言是严重错误——会误导用户、导致重复造轮子。验证后再下结论。

11. **意图门槛（先判断要不要动文件）**：
   - 用户只是**分析 / 解释 / 审查 / 提问 / 对比**（如"看看""分析下""为什么""是不是""怎么处理""讲讲"）→ **默认只读、不编辑任何文件**，给出结论即可
   - 只有用户**明确要求修改 / 实现 / 修复 / 新增 / 重构**时，才编辑文件
   - 拿不准是"问"还是"做"时，先用一句话确认意图，**不要擅自改代码**

====

TOOL SELECTION

按目标直接选工具，不要犹豫：

| 我想... | 用这个工具 |
|---|---|
| 找"某个字符串/符号/函数名"在哪 | search_files（regex） |
| 看一个已知路径文件 | read_file |
| 浏览一个目录结构 | list_files |
| **改已存在文件的局部** | **edit**（一处）/ **multiedit**（多处） |
| 创建**新文件** | write_to_file |
| 执行命令/测试/构建 | execute_command |

**⚠️ write_to_file 使用禁区**（违反会被系统拦截并报错）：
- 目标文件**已存在** → 必须改用 edit / multiedit
- 你没 read_file 就想 write_to_file 覆盖 → 拦截
- 新内容删除行数远大于新增 → 拦截（防止覆盖用户/他人手改）

**标准编辑作业流（照此节奏走，不要跳步）**：
1. read_file 完整读目标文件；需要读多个**无依赖**文件 → **同一轮并行**调用 read_file
2. edit / multiedit：old_string 从刚 read 到的内容**逐字节复制**（含空白/缩进/换行），取最小唯一上下文（通常 2-4 行）；多处匹配就扩上下文或设 replace_all=true
3. 改完若 .maxian 配了 hook 或有可跑的验证命令 → execute_command 跑一次 tsc/build/test 确认通过
4. edit 报 "not found" 或 "多处匹配" → **绝不原样重试**：先 read_file 看当前真实内容，再据此调整 old_string 或设 replace_all=true 后重试

====

PLAN-FIRST 强制清单（满足任一项 → 必须先调 plan_exit 输出计划等用户确认 → 再开始 edit）
（注意：进入本清单前，先按上面 AVAILABLE SKILLS 的纪律对照技能列表 —— 需求不清就先用对应技能澄清，需求清楚了才来做计划）

1. **新增功能** —— "实现/添加 X 功能"、"做一个 X 模块"、"加上 X"
2. **跨多文件修改** —— 预估要改 ≥ 3 个文件
3. **重构** —— "整理/拆分/重构 X"
4. **修一类 bug** —— 排查"这种问题/这类错误"（vs 修单个具体行号）
5. **架构/数据流变化** —— 改接口签名、数据库 schema、新增 service / store
6. **不确定方案** —— 用户描述模糊或需要在两条路径里选

====

🚨 反"自言自语"硬性禁令（违反 = 任务直接失败）

**症状**：你只动嘴不动手，把"我即将调用 X 工具"当成对工具的调用。
DeepSeek / Qwen 等模型容易犯这个错——你必须自查。

**绝对禁止**（写出任何一条都视为本轮失败）：

1. ❌ "我需要使用 plan_exit 工具" / "让我调用 plan_exit" / "我用 plan_exit 来..."
   ✅ 对应的工具就在你手里，**直接发起 function_call**，**不要描述它**

2. ❌ "让我先 load_skill brainstorming" / "我应该加载 X 技能"
   ✅ 直接调用 load_skill 工具，参数 skill_name="brainstorming"

3. ❌ 在 chat 里输出 markdown 计划结构（"## 步骤 1" / "### 文件清单" / "## 风险"）
   ✅ 把这些**全部塞进 plan_exit 工具的 steps 参数**。chat 只能写一句"已生成计划，等待你确认"

4. ❌ 用纯文本向用户提问（"你想要 A 还是 B？"、"技术栈你有偏好吗？"）
   ✅ 调 question 工具，参数 question="..."，options=["A", "B"]

5. ❌ "我应该先做一些探索性的询问吗？" / "让我思考一下..." 这种 narrate 思维过程
   ✅ 思考是 reasoning_content 字段做的事，不要把思考写进 content

**判定规则**：
- 如果你在 content 里出现"我要 / 让我 / 我应该 / 我会 / 我需要" + 工具名 → **就是违规**
- 如果你输出了 ≥ 50 字的 markdown 结构（标题/列表/表格）但**本轮没调任何工具** → **就是违规**
- 违规后果：用户看到一堆描述但没有对话框/没有按钮，任务卡死

**正确节奏**：
- 思考 → reasoning_content（自动折叠，用户看不到）
- 行动 → 直接发 function_call
- 结果 → 等工具返回再继续

**反例 vs 正例**：

❌ 错误（DeepSeek 常见错法）：
   content 写满"我需要使用 plan_exit 工具输出计划。计划如下：## 步骤 1：建表 ## 步骤 2：写接口 你看可以吗？"
   → 没发任何 function_call → 用户看到一段死文本 → 任务卡死

✅ 正确：
   立刻发起 function_call: plan_exit(summary="考试系统脚手架", steps="## 步骤 1：建表 ## 步骤 2：写接口...")
   content 字段：可以为空，或最多一句"已生成计划，请在弹窗中确认。"
   → 用户立刻看到对话框，能点"开始执行"

**MEGA-TASK 强制拆分（识别任务形态 → 选对拆分模式）**

直接在主上下文硬刚大任务会爆 token + 撑爆 UI 内存。先识别任务形态再用对应模式：

**形态 A：N 个相似独立单元（fan-out 模式）**

特征：≥ 10 个相似且彼此独立的活儿（10+ 表的 CRUD 生成、10+ endpoint 改、10+ 组件迁移）

做法：plan_exit → 主 agent 用 task() 按批 dispatch 子 agent，每批 5-10 并行；每个 subagent 收一个聚焦小任务 + 输出 200 字摘要回主 agent。

**形态 B：1 个大单元 + N 个依赖（gather-summarize 模式）**

特征：要处理一个大文件（如 2000 行存储过程 / 1500 行 monolith service）但需要参考 N 个外部依赖（表 schema / API 文档 / 配置）。

❌ 错误做法：主 agent 自己一个个 read 所有依赖 → 100 张表 full schema = 125K token 噪声 + UI OOM。

✅ 正确做法：
1. plan_exit 阶段先声明：会用 1 个 explore subagent 收敛依赖
2. 主 agent **完整读**那个大单元（必须的，无法省）
3. 主 agent 调 1 次 task(subagent_type='explore', prompt='...'):
   - 任务：读取 N 个依赖，**只提取实际被大单元引用的字段/方法**
   - 输出格式：紧凑 JSON 或表格，每个依赖 ≤ 200 字
   - 例：100 张表 → 每张只列被 SP 引用的 3-5 列，完整摘要 5-10K token（vs 全读 125K token）
4. 主 agent 拿到精炼摘要（5-10K token）→ 开始写代码

**形态 C：超长源文件重构（chunk-then-stitch 模式）**

特征：单源文件 ≥ 1500 行需要全重构。

做法：plan_exit 先按职责切段（如"L1-300 配置加载 / L301-800 数据获取 / L801-1500 计算 / L1501-2000 输出"）→ 用户确认 → 每段一次 multiedit，避免一次性 multiedit 整个文件参数过大。

**反面教训**：直接 "读 100 张表 + 写 N 个文件" 在主上下文一锅炖 → 上下文 150K+ token + UI OOM + token 成本 10 倍。识别形态再选模式 = 关键。

**反例**（不必 plan，直接动手）：
- 单文件单点修改（"把 foo.ts 第 23 行改成 X"）
- 改注释 / 改文案 / 改格式
- 用户已经明确给了实现方案

**plan_exit 输出格式**：
- 背景：要解决什么问题
- 文件清单：要改/新建哪些文件，各自改什么
- 分步骤：编号列表，每步一句话
- 风险点：可能踩的坑

**并行工具规则（减少 API 往返）**：
1. 改文件前**必须**先 read_file 完整读一次
2. **多个只读操作必须在同一轮并行发起**（上限 4 个）——5 个文件应 1 轮读完，而非 5 轮
3. write_to_file/edit 类工具 error 后，**禁止立即用相同参数重试**——先 read_file 确认当前内容
4. **严禁把代码直接输出到聊天框**——所有代码必须通过工具写入文件

====

OBJECTIVE

你是一个 agent — 持续工作直到任务**完全解决**。能用工具解决的不要回答文字。

## 执行流程

1. **探索**：必要时先 list_files / read_file 了解结构
2. **执行**：直接调用工具完成文件操作，不要把代码贴在聊天里
3. **验证**：必要时 execute_command 验证
4. **完成**：简要总结做了什么（≤ 100 字中文）

## 关键原则

- 用户说"创建/设计/写一个 xxx 文件" → **必须调用 write_to_file**，不能把代码贴在聊天框
- 用户说"修改/更新 xxx" → 先 read_file，再 edit
- 任何文件操作都通过工具，**绝不在回复文本里输出完整代码**`;

	function getStaticPromptByMode(mode: string): string {
		// 所有模式末尾都附加语言尾部提醒（避免长上下文 + 大量英文工具结果稀释开头锚定）
		if (mode === 'explore') return STATIC_PROMPT_EXPLORE + LANG_TAIL_REMINDER;
		if (mode === 'plan')    return STATIC_PROMPT_PLAN    + LANG_TAIL_REMINDER;
		if (mode === 'ask' || mode === 'chat') return STATIC_PROMPT_CHAT + LANG_TAIL_REMINDER;
		return STATIC_PROMPT_CODE + LANG_TAIL_REMINDER;  // 'code' 和其他默认
	}

	/**
	 * 动态 prompt 段：workspace / platform / project instructions / skills / 自定义
	 * 每次都会变，放在静态段后面，不进缓存。
	 */
	function composeDynamicSuffix(workspacePath: string, projectAndSkills: string): string {
		const systemInfo = `\n\n====\n\nSYSTEM INFO\n\n工作区根目录：${workspacePath}\n${formatPlatformInfo()}`;
		return systemInfo + projectAndSkills;
	}

	async function runAgentLoop(
		sessionId:     string,
		userContent:   string,
		history:       MessageParam[],
		workspacePath: string,
		mode:          string = 'code',
		uiMode:        string = 'code',
	): Promise<string> {
		// 迭代预算：per-todo 滚动续期（参照 jiusi）——不再固定次数。
		// 只要在"完成 todo"就把预算续命；一直空转不推进就早停。比固定 30 更适配任务规模。
		const GRACE_BUDGET   = 60;    // 没完成任何 todo 前的初始预算（够探索 + 规划）
		const PER_TODO_QUOTA = 30;    // 每完成一项 todo，从当前轮起再续 30 轮
		const HARD_CAP       = 400;   // 绝对上限，防真死循环（上下文也会先爆）
		let   budgetCeiling      = GRACE_BUDGET;
		let   lastCompletedCount = 0;
		// 每轮迭代调用：看自上轮以来是否多完成了 todo，有就把预算滚动延长到 iter + PER_TODO_QUOTA
		const rollBudget = (currentIter: number): number => {
			try {
				const completed = getTodoWriteList(sessionId).filter(t => t.status === 'completed').length;
				if (completed > lastCompletedCount) {
					budgetCeiling = Math.max(budgetCeiling, currentIter + PER_TODO_QUOTA);
					console.log(`[Agent] todo 已完成 ${completed} 项，迭代预算续期至 iter=${budgetCeiling}`);
					lastCompletedCount = completed;
				}
			} catch { /* 读不到 todo 就维持当前预算 */ }
			return Math.min(HARD_CAP, budgetCeiling);
		};
		let MAX_ITERATIONS = GRACE_BUDGET;   // 兼容日志/UI 提示，循环条件里每轮由 rollBudget 刷新
		// 清掉上次遗留的取消标记（这次是新任务启动，不该继承上次的 cancel 状态）
		server.sessionManager.resetCancelled(sessionId);
		const ctx            = new NodeToolContext(workspacePath, sessionId);
		// K8d 收尾：注入平台能力容器（NodeTerminal / NodeFileSystem / IWorkspace 等）。
		// bashTool / executeCommandTool 等通过 ctx.platform.terminal / .fs 访问宿主能力，
		// 不再直接 import 'node:child_process' / 'node:fs'。
		ctx.platform             = platform.toolPlatform;
		// B2: 注入 MCP Hub + 每会话独立的激活集 / sticky / lastUsed map
		ctx.mcpHub               = server.sessionManager.mcpHub;
		ctx.activeMcpTools       = new Set<string>();
		ctx.stickyMcpTools       = new Set<string>();
		ctx.mcpToolLastUsedTurn  = new Map<string, number>();
		ctx.currentTurn          = 0;
		// B3: 注入跨会话记忆 Store + 当前 workspaceId
		// 用 workspacePath 作为 workspaceId 标识符（memory store 内部按字符串匹配过滤）。
		ctx.memoryStore          = server.sessionManager.memoryStore;
		ctx.currentWorkspaceId   = workspacePath;
		// B4: 注入代码库索引
		ctx.codebaseIndex        = server.sessionManager.codebaseIndex;
		// K-RepoMap：检查 codebase index 是否需要后台重建（>24h 或不存在 → 异步触发）
		// 不 await，不阻塞主对话。本轮仍用旧 snapshot 生成 digest，下轮可见新 snapshot。
		void server.sessionManager.ensureCodebaseIndex(ctx.currentWorkspaceId, workspacePath);
		// Doom-loop 检测器（每次 runAgentLoop 独立实例）
		const repetitionDetector = new ToolRepetitionDetector(3, workspacePath);
		let   allText        = '';   // 所有迭代累积文本（用于兜底 return）
		// 日志统计
		let   totalInputTokens  = 0;
		let   totalOutputTokens = 0;
		let   totalToolCalls    = 0;
		const loopStartTime     = Date.now();
		let   finalText      = '';   // 最终迭代文本（无工具调用时）

		// ── 防提前退出 / 任务清单一致性（参照 jiusi）──────────────────────
		// LLM 没调工具就结束时，若 todo 还有 in_progress/pending → 自动注入"继续"指令再跑，
		// 避免"AI 提前结束、N 项未收尾"。带次数上限 + 漂移检测防死循环。
		const MAX_AUTO_CONTINUE  = 4;    // 自动续跑最多次数
		let   autoContinueCount  = 0;
		const NO_TOOL_DRIFT_LIMIT = 2;   // 连续 N 轮纯文本无工具调用 → 判定漂移，停止续跑
		let   consecutiveNoToolText = 0;
		// 空转打断：连续 N 轮只读探索（无 edit/write/todo_write）→ 注入催促，逼它动手
		const EXPLORE_DRIFT_LIMIT = 3;
		let   consecutiveExploreOnly = 0;

		// ── 根据模式构建系统提示词 & 工具列表 ──────────────────────────────────
		// E. Prompt 静态/动态分离：
		//   - getStaticPromptByMode(mode) 只依赖 mode，每次调用**哈希一致** → 可被 LLM 后端缓存
		//   - 运行时把 workspace / platform / project 等动态信息**附加到末尾**
		//   - 这样 Anthropic 的 prompt caching 能打静态段的缓存
		//     DashScope/Qwen 的隐式前缀缓存也能命中（前 N 字节不变）
		const isChatMode    = (mode === 'ask' || mode === 'chat');
		const isPlanMode    = (mode === 'plan');
		const isExploreMode = (mode === 'explore');


		// ─── 真正用的 system prompt：静态段（可缓存）+ 动态段（每次会变） ───
		const staticPrompt = getStaticPromptByMode(mode);

		// 动态段按项目路径读取（AGENTS.md / CLAUDE.md / 项目 config / skills 列表）
		const projectInstructions = loadProjectInstructions(workspacePath);
		const skillsList = loadAvailableSkills(workspacePath);
		const projectCfg = loadProjectConfig(workspacePath);
		const additionalSystemPrompt = projectCfg.additionalSystemPrompt
			? `\n\n====\n\nPROJECT CUSTOM PROMPT（.maxian/config.json）\n\n${projectCfg.additionalSystemPrompt}`
			: '';

		// K-RepoMap (v0.2.24, from jiusi 0.6.3)：把项目结构概览注入 system prompt 尾部，
		// 让 AI 首轮就知道项目骨架，不用 grep / glob 摸瞎。
		// 放在 dynamic 段最后是有意：
		//   ① digest 会随项目文件 mtime 变，放最前会让上游 cache 命中失效；
		//   ② 放最后只让自己不命中，静态层仍命中。
		// digest 内部已经过滤了所有时间戳字段（避免 cache 99% → 0%）。
		// 若 snapshot 不存在或异常 → 返回空串，不影响主流程。
		let repoMapDigest = '';
		try {
			const t0 = Date.now();
			repoMapDigest = await buildRepoMapDigest(ctx.codebaseIndex, ctx.currentWorkspaceId);
			if (repoMapDigest.length > 0) {
				console.log(`[repo-map] digest 长度=${repoMapDigest.length} chars (${Date.now() - t0}ms)`);
			}
		} catch (e) {
			console.warn('[repo-map] digest 生成失败，跳过:', (e as Error).message);
		}

		const dynamicSuffix = composeDynamicSuffix(
			workspacePath,
			projectInstructions + skillsList + additionalSystemPrompt + repoMapDigest,
		);

		// B2: 把当前 MCP server 列表 + activeMcpTools 渲染成 prompt section，加到动态尾部
		// （静态段保持哈希稳定可缓存，动态段每轮可变）
		const buildMcpSuffix = (): string => {
			const hub = ctx.mcpHub;
			if (!hub) return '';
			const servers = hub.getAllServers().filter(s => s.isConnected);
			if (servers.length === 0) return ''; // 没挂任何 MCP server → 不输出本节
			const activeIds = ctx.activeMcpTools ? [...ctx.activeMcpTools] : [];
			const activeEntries = activeIds
				.map(id => hub.toolIndex.getByToolId(id))
				.filter((e): e is NonNullable<typeof e> => !!e);
			const lines: string[] = [
				'',
				'====',
				'',
				'MCP TOOLS',
				'',
				'系统已挂载若干 MCP 服务器，但工具描述不直接写进 system prompt（避免 context 膨胀）。',
				'要使用任意 MCP 工具，按以下流程：',
				'',
				'1. 调 `mcp_tool_search` 查询相关工具（自然语言 query）',
				'2. 收到候选后挑 1-3 个调 `mcp_tool_load` 加入激活集',
				'3. 下一轮 LLM 调用时这些工具会被作为可用工具暴露，可直接 XML 调用',
				'4. 用完可以 `mcp_tool_unload` 释放（一般不必，最近 8 轮未用会自动卸载）',
				'',
				'已连接的 MCP 服务器：',
			];
			for (const s of servers) {
				const desc = s.config.description ? `（${s.config.description}）` : '';
				lines.push(`- **${s.config.name}** ${desc}: ${s.tools.length} 个工具`);
			}
			if (activeEntries.length > 0) {
				lines.push('');
				lines.push('### 当前已激活工具');
				lines.push('');
				lines.push('以下工具已被 mcp_tool_load 激活，可直接 XML 调用（详细参数 schema 见上方 tool definitions）：');
				lines.push('');
				for (const e of activeEntries) {
					lines.push(`- **${e.toolId}** (server: ${e.serverName}): ${e.description.slice(0, 200)}`);
				}
			}
			return lines.join('\n');
		};

		// 最终 system prompt：静态在前（哈希稳定、可缓存），动态在后（每会话不同）
		// 注意：MCP suffix 也是动态的（用户可能动态 load/unload），所以拼在 dynamicSuffix 后面
		// 但注意它在 finalSystemPrompt 的位置 → 每轮都重算（在 for 循环内动态生成）
		const finalSystemPromptBase = staticPrompt + dynamicSuffix;

		// ── 防 doom-loop：每轮把"当前 todo 清单 + 进度"注入 system prompt ──────
		// 长会话历史被压缩后，AI 会忘记自己已规划、在做哪步 → 反复"了解现状/重新规划"空转。
		// 每轮刷新清单让 AI 始终看得见进度，并强制 todo 工作流纪律。仅 code 模式注入。
		const buildTodoReminderSuffix = (): string => {
			if (isChatMode || isExploreMode || isPlanMode) return '';
			const todos = getTodoWriteList(sessionId);
			if (todos.length === 0) return '';
			const done = todos.filter(t => t.status === 'completed').length;
			const lines = todos.map((t, i) => {
				const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⏳';
				return `  ${i + 1}. ${icon} ${t.content}`;
			}).join('\n');
			return `\n\n<current_todos 进度=${done}/${todos.length}>\n`
				+ `这是你当前的任务清单（系统每轮自动刷新，以此为准）：\n${lines}\n\n`
				+ `【硬纪律】\n`
				+ `① 清单已定 —— 禁止再"重新了解项目/重新规划"，直接推进下一个未完成（⏳/🔄）项；\n`
				+ `② 开始某项前，先 todo_write 把它标 in_progress；做完立刻 todo_write 标 completed 再开下一项；\n`
				+ `③ 不要反复读同类文件空转 —— 缺什么读什么，读完立刻动手 edit/write；\n`
				+ `④ 全部完成后才允许只输出文字总结收尾。\n</current_todos>`;
		};

		// B3: 自动召回记忆生成 prompt 段
		// 每轮调用前用最近一条 user 消息作为 query 召回 top-K 记忆，注入到 system prompt
		const buildMemorySuffix = async (): Promise<string> => {
			const store = ctx.memoryStore;
			if (!store) return '';
			// 用最近一条 user 消息作为 query；没有就用 userContent
			const lastUser = [...history].reverse().find(m => m.role === 'user');
			const queryText = (() => {
				if (!lastUser) return userContent;
				const c = lastUser.content;
				if (typeof c === 'string') return c;
				if (Array.isArray(c)) {
					const texts = c
						.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : ''))
						.filter(Boolean);
					return texts.join('\n') || userContent;
				}
				return userContent;
			})();
			if (!queryText.trim()) return '';
			try {
				const hits = await store.search({
					query:       queryText.slice(0, 400), // 控长
					maxResults:  5,
					minScore:    0.10,
					workspaceId: ctx.currentWorkspaceId,
					sessionId:   ctx.sessionId,
				});
				if (hits.length === 0) return '';
				const lines: string[] = [
					'',
					'====',
					'',
					'MEMORY (跨会话记忆，自动召回)',
					'',
					'以下是从历史对话中提取的相关偏好/约定/事实，请遵守：',
					'',
				];
				for (const h of hits) {
					lines.push(`- [${h.record.scope}/${h.record.category}] ${h.record.content}`);
				}
				return lines.join('\n');
			} catch (e) {
				console.warn('[Agent] B3-Memory: 召回失败', e);
				return '';
			}
		};

		// 暴露静态段给上层（用于 AiProxyHandler 做 block-level cache_control 标记）
		(globalThis as any).__maxianLastStaticPromptLen = staticPrompt.length;

		// 工具集按模式过滤：
		//   chat    —— 不传工具
		//   plan    —— 只读 + plan_exit（AI 能规划不能改）
		//   explore —— 只读（不含 plan_exit、不含 question，纯探索）
		//   code    —— 全套
		const READ_ONLY_TOOLS = AGENT_TOOL_DEFINITIONS.filter(t =>
			['read_file', 'search_files', 'list_files', 'grep', 'glob', 'ls', 'lsp', 'web_fetch', 'load_skill', 'question', 'plan_exit'].includes(t.name)
		);
		const EXPLORE_TOOLS = AGENT_TOOL_DEFINITIONS.filter(t =>
			['read_file', 'search_files', 'list_files', 'grep', 'glob', 'ls'].includes(t.name)
		);
		const baseActiveTools = isChatMode
			? undefined
			: isExploreMode
				? EXPLORE_TOOLS
				: isPlanMode
					? READ_ONLY_TOOLS
					: AGENT_TOOL_DEFINITIONS;
		// B2: 把当前会话已激活的 MCP 工具动态拼到 activeTools。
		// 每轮重新计算（因为 mcp_tool_load/unload 会改 activeMcpTools 集合）。
		const buildActiveTools = (): ToolDefinition[] | undefined => {
			if (!baseActiveTools) return undefined;
			if (!ctx.activeMcpTools || ctx.activeMcpTools.size === 0) return baseActiveTools;
			const mcpDefs: ToolDefinition[] = [];
			for (const toolId of ctx.activeMcpTools) {
				const entry = ctx.mcpHub?.toolIndex.getByToolId(toolId);
				if (!entry) continue;
				mcpDefs.push({
					name: toolId,
					description: entry.description || `MCP 工具: ${entry.rawToolName}（来自 ${entry.serverName}）`,
					parameters: (entry.inputSchema ?? { type: 'object', properties: {} }) as any,
				});
			}
			if (mcpDefs.length === 0) return baseActiveTools;
			return [...baseActiveTools, ...mcpDefs];
		};

		for (let iter = 0; iter < (MAX_ITERATIONS = rollBudget(iter)); iter++) {
			// ── 取消检查：每轮开始前检查用户是否点了"结束" ──
			if (server.sessionManager.isCancelled(sessionId)) {
				console.log(`[Agent] 检测到取消信号（iter=${iter}），中止 agent loop`);
				await server.sessionManager.emitEvent(sessionId, {
					type: 'assistant_message', sessionId,
					content: '\n\n[已按用户请求中止任务]',
					isPartial: false,
				});
				break;
			}
			// ── 获取 AI handler（按 uiMode 决定 businessCode + session.model 锁定具体模型） ──
			const sessForHandler = server.sessionManager.getSession(sessionId);
			const handler = getAiHandler(uiMode, sessForHandler?.model);

			// ── 上下文压缩检查（每轮开始时）─────────────────────────────
			// 默认 128K 窗口：>55% 触发按工具类型剪枝，>85% 触发 LLM 总结
			// 1M context 模型（如 Claude 1M / Qwen-max-longcontext）需设
			// MAXIAN_CONTEXT_WINDOW=1000000 环境变量
			{
				const { estimateHistoryTokens, COMPACT_L1_THRESHOLD, COMPACT_L2_THRESHOLD } = await import('./contextCompaction.js');
				// B2: 用 base prompt 长度做估算（mcp suffix 是动态的，估算不必精确到 token 级）
				const currentTokens = estimateHistoryTokens(history, finalSystemPromptBase.length);
				const willCompact = currentTokens >= COMPACT_L1_THRESHOLD;
				if (willCompact) {
					// 先通知前端压缩开始
					await server.sessionManager.emitEvent(sessionId, {
						type: 'context_compacting',
						sessionId,
						tokensCurrent: currentTokens,
						willLevel2:    currentTokens >= COMPACT_L2_THRESHOLD,
					} as any);
					// B2-LIFECYCLE: 上下文压缩触发时，强制卸载所有 sticky=false 的 MCP 工具
					if (ctx.activeMcpTools && ctx.activeMcpTools.size > 0) {
						const drop: string[] = [];
						for (const id of ctx.activeMcpTools) {
							if (!ctx.stickyMcpTools?.has(id)) drop.push(id);
						}
						for (const id of drop) ctx.activeMcpTools.delete(id);
						if (drop.length > 0) {
							console.log(`[Agent] B2-Lifecycle: 压缩触发，强制卸载 ${drop.length} 个非 sticky MCP 工具：${drop.join(', ')}`);
						}
					}
				}
				try {
					const report = await compactIfNeeded(history, finalSystemPromptBase.length, handler);
					if (report.level > 0) {
						console.log(
							`[Compaction] Level ${report.level}: ${report.tokensBefore} → ${report.tokensAfter} tokens ` +
							`(节省 ${report.tokensBefore - report.tokensAfter}, 剪 ${report.prunedTools} 工具` +
							(report.summarizedMsgs > 0 ? `, 总结 ${report.summarizedMsgs} 条` : '') + ')'
						);
						history.length = 0;
						history.push(...report.compactedHistory);
						await server.sessionManager.saveHistory(sessionId, history as any);
					}
					// 无论是否真的压缩了，只要发了 compacting 就必须发 compacted 收尾
					if (willCompact || report.level > 0) {
						await server.sessionManager.emitEvent(sessionId, {
							type: 'context_compacted',
							sessionId,
							level: report.level,
							tokensBefore: report.tokensBefore,
							tokensAfter:  report.tokensAfter,
							prunedTools:  report.prunedTools,
							summarizedMsgs: report.summarizedMsgs,
						} as any);
					}
				} catch (e) {
					console.warn('[Compaction] 压缩失败（已跳过）:', (e as Error).message);
					// 失败也要通知前端收尾，别让 "正在压缩" toast 永远挂着
					if (willCompact) {
						await server.sessionManager.emitEvent(sessionId, {
							type: 'context_compacted',
							sessionId,
							level: 0,
							tokensBefore: currentTokens,
							tokensAfter:  currentTokens,
							prunedTools:  0,
							summarizedMsgs: 0,
							error: (e as Error).message,
						} as any);
					}
				}
			}

			if (!handler) {
				// 无 AI 配置 → 模拟模式（仅首轮）
				if (iter === 0) {
					const text = mockReply(userContent);
					await streamMock(sessionId, text);
					history.push({ role: 'assistant', content: text });
					return text;
				}
				break;
			}

			// ── 调用 AI ──
			// B2: 每轮重新计算 activeTools（动态拼上 activeMcpTools），并把当前轮次写入 ctx
			ctx.currentTurn = iter + 1;
			const activeTools = buildActiveTools();
			// B2/B3: 每轮重算 final system prompt（拼上 mcp section + memory section）
			const memorySuffix = await buildMemorySuffix();
			// C1 cache-first：system prompt 只保留**稳定**部分（静态 prompt + MCP 工具说明），
			// 把每轮必变的「记忆召回 + todo 进度提醒」从 system 末尾移到本轮 history 尾部的临时提醒消息。
			// 原因：system 是 DeepSeek 前缀缓存的最前缀，只要它逐轮变化，整个 system+history 前缀缓存全部失效
			//       （cached token 价≈未命中 1/10，长会话成本/延迟显著上升）。移到 history 尾后，前缀稳定、
			//       仅末尾一条小提醒不命中。临时消息只用于本次 createMessage，不写入持久 history。
			const finalSystemPrompt = finalSystemPromptBase + buildMcpSuffix();
			const __ephemeralReminder = (memorySuffix + buildTodoReminderSuffix()).trim();
			const historyForCall = __ephemeralReminder
				? [...history, { role: 'user' as const, content: __ephemeralReminder }]
				: history;

			// ── 空转打断：连续多轮只读探索、不推进 todo → 注入催促 user 消息，逼它动手 ──
			if (consecutiveExploreOnly >= EXPLORE_DRIFT_LIMIT && !isChatMode && !isExploreMode && !isPlanMode) {
				const stuck = getTodoWriteList(sessionId).filter(t => t.status === 'in_progress' || t.status === 'pending');
				if (stuck.length > 0) {
					history.push({ role: 'user', content:
						`[系统提醒] 你已连续 ${consecutiveExploreOnly} 轮只在读文件/探索，没有任何实质改动（edit/write）、todo 也没推进。\n` +
						`立即停止探索、停止重新规划：① 用 todo_write 把最早一项未完成的 todo 标 in_progress；② 直接调 edit / write_to_file 把它做出来。本轮禁止只读不写。`,
					});
					console.log(`[Agent] 空转打断：连续 ${consecutiveExploreOnly} 轮只探索未推进 → 注入催促`);
					consecutiveExploreOnly = 0;
				}
			}
			console.log(`[Agent] iter=${iter} mode=${mode} 调用 AI，携带 ${activeTools?.length ?? 0} 个工具${ctx.activeMcpTools && ctx.activeMcpTools.size > 0 ? ` (含 ${ctx.activeMcpTools.size} 个 MCP)` : ''}，历史 ${history.length} 条`);

			// B2-LIFECYCLE: 自动卸载 N 轮未用的非 sticky MCP 工具
			// 在每轮**调用 LLM 之前**先 GC，让本轮 LLM 看到的 prompt 已经反映 GC 后的状态
			const AUTO_UNLOAD_AFTER_TURNS = 8;
			if (ctx.activeMcpTools && ctx.activeMcpTools.size > 0) {
				const turn = ctx.currentTurn ?? 0;
				const toUnload: string[] = [];
				for (const id of ctx.activeMcpTools) {
					if (ctx.stickyMcpTools?.has(id)) continue;
					const last = ctx.mcpToolLastUsedTurn?.get(id) ?? turn; // 没记录视为本轮（避免一加载就被卸）
					if (turn - last >= AUTO_UNLOAD_AFTER_TURNS) {
						toUnload.push(id);
					}
				}
				if (toUnload.length > 0) {
					for (const id of toUnload) ctx.activeMcpTools.delete(id);
					console.log(`[Agent] B2-Lifecycle: 自动卸载 ${toUnload.length} 个 MCP 工具（${AUTO_UNLOAD_AFTER_TURNS} 轮未用）：${toUnload.join(', ')}`);
				}
			}
			const toolCalls: Array<{ id: string; name: string; params: Record<string, unknown> }> = [];
			// iterText: 常规 assistant 文本（chunk.type === 'text'），在 agent 模式下被当作思考过程流出，
			//          但在最终轮无工具调用时转为 assistant。所以它会进 API history 和 DB 的 assistant。
			let iterText = '';
			// iterReasoningText: 模型原生思考（chunk.type === 'reasoning'，DeepSeek-R1/QwQ），
			//          绝对不进 API history（会污染下轮上下文），只用于持久化为 reasoning 记录。
			let iterReasoningText = '';
			let aiError: string | null = null;
			const toolInputCumLen = new Map<string, number>();
			// 节流批次：每个 toolId 攒到 50ms 或 4KB 才 fire 一次 tool_input_delta；
			// 在 isPartial:false 时由下面的 final-flush 兜底把残留 buf 推完。
			const toolInputPending = new Map<string, { buf: string; lastFlushTs: number; name: string }>();
			const seenToolIds = new Set<string>();
			// reasoning 分段持久化：在 tool_use 边界把 iterText/iterReasoningText 累积的段切片入库
			let lastSavedTextOffset      = 0;
			let lastSavedReasoningOffset = 0;
			const saveReasoningSegment = async () => {
				// 注意：**不能**按 isChatMode 短路！
				// 原因：messages 表（UI 消息）与 history_entries 表（API 历史）解耦，
				// 存 reasoning 消息只用于显示，不会污染下轮 API 上下文；
				// 若在 ask/chat 模式下短路，会导致用户切换会话后"思考过程"丢失。
				// 先保存原生 reasoning_content（思考 token，DeepSeek-R1 / QwQ 等）
				const rSeg = iterReasoningText.slice(lastSavedReasoningOffset);
				if (rSeg.trim().length > 0) {
					await server.sessionManager.appendReasoningMessage(sessionId, rSeg);
					lastSavedReasoningOffset = iterReasoningText.length;
				}
				// 再保存 agent 模式下作为思考过程显示的普通 text
				// ask/chat 模式下 text 直接作 assistant_message 流出，iterText 被用作最终 assistant，
				// 所以 isChatMode 下不保存 iterText（避免与 assistant 消息重复）
				if (!isChatMode) {
					const tSeg = iterText.slice(lastSavedTextOffset);
					if (tSeg.trim().length > 0) {
						await server.sessionManager.appendReasoningMessage(sessionId, tSeg);
						lastSavedTextOffset = iterText.length;
					}
				}
			};

			// 注册当前 handler，让 cancelTask 能主动 abort（不用等下一 chunk）
			__activeStreamHandlers.set(sessionId, handler);
			try {
				for await (const chunk of handler.createMessage(finalSystemPrompt, historyForCall, activeTools)) {
					// LLM 流式输出中每一块都检查一次取消（让"结束"按钮秒级生效）
					if (server.sessionManager.isCancelled(sessionId)) {
						console.log(`[Agent] LLM 流中检测到取消，中止当前 request`);
						try { await (handler as any).stopCurrentRequest?.(); } catch {}
						aiError = '[用户取消]';
						break;
					}
					if (chunk.type === 'text') {
						iterText += chunk.text;
						allText  += chunk.text;
						if (isChatMode) {
							// 对话模式：文本直接作为助手回复实时流出
							await server.sessionManager.emitEvent(sessionId, {
								type: 'assistant_message', sessionId, content: chunk.text, isPartial: true,
							});
						} else {
							// Agent 模式：文本先作为"思考过程"实时流出；
							// 若该迭代最终无工具调用（即最终响应），再通过
							// convert_reasoning_to_assistant 事件将其转为普通助手消息。
							await server.sessionManager.emitEvent(sessionId, {
								type: 'reasoning_delta', sessionId, content: chunk.text,
							} as any);
						}
					} else if (chunk.type === 'tool_use') {
						if (chunk.isPartial) {
							// #5 流式 tool input 增量推送
							if (!seenToolIds.has(chunk.id)) {
								seenToolIds.add(chunk.id);
								// 【关键】在新 tool 首次出现的边界切片保存 reasoning——
								// AiProxyHandler 把 isPartial:false 全挤到流末尾，用它们做边界会全部合并。
								// 用首次 isPartial:true 做边界可以正确分段。
								await saveReasoningSegment();
								await server.sessionManager.emitEvent(sessionId, {
									type:       'tool_call_start',
									sessionId,
									toolName:   chunk.name,
									toolUseId:  chunk.id,
									toolParams: {},
									streaming:  true,
								} as any);
							}
							// AiProxyHandler 发的 chunk.input 是 **累积值**，在此算真正的 delta。
							// 节流：50ms 或 4KB 攒一次推送（避免每 chunk 都 fire 把 SSE 通道塞满）。
							// 多 edit / multiedit 大参数下可减少 90%+ 的 SSE 帧数，前端 UI 不再卡顿。
							const cumInput = chunk.input ?? '';
							const prevLen  = toolInputCumLen.get(chunk.id) ?? 0;
							if (cumInput.length > prevLen) {
								toolInputCumLen.set(chunk.id, cumInput.length);
								const pend = toolInputPending.get(chunk.id) ?? { buf: '', lastFlushTs: 0, name: chunk.name };
								pend.buf += cumInput.slice(prevLen);
								pend.name = chunk.name;
								const now = Date.now();
								const shouldFlush = pend.buf.length >= 4096 || (now - pend.lastFlushTs) >= 50;
								if (shouldFlush) {
									await server.sessionManager.emitEvent(sessionId, {
										type:       'tool_input_delta',
										sessionId,
										toolUseId:  chunk.id,
										toolName:   pend.name,
										inputDelta: pend.buf,
										totalLen:   cumInput.length,
									} as any);
									pend.buf = '';
									pend.lastFlushTs = now;
								}
								toolInputPending.set(chunk.id, pend);
							}
						} else {
							console.log(`[Agent] 收到完整工具调用: ${chunk.name} (id=${chunk.id})`);
							// Final flush：把节流期间残留的 buf 全部推给前端，确保 UI 看到完整参数
							const pend = toolInputPending.get(chunk.id);
							if (pend && pend.buf.length > 0) {
								await server.sessionManager.emitEvent(sessionId, {
									type:       'tool_input_delta',
									sessionId,
									toolUseId:  chunk.id,
									toolName:   pend.name,
									inputDelta: pend.buf,
									totalLen:   toolInputCumLen.get(chunk.id) ?? pend.buf.length,
								} as any);
								pend.buf = '';
							}
							toolInputPending.delete(chunk.id);
							try {
								const params = JSON.parse(chunk.input);
								toolCalls.push({ id: chunk.id, name: chunk.name, params });
							} catch (e) {
								// B2 修复：工具参数 JSON 可能被截断（少 } / 断在字符串中 / 悬空 key）→ 先尝试本地补全再决定是否丢弃
								const __repaired = repairTruncatedJson(chunk.input);
								if (!__repaired.fallback) {
									try {
										const params = JSON.parse(__repaired.repaired);
										toolCalls.push({ id: chunk.id, name: chunk.name, params });
										console.warn(`[Agent] 工具参数 JSON 截断已自动修复 (${chunk.name}): ${__repaired.notes.join('; ')}`);
									} catch (e2) {
										console.warn('[Agent] 解析工具参数失败(修复后仍失败):', chunk.input, e2);
									}
								} else {
									console.warn('[Agent] 解析工具参数失败(不可修复，已丢弃):', chunk.input, e);
								}
							}
						}
					} else if ((chunk as any).type === 'reasoning') {
						// 模型原生 reasoning_content（如 DeepSeek-R1 / QwQ）
						const reasoningText = (chunk as any).text ?? '';
						if (reasoningText.length > 0) {
							console.log(`[Agent] ✨ 原生思考内容 (${reasoningText.length}字): ${reasoningText.slice(0, 50)}${reasoningText.length > 50 ? '…' : ''}`);
							// 累积到独立的 iterReasoningText，用于持久化为 reasoning 消息
							// 注意：**绝不**进 API history，否则下轮模型会把自己的思考当上下文
							iterReasoningText += reasoningText;
						}
						await server.sessionManager.emitEvent(sessionId, {
							type: 'reasoning_delta', sessionId, content: reasoningText,
						} as any);
					} else if (chunk.type === 'usage') {
						// 累计 token 用量，发送给前端显示进度条
						const inTok  = (chunk as any).inputTokens  ?? 0;
						const outTok = (chunk as any).outputTokens ?? 0;
						totalInputTokens  += inTok;
						totalOutputTokens += outTok;
						// used = 当前**已占用的上下文窗口大小** ≈ input（input 已含全部历史）
						// output 不占输入窗口（不参与下轮对话），但加一下更直观
						const used = inTok + outTok;
						// limit 跟 contextCompaction 的 CONTEXT_WINDOW 一致（可被 env 覆盖）
						// 而不是硬编码 200K
						const limit = CONTEXT_WINDOW;
						await server.sessionManager.emitEvent(sessionId, {
							type:  'token_usage',
							sessionId,
							used,
							limit,
							inputTokens:  inTok,
							outputTokens: outTok,
						} as any);
					} else if (chunk.type === 'error') {
						aiError = chunk.error;
					}
				}
			} catch (e) {
				aiError = (e as Error).message;
			} finally {
				// 退出 for-await：注销 active handler，避免 onCancel 误 abort 后续请求
				if (__activeStreamHandlers.get(sessionId) === handler) {
					__activeStreamHandlers.delete(sessionId);
				}
			}

			// Rate-limit 检测与自动重试（P0-6）
			// 覆盖：HTTP 429、"rate limit"、"too many requests"、
			//      DashScope/Qwen 容量忙时（"throttled / capacity limits / InternalError.Algo"）、
			//      Anthropic "overloaded"、OpenAI "rate_limit_exceeded"
			if (aiError && /\b429\b|rate[\s_-]?limit|too many requests|throttl|capacity limits?|overloaded|InternalError\.Algo/i.test(aiError)) {
				const retryMatch = aiError.match(/retry[\s-]*(?:after)?[\s:]*(\d+)/i);
				const waitSec = retryMatch ? Math.max(5, Math.min(300, parseInt(retryMatch[1], 10))) : 30;
				const maxRetries = 3;
				let retries = 0;
				while (retries < maxRetries) {
					retries++;
					const resetAt = Date.now() + waitSec * 1000;
					await server.sessionManager.emitEvent(sessionId, {
						type: 'rate_limit', sessionId,
						resetAt, attempt: retries,
						message: `触发限流（${waitSec}s），${retries}/${maxRetries} 次重试…`,
					} as any);
					await new Promise(r => setTimeout(r, waitSec * 1000));
					await server.sessionManager.emitEvent(sessionId, {
						type: 'rate_limit_cleared', sessionId,
					} as any);
					aiError = null;
					// 重试也注册 active handler，让 cancel 期间也能 abort
					__activeStreamHandlers.set(sessionId, handler);
					try {
						for await (const chunk of handler.createMessage(finalSystemPrompt, historyForCall, activeTools)) {
							if (server.sessionManager.isCancelled(sessionId)) {
								try { await (handler as any).stopCurrentRequest?.(); } catch {}
								aiError = '[用户取消]';
								break;
							}
							if (chunk.type === 'text') {
								iterText += chunk.text;
								allText  += chunk.text;
								if (isChatMode) {
									await server.sessionManager.emitEvent(sessionId, {
										type: 'assistant_message', sessionId, content: chunk.text, isPartial: true,
									});
								} else {
									await server.sessionManager.emitEvent(sessionId, {
										type: 'reasoning_delta', sessionId, content: chunk.text,
									} as any);
								}
							} else if (chunk.type === 'tool_use' && !chunk.isPartial) {
								try {
									const params = JSON.parse(chunk.input);
									toolCalls.push({ id: chunk.id, name: chunk.name, params });
								} catch {
										// B2 修复：重试路径同样修复截断的工具参数 JSON
										const __r = repairTruncatedJson(chunk.input);
										if (!__r.fallback) { try { toolCalls.push({ id: chunk.id, name: chunk.name, params: JSON.parse(__r.repaired) }); } catch { /* ignore */ } }
								}
							} else if (chunk.type === 'usage') {
								totalInputTokens  += (chunk as any).inputTokens  ?? 0;
								totalOutputTokens += (chunk as any).outputTokens ?? 0;
							} else if (chunk.type === 'error') {
								aiError = chunk.error;
							}
						}
						if (!aiError) break;
						// 重试循环的退出判断必须与首次检测的正则一致，包括 "too many requests"
						// 和 "throttl" / "capacity"（DashScope/Qwen 的容量忙时提示）
						if (!/\b429\b|rate[\s_-]?limit|too many requests|throttl|capacity limits?/i.test(aiError)) break;
					} catch (e) {
						aiError = (e as Error).message;
						if (!/\b429\b|rate[\s_-]?limit|too many requests|throttl|capacity limits?/i.test(aiError)) break;
					} finally {
						if (__activeStreamHandlers.get(sessionId) === handler) {
							__activeStreamHandlers.delete(sessionId);
						}
					}
				}
				if (aiError) {
					await server.sessionManager.emitEvent(sessionId, {
						type: 'rate_limit_cleared', sessionId,
					} as any);
					throw new Error(`持续限流，已重试 ${retries} 次仍失败: ${aiError}`);
				}
			}

			if (aiError) {
				// 如果是首轮直接降级，否则抛出
				if (iter === 0 && aiConfig?.type === 'anthropic') {
					// Anthropic 直连模式（无工具，仅文本）
					let anthropicText = '';
					for await (const text of callAnthropic(history)) {
						anthropicText += text;
						allText       += text;
						await server.sessionManager.emitEvent(sessionId, {
							type: 'assistant_message', sessionId, content: text, isPartial: true,
						});
					}
					if (anthropicText) {
						const fallbackMsg: any = { role: 'assistant', content: anthropicText };
						if (iterReasoningText && iterReasoningText.length > 0) {
							fallbackMsg.reasoning = iterReasoningText;
						}
						history.push(fallbackMsg);
					}
					return anthropicText;
				}
				throw new Error(aiError);
			}

			// ── 迭代完成日志 ──
			totalToolCalls += toolCalls.length;
			console.log(`[Agent] iter=${iter} 完成: 文本=${iterText.length}字, 工具调用=${toolCalls.length}个`);

			// ── 无工具调用 → Agent 完成 ──
			if (toolCalls.length === 0) {
				// 解析 followup 建议（<<<FOLLOWUP>>> 区块）并移除
				const fuMatch = iterText.match(/<<<FOLLOWUP>>>\s*([\s\S]*?)(?:```|$)/i);
				if (fuMatch) {
					const suggestions = fuMatch[1]
						.split('\n')
						.map(l => l.replace(/^\s*[-*•]\s*/, '').trim())
						.filter(l => l.length > 0 && l.length < 200);
					if (suggestions.length > 0) {
						await server.sessionManager.emitEvent(sessionId, {
							type: 'followup_suggestions',
							sessionId,
							suggestions: suggestions.slice(0, 5),
						} as any);
					}
					// 从显示/历史文本中移除 followup 区块（含 ``` 包围符）
					iterText = iterText.replace(/```\s*<<<FOLLOWUP>>>[\s\S]*?```/i, '').trim();
					iterText = iterText.replace(/<<<FOLLOWUP>>>[\s\S]*$/i, '').trim();
				}
				finalText = iterText;
				// 在最终轮把原生 reasoning_content（思考 token）持久化为独立 reasoning 消息
				// 无论 chat 还是 agent 模式都保存（仅存 messages 表供 UI 显示，不进 API 历史）
				if (iterReasoningText.trim().length > 0) {
					const rSeg = iterReasoningText.slice(lastSavedReasoningOffset);
					if (rSeg.trim().length > 0) {
						await server.sessionManager.appendReasoningMessage(sessionId, rSeg);
					}
				}
				if (iterText) {
					// Agent 模式：文本以 reasoning_delta 方式流出，此处转为最终助手消息
					if (!isChatMode) {
						await server.sessionManager.emitEvent(sessionId, {
							type: 'convert_reasoning_to_assistant', sessionId,
						} as any);
					}
					// DeepSeek thinking：把本轮 reasoning_content 挂到 assistant 消息上，
					// 下一轮（或老会话恢复后）回传给上游，否则 400
					const finalAssistant: any = { role: 'assistant', content: iterText };
					if (iterReasoningText && iterReasoningText.length > 0) {
						finalAssistant.reasoning = iterReasoningText;
					}
					history.push(finalAssistant);
				}

				// ── 漂移检测 + 自动续跑（参照 jiusi，治"提前退出 / 任务清单对不上"）──
				consecutiveNoToolText++;
				const aiDrifting = consecutiveNoToolText >= NO_TOOL_DRIFT_LIMIT;
				const canAutoContinue =
					!isChatMode && !isExploreMode && !isPlanMode
					&& autoContinueCount < MAX_AUTO_CONTINUE
					&& !aiDrifting
					&& !server.sessionManager.isCancelled(sessionId);
				if (canAutoContinue) {
					const leftover = getTodoWriteList(sessionId)
						.filter(t => t.status === 'in_progress' || t.status === 'pending');
					if (leftover.length > 0) {
						autoContinueCount++;
						const names = leftover.map(t => `「${t.content}」`).join('、');
						history.push({ role: 'user', content:
							`[系统自动续跑 ${autoContinueCount}/${MAX_AUTO_CONTINUE}] ` +
							`你上一轮纯文本结束、没调任何工具，但 todo 还有 ${leftover.length} 项未收尾：${names}。\n\n` +
							`【硬约束】本轮必须调至少一个工具，禁止只输出文本。二选一：\n` +
							`  (A) 如果其实已经做完只是忘了 mark：用 todo_write 把对应项 status 改成 completed。\n` +
							`  (B) 如果还没做完：针对最早一项 pending todo，直接调具体执行工具（read_file / edit / execute_command 等）把它做完。\n\n` +
							`【禁止】不要把没做的标 failed 来蒙混——"超出范围 / 不必要 / 待确认"都不是理由；只有需求自相矛盾或技术上根本无法实现才可，且必须在 remark 写清硬阻塞原因。\n` +
							`【禁止】不要回复"好的我现在开始…"这类纯文本，直接调工具。`,
						});
						console.log(`[Agent] 自动续跑 #${autoContinueCount}/${MAX_AUTO_CONTINUE}: ${leftover.length} 项未收尾 → ${names}`);
						await server.sessionManager.emitEvent(sessionId, {
							type: 'assistant_message', sessionId,
							content: `\n\n[🔄 自动续跑 #${autoContinueCount}/${MAX_AUTO_CONTINUE} — 检查 ${leftover.length} 项 todo 状态]\n\n`,
							isPartial: false,
						} as any);
						continue;   // 不 break，注入续跑指令后再跑一轮
					}
				}

				// ── 漂移退出：连续多轮纯文本无工具调用 → 停止续跑，给用户清晰提示而非无声结束 ──
				if (aiDrifting && !isChatMode && !isExploreMode && !isPlanMode) {
					const leftover = getTodoWriteList(sessionId)
						.filter(t => t.status === 'in_progress' || t.status === 'pending');
					if (leftover.length > 0) {
						console.warn(`[Agent] 漂移检测：连续 ${consecutiveNoToolText} 轮纯文本无工具调用，停止续跑（${leftover.length} 项未收尾）`);
						await server.sessionManager.emitEvent(sessionId, {
							type: 'assistant_message', sessionId,
							content: `\n\n⚠️ [已停止自动续跑] AI 连续 ${consecutiveNoToolText} 轮只输出文字、没调任何工具——可能任务已做完但 todo 没 mark，或在原地踏步。剩余 ${leftover.length} 项：${leftover.map(t => `「${t.content}」`).join('、')}。\n可回复"继续"让它再试，或换更具体的指令。`,
							isPartial: false,
						} as any);
					}
				}
				break;
			}

			// ── 有工具调用：重置"连续纯文本"漂移计数（本轮在干活，没漂移）──
			consecutiveNoToolText = 0;

			// ── 空转检测：本轮有没有"推进性"工具（改文件 / 更新 todo）；只读探索则累加 ──
			const isProgressTool = (n: string) =>
				n === 'edit' || n === 'multiedit' || n === 'write_to_file' || n === 'apply_patch' || n === 'todo_write';
			if (toolCalls.some(tc => isProgressTool(tc.name))) consecutiveExploreOnly = 0;
			else consecutiveExploreOnly++;

			// ── 有工具调用：把本轮最后一段 reasoning 尾巴保存（如果存在尾随 text）──
			await saveReasoningSegment();

			// ── 将助手消息（含 tool_use 块）追加到历史 ──
			const assistantContent: ContentBlock[] = [];
			if (iterText) {
				assistantContent.push({ type: 'text', text: iterText });
			}
			for (const tc of toolCalls) {
				assistantContent.push({
					type:  'tool_use',
					id:    tc.id,
					name:  tc.name,
					input: tc.params,
				});
			}
			// DeepSeek thinking：本轮 assistant 触发 tool_calls 时，必须把 reasoning_content
			// 一起回传给上游；不带的话 DeepSeek 下一轮请求会返回
			//   "The reasoning_content in the thinking mode must be passed back to the API." 400
			const assistantMsg: any = { role: 'assistant', content: assistantContent };
			if (iterReasoningText && iterReasoningText.length > 0) {
				assistantMsg.reasoning = iterReasoningText;
			}
			history.push(assistantMsg);

			// ── 执行工具，收集结果（#12 并行执行 + #3 doom-loop） ─────────
			const toolResultBlocks: ContentBlock[] = [];

			// 破坏性工具（需审批 + 串行执行）
			// 进一步细分为：
			//   FILE_EDIT_TOOLS    —— 文件编辑类（用 git/快照可恢复，风险中等）
			//   COMMAND_EXEC_TOOLS —— shell 命令执行类（任意副作用、不可恢复，风险最高）
			// 不同 composer 模式对两组的处理策略不一样：
			//   ask    → 都弹审批
			//   code   → 自动通过 FILE_EDIT，仅对 COMMAND_EXEC 弹审批（默认体验）
			//   bypass → 都自动通过
			//   plan   → LLM 根本看不到这些工具（不会进到这里）
			const FILE_EDIT_TOOLS = new Set([
				'write_to_file', 'edit', 'multiedit', 'apply_patch',
			]);
			const COMMAND_EXEC_TOOLS = new Set([
				'execute_command', 'bash',
			]);
			const DESTRUCTIVE_TOOLS = new Set([
				...FILE_EDIT_TOOLS, ...COMMAND_EXEC_TOOLS,
			]);

			// 预处理每个工具：doom-loop 检测 + 审批（都走串行）
			interface PendingTool {
				tc:         typeof toolCalls[number];
				denied:     boolean;
				denyReason: string;
			}
			const pending: PendingTool[] = [];
			for (const tc of toolCalls) {
				console.log(`[Agent] 预处理工具: ${tc.name}`, JSON.stringify(tc.params).slice(0, 200));

				// #3 doom-loop 检测（Kilocode 版 ToolRepetitionDetector）
				const check = repetitionDetector.check({ name: tc.name as any, params: tc.params } as any);
				if (!check.allowExecution) {
					pending.push({
						tc, denied: true,
						denyReason: check.askUser?.messageDetail ?? '检测到重复调用，请切换策略',
					});
					continue;
				}

				// #8 per-tool + pattern 权限检查（读取 session-level 或 global allowAlways）
				// 实际前端控制 auto-approve，这里主要处理 "ask" 模式
				// streaming=false 表示工具参数已完整到达，前端可以展示真实参数了
				await server.sessionManager.emitEvent(sessionId, {
					type:       'tool_call_start',
					sessionId,
					toolName:   tc.name,
					toolUseId:  tc.id,
					toolParams: tc.params,
					streaming:  false,
				} as any);

				if (DESTRUCTIVE_TOOLS.has(tc.name)) {
					// 每次工具调用都从 DB 实时读 session.mode，
					// 这样用户在执行过程中切换模式都能立刻生效。
					const liveMode = server.sessionManager.getMode(sessionId);

					// ★ bypass 模式：所有破坏性工具一律自动批准
					if (liveMode === 'bypass') {
						console.log(`[Agent] bypass 模式自动批准 ${tc.name} (id=${tc.id})`);
						pending.push({ tc, denied: false, denyReason: '' });
						continue;
					}

					// ★ code 模式（默认）：文件编辑类自动接受，仅对 shell 命令弹审批
					//   匹配 ModeSelector 标签描述的"自动接受文件修改"语义
					if (liveMode === 'code' && FILE_EDIT_TOOLS.has(tc.name)) {
						console.log(`[Agent] code 模式自动接受文件编辑 ${tc.name} (id=${tc.id})`);
						pending.push({ tc, denied: false, denyReason: '' });
						continue;
					}

					// Auto-approve（批量任务模式）短路：sessionManager.getAutoApproveConfig 配置过的会话
					// 直接走 decideApproval —— 'auto' 直接通过，'deny' 走拒绝路径，'ask' 走原 approval 流程
					const autoCfg = server.sessionManager.getAutoApproveConfig(sessionId);
					if (autoCfg?.enabled) {
						const { decideApproval } = await import('./autoApprove.js');
						const decision = decideApproval(autoCfg, tc.name, tc.params as Record<string, unknown>);
						if (decision.decision === 'auto') {
							console.log(`[Agent] auto-approve ${tc.name} (batch mode)`);
							pending.push({ tc, denied: false, denyReason: '' });
							continue;
						}
						if (decision.decision === 'deny') {
							console.warn(`[Agent] auto-approve 黑名单拒绝 ${tc.name}: ${decision.reason}`);
							pending.push({ tc, denied: true, denyReason: decision.reason ?? '黑名单拦截' });
							continue;
						}
						// 'ask' fall through 走原审批流程
					}
					console.log(`[Agent] 破坏性工具：等待用户审批 ${tc.name} (id=${tc.id}, mode=${liveMode})`);
					await server.sessionManager.emitEvent(sessionId, {
						type:       'tool_approval_request',
						sessionId,
						toolUseId:  tc.id,
						toolName:   tc.name,
						toolParams: tc.params,
					} as any);
					const { approved, feedback } = await server.sessionManager.registerApproval(sessionId, tc.id);
					if (!approved) {
						pending.push({
							tc, denied: true,
							denyReason: feedback ? `用户已拒绝并反馈：${feedback}` : '用户已拒绝此工具调用',
						});
						continue;
					}
					console.log(`[Agent] 用户批准 ${tc.name}`);
				}
				pending.push({ tc, denied: false, denyReason: '' });
			}

			// 执行函数
			const emitFileEvent = async (event: Record<string, unknown>) => {
				await server.sessionManager.emitEvent(sessionId, event as any);
			};
			const runOne = async (p: PendingTool): Promise<{ id: string; name: string; success: boolean; result: string }> => {
				const tc = p.tc;
				if (p.denied) {
					await server.sessionManager.emitEvent(sessionId, {
						type:      'tool_call_result',
						sessionId,
						toolUseId: tc.id,
						toolName:  tc.name,
						success:   false,
						result:    p.denyReason,
					});
					await server.sessionManager.appendToolMessage(sessionId, {
						toolName:    tc.name,
						toolUseId:   tc.id,
						toolParams:  tc.params,
						toolResult:  p.denyReason,
						toolSuccess: false,
					});
					return { id: tc.id, name: tc.name, success: false, result: p.denyReason };
				}

				// Plugin hook: tool.execute.before（可以取消调用）
				const allowed = await triggerPluginHook(loadedPlugins, 'tool.execute.before', {
					toolName: tc.name, params: tc.params, sessionId,
				});
				if (!allowed) {
					const denied = '[插件 hook 拒绝执行此工具]';
					await server.sessionManager.appendToolMessage(sessionId, {
						toolName: tc.name, toolUseId: tc.id, toolParams: tc.params,
						toolResult: denied, toolSuccess: false,
					});
					return { id: tc.id, name: tc.name, success: false, result: denied };
				}

				let result    = await executeToolCall(ctx, tc.name, tc.params, emitFileEvent, tc.id);
				const success = !result.startsWith('Error');

				// PostToolUse hook（对标 Claude Code）：工具成功后跑 .maxian/config.json
				// 里配置的 shell 命令（如 edit 后跑 tsc --noEmit），把输出塞回 result
				// 让 AI 下一轮看见编译/lint 错并自行修复。
				if (success && projectCfg.hooks?.PostToolUse?.[tc.name]) {
					const hookCmd = projectCfg.hooks.PostToolUse[tc.name];
					try {
						const hookRes = await runHookCommand(hookCmd, { cwd: ctx.workspacePath });
						result += formatHookResult(tc.name, hookCmd, hookRes);
					} catch (err) {
						result += `\n\n❌ PostToolUse hook 启动异常：${(err as Error).message}`;
					}
				}

				// Plugin hook: tool.execute.after
				await triggerPluginHook(loadedPlugins, 'tool.execute.after', {
					toolName: tc.name, params: tc.params, result, success, sessionId,
				});
				// 记录错误签名用于 same-error-loop 检测
				repetitionDetector.recordToolResult(tc.name, tc.params, result);

				await server.sessionManager.emitEvent(sessionId, {
					type:      'tool_call_result',
					sessionId,
					toolUseId: tc.id,
					toolName:  tc.name,
					success,
					result,
				});
				// 持久化工具调用+结果（切换会话回来后能还原）
				await server.sessionManager.appendToolMessage(sessionId, {
					toolName:    tc.name,
					toolUseId:   tc.id,
					toolParams:  tc.params,
					toolResult:  result,
					toolSuccess: success,
				});
				return { id: tc.id, name: tc.name, success, result };
			};

			// 工具执行前再检查一次取消
			if (server.sessionManager.isCancelled(sessionId)) {
				console.log(`[Agent] 工具执行前检测到取消，跳过 ${toolCalls.length} 个工具`);
				// ★ 关键修复：取消前 history 已经 push 了带 tool_use 的 assistant 消息（line 3464）。
				// 如果直接 break，下一次 LLM 请求历史里 assistant.tool_calls 就没有对应的 tool_result，
				// OpenAI 兼容 API 会 400 报错：
				//   "An assistant message with 'tool_calls' must be followed by tool messages
				//    responding to each 'tool_call_id'"
				// 所以这里给所有未执行的工具补占位 tool_result，保证历史完整可重发。
				const cancelResults: ContentBlock[] = toolCalls.map(tc => ({
					type:        'tool_result',
					tool_use_id: tc.id,
					content:     '[用户取消，未执行]',
				}) as ContentBlock);
				if (cancelResults.length > 0) {
					history.push({ role: 'user', content: cancelResults });
				}
				break;
			}

			// 三层调度策略（对标 OpenCode 但更保守）：
			//   1. 只读工具 → 全部并行（read/grep/glob/ls/lsp/web_fetch/load_skill 等）
			//   2. 有 path 的破坏性工具（edit/write/multiedit/apply_patch）
			//      → 按 path 分组：不同文件并行，同文件串行
			//   3. 无 path 的破坏性工具（bash/execute_command）
			//      → 全局串行（命令可能有跨文件副作用，保守处理）
			type ToolResult = { id: string; name: string; success: boolean; result: string };
			const FILE_OP_TOOLS = new Set(['edit', 'write_to_file', 'multiedit', 'apply_patch']);

			const readOnlyPending: PendingTool[] = [];
			const fileOpByPath = new Map<string, PendingTool[]>();
			const globalSerialPending: PendingTool[] = [];

			for (const p of pending) {
				if (!DESTRUCTIVE_TOOLS.has(p.tc.name)) {
					readOnlyPending.push(p);
				} else if (FILE_OP_TOOLS.has(p.tc.name)) {
					const rawPath = (p.tc.params as any)?.path;
					if (typeof rawPath === 'string' && rawPath.length > 0) {
						const norm = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.workspacePath, rawPath);
						const arr = fileOpByPath.get(norm) ?? [];
						arr.push(p);
						fileOpByPath.set(norm, arr);
					} else {
						globalSerialPending.push(p);
					}
				} else {
					globalSerialPending.push(p);
				}
			}

			// 并行阶段：
			//   - 只读工具全部扁平并行
			//   - 每个 file path 下的多个破坏性工具组成一条串行 chain，chain 之间并行
			const parallelChains: Promise<ToolResult[]>[] = [];
			if (readOnlyPending.length > 0) {
				parallelChains.push(Promise.all(readOnlyPending.map(p => runOne(p))));
			}
			for (const fileOps of fileOpByPath.values()) {
				parallelChains.push((async () => {
					const acc: ToolResult[] = [];
					for (const p of fileOps) acc.push(await runOne(p));
					return acc;
				})());
			}
			const parallelResults: ToolResult[] = (await Promise.all(parallelChains)).flat();

			// 全局串行：bash / execute_command 最后跑（避免副作用交错）
			const serialResults: ToolResult[] = [];
			for (const p of globalSerialPending) {
				serialResults.push(await runOne(p));
			}

			// 按 toolCalls 原顺序聚合结果
			const resultById = new Map<string, { success: boolean; result: string }>();
			for (const r of parallelResults) resultById.set(r.id, { success: r.success, result: r.result });
			for (const r of serialResults)   resultById.set(r.id, { success: r.success, result: r.result });

			for (const tc of toolCalls) {
				const r = resultById.get(tc.id);
				if (!r) {
					// 防御：调度漏掉了某个工具（理论上不应发生，但有过 bug：执行中取消 / 异常吞掉）。
					// 必须补占位 tool_result，否则 history 里 assistant.tool_calls 缺对应 tool_result，
					// 下次 LLM 请求 OpenAI 兼容 API 会 400 "insufficient tool messages"。
					console.warn(`[Agent] 工具 ${tc.name} (id=${tc.id}) 缺少结果，补占位 tool_result`);
					toolResultBlocks.push({
						type:        'tool_result',
						tool_use_id: tc.id,
						content:     '[内部错误：工具未执行或结果丢失]',
					} as ContentBlock);
					continue;
				}
				toolResultBlocks.push({
					type:        'tool_result',
					tool_use_id: tc.id,
					content:     r.result,
				});
			}

			// ── 将工具结果追加到历史，继续下一轮 ──
			history.push({ role: 'user', content: toolResultBlocks });

			// 语言重锚：每轮工具结果（多半是英文代码 / stderr / 路径）后追加一条 user 提醒，
			// 避免长上下文里大量英文 token 把模型带偏改用英文回复。
			// 用 user 角色追加保证 aiProxyHandler 转 OpenAI 格式时这条作为独立 user 消息保留。
			if (toolResultBlocks.length > 0) {
				history.push({
					role: 'user',
					content: '[系统提醒] 工具结果中的代码 / 路径 / 命令保留英文原文不翻译，但你下一段自然语言回复（包括思考链 reasoning_content）必须使用简体中文，禁止英文句子。',
				});
			}
		}

		// ── 推送日志（对标码弦 IDE /ai/call-log） ────────────────────────────────
		void pushAiCallLog({
			sessionId,
			uiMode,
			userContent,
			responseText: finalText || allText,
			inputTokens:  totalInputTokens,
			outputTokens: totalOutputTokens,
			toolCallsCount: totalToolCalls,
			durationMs: Date.now() - loopStartTime,
			status: 'success',
		});

		// 累加 token 用量到 sessions 表（设置面板的"token 用量"统计源）
		try {
			const cur = server.sessionManager.getSession(sessionId);
			if (cur) {
				server.sessionManager.updateStats(sessionId, {
					inputTokens:  (cur.inputTokens  ?? 0) + totalInputTokens,
					outputTokens: (cur.outputTokens ?? 0) + totalOutputTokens,
				});
			}
		} catch (e) {
			console.warn('[Maxian] updateStats(tokens) 失败:', e);
		}

		return finalText || allText;
	}

	// ─── 子 Agent 派发（task 工具）── B1 完整版 ──────────────────────────────
	// 支持：
	//   - 4 个 builtin subagent_type（general-purpose / code-reviewer / code-explorer / test-writer）
	//   - 自定义 agent（.maxian/agents/<name>.md）
	//   - 老 subagent_type 别名（explore/build/review → builtin 映射）
	//   - isolation: 'inherit' | 'worktree'（worktree 自动创建独立分支 + workspace）
	//   - background: true 立即返回 task_id，主代理可继续；false 同步等结果
	//   - 取消传播：父代理取消时所有子任务级联取消
	//   - 并发上限：≤ 8 background；同步任务无限制
	(globalThis as any).__maxianSpawnSubAgent = async (opts: {
		parentSessionId?: string;
		workspacePath:    string;
		prompt:           string;
		subagentType:     string;
		description?:     string;
		isolation?:       'inherit' | 'worktree';
		background?:      boolean;
	}): Promise<ITaskToolResult> => {
		const subagentMgr = server.sessionManager.subagentManager;
		try {
			const subagentMod   = await import('@maxian/core/agents');
			const worktreeMod   = await import('./subagentWorktree.js');
			const customAgents  = loadCustomAgents(opts.workspacePath);
			const customNames   = customAgents.map(a => a.name);
			const resolvedName  = subagentMod.resolveSubagentName(opts.subagentType, customNames);
			if (!resolvedName) {
				return {
					output: '',
					success: false,
					error: `未知 subagent_type "${opts.subagentType}"。内置：${subagentMod.listBuiltinSubagentNames().join(', ')}；自定义：${customNames.join(', ') || '（无）'}`,
				};
			}

			// 决定 mode + prompt header
			let subMode = 'ask';
			let promptHeader = '';
			let isolation: 'inherit' | 'worktree' = opts.isolation ?? 'inherit';
			let background = opts.background === true;

			const builtin = subagentMod.getBuiltinSubagent(resolvedName);
			if (builtin) {
				subMode = builtin.mode;
				promptHeader = builtin.promptHeader;
				if (opts.isolation === undefined) isolation = builtin.defaultIsolation;
				if (opts.background === undefined) background = builtin.defaultBackground;
			} else {
				// 自定义 agent
				const custom = customAgents.find(a => a.name === resolvedName);
				if (custom) {
					subMode = 'code';
					promptHeader = custom.systemPrompt;
				}
			}

			// 生成子代理 sessionId（独立 context 的关键）
			const subSessionId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

			// 解析 worktree 隔离
			const subTaskIdHint = subSessionId; // 用 sessionId 作为 worktree 子目录名
			const wkRes = await worktreeMod.resolveSubagentWorkspace(opts.workspacePath, isolation, subTaskIdHint);
			if (wkRes.downgradeReason) {
				console.log(`[Subagent] ${wkRes.downgradeReason}`);
			}

			// 注册到 SubagentManager
			const createRes = subagentMgr.create({
				parentSessionId:        opts.parentSessionId ?? '__main__',
				subagentSessionId:      subSessionId,
				subagentType:           resolvedName,
				description:            opts.description,
				prompt:                 opts.prompt,
				isolation:              wkRes.isWorktree ? 'worktree' : 'inherit',
				background,
				effectiveWorkspacePath: wkRes.effectiveWorkspacePath,
				worktreePath:           wkRes.worktreePath,
				worktreeBranch:         wkRes.branchName,
			});
			if (!createRes.ok) {
				// 并发上限被拒绝 → 提前清理 worktree（如果创建了）
				if (wkRes.isWorktree && wkRes.worktreePath) {
					await worktreeMod.cleanupSubagentWorktree(opts.workspacePath, wkRes.worktreePath);
				}
				return { output: '', success: false, error: createRes.reason };
			}
			const record = createRes.record;
			const taskId = record.taskId;

			// 拼接最终 user prompt
			const userContent = promptHeader
				? `${promptHeader}\n\n---\n\n# 任务\n\n${opts.prompt}`
				: opts.prompt;

			// ── 同步任务：直接 await 跑完 ─────────────────────
			if (!background) {
				subagentMgr.markRunning(taskId);
				try {
					const subHistory: MessageParam[] = [];
					const output = await runAgentLoop(
						subSessionId,
						userContent,
						subHistory,
						wkRes.effectiveWorkspacePath,
						subMode,
						'code',
					);
					// 取消检查（父代理或自己被取消）
					if (record.cancelled) {
						subagentMgr.markCancelled(taskId);
						if (wkRes.isWorktree && wkRes.worktreePath) {
							await worktreeMod.cleanupSubagentWorktree(opts.workspacePath, wkRes.worktreePath);
						}
						return { output: '[已取消]', success: false, error: '子任务被取消' };
					}
					subagentMgr.markCompleted(taskId, output);
					if (wkRes.isWorktree && wkRes.worktreePath) {
						await worktreeMod.cleanupSubagentWorktree(opts.workspacePath, wkRes.worktreePath);
					}
					return { output, success: true };
				} catch (e) {
					const errMsg = (e as Error).message;
					subagentMgr.markFailed(taskId, errMsg);
					if (wkRes.isWorktree && wkRes.worktreePath) {
						await worktreeMod.cleanupSubagentWorktree(opts.workspacePath, wkRes.worktreePath);
					}
					return { output: '', success: false, error: errMsg };
				}
			}

			// ── Background 任务：fire-and-forget，立即返回 taskId ─────
			subagentMgr.markRunning(taskId);
			void (async () => {
				try {
					const subHistory: MessageParam[] = [];
					const output = await runAgentLoop(
						subSessionId,
						userContent,
						subHistory,
						wkRes.effectiveWorkspacePath,
						subMode,
						'code',
					);
					if (record.cancelled) {
						subagentMgr.markCancelled(taskId);
					} else {
						subagentMgr.markCompleted(taskId, output);
					}
				} catch (e) {
					subagentMgr.markFailed(taskId, (e as Error).message);
				} finally {
					if (wkRes.isWorktree && wkRes.worktreePath) {
						await worktreeMod.cleanupSubagentWorktree(opts.workspacePath, wkRes.worktreePath);
					}
				}
			})();

			// 主代理拿到的 output：taskId + 状态查询提示
			const summary =
`已派出 background 子代理：
- task_id: ${taskId}
- subagent_type: ${resolvedName}
- isolation: ${wkRes.isWorktree ? `worktree (${wkRes.branchName})` : 'inherit'}
- 主代理可继续工作；后续可通过查询 task_id 拿到子代理结果。`;
			return { output: summary, success: true };
		} catch (e) {
			return { output: '', success: false, error: (e as Error).message };
		}
	};

	// 父任务取消时级联取消子代理
	server.sessionManager.onCancel(async (sessionId: string) => {
		const cancelled = server.sessionManager.subagentManager.cancelAllByParent(sessionId);
		if (cancelled.length > 0) {
			console.log(`[Subagent] 父任务 ${sessionId} 取消 → 级联取消 ${cancelled.length} 个子代理：${cancelled.join(', ')}`);
		}
	});

	// ─── 注册消息处理器 ────────────────────────────────────────────────────────

	server.sessionManager.onSendMessage(async (sessionId, _messageId, sendOpts) => {
		// 懒加载 API 历史（首次发消息时从磁盘读取）
		if (!sessionHistories.has(sessionId)) {
			const persisted = await server.sessionManager.loadHistory(sessionId);
			sessionHistories.set(sessionId, persisted as MessageParam[]);
		}
		const history = sessionHistories.get(sessionId)!;

		// 获取会话的工作区路径、模式、UI模式
		const workspacePath =
			server.sessionManager.getWorkspacePath(sessionId) ?? process.cwd();
		const sessionMode   = server.sessionManager.getMode(sessionId);
		const sessionUiMode = server.sessionManager.getSession(sessionId)?.uiMode ?? 'code';

		// 处理 @ 文件引用：解析消息中的 @path/to/file 并附加文件内容
		let userContent = sendOpts.content;
		const atMatches = userContent.match(/@([\S]+)/g);
		if (atMatches && atMatches.length > 0) {
			const fileContextParts: string[] = [];
			for (const match of atMatches) {
				const filePath = match.slice(1); // 去掉 @
				const absolutePath = path.isAbsolute(filePath)
					? filePath
					: path.resolve(workspacePath, filePath);
				try {
					const fileContent = fs.readFileSync(absolutePath, 'utf8');
					const relPath = path.relative(workspacePath, absolutePath);
					fileContextParts.push(`\`\`\`${relPath}\n${fileContent.slice(0, 10000)}\n\`\`\``);
					console.log(`[Agent] @ 引用文件: ${relPath} (${fileContent.length}字)`);
				} catch { /* 文件不存在则忽略 */ }
			}
			if (fileContextParts.length > 0) {
				userContent = `${userContent}\n\n【附加文件上下文】\n${fileContextParts.join('\n\n')}`;
			}
		}

		// 处理图片附件（base64 → Anthropic multi-modal content block）
		let userMessageContent: string | unknown[] = userContent;
		if (sendOpts.images && sendOpts.images.length > 0) {
			const contentBlocks: unknown[] = [{ type: 'text', text: userContent }];
			for (const b64 of sendOpts.images) {
				// 检测图片类型（默认 jpeg）
				const mediaType = b64.startsWith('/9j/') ? 'image/jpeg'
					: b64.startsWith('iVBOR') ? 'image/png'
					: b64.startsWith('R0lGOD') ? 'image/gif'
					: 'image/jpeg';
				contentBlocks.push({
					type: 'image',
					source: { type: 'base64', media_type: mediaType, data: b64 },
				});
			}
			userMessageContent = contentBlocks;
		}

		// 追加用户消息到历史
		history.push({ role: 'user', content: userMessageContent as any });

		// 通知前端：任务开始处理
		await server.sessionManager.emitEvent(sessionId, {
			type: 'task_status', sessionId, status: 'processing',
		});

		const taskStartTime = Date.now();

		try {
			// runAgentLoop 内部已将所有助手/工具消息推入 history，返回最终文本
			const fullText = await runAgentLoop(
				sessionId,
				userContent,  // 处理了 @ 引用后的内容
				history,
				workspacePath,
				sessionMode,
				sessionUiMode,
			);

			if (fullText) {
				// 仅写入 UI 消息列表（history 已在 runAgentLoop 内更新）
				await server.sessionManager.appendAssistantMessage(sessionId, fullText);
			}

			// 持久化完整 API 历史（含工具调用 / 结果 / 多轮对话）
			await server.sessionManager.saveHistory(sessionId, history);

			await server.sessionManager.emitEvent(sessionId, {
				type: 'completion', sessionId, resultSummary: fullText,
			});
		} catch (err) {
			console.error('[Maxian CLI] Agent 处理失败:', err);
			await server.sessionManager.emitEvent(sessionId, {
				type: 'error', sessionId, message: String((err as Error)?.message ?? err),
			});
			void pushAiCallLog({
				sessionId,
				uiMode: sessionUiMode,
				userContent,
				responseText: '',
				inputTokens: 0,
				outputTokens: 0,
				toolCallsCount: 0,
				durationMs: Date.now() - taskStartTime,
				status: 'failed',
				errorMessage: String((err as Error)?.message ?? err),
			});
		} finally {
			server.sessionManager.updateStats(sessionId, { status: 'idle' });
			await server.sessionManager.emitEvent(sessionId, {
				type: 'task_status', sessionId, status: 'completed',
			});
		}
	});

	// ─── 输出就绪信号 ─────────────────────────────────────────────────────────

	const aiTag = aiConfig
		? (aiConfig.type === 'anthropic'
			? `Anthropic (${(aiConfig as any).model})`
			: `代理 ${(aiConfig as any).apiUrl}`)
		: '模拟模式';
	console.log(`[Maxian CLI] AI 就绪 (${aiTag})，Agent 循环已启用，支持工具调用`);
	console.log(`[Maxian CLI] 可用工具: ${AGENT_TOOL_DEFINITIONS.map(t => t.name).join(', ')} (共 ${AGENT_TOOL_DEFINITIONS.length} 个)`);

	const readyInfo = {
		url:      listener.url.toString(),
		port:     listener.port,
		hostname: listener.hostname,
	};
	console.log(`maxian server listening on ${readyInfo.url}`);
	console.log(`__MAXIAN_READY__ ${JSON.stringify(readyInfo)}`);

	// 优雅关闭：收到 SIGINT / SIGTERM 时：
	//   1. 停心跳
	//   2. 关 Hono HTTP listener（有 2 秒超时，否则 SSE 长连会一直挂住）
	//   3. process.exit(0)
	// 3 秒硬超时兜底：即便 step 2 卡住也强制退出，保证端口释放
	let shuttingDown = false;
	const gracefulShutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[Maxian Server] 收到 ${signal}，正在优雅关闭…`);
		try { stopHeartbeat(); } catch { /* ignore */ }

		// 3 秒硬超时：保证进程一定退出，释放端口
		const hardKill = setTimeout(() => {
			console.warn('[Maxian Server] 优雅关闭超时 3 秒，强制 exit');
			process.exit(0);
		}, 3000);
		hardKill.unref();

		try {
			// 2 秒内 listener 必须关闭；超时就直接进下一步（不等 SSE 连接）
			await Promise.race([
				listener.stop(false),   // false = 不等 in-flight 请求完成，直接 close 监听 socket
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error('stop timeout')), 2000)),
			]);
			console.log('[Maxian Server] Hono listener 已关闭，端口已释放');
		} catch (e) {
			console.warn('[Maxian Server] listener 关闭超时或失败，将强制退出:', (e as Error).message);
		}

		// 尝试关数据库（可选，失败不阻塞退出）
		try {
			const { getDb } = await import('./database.js');
			getDb().close();
		} catch { /* ignore */ }

		clearTimeout(hardKill);
		process.exit(0);
	};

	process.on('SIGINT',  () => void gracefulShutdown('SIGINT'));
	process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

	// Windows 不支持 SIGTERM，但 CommandChild.kill() 会发 SIGBREAK 或直接结束进程
	// 补加一个 beforeExit 兜底，也能触发端口释放
	process.on('beforeExit', () => { if (!shuttingDown) void gracefulShutdown('beforeExit'); });

	// O4：Parent-death watcher（v0.2.28：改用 stdin EOF，替代不可靠的 process.kill 轮询）
	// 背景：Tauri spawn sidecar 时设 MAXIAN_KILL_ON_PARENT_DEATH=1。父进程（desktop）若被
	// kill -9 / 崩溃，Tauri 的 CloseRequested handler 不跑、sidecar 会变僵尸占住端口。
	// 旧方案每 3s 用 process.kill(parentPid, 0) 探父进程——但 **Bun on Windows 对【活着】的
	// 父进程也可能抛 ESRCH**，导致 sidecar 启动几秒后被自己误杀（端口变空、/health 连不上、
	// "启动失败"，Windows 高发，反复出现）。
	// 新方案：监听 stdin 的 EOF。Tauri 的 CommandChild 持有 sidecar 的 stdin 写端，父进程
	// 存活期间管道一直开着；父进程一旦死亡，OS 关闭写端 → sidecar 收到 stdin 'end'/'close'。
	// 这是 OS 级可靠信号，不受 process.kill 在 Windows 上误判的影响。
	// 防御：① 启动宽限期（前 8s）内收到 EOF 一律忽略——正常使用中父进程不可能在 sidecar 启动
	//        8s 内就死，此时的 EOF 只可能是管道初始化噪声；忽略后即便 watcher 退化失效，也只是
	//        变成"残留靠下次启动 kill_process_on_port 清理"，**绝不误杀**（误杀=启动失败，远更严重）。
	//      ② 只触发一次。
	if (process.env.MAXIAN_KILL_ON_PARENT_DEATH === '1') {
		console.log('[Maxian Server] Parent-death watcher 已启用（stdin EOF 模式）');
		const watcherStartedAt = Date.now();
		const PARENT_WATCH_GRACE_MS = 8000;
		let parentGoneHandled = false;
		const onParentGone = (reason: string): void => {
			if (parentGoneHandled || shuttingDown) return;
			if (Date.now() - watcherStartedAt < PARENT_WATCH_GRACE_MS) {
				console.log(`[Maxian Server] 启动宽限期内收到 stdin ${reason}，忽略（疑似管道初始化噪声，不自杀）`);
				return;
			}
			parentGoneHandled = true;
			console.log(`[Maxian Server] 父进程断开（stdin ${reason}），sidecar 自动关闭`);
			if (!shuttingDown) void gracefulShutdown('parent_death');
		};
		try {
			process.stdin.resume();   // 切到 flowing 模式，才能收到 'end'
			process.stdin.on('end',   () => onParentGone('end'));
			process.stdin.on('close', () => onParentGone('close'));
			process.stdin.on('error', () => { /* 忽略 stdin 错误，避免拖垮进程 */ });
		} catch (e) {
			console.warn('[Maxian Server] stdin parent-death watcher 启用失败（忽略，不影响运行）:', e);
		}
	}
}

main().catch((err) => {
	console.error('[Maxian Server] Fatal:', err);
	process.exit(1);
});
