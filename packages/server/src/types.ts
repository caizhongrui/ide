/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Shared Types
 *--------------------------------------------------------------------------------------------*/

/** HTTP server 监听配置 */
export interface ListenOptions {
	/** 监听端口（0 = 随机分配） */
	port: number;
	/** 监听地址（默认 127.0.0.1） */
	hostname?: string;
	/** 认证用户名（可选） */
	username?: string;
	/** 认证密码（可选，不设则不认证） */
	password?: string;
	/** 是否允许 CORS */
	cors?: string[] | boolean;
}

/** HTTP server 句柄 */
export interface Listener {
	/** 实际监听的 hostname */
	hostname: string;
	/** 实际监听的端口 */
	port: number;
	/** 完整 URL */
	url: URL;
	/** 底层 Node.js HTTP Server（供附加 WebSocket 使用） */
	httpServer: import('node:http').Server;
	/** 关闭服务器 */
	stop: (closeConnections?: boolean) => Promise<void>;
}

/** 健康检查结果 */
export interface HealthCheckResult {
	ok: boolean;
	version: string;
	uptime: number;
}

/** 会话摘要（供 REST API 使用） */
export interface SessionSummary {
	id: string;
	title: string;
	status: 'running' | 'done' | 'error' | 'idle';
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	workspacePath?: string;
	/** UI 模式：'code' = 代码模式，'chat' = 对话模式 */
	uiMode: 'code' | 'chat';
	/** 归档（软删除） */
	archived?: boolean;
	/** 置顶 */
	pinned?: boolean;
	/**
	 * K-MultiModel (v0.2.25)：用户在该会话选定的具体模型名
	 * （对应后端 ai_business_scene_model.model）。
	 * null/undefined 表示走 uiMode 对应 businessCode 的默认模型（fallback）。
	 */
	model?: string | null;
}

/** 工作区信息 */
export interface WorkspaceInfo {
	path: string;
	name: string;
	openedAt: number;
}

/* ════════════════════════════════════════════════════════════════════════
 *  批量任务 v0.2.16+
 *
 *  一个 batch = 用户一次提交的一组活儿。
 *  每个 task 跑起来后会创建一个 session（task.sessionId 关联）。
 *  task.status 跟 session.status 各管各的，task 维度更细（queued/skipped 等）。
 * ══════════════════════════════════════════════════════════════════════ */

/** 批次状态机 */
export type BatchStatus =
	| 'draft'         // 草稿（创建后未启动）
	| 'running'       // 跑中
	| 'paused'        // 用户主动暂停
	| 'awaiting_user' // 因任务失败暂停等用户决策（仅 on_failure='pause' 时）
	| 'completed'     // 全部任务结束
	| 'aborted';      // 用户取消整批

/** 单任务状态机 */
export type TaskStatus =
	| 'queued'      // 已排队
	| 'running'     // 跑中
	| 'completed'   // 成功
	| 'failed'      // 失败（待用户决策 / 已记录）
	| 'skipped'     // 用户主动跳过 OR on_failure='skip'
	| 'cancelled'   // 用户主动取消 / 整批 abort 牵连
	| 'stuck';      // 心跳超时（>10min 无活动）

/** 失败处理策略 */
export type OnFailureStrategy =
	| 'pause'        // 任务级：标记 failed 等用户决策；批次级默认值
	| 'skip'         // 自动跳过，继续下一个
	| 'retry'        // 自动重试（最多 max_retry 次后转 pause）
	| 'abort_batch'; // 整批取消

/** 批次完整记录（DB 行映射，camelCase）*/
export interface TaskBatch {
	id:             string;
	name:           string;
	description?:   string;
	createdAt:      number;
	updatedAt:      number;
	status:         BatchStatus;
	autoApprove:    boolean;
	maxConcurrency: number;
	onFailure:      OnFailureStrategy;
	tokenBudget?:   number;            // null = 无限
	totalTasks:     number;
	completedCount: number;
	failedCount:    number;
	skippedCount:   number;
	tokensUsed:     number;
}

/** 单任务完整记录（DB 行映射，camelCase）*/
export interface BatchTask {
	id:             string;
	batchId:        string;
	sessionId?:     string;            // 跑起来后填
	workspaceId:    string;
	title:          string;
	prompt:         string;
	mode:           string;            // 'code' | 'explore' | 'plan' | 'ask'
	template?:      string;
	position:       number;
	dependsOn?:     string[];          // task id 数组（DB 存 JSON）
	status:         TaskStatus;
	createdAt:      number;
	startedAt?:     number;
	finishedAt?:    number;
	lastHeartbeat?: number;
	onFailure?:     OnFailureStrategy; // null = 用 batch 默认
	failureReason?: string;
	failureAction?: 'retry' | 'skip' | 'abort_batch';   // 用户最近一次决策
	retryCount:     number;
	maxRetry:       number;
	tokensUsed:     number;
	resultSummary?: string;
	filesChanged?:  string[];
}

/** 创建批次的输入（API 接受） */
export interface CreateBatchInput {
	name:            string;
	description?:    string;
	autoApprove?:    boolean;          // 默认 true
	maxConcurrency?: number;           // 默认 3
	onFailure?:      OnFailureStrategy;// 默认 'pause'
	tokenBudget?:    number;
	tasks: Array<{
		workspaceId:  string;
		title:        string;
		prompt:       string;
		mode?:        string;          // 默认 'code'
		template?:    string;
		dependsOn?:   string[];
		onFailure?:   OnFailureStrategy;
		maxRetry?:    number;
	}>;
	/** 创建后立即启动？默认 false（保存为草稿）*/
	autoStart?:      boolean;
}
