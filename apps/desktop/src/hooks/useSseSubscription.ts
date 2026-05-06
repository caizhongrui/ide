/*---------------------------------------------------------------------------------------------
 *  useSseSubscription — SSE 订阅 + 自动重连封装（K11a-cont）
 *  通过 SDK client.subscribeEvents 接入；切换会话/手动 reconnect 时自动 unsubscribe
 *--------------------------------------------------------------------------------------------*/

import { onCleanup } from 'solid-js'
import type { MaxianEvent } from '@maxian/sdk'

export interface SseClientLike {
	subscribeEvents(
		sessionId: string,
		onEvent: (e: MaxianEvent) => void,
		onError?: (e: unknown) => void,
	): () => void
}

export interface SseSubscriptionHandle {
	/** 切换或建立订阅；旧的会被自动清理 */
	subscribe: (sessionId: string) => void
	/** 强制断开当前订阅 */
	unsubscribe: () => void
	/** 当前已订阅的 session id（若无则 null） */
	currentSessionId: () => string | null
}

export interface UseSseSubscriptionOptions {
	getClient:  () => Promise<SseClientLike>
	onEvent:    (e: MaxianEvent) => void
	onError?:   (e: unknown) => void
}

export function useSseSubscription(opts: UseSseSubscriptionOptions): SseSubscriptionHandle {
	let unsubscribe: (() => void) | null = null
	let currentId: string | null = null

	const doUnsubscribe = (): void => {
		if (unsubscribe) {
			try { unsubscribe() } catch { /* ignore */ }
			unsubscribe = null
			currentId = null
		}
	}

	const subscribe = (sessionId: string): void => {
		// 切换到不同 session 才重新订阅，避免 SSE 闪断
		if (currentId === sessionId && unsubscribe) return
		doUnsubscribe()
		currentId = sessionId
		void opts.getClient().then((c) => {
			// 在等待 client 期间，可能用户又切到了别的 session
			if (currentId !== sessionId) return
			unsubscribe = c.subscribeEvents(
				sessionId,
				opts.onEvent,
				opts.onError ?? ((err) => console.error('[SSE]', err)),
			)
		})
	}

	onCleanup(() => doUnsubscribe())

	return {
		subscribe,
		unsubscribe: doUnsubscribe,
		currentSessionId: () => currentId,
	}
}
