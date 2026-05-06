/*---------------------------------------------------------------------------------------------
 *  usePromptHistory — composer 输入历史，↑/↓ 翻历史（K11b 抽离自 App.tsx）
 *
 *  - localStorage 持久化（key = "maxian:prompt-history"），最多保留 100 条
 *  - historyIdx -1 表示当前是"新输入"；0..n-1 是历史条目
 *  - historyDraft 暂存当前未提交的输入，方便用户从历史回到草稿
 *--------------------------------------------------------------------------------------------*/

import { createSignal } from 'solid-js'

const HISTORY_STORAGE_KEY = 'maxian:prompt-history'
const HISTORY_MAX         = 100

export interface UsePromptHistoryReturn {
	promptHistory:    () => string[]
	historyIdx:       () => number
	setHistoryIdx:    (n: number | ((prev: number) => number)) => void
	historyDraft:     () => string
	setHistoryDraft:  (s: string) => void
	/** 把一条新输入加进历史（去重相邻重复） */
	pushPromptHistory:(text: string) => void
}

export function usePromptHistory(): UsePromptHistoryReturn {
	const [promptHistory, setPromptHistory] = createSignal<string[]>(
		(() => {
			try { return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]') }
			catch { return [] }
		})()
	)
	const [historyIdx, setHistoryIdx] = createSignal(-1)
	const [historyDraft, setHistoryDraft] = createSignal('')

	function pushPromptHistory(text: string) {
		if (!text.trim()) return
		setPromptHistory(prev => {
			if (prev[prev.length - 1] === text) return prev   // 去重相邻
			const next = [...prev, text].slice(-HISTORY_MAX)
			try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
			return next
		})
		setHistoryIdx(-1)
	}

	return {
		promptHistory, historyIdx, setHistoryIdx,
		historyDraft, setHistoryDraft, pushPromptHistory,
	}
}
