/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Interface Barrel Export
 *
 *  所有平台相关能力的抽象接口统一从这里导出。
 *  Core 内部代码只能 import from '@maxian/core/interfaces'，
 *  严禁直接 import 'vscode' / 'fs' / 'child_process'。
 *--------------------------------------------------------------------------------------------*/

export type {
	IFileSystem,
	FileStat,
	FileEntry,
	DeleteOptions,
	ListFilesOptions,
	FileSystemErrorCode,
} from './IFileSystem.js';
export { FileSystemError } from './IFileSystem.js';

export type {
	ITerminal,
	ExecuteOptions,
	ExecuteResult,
	TerminalChunk,
} from './ITerminal.js';

export type { IWorkspace } from './IWorkspace.js';

export type {
	IMessageBus,
	IDisposable,
	MaxianEvent,
	MaxianCommand,
	AssistantMessageEvent,
	ReasoningEvent,
	ToolCallStartEvent,
	ToolCallArgsStreamingEvent,
	ToolCallResultEvent,
	TodoListUpdateEvent,
	TodoItem,
	TokenUsageEvent,
	TaskStatusEvent,
	ErrorEvent,
	FileChangeEvent,
	FileChangeSummary,
	CompletionEvent,
	// N1d 新增 9 种
	ToolApprovalRequestEvent,
	ToolInputDeltaEvent,
	ContextCompactingEvent,
	ContextCompactedEvent,
	ConvertReasoningToAssistantEvent,
	FollowupSuggestionsEvent,
	RateLimitEvent,
	RateLimitClearedEvent,
	TaskAbortedEvent,
} from './IMessageBus.js';

export type { IConfiguration } from './IConfiguration.js';

export type { IStorage, StorageScope } from './IStorage.js';

export type { IAuthProvider, AuthCredentials } from './IAuthProvider.js';

export type { ISkillService } from './ISkillService.js';

export type { IBehaviorReporter } from './IBehaviorReporter.js';
export { NoopBehaviorReporter } from './IBehaviorReporter.js';

export type { ITenantContext } from './ITenantContext.js';
export { LocalTenantContext } from './ITenantContext.js';

export type { IClock } from './IClock.js';
export { SystemClock } from './IClock.js';

export type { ILspService, LspDiagnostic, LspLocation } from './ILspService.js';

export type { IFileWatcher } from './IFileWatcher.js';

export type {
	ISearchService,
	SearchTextOptions,
	SearchTextMatch,
} from './ISearchService.js';

/**
 * 平台能力容器 — 所有接口的集合。
 * 使用方（IDE / Desktop / Cloud Worker）把各自的实现打包传给 Core。
 *
 * 必填字段（7 个）：所有形态必须实现
 * 可选字段（6 个）：按形态能力提供，core 内部按 truthy 检查使用
 */
export interface MaxianPlatform {
	// ── 必填 ─────────────────────────────────────────────
	fs: import('./IFileSystem.js').IFileSystem;
	terminal: import('./ITerminal.js').ITerminal;
	workspace: import('./IWorkspace.js').IWorkspace;
	messageBus: import('./IMessageBus.js').IMessageBus;
	config: import('./IConfiguration.js').IConfiguration;
	storage: import('./IStorage.js').IStorage;
	auth: import('./IAuthProvider.js').IAuthProvider;

	// ── 可选 ─────────────────────────────────────────────
	/** 外部文件变更监听（stale-overwrite 检测增强可选用） */
	fileWatcher?: import('./IFileWatcher.js').IFileWatcher;
	/** Skills 加载（项目级 SKILLS.md 等） */
	skills?: import('./ISkillService.js').ISkillService;
	/** 行为埋点上报（生产可空实现 NoopBehaviorReporter） */
	reporter?: import('./IBehaviorReporter.js').IBehaviorReporter;
	/** 多租户上下文（云端 worker 必填，本地形态可省 = LocalTenantContext） */
	tenant?: import('./ITenantContext.js').ITenantContext;
	/** 可注入时钟（默认 SystemClock，测试 / 回放可注入 FakeClock） */
	clock?: import('./IClock.js').IClock;
	/** LSP 能力（IDE 形态特有；Desktop / Web 等无此能力） */
	lsp?: import('./ILspService.js').ILspService;
	/**
	 * 内容搜索服务（ripgrep / vscode searchService 抽象）。
	 * 未注入时，core 的 searchFilesTool 将退回到 NodeSearchService（子进程 ripgrep）。
	 * IDE 必须注入 VSCodeSearchService 以复用 vscode 内置 ripgrep + ignoreFiles 等能力。
	 */
	search?: import('./ISearchService.js').ISearchService;
}
