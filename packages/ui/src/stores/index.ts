/*---------------------------------------------------------------------------------------------
 *  @maxian/ui/stores — 统一导出
 *--------------------------------------------------------------------------------------------*/

export {
	createMessagesStore,
	type ChatMessage,
	type MessageRole,
	type MessagesStoreApi,
} from './messagesStore.js';

export {
	createSseDispatcher,
	type SseDispatcher,
	type SseDispatchContext,
	type SseEvent,
} from './sseAdapter.js';
