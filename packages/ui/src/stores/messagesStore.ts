/*---------------------------------------------------------------------------------------------
 *  messagesStore — 跨形态共享消息 store（Solid signal-based）
 *
 *  设计目标：
 *    1. 同一份 store 同时支撑 desktop 和 IDE/Solo 两端 UI
 *    2. 工具调用状态嵌入消息（沿用 desktop 现成模式，IDE 端切过来后行为对齐）
 *    3. 流式更新：append / patchLast / patchById / finalizeStreaming
 *    4. 不依赖任何具体 UI 组件，纯数据
 *
 *  调用方负责把 sidecar SSE 事件翻译成 store 操作（见 sseAdapter.ts）。
 *--------------------------------------------------------------------------------------------*/

import { createSignal, type Accessor } from 'solid-js';

export type MessageRole =
	| 'user'
	| 'assistant'
	| 'reasoning'
	| 'tool'
	| 'error'
	| 'system';

/**
 * 跨端共享的消息形态。
 *
 * - 文本类（user / assistant / reasoning / error / system）：用 `content`
 * - 工具类（role='tool'）：用 toolName / toolId / toolParams / toolResult / liveOutput / toolSuccess
 *
 * 为简化心智模型，工具卡片就是一条 role='tool' 的消息（与 desktop 当前模型一致）。
 * 同 toolId 的多次更新通过 patchById 复用同一条消息。
 */
export interface ChatMessage {
	id:           string;
	role:         MessageRole;
	content:      string;
	createdAt:    number;
	isPartial?:   boolean;

	// 工具字段（role='tool' 时有效）
	toolName?:    string;
	toolId?:      string;
	toolParams?:  Record<string, unknown>;
	toolResult?:  string;
	toolSuccess?: boolean;
	liveOutput?:  string;     // bash / execute_command 实时 stdout

	// reasoning 字段
	charCount?:   number;     // 当前 reasoning 已收的字符数（UI 折叠/展开用）

	// 平台扩展（IDE 的 ask/checkpoint 等）
	metadata?:    Record<string, unknown>;
}

export interface MessagesStoreApi {
	/** 当前消息数组（reactive accessor） */
	messages: Accessor<ChatMessage[]>;
	/** 追加一条新消息 */
	append(msg: ChatMessage): void;
	/** 在末尾消息上做局部更新（流式补字常用） */
	patchLast(patch: Partial<ChatMessage>): void;
	/** 按 id 找消息后更新（异步流式更新指定消息） */
	patchById(id: string, patch: Partial<ChatMessage>): void;
	/** 按 toolId 找/创建工具消息后更新（同 toolId 复用） */
	upsertTool(toolId: string, patch: Partial<ChatMessage>): void;
	/** 把所有 isPartial=true 的消息标记为完成（一轮回复结束时调用） */
	finalizeStreaming(): void;
	/** 清空（切会话 / 清对话） */
	clear(): void;
	/** 整体覆盖（历史回放载入时用） */
	setAll(msgs: ChatMessage[]): void;
}

/**
 * 创建一个新的 messages store 实例。
 * 每个 session（IDE 模式 1 个；Solo 多个）应有独立的 store 实例。
 */
export function createMessagesStore(initial: ChatMessage[] = []): MessagesStoreApi {
	const [messages, setMessages] = createSignal<ChatMessage[]>(initial);

	const append: MessagesStoreApi['append'] = (msg) => {
		setMessages(prev => [...prev, msg]);
	};

	const patchLast: MessagesStoreApi['patchLast'] = (patch) => {
		setMessages(prev => {
			if (prev.length === 0) return prev;
			const next = prev.slice();
			next[next.length - 1] = { ...next[next.length - 1], ...patch };
			return next;
		});
	};

	const patchById: MessagesStoreApi['patchById'] = (id, patch) => {
		setMessages(prev => {
			const idx = prev.findIndex(m => m.id === id);
			if (idx < 0) return prev;
			const next = prev.slice();
			next[idx] = { ...next[idx], ...patch };
			return next;
		});
	};

	const upsertTool: MessagesStoreApi['upsertTool'] = (toolId, patch) => {
		setMessages(prev => {
			const idx = prev.findIndex(m => m.role === 'tool' && m.toolId === toolId);
			if (idx >= 0) {
				const next = prev.slice();
				next[idx] = { ...next[idx], ...patch };
				return next;
			}
			// 不存在 → 新建工具消息
			const fresh: ChatMessage = {
				id:        patch.id ?? `tool-${toolId}`,
				role:      'tool',
				content:   patch.content ?? '',
				createdAt: patch.createdAt ?? Date.now(),
				toolId,
				...patch,
			};
			return [...prev, fresh];
		});
	};

	const finalizeStreaming: MessagesStoreApi['finalizeStreaming'] = () => {
		setMessages(prev => prev.map(m => (m.isPartial ? { ...m, isPartial: false } : m)));
	};

	const clear: MessagesStoreApi['clear'] = () => setMessages([]);
	const setAll: MessagesStoreApi['setAll'] = (msgs) => setMessages(msgs);

	return { messages, append, patchLast, patchById, upsertTool, finalizeStreaming, clear, setAll };
}
