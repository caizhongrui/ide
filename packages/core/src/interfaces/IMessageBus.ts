/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Message Bus (Event Stream) Abstraction
 *--------------------------------------------------------------------------------------------*/

/**
 * 消息总线抽象接口。
 *
 * 核心职责：把 Agent 执行过程中的事件流推送给 UI 层。
 *
 * 实现方：
 * - IDE：基于 VSCode Emitter（同进程，同步回调）
 * - Desktop：基于 Tauri IPC（跨进程，异步 JSON Lines 传输）
 */
export interface IMessageBus {
	/**
	 * 发送事件到 UI 层。
	 * Core 内部调用此方法广播各种事件（工具调用、流式响应等）。
	 */
	emit(event: MaxianEvent): void;

	/**
	 * 监听来自 UI 的命令。
	 * 如用户主动取消任务、切换模式等。
	 */
	onCommand(handler: (command: MaxianCommand) => void): IDisposable;
}

/** 可销毁对象 */
export interface IDisposable {
	dispose(): void;
}

/** Core → UI 的事件类型（联合类型，按 type 字段区分） */
export type MaxianEvent =
	| AssistantMessageEvent
	| ReasoningEvent
	| ToolCallStartEvent
	| ToolCallArgsStreamingEvent
	| ToolCallResultEvent
	| TodoListUpdateEvent
	| TokenUsageEvent
	| TaskStatusEvent
	| ErrorEvent
	| FileChangeEvent
	| CompletionEvent
	// ── N1d 补齐 server 实际广播但 union 之前缺的 8 种事件 ────────
	| ToolApprovalRequestEvent
	| ToolInputDeltaEvent
	| ContextCompactingEvent
	| ContextCompactedEvent
	| ConvertReasoningToAssistantEvent
	| FollowupSuggestionsEvent
	| RateLimitEvent
	| RateLimitClearedEvent
	| TaskAbortedEvent;

/** AI 助手消息（流式文本） */
export interface AssistantMessageEvent {
	type: 'assistant_message';
	sessionId: string;
	content: string;
	/** 是否为流式中间结果（true = 正在流式输出，false = 已完成） */
	isPartial: boolean;
}

/** 思考过程（reasoning） */
export interface ReasoningEvent {
	type: 'reasoning';
	sessionId: string;
	content: string;
	isPartial: boolean;
}

/** 工具调用开始 */
export interface ToolCallStartEvent {
	type: 'tool_call_start';
	sessionId: string;
	toolUseId: string;
	toolName: string;
}

/** 工具参数流式构建（展示给用户看的进度） */
export interface ToolCallArgsStreamingEvent {
	type: 'tool_call_args_streaming';
	sessionId: string;
	toolUseId: string;
	toolName: string;
	partialArgs: string;
}

/** 工具调用结果 */
export interface ToolCallResultEvent {
	type: 'tool_call_result';
	sessionId: string;
	toolUseId: string;
	toolName: string;
	success: boolean;
	result: string;
	errorMessage?: string;
}

/** TODO 列表更新 */
export interface TodoListUpdateEvent {
	type: 'todo_list_update';
	sessionId: string;
	todos: TodoItem[];
}

export interface TodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/** Token 使用量更新 */
export interface TokenUsageEvent {
	type: 'token_usage';
	sessionId: string;
	inputTokens: number;
	outputTokens: number;
	contextTokens: number;
	totalCost?: number;
}

/** 任务状态变化 */
export interface TaskStatusEvent {
	type: 'task_status';
	sessionId: string;
	status: 'pending' | 'processing' | 'completed' | 'error' | 'aborted';
}

/** 错误事件 */
export interface ErrorEvent {
	type: 'error';
	sessionId: string;
	message: string;
	code?: string;
}

/** 文件变更通知 */
export interface FileChangeEvent {
	type: 'file_change';
	sessionId: string;
	changes: FileChangeSummary[];
}

export interface FileChangeSummary {
	path: string;
	action: 'created' | 'modified' | 'deleted';
	linesAdded?: number;
	linesRemoved?: number;
}

/** 任务完成事件 */
export interface CompletionEvent {
	type: 'completion';
	sessionId: string;
	resultSummary?: string;
}

// ─────────────────────────────────────────────────────────────────
// N1d 新增事件类型（与 maxian-server 实际广播一致）
// ─────────────────────────────────────────────────────────────────

/** 工具调用需要用户审批 */
export interface ToolApprovalRequestEvent {
	type: 'tool_approval_request';
	sessionId: string;
	toolUseId: string;
	toolName: string;
	params?: Record<string, unknown>;
	/** 风险描述（destructive / network / fs-write 等） */
	risk?: string;
}

/** 工具参数流式构建（AI tokenizer 边出 token 边构造 JSON） */
export interface ToolInputDeltaEvent {
	type: 'tool_input_delta';
	sessionId: string;
	toolUseId: string;
	toolName: string;
	partialArgs: string;
}

/** 上下文压缩开始 */
export interface ContextCompactingEvent {
	type: 'context_compacting';
	sessionId: string;
	beforeTokens: number;
}

/** 上下文压缩完成 */
export interface ContextCompactedEvent {
	type: 'context_compacted';
	sessionId: string;
	beforeTokens: number;
	afterTokens: number;
	tokensFreed: number;
}

/** 思考块（reasoning）转为正式 assistant 消息 */
export interface ConvertReasoningToAssistantEvent {
	type: 'convert_reasoning_to_assistant';
	sessionId: string;
	toolUseId: string;
}

/** AI 给出的追问建议 */
export interface FollowupSuggestionsEvent {
	type: 'followup_suggestions';
	sessionId: string;
	suggestions: string[];
}

/** 触发 LLM 限流，正在退避重试 */
export interface RateLimitEvent {
	type: 'rate_limit';
	sessionId: string;
	/** 重试时间戳（毫秒） */
	resetAt: number;
	/** 第几次重试 */
	attempt: number;
	message?: string;
}

/** 限流已解除，恢复正常 */
export interface RateLimitClearedEvent {
	type: 'rate_limit_cleared';
	sessionId: string;
}

/** 任务被取消的明确广播信号（与 task_status:aborted 配套，前端用作 1500ms 事件丢弃窗口起点） */
export interface TaskAbortedEvent {
	type: 'task_aborted';
	sessionId: string;
	reason?: string;
}

/** UI → Core 的命令类型 */
export type MaxianCommand =
	| { type: 'send_message'; sessionId: string; text: string; images?: string[] }
	| { type: 'cancel_task'; sessionId: string }
	| { type: 'approve_tool'; sessionId: string; toolUseId: string; approved: boolean; feedback?: string }
	| { type: 'switch_mode'; sessionId: string; mode: 'code' | 'ask' | 'debug' | 'architect' | 'solo' }
	| { type: 'resume_task'; sessionId: string };
