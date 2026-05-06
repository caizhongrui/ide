/*---------------------------------------------------------------------------------------------
 *  useInChatSearch — 会话内 ⌘F 文本搜索（K11b 抽离自 App.tsx）
 *
 *  在当前 messages 数组里搜命中：消息 content / toolName / toolResult。
 *  返回一组命中的消息索引（messages 数组的 index），按出现顺序排列。
 *
 *  调用方负责：
 *   - 把 `messages` 信号传入（我们用 `() => ChatMessage[]` 回调读）
 *   - 接到 jumpToHit 后实际滚动到对应 DOM（hook 只设 focusedMsgIdx）
 *--------------------------------------------------------------------------------------------*/

import { createMemo, createSignal } from 'solid-js'
import type { ChatMessage } from '../lib/types'

export interface UseInChatSearchOptions {
	messages:        () => ChatMessage[]
	setFocusedMsgIdx:(idx: number) => void
}

export interface UseInChatSearchReturn {
	/** 是否显示搜索框 */
	showInChatSearch:    () => boolean
	setShowInChatSearch: (v: boolean) => void
	/** 搜索关键词 */
	inChatSearchQuery:    () => string
	setInChatSearchQuery: (v: string) => void
	/** 当前命中索引（在 hits 数组里的位置） */
	inChatSearchIdx:      () => number
	setInChatSearchIdx:   (v: number) => void
	/** input ref setter（host 可以直接 ref={inChatSearchInputRef} 但要 setter 才能拿到） */
	setInputRef:         (el: HTMLInputElement | undefined) => void
	/** memo: 当前所有命中消息的 messages 数组索引 */
	inChatSearchHits:    () => number[]
	openInChatSearch:    () => void
	closeInChatSearch:   () => void
	jumpToSearchHit:     (idx: number) => void
}

export function useInChatSearch(opts: UseInChatSearchOptions): UseInChatSearchReturn {
	const [showInChatSearch, setShowInChatSearch] = createSignal(false)
	const [inChatSearchQuery, setInChatSearchQuery] = createSignal('')
	const [inChatSearchIdx, setInChatSearchIdx] = createSignal(0)
	let inChatSearchInputRef: HTMLInputElement | undefined

	const inChatSearchHits = createMemo((): number[] => {
		const q = inChatSearchQuery().trim().toLowerCase()
		if (!q || !showInChatSearch()) return []
		const hits: number[] = []
		const list = opts.messages()
		for (let i = 0; i < list.length; i++) {
			const m = list[i]
			const text = (m.content ?? '') + ' ' + (m.toolName ?? '') + ' ' + (m.toolResult ?? '')
			if (text.toLowerCase().includes(q)) hits.push(i)
		}
		return hits
	})

	function openInChatSearch() {
		setShowInChatSearch(true)
		setInChatSearchIdx(0)
		setTimeout(() => { inChatSearchInputRef?.focus(); inChatSearchInputRef?.select() }, 0)
	}
	function closeInChatSearch() {
		setShowInChatSearch(false)
	}
	function jumpToSearchHit(idx: number) {
		const hits = inChatSearchHits()
		if (hits.length === 0) return
		const i = ((idx % hits.length) + hits.length) % hits.length
		setInChatSearchIdx(i)
		const targetMsgIdx = hits[i]
		opts.setFocusedMsgIdx(targetMsgIdx)
		queueMicrotask(() => {
			const el = document.querySelector(`[data-msg-idx="${targetMsgIdx}"]`) as HTMLElement | null
			el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
		})
	}

	return {
		showInChatSearch, setShowInChatSearch,
		inChatSearchQuery, setInChatSearchQuery,
		inChatSearchIdx, setInChatSearchIdx,
		setInputRef: (el) => { inChatSearchInputRef = el },
		inChatSearchHits, openInChatSearch, closeInChatSearch, jumpToSearchHit,
	}
}
