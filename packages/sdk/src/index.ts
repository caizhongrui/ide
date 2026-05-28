/*---------------------------------------------------------------------------------------------
 *  Maxian SDK — HTTP Client for @maxian/server
 *--------------------------------------------------------------------------------------------*/

export interface ClientOptions {
	baseUrl: string;
	username?: string;
	password?: string;
	fetch?: typeof fetch;
	/**
	 * 显式声明客户端协议版本（写入 X-Maxian-Protocol header）。
	 * 不传 = 不发该 header，避免 vscode-file:// 等严苛 origin 下的 CORS preflight 问题。
	 * server 总是把自己的协议版本写在 response header（X-Maxian-Protocol），客户端可读后校验。
	 */
	protocolVersion?: string;
}

/** 持久化存储的 UI 消息（从 GET /sessions/:id/messages 返回） */
export interface StoredMessage {
	id: string;
	role: 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'reasoning';
	content: string;
	createdAt: number;
	/** K-ImageHistory (v0.2.25)：附加元数据，images = 图片 dataUrl 数组（切会话后还原缩略图） */
	metadata?: { images?: string[] } | null;
}

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
	uiMode: 'code' | 'chat';
	archived?: boolean;
	pinned?: boolean;
	/**
	 * K-MultiModel (v0.2.25)：会话绑定的具体模型名（对应 ai_business_scene_model.model）。
	 * null/undefined 表示走该 uiMode 对应 businessCode 的默认模型。
	 */
	model?: string | null;
}

export interface Workspace {
	id: string;
	path: string;
	name: string;
	openedAt: number;
}

export interface MaxianEvent {
	type: string;
	sessionId: string;
	[key: string]: unknown;
}

/* ════════════════════════════════════════════════════════════════════════
 *  批量任务（v0.2.16+）
 * ══════════════════════════════════════════════════════════════════════ */

export type BatchStatus =
	| 'draft' | 'running' | 'paused' | 'awaiting_user' | 'completed' | 'aborted';

export type TaskStatus =
	| 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'stuck';

export type OnFailureStrategy = 'pause' | 'skip' | 'retry' | 'abort_batch';

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
	tokenBudget?:   number;
	totalTasks:     number;
	completedCount: number;
	failedCount:    number;
	skippedCount:   number;
	tokensUsed:     number;
}

export interface BatchTask {
	id:             string;
	batchId:        string;
	sessionId?:     string;
	workspaceId:    string;
	title:          string;
	prompt:         string;
	mode:           string;
	template?:      string;
	position:       number;
	dependsOn?:     string[];
	status:         TaskStatus;
	createdAt:      number;
	startedAt?:     number;
	finishedAt?:    number;
	lastHeartbeat?: number;
	onFailure?:     OnFailureStrategy;
	failureReason?: string;
	failureAction?: 'retry' | 'skip' | 'abort_batch';
	retryCount:     number;
	maxRetry:       number;
	tokensUsed:     number;
	resultSummary?: string;
	filesChanged?:  string[];
}

export interface CreateBatchInput {
	name:            string;
	description?:    string;
	autoApprove?:    boolean;
	maxConcurrency?: number;
	onFailure?:      OnFailureStrategy;
	tokenBudget?:    number;
	autoStart?:      boolean;
	tasks: Array<{
		workspaceId:  string;
		title:        string;
		prompt:       string;
		mode?:        string;
		template?:    string;
		dependsOn?:   string[];
		onFailure?:   OnFailureStrategy;
		maxRetry?:    number;
	}>;
}

export type BatchEvent =
	| { type: 'task_status_changed'; taskId: string; status: TaskStatus; failureReason?: string }
	| { type: 'task_progress';       taskId: string; tokensUsed: number }
	| { type: 'batch_progress';      completedCount: number; failedCount: number; skippedCount: number; tokensUsed: number }
	| { type: 'batch_status_changed'; status: BatchStatus }
	| { type: 'task_heartbeat';      taskId: string; lastHeartbeat: number };

export interface HealthResult {
	ok: boolean;
	version: string;
	uptime: number;
}

/* ──────────── B3: Auto-Memory 类型 ──────────── */

export type MemoryScope    = 'global' | 'workspace' | 'session';
export type MemoryCategory = 'preference' | 'convention' | 'fact' | 'style' | 'tech-stack' | 'other';
export type MemorySource   = 'auto' | 'manual';

export interface MemoryRecord {
	id:             string;
	scope:          MemoryScope;
	workspaceId?:   string;
	sessionId?:     string;
	category:       MemoryCategory;
	content:        string;
	source:         MemorySource;
	starred:        boolean;
	createdAt:      number;
	lastAccessedAt: number;
	accessCount:    number;
}

/* ──────────── B1: Subagent 类型 ──────────── */

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentRecord {
	taskId:            string;
	parentSessionId:   string;
	subagentSessionId: string;
	subagentType:      string;
	description?:      string;
	isolation:         'inherit' | 'worktree';
	background:        boolean;
	status:            SubagentStatus;
	createdAt:         number;
	startedAt?:        number;
	finishedAt?:       number;
	error?:            string;
	output?:           string;
	worktreePath?:     string;
	worktreeBranch?:   string;
}

/* ──────────── B4: Codebase Index 类型 ──────────── */

export type CodebaseSymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'const' | 'export' | 'other';

export interface CodebaseFileNode {
	path:    string;
	purpose: string;
	loc:     number;
	mtime:   number;
}

export interface CodebaseApiEntry {
	id?:         number;
	filePath:    string;
	symbolName:  string;
	symbolKind:  CodebaseSymbolKind;
	signature?:  string;
	docstring?:  string;
	startLine:   number;
	endLine:     number;
}

