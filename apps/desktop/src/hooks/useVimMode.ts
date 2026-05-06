/*---------------------------------------------------------------------------------------------
 *  useVimMode — composer textarea 的基础 modal 编辑（K11b 抽离自 App.tsx）
 *
 *  实现 vim 的 normal / insert / visual 三种基本模式，以及常用按键：
 *    - 进入 insert：i / a / A / I / o / O
 *    - 移动：h / l / j / k / 0 / $ / w / b / Home / End
 *    - 编辑：x（删字符）/ D（删到行尾，进 register）/ p（粘贴 register）
 *    - 模式：Esc → normal
 *
 *  enabled 状态用 localStorage（VIM_ENABLED_KEY）持久化。Host 用 vimEnabled() 给 UI 显示
 *  当前开关状态，调 toggleVim 翻转。`handleVimKey` 在 textarea 的 onKeyDown 里调用，
 *  返回 true 时表示该按键已被 vim 模式消化（host 应阻止默认行为）。
 *--------------------------------------------------------------------------------------------*/

import { createSignal } from 'solid-js'

export type VimMode = 'normal' | 'insert' | 'visual'

const VIM_ENABLED_KEY = 'maxian:vim-enabled'

export interface UseVimModeReturn {
	vimEnabled:    () => boolean
	toggleVim:     (on: boolean) => void
	vimMode:       () => VimMode
	setVimMode:    (m: VimMode) => void
	/** 在 textarea 的 onKeyDown 里调用；返回 true 表示该按键已处理（host 应 e.preventDefault 已由本函数完成）*/
	handleVimKey:  (e: KeyboardEvent, ta: HTMLTextAreaElement) => boolean
}

export function useVimMode(): UseVimModeReturn {
	const [vimEnabled, setVimEnabled] = createSignal<boolean>(
		(() => { try { return localStorage.getItem(VIM_ENABLED_KEY) === '1' } catch { return false } })()
	)
	function toggleVim(on: boolean) {
		setVimEnabled(on)
		try { localStorage.setItem(VIM_ENABLED_KEY, on ? '1' : '0') } catch {}
	}
	const [vimMode, setVimMode] = createSignal<VimMode>('insert')
	let vimRegister = ''

	function handleVimKey(e: KeyboardEvent, ta: HTMLTextAreaElement): boolean {
		if (!vimEnabled()) return false
		if (e.metaKey || e.ctrlKey || e.altKey) return false
		const mode = vimMode()
		const k = e.key

		// Esc 任何时候 → normal
		if (k === 'Escape') { setVimMode('normal'); e.preventDefault(); return true }

		if (mode === 'insert') {
			// insert 模式下除了 Esc 都透传
			return false
		}

		if (mode === 'normal' || mode === 'visual') {
			const val = ta.value
			const pos = ta.selectionStart
			const lineStart = val.lastIndexOf('\n', pos - 1) + 1
			const lineEnd   = val.indexOf('\n', pos); const lineEndIdx = lineEnd < 0 ? val.length : lineEnd

			const set = (s: number, ePos?: number) => {
				ta.selectionStart = s
				ta.selectionEnd   = ePos ?? s
			}

			if (k === 'i') { setVimMode('insert'); e.preventDefault(); return true }
			if (k === 'a') { set(pos + 1); setVimMode('insert'); e.preventDefault(); return true }
			if (k === 'A') { set(lineEndIdx); setVimMode('insert'); e.preventDefault(); return true }
			if (k === 'I') { set(lineStart); setVimMode('insert'); e.preventDefault(); return true }
			if (k === 'o') {
				ta.value = val.slice(0, lineEndIdx) + '\n' + val.slice(lineEndIdx)
				set(lineEndIdx + 1); setVimMode('insert'); e.preventDefault(); return true
			}
			if (k === 'O') {
				ta.value = val.slice(0, lineStart) + '\n' + val.slice(lineStart)
				set(lineStart); setVimMode('insert'); e.preventDefault(); return true
			}
			if (k === 'h') { set(Math.max(0, pos - 1)); e.preventDefault(); return true }
			if (k === 'l') { set(Math.min(val.length, pos + 1)); e.preventDefault(); return true }
			if (k === 'j') {
				const nextLineStart = lineEndIdx + 1
				if (nextLineStart > val.length) return true
				const col = pos - lineStart
				const nextLineEnd = val.indexOf('\n', nextLineStart)
				const nlEnd = nextLineEnd < 0 ? val.length : nextLineEnd
				set(Math.min(nextLineStart + col, nlEnd))
				e.preventDefault(); return true
			}
			if (k === 'k') {
				if (lineStart === 0) return true
				const prevLineEnd = lineStart - 1
				const prevLineStart = val.lastIndexOf('\n', prevLineEnd - 1) + 1
				const col = pos - lineStart
				set(Math.min(prevLineStart + col, prevLineEnd))
				e.preventDefault(); return true
			}
			if (k === '0' || k === 'Home') { set(lineStart); e.preventDefault(); return true }
			if (k === '$' || k === 'End')  { set(lineEndIdx); e.preventDefault(); return true }
			if (k === 'w') {
				// 下一个单词起点
				let i = pos
				while (i < val.length && /\w/.test(val[i])) i++
				while (i < val.length && !/\w/.test(val[i])) i++
				set(i); e.preventDefault(); return true
			}
			if (k === 'b') {
				let i = pos
				while (i > 0 && !/\w/.test(val[i - 1])) i--
				while (i > 0 && /\w/.test(val[i - 1])) i--
				set(i); e.preventDefault(); return true
			}
			if (k === 'x') {
				ta.value = val.slice(0, pos) + val.slice(pos + 1)
				set(pos); e.preventDefault(); return true
			}
			if (k === 'D') {
				ta.value = val.slice(0, pos) + val.slice(lineEndIdx)
				vimRegister = val.slice(pos, lineEndIdx)
				set(pos); e.preventDefault(); return true
			}
			if (k === 'p') {
				ta.value = val.slice(0, pos + 1) + vimRegister + val.slice(pos + 1)
				set(pos + 1 + vimRegister.length); e.preventDefault(); return true
			}
			// 屏蔽普通字符输入
			if (k.length === 1 && /[a-zA-Z0-9]/.test(k)) {
				e.preventDefault()
				return true
			}
		}
		return false
	}

	return { vimEnabled, toggleVim, vimMode, setVimMode, handleVimKey }
}
