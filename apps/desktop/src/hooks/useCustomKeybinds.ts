/*---------------------------------------------------------------------------------------------
 *  useCustomKeybinds — 用户自定义快捷键（K11b 抽离自 App.tsx）
 *
 *  - 用 localStorage 持久化用户改的快捷键覆盖；其余走默认
 *  - 提供 eventToKeybind / matchKeybind 工具，便于全局键盘监听匹配
 *
 *  覆盖键的规范字符串："mod+n" / "mod+shift+p" / "mod+/" 等。`mod` 表示 ⌘（macOS）或 Ctrl（其他）。
 *--------------------------------------------------------------------------------------------*/

import { createSignal } from 'solid-js'

export type KeybindAction =
	| 'new-session'
	| 'close-session'
	| 'prev-session'
	| 'next-session'
	| 'cmd-palette'
	| 'slash-cmd'
	| 'terminal'
	| 'settings'
	| 'help'
	| 'global-search'

export interface KeybindEntry {
	action:     KeybindAction
	label:      string
	defaultKey: string
}

export const KEYBIND_DEFAULTS: KeybindEntry[] = [
	{ action: 'new-session',   label: '新建会话',     defaultKey: 'mod+n' },
	{ action: 'close-session', label: '关闭当前会话', defaultKey: 'mod+w' },
	{ action: 'prev-session',  label: '上一个会话',   defaultKey: 'mod+[' },
	{ action: 'next-session',  label: '下一个会话',   defaultKey: 'mod+]' },
	{ action: 'slash-cmd',     label: '斜杠命令面板', defaultKey: 'mod+k' },
	{ action: 'cmd-palette',   label: '全局搜索',     defaultKey: 'mod+p' },
	{ action: 'terminal',      label: '切换终端',     defaultKey: 'mod+`' },
	{ action: 'settings',      label: '打开设置',     defaultKey: 'mod+,' },
	{ action: 'help',          label: '快捷键速查',   defaultKey: 'mod+/' },
]

const KEYBIND_STORAGE = 'maxian:keybinds'

/** 把 KeyboardEvent 转成 "mod+X" 字符串 */
export function eventToKeybind(e: KeyboardEvent): string {
	const mod = e.metaKey || e.ctrlKey
	const shift = e.shiftKey
	const alt = e.altKey
	let k = e.key.toLowerCase()
	if (k === ' ') k = 'space'
	const parts: string[] = []
	if (mod) parts.push('mod')
	if (alt) parts.push('alt')
	if (shift) parts.push('shift')
	parts.push(k)
	return parts.join('+')
}

/** 检查 KeyboardEvent 是否匹配绑定字符串 */
export function matchKeybind(e: KeyboardEvent, bind: string): boolean {
	return eventToKeybind(e) === bind.toLowerCase()
}

export interface UseCustomKeybindsReturn {
	customKeybinds: () => Record<string, string>
	getKeybind:     (action: KeybindAction) => string
	setKeybind:     (action: KeybindAction, key: string) => void
	resetKeybind:   (action: KeybindAction) => void
}

export function useCustomKeybinds(): UseCustomKeybindsReturn {
	const [customKeybinds, setCustomKeybinds] = createSignal<Record<string, string>>(
		(() => {
			try { return JSON.parse(localStorage.getItem(KEYBIND_STORAGE) || '{}') }
			catch { return {} }
		})()
	)

	function getKeybind(action: KeybindAction): string {
		const custom = customKeybinds()[action]
		if (custom) return custom
		return KEYBIND_DEFAULTS.find(k => k.action === action)?.defaultKey ?? ''
	}
	function setKeybind(action: KeybindAction, key: string) {
		const next = { ...customKeybinds(), [action]: key }
		setCustomKeybinds(next)
		try { localStorage.setItem(KEYBIND_STORAGE, JSON.stringify(next)) } catch { /* ignore */ }
	}
	function resetKeybind(action: KeybindAction) {
		const next = { ...customKeybinds() }
		delete next[action]
		setCustomKeybinds(next)
		try { localStorage.setItem(KEYBIND_STORAGE, JSON.stringify(next)) } catch { /* ignore */ }
	}

	return { customKeybinds, getKeybind, setKeybind, resetKeybind }
}