export interface CodebaseModuleSummary {
	dirPath:  string;
	summary:  string;
	keyFiles: string[];
}

export interface CodebaseDepsEntry {
	from:  string;
	to:    string;
	count: number;
}

export interface CodebaseIndexSnapshot {
	workspaceId:    string;
	workspacePath:  string;
	lastIndexedAt:  number;
	fileCount:      number;
	apiCount:       number;
	moduleCount:    number;
	architecture?:  string;
	tree:           CodebaseFileNode[];
	modules:        CodebaseModuleSummary[];
	deps:           CodebaseDepsEntry[];
}

export interface CodebaseSearchHit {
	entry: CodebaseApiEntry;
	score: number;
}

/**
 * K-MultiModel (v0.2.25)：某 businessCode 场景下的一行候选模型。
 * 对应后端 ai_business_scene_model 表。
 */
export interface SceneModel {
	id:             number;
	businessCode:   string;
	provider:       string;
	model:          string;          // 用户面选择的唯一 ID（同一 businessCode 内唯一）
	isDefault:      number;          // 0 / 1
	priority?:      number;
	temperature?:   number;
	maxTokens?:     number;
	supportVision?: number;          // 0 / 1
	contextWindow?: number;
}

export class MaxianClient {
	private readonly baseUrl: string;
	private readonly auth?: string;
	private readonly authQuery?: string; // base64(user:pass) for EventSource ?auth=
	private readonly fetchFn: typeof fetch;
	private readonly protocolVersion?: string;

