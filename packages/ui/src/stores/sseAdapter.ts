/*---------------------------------------------------------------------------------------------
 *  sseAdapter — sidecar SSE 事件 → MessagesStore 更新
 *
 *  调用方：
 *    const store = createMessagesStore();
 *    const dispatch = createSseDispatcher(store);
 *    client.subscribeEvents(sessionId, e => dispatch(e));
 *
 *  事件覆盖：
 *    - reasoning / reasoning_delta → 创建/续写 reasoning 气泡（多轮自动分组）
 *    - assistant_message            → 创建/续写 assistant 文本气泡
 *    - tool_call_start              → upsert 工具消息（toolName + 完整参数）
 *    - tool_input_delta             → 流式补 toolParams（pending 状态展示）
 *    - tool_call_result             → 标记 toolSuccess + toolResult
 *    - tool_approval_request        → 调用方自行处理（本 adapter 不管 UI 弹窗）
 *    - completion                   → finalizeStreaming
 *    - task_status='completed'      → finalizeStreaming
 *    - error                        → 追加 error 消息
 *
 *  其他事件（token_usage / heartbeat / file_changed / ...）由调用方按需另行处理；
 *  本 adapter 只关心"消息流"那部分。
 *--------------------------------------------------------------------------------------------*/

import type { MessagesStoreApi, ChatMessage } from './messagesStore.js';

export interface SseEvent {
	type:      string;
	sessionId: string;
	[key: string]: unknown;
}

export interface SseDispatchContext {
	/** 上次事件是否为 reasoning（多轮 LLM 调用之间触发新气泡） */
	lastWasReasoning: boolean;
}

export interface SseDispatcher {
	(event: SseEvent): void;
}

/**
 * 创建一个 SSE 事件分发器。
 * 内部持有 SseDispatchContext 跨事件状态（reasoning 折叠等）。
 */
export function createSseDispatcher(store: MessagesStoreApi): SseDispatcher {
	const ctx: SseDispatchContext = { lastWasReasoning: false };

	return function dispatch(event: SseEvent): void {
		const isReasoning   = event.type === 'reasoning' || event.type === 'reasoning_delta';
		const isPassThrough =
			event.type === 'token_usage' ||
			event.type === 'heartbeat' ||
			event.type === 'tool_input_delta';

		// 多轮 LLM 调用气泡分组：上次是 reasoning + 本次是非 reasoning 非 passthrough → 上一条 reasoning 收尾
		const isGroupBoundary = !isReasoning && !isPassThrough;
		if (ctx.lastWasReasoning && isGroupBoundary) {
			store.patchLast({ isPartial: false });
			ctx.lastWasReasoning = false;
		}

		switch (event.type) {
			case 'reasoning':
			case 'reasoning_delta': {
				const delta = String(event['content'] ?? event['text'] ?? '');
				if (!delta) break;
				appendOrExtendReasoning(store, delta);
				ctx.lastWasReasoning = true;
				break;
			}
			case 'assistant_message': {
				const content    = String(event['content'] ?? '');
				const isPartial  = event['isPartial'] === true || event['partial'] === true;
				appendOrExtendAssistant(store, content, isPartial);
				if (!isPartial) ctx.lastWasReasoning = false;
				break;
			}
			case 'tool_call_start': {
				const toolUseId = String(event['toolUseId'] ?? event['toolId'] ?? '');
				const toolName  = String(event['toolName']  ?? 'unknown');
				if (!toolUseId) break;
				const toolParams = (event['toolParams'] ?? event['input'] ?? {}) as Record<string, unknown>;
				store.upsertTool(toolUseId, {
					toolName, toolId: toolUseId, toolParams,
					content: '',
					isPartial: true,
				});
				break;
			}
			case 'tool_input_delta': {
				// 实时流式 tool 参数：UI 通常显示"已生成 N 字"，这里只把累计 input 写到 toolParams
				const toolUseId = String(event['toolUseId'] ?? event['toolId'] ?? '');
				if (!toolUseId) break;
				const partial = event['partialArgs'] ?? event['input'];
				if (partial !== undefined) {
					store.upsertTool(toolUseId, {
						toolParams: typeof partial === 'object' && partial !== null
							? partial as Record<string, unknown>
							: { _streaming: String(partial) },
						isPartial: true,
					});
				}
				break;
			}
			case 'tool_call_result': {
				const toolUseId = String(event['toolUseId'] ?? event['toolId'] ?? '');
				if (!toolUseId) break;
				const success = event['success'] !== false;
				const result  = String(event['result'] ?? event['output'] ?? event['content'] ?? '');
				store.upsertTool(toolUseId, {
					toolResult: result,
					toolSuccess: success,
					isPartial: false,
				});
				break;
			}
			case 'completion':
			case 'task_status': {
				if (event.type === 'task_status' && event['status'] !== 'completed') break;
				store.finalizeStreaming();
				ctx.lastWasReasoning = false;
				break;
			}
			case 'error': {
				const msg = String(event['message'] ?? event['error'] ?? 'unknown error');
				store.append({
					id:        `err-${Date.now()}`,
					role:      'error',
					content:   msg,
					createdAt: Date.now(),
				});
				ctx.lastWasReasoning = false;
				break;
			}
			// tool_approval_request / file_changed / token_usage / 其他 → 调用方另行处理
		}
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部 helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 reasoning delta 续到末尾的 reasoning 消息；若末尾不是 reasoning（或非 partial），新建一条
 */
function appendOrExtendReasoning(store: MessagesStoreApi, delta: string): void {
	const list = store.messages();
	const last = list[list.length - 1];
	if (last && last.role === 'reasoning' && last.isPartial) {
		store.patchLast({
			content:   last.content + delta,
			charCount: (last.charCount ?? 0) + delta.length,
		});
	} else {
		store.append({
			id:        `reasoning-${Date.now()}`,
			role:      'reasoning',
			content:   delta,
			createdAt: Date.now(),
			isPartial: true,
			charCount: delta.length,
		});
	}
}

/**
 * 把 assistant_message 续到末尾的 assistant 消息；若末尾不是 assistant 或非 partial，新建一条
 */
function appendOrExtendAssistant(store: MessagesStoreApi, content: string, isPartial: boolean): void {
	const list = store.messages();
	const last = list[list.length - 1];
	if (last && last.role === 'assistant' && last.isPartial) {
		// 流式覆盖：sidecar 通常每次发的是"完整累积内容"，不是增量
		store.patchLast({ content, isPartial });
	} else {
		store.append({
			id:        `assistant-${Date.now()}`,
			role:      'assistant',
			content,
			createdAt: Date.now(),
			isPartial,
		});
	}
}

// 导出类型供 consumer 使用
export type { ChatMessage };
