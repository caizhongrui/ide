/*---------------------------------------------------------------------------------------------
 *  useApprovalQueue — 工具审批白名单（K11a-cont）
 *  全局"总是允许"列表 + 当前会话"本会话允许"列表 + isAutoApproved 检查
 *--------------------------------------------------------------------------------------------*/

import { createSignal } from 'solid-js'

const ALLOW_ALWAYS_KEY = 'maxian:tool-allow-always'

export interface ApprovalQueue {
	allowAlways:        () => Set<string>
	sessionAllow:       () => Map<string, Set<string>>
	addAllowAlways:     (toolName: string) => void
	removeAllowAlways:  (toolName: string) => void
	addSessionAllow:    (sessionId: string, toolName: string) => void
	clearSessionAllow:  (sessionId: string) => void
	isAutoApproved:     (sessionId: string, toolName: string) => boolean
}

export function useApprovalQueue(): ApprovalQueue {
	const initial = (() => {
		try { return new Set<string>(JSON.parse(localStorage.getItem(ALLOW_ALWAYS_KEY) || '[]')) }
		catch { return new Set<string>() }
	})()
	const [allowAlways, setAllowAlways] = createSignal<Set<string>>(initial)
	// 当前会话的一次性允许列表（不持久化，切会话就重置）
	const [sessionAllow, setSessionAllow] = createSignal<Map<string, Set<string>>>(new Map())

	const persistAllowAlways = (set: Set<string>): void => {
		try { localStorage.setItem(ALLOW_ALWAYS_KEY, JSON.stringify([...set])) } catch {}
	}

	const addAllowAlways = (toolName: string): void => {
		setAllowAlways((prev) => {
			const next = new Set(prev)
			next.add(toolName)
			persistAllowAlways(next)
			return next
		})
	}

	const removeAllowAlways = (toolName: string): void => {
		setAllowAlways((prev) => {
			const next = new Set(prev)
			next.delete(toolName)
			persistAllowAlways(next)
			return next
		})
	}

	const addSessionAllow = (sessionId: string, toolName: string): void => {
		setSessionAllow((prev) => {
			const next = new Map(prev)
			const set = new Set(next.get(sessionId) ?? [])
			set.add(toolName)
			next.set(sessionId, set)
			return next
		})
	}

	const clearSessionAllow = (sessionId: string): void => {
		setSessionAllow((prev) => {
			if (!prev.has(sessionId)) return prev
			const next = new Map(prev)
			next.delete(sessionId)
			return next
		})
	}

	const isAutoApproved = (sessionId: string, toolName: string): boolean => {
		if (allowAlways().has(toolName)) return true
		if (sessionAllow().get(sessionId)?.has(toolName)) return true
		return false
	}

	return {
		allowAlways,
		sessionAllow,
		addAllowAlways,
		removeAllowAlways,
		addSessionAllow,
		clearSessionAllow,
		isAutoApproved,
	}
}