	constructor(opts: ClientOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/$/, '');
		if (opts.username && opts.password) {
			const encoded = btoa(`${opts.username}:${opts.password}`);
			this.auth = 'Basic ' + encoded;
			this.authQuery = encoded;
		}
		this.fetchFn         = opts.fetch ?? fetch;
		this.protocolVersion = opts.protocolVersion;
	}

	private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		// 仅当 caller 显式声明 protocolVersion 时才发该 header
		// （避免 vscode-file:// 等 origin 下浏览器 CORS preflight 的 cache 异常）
		if (this.protocolVersion) {
			headers['X-Maxian-Protocol'] = this.protocolVersion;
		}
		if (this.auth) headers['Authorization'] = this.auth;
		const res = await this.fetchFn(`${this.baseUrl}${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`[${res.status}] ${path}: ${text || res.statusText}`);
		}
		if (res.status === 204) return undefined as T;
		// 使用 text() + JSON.parse：Tauri plugin-http 下 res.json() 对大 body 偶尔挂起
		const text = await res.text();
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch (e) {
			throw new Error(`[${res.status}] ${path}: 响应 JSON 解析失败 (${(e as Error).message})`);
		}
	}

	async health(): Promise<HealthResult> {
		return this.request('GET', '/health');
	}

	async listSessions(): Promise<{ sessions: SessionSummary[] }> {
		return this.request('GET', '/sessions');
	}

	async createSession(opts: { title?: string; workspacePath: string; mode?: string; uiMode?: 'code' | 'chat' }): Promise<SessionSummary> {
		return this.request('POST', '/sessions', opts);
	}

	async renameSession(id: string, title: string): Promise<SessionSummary> {
		return this.request('PATCH', `/sessions/${id}`, { title });
	}

	/** 更新会话模式（code / ask / plan / ...） */
	async updateSessionMode(id: string, mode: string): Promise<SessionSummary> {
		return this.request('PATCH', `/sessions/${id}`, { mode });
	}

	async getSessionMessages(
		id: string,
		opts?: { limit?: number; before?: number }
	): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
		const qs = new URLSearchParams();
		if (opts?.limit  !== undefined) qs.set('limit',  String(opts.limit));
		if (opts?.before !== undefined) qs.set('before', String(opts.before));
		const q = qs.toString() ? `?${qs}` : '';
		return this.request('GET', `/sessions/${id}/messages${q}`);
	}

	async deleteSession(id: string): Promise<void> {
		await this.request('DELETE', `/sessions/${id}`);
	}

	/**
	 * 清空会话内容（messages + history_entries），保留 session 本身。
	 * 给 /clear 命令用——清空后继续聊，AI 不再"记得"之前内容。
	 */
	async clearSessionContent(id: string): Promise<{ ok: boolean; deletedMessages: number; deletedHistory: number }> {
		return this.request('POST', `/sessions/${id}/clear`);
	}

	// ─── K-MultiModel (v0.2.25) ──────────────────────────────────────────

	/**
	 * 拉取某 businessCode 场景下的所有候选模型。
	 * 透传 sidecar /scene-models/:code（sidecar 2 min 内存缓存 + 同步 sceneModelCache）。
	 *
	 * @param businessCode 业务场景代码，如 'IDE_CHAT_CODE' / 'IDE_CHAT_ASK'
	 */
	async listSceneModels(businessCode: string): Promise<{
		models:  SceneModel[];
		cached:  boolean;
		error?:  string;
	}> {
		return this.request('GET', `/scene-models/${encodeURIComponent(businessCode)}`);
	}

	/**
	 * 设置会话绑定的模型名。null 表示走该 uiMode 对应 businessCode 的默认模型。
	 */
	async setSessionModel(sid: string, model: string | null): Promise<void> {
		await this.request('PATCH', `/sessions/${sid}/model`, { model });
	}

	async sendMessage(sessionId: string, opts: { content: string; images?: string[] }): Promise<{ messageId: string }> {
		return this.request('POST', `/sessions/${sessionId}/messages`, opts);
	}

	async cancelTask(sessionId: string): Promise<void> {
		await this.request('POST', `/sessions/${sessionId}/cancel`);
	}

	/** 批准或拒绝工具调用权限请求 */
	async approveToolCall(sessionId: string, toolUseId: string, approved: boolean, feedback?: string): Promise<void> {
		await this.request('POST', `/sessions/${sessionId}/approve`, { toolUseId, approved, feedback });
	}

	/**
	 * 获取会话中被修改的文件列表。
	 * - files: 兼容旧版只返回路径列表
	 * - details: 含 action ('created' | 'modified' | 'deleted')，每个 path 取最近一次状态
	 */
	async getChangedFiles(sessionId: string): Promise<{
		files: string[];
		details?: Array<{ path: string; action: 'created' | 'modified' | 'deleted' }>;
	}> {
		return this.request('GET', `/sessions/${sessionId}/changed-files`);
	}

	/** 将指定文件恢复到会话开始前的状态（文件快照） */
	async revertFile(sessionId: string, filePath: string): Promise<{ ok: boolean; error?: string }> {
		return this.request('POST', `/sessions/${sessionId}/revert`, { path: filePath });
	}

	/**
	 * O3：重算所有会话的 token 用量（按 history 内容估算）。
	 * @param force true = 不论原值是否为 0，全部重新覆盖；false = 仅对 0 值会话回填
	 */
	async recalculateAllSessionTokens(force = false): Promise<{ ok: boolean; touched: number; force: boolean }> {
		return this.request('POST', '/sessions/recalculate-tokens', { force });
	}

	/**
	 * O1：清除会话的工具失败记忆 - 删除 history 里所有 tool_result 错误条目。
	 * 用于解决"底层修复后 AI 仍按旧错误推理"的问题（如 require is not defined / Binary File 误判）。
	 */
	async pruneToolErrors(sessionId: string): Promise<{ ok: boolean; pruned: number; before: number; after: number; error?: string }> {
		return this.request('POST', `/sessions/${sessionId}/prune-tool-errors`);
	}

	/** 获取文件变更 diff（原始快照内容 vs 当前磁盘内容） */
	async getFileDiff(sessionId: string, filePath: string): Promise<{ original: string | null; current: string }> {
		return this.request('GET', `/sessions/${sessionId}/file-diff?path=${encodeURIComponent(filePath)}`);
	}

	/** 分叉会话：复制消息历史到新会话 */
	async forkSession(sessionId: string): Promise<{ ok: boolean; session?: SessionSummary }> {
		return this.request('POST', `/sessions/${sessionId}/fork`);
	}

	/** 回退到指定消息（删除该消息及其后所有消息） */
	async revertToMessage(sessionId: string, messageId: string): Promise<{ ok: boolean; deleted: number; newMsgCount: number; error?: string }> {
		return this.request('POST', `/sessions/${sessionId}/revert-to`, { messageId });
	}

	/** 回答 Agent 的 question 工具提问 */
	async answerQuestion(sessionId: string, opts: { answer?: string; selected?: string[]; cancelled?: boolean }): Promise<void> {
		await this.request('POST', `/sessions/${sessionId}/answer-question`, opts);
	}

	/** 响应 Agent 的 plan_exit 请求 */
	async respondPlanExit(sessionId: string, approved: boolean, feedback?: string): Promise<void> {
		await this.request('POST', `/sessions/${sessionId}/plan-exit`, { approved, feedback });
	}

	/** 手动触发上下文压缩（/compact 命令）*/
	async compactSession(sessionId: string): Promise<{
		ok: boolean; level: number; tokensBefore: number; tokensAfter: number;
		prunedTools: number; summarizedMsgs: number; error?: string;
	}> {
		return this.request('POST', `/sessions/${sessionId}/compact`);
	}

	/** 归档 / 取消归档 */
	async setSessionArchived(sessionId: string, archived: boolean): Promise<{ ok: boolean; session?: SessionSummary }> {
		return this.request('POST', `/sessions/${sessionId}/archive`, { archived });
	}

	/** 置顶 / 取消置顶 */
	async setSessionPinned(sessionId: string, pinned: boolean): Promise<{ ok: boolean; session?: SessionSummary }> {
		return this.request('POST', `/sessions/${sessionId}/pin`, { pinned });
	}

	/** 删除单条消息 */
	async deleteMessage(sessionId: string, messageId: string): Promise<{ deleted: boolean }> {
		return this.request('DELETE', `/sessions/${sessionId}/messages/${messageId}`);
	}

	/** 编辑用户消息（并删除其后所有消息） */
	async editUserMessage(sessionId: string, messageId: string, content: string): Promise<{ ok: boolean; deletedAfter: number; error?: string }> {
		return this.request('PATCH', `/sessions/${sessionId}/messages/${messageId}`, { content });
	}

	/** 从指定消息重新生成（删除其后消息，由前端再触发一次 send 重跑） */
	async regenerateFromMessage(sessionId: string, messageId: string): Promise<{ ok: boolean; kept: number; deleted: number; promptUserId: string | null }> {
		return this.request('POST', `/sessions/${sessionId}/messages/${messageId}/regenerate`);
	}

	/** 从指定消息 fork 出新会话 */
	async forkFromMessage(sessionId: string, messageId: string): Promise<{ ok: boolean; newSessionId?: string }> {
		return this.request('POST', `/sessions/${sessionId}/messages/${messageId}/fork`);
	}

	/**
	 * 订阅会话 SSE 事件流。
	 *
	 * 使用 XMLHttpRequest 代替 fetch + ReadableStream：
	 *  - XHR 不被 Tauri HTTP plugin 拦截，能在 WKWebView 中做真正的流式读取
	 *  - 通过 onprogress 逐块处理 SSE 数据
	 *  - 自动重连 + 指数退避，最大 16 秒
	 *  - auth 通过 ?auth= 查询参数传递（loopback）或 Authorization header（远程）
	 */
	subscribeEvents(sessionId: string, onEvent: (e: MaxianEvent) => void, onError?: (e: unknown) => void): () => void {
		const qs = this.authQuery ? `?auth=${encodeURIComponent(this.authQuery)}` : '';
		const url = `${this.baseUrl}/sessions/${sessionId}/events${qs}`;
		const isLoopback = /127\.0\.0\.1|localhost|\[::1\]/.test(this.baseUrl);

		let aborted = false;
		let currentAbort: AbortController | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let delay = 250;

		// ⚠️ 重要：换掉 XMLHttpRequest 实现 → fetch + ReadableStream
		//
		// 为什么换：XMLHttpRequest.responseText 会**累积整个 SSE 流的完整文本**
		// 直到连接关闭。一个长任务（30 分钟以上）SSE 总流量轻松几百 MB，
		// 这些数据全部 pin 在 xhr.responseText 上无法 GC，是 webview OOM 的真正凶手。
		//
		// fetch + body.getReader() 是 chunked stream 模式，每个 chunk 读完即释放，
		// 不累积历史。同样的连接长跑，内存占用稳定在几 KB 级别。
		const connect = async () => {
			if (aborted) return;
			const ac = new AbortController();
			currentAbort = ac;

			const headers: Record<string, string> = {
				'Accept':       'text/event-stream',
				'Cache-Control':'no-cache',
			};
			if (this.auth && !isLoopback) headers['Authorization'] = this.auth;

			let buf = '';
			try {
				const res = await this.fetchFn(url, { headers, signal: ac.signal });
				if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
				const body = res.body;
				if (!body) throw new Error('SSE no body stream');
				const reader = body.getReader();
				const decoder = new TextDecoder('utf-8');

				while (true) {
					if (aborted) { try { await reader.cancel(); } catch { /* ignore */ } break; }
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });

					// 按双换行分割事件块
					const blocks = buf.split('\n\n');
					buf = blocks.pop() ?? '';

					for (const block of blocks) {
						if (!block.trim()) continue;
						for (const line of block.split('\n')) {
							if (line.startsWith('data:')) {
								const data = line.slice(5).trim();
								if (data && data !== '[DONE]') {
									try { onEvent(JSON.parse(data) as MaxianEvent); } catch (e) { onError?.(e); }
								}
							}
						}
					}
				}

				if (!aborted) {
					// 服务端关闭连接 → 立即重连（重置 delay）
					delay = 250;
					retryTimer = setTimeout(connect, delay);
				}
			} catch (err) {
				if (aborted || (err as any)?.name === 'AbortError') return;
				onError?.(err);
				retryTimer = setTimeout(() => {
					delay = Math.min(delay * 2, 16000);
					connect();
				}, delay);
			}
		};

		connect();

		return () => {
			aborted = true;
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			currentAbort?.abort();
			currentAbort = null;
		};
	}

	async listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
		return this.request('GET', '/workspaces');
	}

	async addWorkspace(path: string): Promise<Workspace> {
		return this.request('POST', '/workspaces', { path });
	}

	async renameWorkspace(id: string, name: string): Promise<Workspace> {
		return this.request('PATCH', `/workspaces/${id}`, { name });
	}

	async removeWorkspace(id: string): Promise<void> {
		await this.request('DELETE', `/workspaces/${id}`);
	}

	async listFiles(workspaceId: string, pattern?: string): Promise<{ files: string[] }> {
		const qs = pattern ? `?pattern=${encodeURIComponent(pattern)}` : '';
		return this.request('GET', `/workspaces/${workspaceId}/files${qs}`);
	}

	/** 读取项目级配置 + 自定义 agent / command */
	async getProjectConfig(workspaceId: string): Promise<{
		config: {
			defaultBusinessCode?: string;
			permissions?: any;
			model?: { temperature?: number; topP?: number; maxTokens?: number };
			additionalSystemPrompt?: string;
			plugins?: string[];
			disabledTools?: string[];
		};
		agents: Array<{ name: string; description: string; systemPrompt: string; tools?: string[]; model?: string; temperature?: number; topP?: number }>;
		commands: Array<{ name: string; description: string; template: string; agent?: string }>;
	}> {
		return this.request('GET', `/workspaces/${workspaceId}/project-config`);
	}

	/** 全局符号 + 文件名搜索（⌘P 命令面板用）*/
	async searchSymbols(workspaceId: string, query: string): Promise<{
		symbols: Array<{ name: string; kind?: number; location?: any; containerName?: string }>;
		files:   string[];
	}> {
		return this.request('GET', `/workspaces/${workspaceId}/symbols?q=${encodeURIComponent(query)}`);
	}

	/** 读取工作区任意文件，用于预览面板
	 *  - 文本文件：encoding='utf8'，content=文件文本
	 *  - 图片/音视频：encoding='base64'，content=base64 数据（isImage/isAudio/isVideo 指示类型）
	 *  - 二进制：encoding='none'，content=''，isBinary=true
	 *  - 文件过大或出错：带 error 字段（仍返回 200）
	 */
	async readFileContent(workspaceId: string, filePath: string): Promise<{
		path:         string;
		absolutePath: string;
		size:         number;
		mimeType:     string;
		isBinary:     boolean;
		isImage:      boolean;
		isAudio:      boolean;
		isVideo:      boolean;
		encoding:     'utf8' | 'base64' | 'none';
		content:      string;
		error?:       string;
	}> {
		return this.request(
			'GET',
			`/workspaces/${workspaceId}/file-content?path=${encodeURIComponent(filePath)}`,
		);
	}

	/** 写入文件内容（P0-2: 应用代码到文件；保留 CRLF 风格；支持 mtime 冲突检测）
	 *  - createIfMissing 默认 true；若为 false 且文件不存在，返回 404
	 *  - expectedMtimeMs：若提供，写入前对比；若 mtime 不匹配，返回 409（文件被外部修改）
	 */
	async writeFileContent(workspaceId: string, filePath: string, content: string, opts?: {
		createIfMissing?: boolean;
		expectedMtimeMs?: number;
	}): Promise<{
		ok:           true;
		path:         string;
		absolutePath: string;
		size:         number;
		mtimeMs:      number;
		created:      boolean;
	}> {
		return this.request(
			'POST',
			`/workspaces/${workspaceId}/file-write`,
			{ path: filePath, content, ...(opts ?? {}) },
		);
	}

	/** 查询文件 mtime/size（P0-4: 外部变更检测） */
	async getFileStat(workspaceId: string, filePath: string): Promise<{
		path:         string;
		absolutePath: string;
		size:         number;
		mtimeMs:      number;
		exists:       boolean;
	}> {
		return this.request(
			'GET',
			`/workspaces/${workspaceId}/file-stat?path=${encodeURIComponent(filePath)}`,
		);
	}

	/** 列出工作区可用的 Skills（扫描 .maxian/skills/ 、.claude/skills/ 及用户级目录） */
	async listSkills(workspaceId: string): Promise<{
		skills: Array<{
			name:        string;
			description: string;
			path:        string;
			source:      'workspace-maxian' | 'workspace-claude' | 'user-maxian' | 'user-claude';
			size:        number;
		}>;
		searchedDirs: Array<{ path: string; source: string; exists: boolean }>;
	}> {
		return this.request('GET', `/workspaces/${workspaceId}/skills`);
	}

	/** Git Worktree 相关 */
	async listWorktrees(workspaceId: string): Promise<{ worktrees: Array<{ path: string; branch: string; head: string; locked: boolean }> }> {
		return this.request('GET', `/workspaces/${workspaceId}/worktrees`);
	}

	async listBranches(workspaceId: string): Promise<{ branches: string[] }> {
		return this.request('GET', `/workspaces/${workspaceId}/branches`);
	}

	async createWorktree(workspaceId: string, opts: { branch: string; newBranch?: string; worktreePath?: string }): Promise<{ ok: boolean; path?: string; error?: string }> {
		return this.request('POST', `/workspaces/${workspaceId}/worktrees`, opts);
	}

	async removeWorktree(workspaceId: string, worktreePath: string): Promise<{ ok: boolean; error?: string }> {
		return this.request('DELETE', `/workspaces/${workspaceId}/worktrees`, { worktreePath });
	}

	/** 获取工作区当前 git 分支 */
	async getCurrentBranch(workspaceId: string): Promise<{ branch: string | null; isGitRepo: boolean; error?: string }> {
		return this.request('GET', `/workspaces/${workspaceId}/current-branch`);
	}

	/** 检出 git 分支 */
	async checkoutBranch(workspaceId: string, branch: string): Promise<{ ok: boolean; error?: string }> {
		return this.request('POST', `/workspaces/${workspaceId}/checkout`, { branch });
	}

	/** 配置服务端的 AI 代理（登录后调用，凭据在服务端运行时生效） */
	async configureAi(opts: { apiUrl: string; username: string; password: string }): Promise<void> {
		await this.request('POST', '/auth/configure', opts);
	}

	/** 清除服务端 AI 代理配置（登出时调用） */
	async clearAiConfig(): Promise<void> {
		await this.request('DELETE', '/auth/configure');
	}

	/** 查询服务端 AI 配置状态 */
	async getAiStatus(): Promise<{ configured: boolean; apiUrl: string | null }> {
		return this.request('GET', '/auth/status');
	}

	async listTools(): Promise<{ tools: string[] }> {
		return this.request('GET', '/tools');
	}

	async executeTool(opts: { name: string; params: Record<string, unknown>; toolUseId?: string }): Promise<unknown> {
		return this.request('POST', '/tools/execute', opts);
	}

	/* ──────────── B2: MCP 服务器配置 ──────────── */

	/**
	 * 拉取当前 sidecar 持有的 MCP 配置 + 各服务器的运行时连接状态。
	 */
	async getMcpConfig(): Promise<{
		configs: Array<{ name: string; url: string; headers?: Record<string, string>; enabled: boolean; description?: string }>;
		runtime: Array<{ name: string; isConnected: boolean; isConnecting: boolean; error?: string; toolCount: number; resourceCount: number }>;
		toolIndexSize: number;
	}> {
		return this.request('GET', '/config/mcp');
	}

	/**
	 * 全量替换 MCP 配置（语义：桌面 settings 保存按钮）。
	 * sidecar 收到后会断开旧连接 + 立即重连所有 enabled 的 server，并重建工具索引。
	 */
	async setMcpConfig(configs: Array<{
		name: string;
		url: string;
		headers?: Record<string, string>;
		enabled: boolean;
		description?: string;
	}>): Promise<{
		ok: boolean;
		added: string[];
		updated: string[];
		removed: string[];
		runtime: Array<{ name: string; isConnected: boolean; isConnecting: boolean; error?: string; toolCount: number }>;
	}> {
		return this.request('PUT', '/config/mcp', { configs });
	}

	/** 列出当前已索引的全部 MCP 工具（用于桌面 UI 显示） */
	async listMcpTools(): Promise<{
		total: number;
		tools: Array<{
			toolId: string;
			serverName: string;
			rawToolName: string;
			description: string;
			inputSchema?: unknown;
		}>;
	}> {
		return this.request('GET', '/config/mcp/tools');
	}

	/** 在 MCP 工具索引中搜索（与 mcp_tool_search 元工具同源） */
	async searchMcpTools(query: string, opts?: { max?: number; servers?: string[] }): Promise<{
		hits: Array<{ toolId: string; serverName: string; rawToolName: string; description: string; score: number }>;
	}> {
		const max = opts?.max ?? 10;
		const servers = opts?.servers?.join(',');
		const qs = new URLSearchParams({ q: query, max: String(max) });
		if (servers) qs.set('servers', servers);
		return this.request('GET', `/config/mcp/tools/search?${qs.toString()}`);
	}

	/* ──────────── B1: Sub-agents 编排 ──────────── */

	/**
	 * 列出某 parent session 派出的所有子代理（含 background + 已完成）
	 */
	async listSubagents(opts?: { parentSessionId?: string; status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' }): Promise<{
		records: Array<{
			taskId:           string;
			parentSessionId:  string;
			subagentSessionId: string;
			subagentType:     string;
			description?:     string;
			isolation:        'inherit' | 'worktree';
			background:       boolean;
			status:           'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
			createdAt:        number;
			startedAt?:       number;
			finishedAt?:      number;
			error?:           string;
			output?:          string;
			worktreePath?:    string;
			worktreeBranch?:  string;
		}>;
	}> {
		const qs = new URLSearchParams();
		if (opts?.parentSessionId) qs.set('parent', opts.parentSessionId);
		if (opts?.status) qs.set('status', opts.status);
		const suffix = qs.toString() ? `?${qs.toString()}` : '';
		return this.request('GET', `/subagents${suffix}`);
	}

	/** 查询单个子代理状态 */
	async getSubagent(taskId: string): Promise<{
		taskId:           string;
		status:           'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
		output?:          string;
		error?:           string;
		startedAt?:       number;
		finishedAt?:      number;
	}> {
		return this.request('GET', `/subagents/${taskId}`);
	}

	/** 取消单个子代理（写入 cancelled 信号；子代理 loop 下一轮检测到会退出） */
	async cancelSubagent(taskId: string): Promise<{ ok: boolean }> {
		return this.request('POST', `/subagents/${taskId}/cancel`);
	}

	/**
	 * 订阅子代理事件流（任务编排面板用）。
	 * 返回 close() 用于断开。
	 */
	/* ──────────── B5: Browser Bridge ──────────── */

	/** 浏览器面板上报实时事件（console 日志 / network 请求 / url 变化）给 sidecar buffer */
	async browserPushEvent(event: {
		kind:        'console' | 'network' | 'url-change';
		level?:      string;
		text?:       string;
		method?:     string;
		url?:        string;
		status?:     number;
		durationMs?: number;
		timestamp?:  number;
	}): Promise<{ ok: boolean }> {
		return this.request('POST', '/browser/event', event);
	}

	/** AI 工具命令执行结果回写给 sidecar */
	async browserReply(cmdId: string, ok: boolean, result?: unknown, error?: string): Promise<{ ok: boolean }> {
		return this.request('POST', '/browser/reply', { cmdId, ok, result, error });
	}

	/** 订阅 AI 工具下发的浏览器命令（前端 panel 打开时调） */
	subscribeBrowserEvents(opts?: {
		onCommand?:  (cmd: { cmdId: string; op: string; args: Record<string, unknown> }) => void;
		onNavigate?: (e: { url: string }) => void;
		onClosePage?:() => void;
	}): { close: () => void } {
		const url = `${this.baseUrl}/browser/events`;
		const finalUrl = this.authQuery
			? `${url}?auth=${encodeURIComponent(this.authQuery)}`
			: url;
		const es = new EventSource(finalUrl);
		const handlers: Array<[string, (e: MessageEvent) => void]> = [];
		const bind = (evt: string, fn: ((e: any) => void) | undefined) => {
			if (!fn) return;
			const wrap = (e: MessageEvent) => { try { fn(JSON.parse(e.data)) } catch { /* */ } };
			es.addEventListener(evt, wrap as EventListener);
			handlers.push([evt, wrap]);
		};
		bind('command',    opts?.onCommand);
		bind('navigate',   opts?.onNavigate);
		bind('close-page', opts?.onClosePage);
		return {
			close: () => {
				for (const [evt, wrap] of handlers) es.removeEventListener(evt, wrap as EventListener);
				es.close();
			},
		};
	}

	subscribeSubagentEvents(opts?: {
		onUpdate?: (record: {
			taskId:            string;
			parentSessionId:   string;
			subagentSessionId: string;
			subagentType:      string;
			description?:      string;
			isolation:         'inherit' | 'worktree';
			background:        boolean;
			status:            'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
			createdAt:         number;
			startedAt?:        number;
			finishedAt?:       number;
			error?:            string;
			output?:           string;
			worktreePath?:     string;
			worktreeBranch?:   string;
		}) => void;
	}): { close: () => void } {
		const url = `${this.baseUrl}/subagents/events`;
		const finalUrl = this.authQuery
			? `${url}?auth=${encodeURIComponent(this.authQuery)}`
			: url;
		const es = new EventSource(finalUrl);
		const handlers: Array<[string, (e: MessageEvent) => void]> = [];
		const bind = (evt: string, fn: ((e: any) => void) | undefined) => {
			if (!fn) return;
			const wrap = (e: MessageEvent) => { try { fn(JSON.parse(e.data)) } catch { /* */ } };
			es.addEventListener(evt, wrap as EventListener);
			handlers.push([evt, wrap]);
		};
		bind('task-update', opts?.onUpdate);
		return {
			close: () => {
				for (const [evt, wrap] of handlers) es.removeEventListener(evt, wrap as EventListener);
				es.close();
			},
		};
	}

	/* ──────────── B3: Auto-Memory ──────────── */

	async listMemories(filter?: {
		scope?:       MemoryScope;
		workspaceId?: string;
		sessionId?:   string;
	}): Promise<{ records: MemoryRecord[] }> {
		const qs = new URLSearchParams();
		if (filter?.scope)       qs.set('scope', filter.scope);
		if (filter?.workspaceId) qs.set('workspace_id', filter.workspaceId);
		if (filter?.sessionId)   qs.set('session_id', filter.sessionId);
		const tail = qs.size > 0 ? `?${qs.toString()}` : '';
		return this.request('GET', `/memory${tail}`);
	}

	async getMemory(id: string): Promise<{ record: MemoryRecord }> {
		return this.request('GET', `/memory/${id}`);
	}

	async createMemory(input: {
		scope:        MemoryScope;
		workspaceId?: string;
		sessionId?:   string;
		category:     MemoryCategory;
		content:      string;
		source?:      'auto' | 'manual';
		starred?:     boolean;
	}): Promise<{ record: MemoryRecord }> {
		return this.request('POST', `/memory`, input);
	}

	async updateMemory(id: string, patch: { content?: string; category?: MemoryCategory }): Promise<{ record: MemoryRecord }> {
		return this.request('PUT', `/memory/${id}`, patch);
	}

	async setMemoryStarred(id: string, starred: boolean): Promise<{ record: MemoryRecord }> {
		return this.request('PATCH', `/memory/${id}/star`, { starred });
	}

	async deleteMemory(id: string): Promise<{ ok: boolean }> {
		return this.request('DELETE', `/memory/${id}`);
	}

	async searchMemories(input: {
		query:        string;
		scope?:       MemoryScope;
		workspaceId?: string;
		sessionId?:   string;
		category?:    MemoryCategory;
		maxResults?:  number;
		minScore?:    number;
	}): Promise<{ hits: Array<{ record: MemoryRecord; score: number }> }> {
		return this.request('POST', `/memory/search`, input);
	}

	async clearMemories(filter?: { scope?: MemoryScope; workspaceId?: string; sessionId?: string }): Promise<{ removed: number }> {
		return this.request('POST', `/memory/clear`, filter ?? {});
	}

	/* ──────────── B4: Codebase Index ──────────── */

	async getCodebaseSnapshot(workspaceId: string): Promise<{ snapshot: CodebaseIndexSnapshot | null }> {
		return this.request('GET', `/codebase/${encodeURIComponent(workspaceId)}`);
	}

	async refreshCodebaseIndex(workspaceId: string, opts?: { incremental?: boolean }): Promise<{
		ok:         boolean;
		snapshot?:  CodebaseIndexSnapshot;
		durationMs?: number;
		error?:     string;
	}> {
		return this.request('POST', `/codebase/${encodeURIComponent(workspaceId)}/refresh`, {
			incremental: opts?.incremental !== false,
		});
	}

	/**
	 * SSE 进度版刷新；调用方拿到 EventSource 自己监听 progress / done / error 事件。
	 * 返回的 close() 用于提前断开（用户取消）。
	 */
	subscribeCodebaseRefresh(workspaceId: string, opts?: {
		incremental?: boolean;
		onStart?:    (e: { workspaceId: string; incremental: boolean; startedAt: number }) => void;
		onProgress?: (e: { message: string; ts: number }) => void;
		onDone?:     (e: { ok: boolean; snapshot: CodebaseIndexSnapshot; durationMs: number }) => void;
		onError?:    (e: { message: string }) => void;
	}): { close: () => void } {
		const inc = opts?.incremental !== false;
		const url = `${this.baseUrl}/codebase/${encodeURIComponent(workspaceId)}/refresh/events?incremental=${inc}`;
		// EventSource 不支持自定义 header 传 Basic Auth；走 querystring auth 兜底
		const sep = url.includes('?') ? '&' : '?';
		const finalUrl = this.authQuery
			? `${url}${sep}auth=${encodeURIComponent(this.authQuery)}`
			: url;
		const es = new EventSource(finalUrl);
		const handlers: Array<[string, (e: MessageEvent) => void]> = [];
		const bind = (evt: string, fn: ((e: any) => void) | undefined) => {
			if (!fn) return;
			const wrap = (e: MessageEvent) => { try { fn(JSON.parse(e.data)) } catch { /* */ } };
			es.addEventListener(evt, wrap as EventListener);
			handlers.push([evt, wrap]);
		};
		bind('start', opts?.onStart);
		bind('progress', opts?.onProgress);
		bind('done', opts?.onDone);
		bind('error', opts?.onError);
		return {
			close: () => {
				for (const [evt, wrap] of handlers) es.removeEventListener(evt, wrap as EventListener);
				es.close();
			},
		};
	}

	async searchCodebase(workspaceId: string, query: string, maxResults = 20): Promise<{ hits: CodebaseSearchHit[] }> {
		return this.request('POST', `/codebase/${encodeURIComponent(workspaceId)}/search`, { query, maxResults });
	}

	async deleteCodebaseIndex(workspaceId: string): Promise<{ ok: boolean }> {
		return this.request('DELETE', `/codebase/${encodeURIComponent(workspaceId)}`);
	}

	/* ──────────── 批量任务（v0.2.16+）──────────── */

	async createBatch(input: CreateBatchInput): Promise<{ batch: TaskBatch }> {
		return this.request('POST', '/batches', input);
	}

	async listBatches(filter?: { status?: BatchStatus }): Promise<{ batches: TaskBatch[] }> {
		const qs = filter?.status ? `?status=${encodeURIComponent(filter.status)}` : '';
		return this.request('GET', `/batches${qs}`);
	}

	async getBatchDetail(id: string): Promise<{ batch: TaskBatch; tasks: BatchTask[] }> {
		return this.request('GET', `/batches/${id}`);
	}

	async updateBatch(
		id: string,
		patch: Partial<{
			status:          BatchStatus;
			name:            string;
			description:     string;
			autoApprove:     boolean;
			maxConcurrency:  number;
			onFailure:       OnFailureStrategy;
			tokenBudget:     number | null;
		}>,
	): Promise<{ batch: TaskBatch }> {
		return this.request('PATCH', `/batches/${id}`, patch);
	}

	async reorderBatchTasks(batchId: string, taskIds: string[]): Promise<{ ok: boolean; tasks: BatchTask[] }> {
		return this.request('PATCH', `/batches/${batchId}/reorder`, { taskIds });
	}

	/** 仅 draft 批次：替换所有任务（编辑保存用） */
	async replaceBatchTasks(
		batchId: string,
		tasks: Array<{
			workspaceId:  string;
			title:        string;
			prompt:       string;
			mode?:        string;
			template?:    string;
			dependsOn?:   string[];
			onFailure?:   OnFailureStrategy;
			maxRetry?:    number;
		}>,
	): Promise<{ ok: boolean; tasks: BatchTask[] }> {
		return this.request('POST', `/batches/${batchId}/replace-tasks`, { tasks });
	}

	async deleteBatch(id: string): Promise<{ ok: boolean }> {
		return this.request('DELETE', `/batches/${id}`);
	}

	async listBatchTasks(batchId: string, filter?: { status?: TaskStatus }): Promise<{ tasks: BatchTask[] }> {
		const qs = filter?.status ? `?status=${encodeURIComponent(filter.status)}` : '';
		return this.request('GET', `/batches/${batchId}/tasks${qs}`);
	}

	async updateBatchTask(
		batchId: string, taskId: string,
		patch: Partial<{
			onFailure: OnFailureStrategy | null;
			prompt:    string;
			title:     string;
			mode:      string;
		}>,
	): Promise<{ task: BatchTask }> {
		return this.request('PATCH', `/batches/${batchId}/tasks/${taskId}`, patch);
	}

	async retryBatchTask(batchId: string, taskId: string): Promise<{ task: BatchTask }> {
		return this.request('POST', `/batches/${batchId}/tasks/${taskId}/retry`);
	}

	async skipBatchTask(batchId: string, taskId: string): Promise<{ task: BatchTask }> {
		return this.request('POST', `/batches/${batchId}/tasks/${taskId}/skip`);
	}

	/**
	 * 订阅批次实时进度事件（SSE）。
	 * 复用 subscribeEvents 的 fetch+ReadableStream 实现，无 XHR 内存累积问题。
	 *
	 * @returns unsubscribe 函数
	 */
	subscribeBatchEvents(
		batchId: string,
		onEvent: (event: BatchEvent) => void,
		onError?: (e: unknown) => void,
	): () => void {
		const qs = this.authQuery ? `?auth=${encodeURIComponent(this.authQuery)}` : '';
		const url = `${this.baseUrl}/batches/${batchId}/events${qs}`;
		const isLoopback = /127\.0\.0\.1|localhost|\[::1\]/.test(this.baseUrl);

		let aborted = false;
		let currentAbort: AbortController | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let delay = 250;

		const connect = async (): Promise<void> => {
			if (aborted) return;
			const ac = new AbortController();
			currentAbort = ac;

			const headers: Record<string, string> = {
				'Accept':       'text/event-stream',
				'Cache-Control':'no-cache',
			};
			if (this.auth && !isLoopback) headers['Authorization'] = this.auth;

			let buf = '';
			try {
				const res = await this.fetchFn(url, { headers, signal: ac.signal });
				if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
				const body = res.body;
				if (!body) throw new Error('SSE no body stream');
				const reader = body.getReader();
				const decoder = new TextDecoder('utf-8');

				while (true) {
					if (aborted) { try { await reader.cancel(); } catch { /* ignore */ } break; }
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					const blocks = buf.split('\n\n');
					buf = blocks.pop() ?? '';
					for (const block of blocks) {
						if (!block.trim()) continue;
						for (const line of block.split('\n')) {
							if (line.startsWith('data:')) {
								const data = line.slice(5).trim();
								if (data && data !== '[DONE]') {
									try {
										const ev = JSON.parse(data) as BatchEvent;
										// 跳过心跳里的 sentinel
										if ((ev as any).taskId !== '__hb__') onEvent(ev);
									} catch (e) { onError?.(e); }
								}
							}
						}
					}
				}
				if (!aborted) {
					delay = 250;
					retryTimer = setTimeout(connect, delay);
				}
			} catch (err) {
				if (aborted || (err as any)?.name === 'AbortError') return;
				onError?.(err);
				retryTimer = setTimeout(() => {
					delay = Math.min(delay * 2, 16000);
					connect();
				}, delay);
			}
		};

		void connect();

		return () => {
			aborted = true;
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			currentAbort?.abort();
			currentAbort = null;
		};
	}
}
