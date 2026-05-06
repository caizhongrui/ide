/*---------------------------------------------------------------------------------------------
 *  useGitBranchPicker — 左下角分支选择器（K11b 抽离自 App.tsx）
 *
 *  封装：
 *    - currentBranch 信号（外部 effect 在 workspace 变化时也会写它）
 *    - showBranchPicker / branchPickerBranches / loading / search / rect
 *    - loadBranchPicker / openBranchPicker / switchBranch 三个操作
 *
 *  通过 deps 注入 activeWorkspace + getClient（避免和 App 全局耦合）。
 *--------------------------------------------------------------------------------------------*/

import { createSignal } from 'solid-js'

export interface BranchPickerClient {
	listBranches:    (wsId: string) => Promise<{ branches?: string[] }>
	checkoutBranch:  (wsId: string, branch: string) => Promise<{ ok: boolean; error?: string }>
}

export interface UseGitBranchPickerOptions {
	activeWorkspace: () => { id: string } | null | undefined
	getClient:       () => Promise<BranchPickerClient>
}

export interface UseGitBranchPickerReturn {
	currentBranch:           () => string | null
	setCurrentBranch:        (v: string | null) => void
	showBranchPicker:        () => boolean
	setShowBranchPicker:     (v: boolean) => void
	branchPickerBranches:    () => string[]
	setBranchPickerBranches: (v: string[]) => void
	branchPickerLoading:     () => boolean
	branchPickerSearch:      () => string
	setBranchPickerSearch:   (v: string) => void
	branchPickerRect:        () => { bottom: number; left: number }
	loadBranchPicker:        () => Promise<void>
	openBranchPicker:        (e: MouseEvent, btn: HTMLButtonElement) => void
	switchBranch:            (branch: string) => Promise<void>
}

export function useGitBranchPicker(opts: UseGitBranchPickerOptions): UseGitBranchPickerReturn {
	const [currentBranch, setCurrentBranch] = createSignal<string | null>(null)
	const [showBranchPicker, setShowBranchPicker] = createSignal(false)
	const [branchPickerBranches, setBranchPickerBranches] = createSignal<string[]>([])
	const [branchPickerLoading, setBranchPickerLoading] = createSignal(false)
	const [branchPickerSearch, setBranchPickerSearch] = createSignal("")
	const [branchPickerRect, setBranchPickerRect] = createSignal({ bottom: 0, left: 0 })

	async function loadBranchPicker() {
		const ws = opts.activeWorkspace()
		if (!ws) return
		setBranchPickerLoading(true)
		try {
			const c = await opts.getClient()
			const br = await c.listBranches(ws.id)
			setBranchPickerBranches(br.branches ?? [])
		} catch { /* 忽略 */ }
		finally { setBranchPickerLoading(false) }
	}

	function openBranchPicker(e: MouseEvent, btn: HTMLButtonElement) {
		e.stopPropagation()
		if (showBranchPicker()) { setShowBranchPicker(false); return }
		const rect = btn.getBoundingClientRect()
		setBranchPickerRect({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
		setBranchPickerSearch("")
		setShowBranchPicker(true)
		void loadBranchPicker()
	}

	async function switchBranch(branch: string) {
		const ws = opts.activeWorkspace()
		if (!ws || branch === currentBranch()) { setShowBranchPicker(false); return }
		setShowBranchPicker(false)
		try {
			const c = await opts.getClient()
			const r = await c.checkoutBranch(ws.id, branch)
			if (r.ok) {
				setCurrentBranch(branch)
			} else {
				alert(`切换分支失败：${r.error ?? '未知错误'}`)
			}
		} catch (e) {
			alert(`切换分支失败：${(e as Error).message}`)
		}
	}

	return {
		currentBranch, setCurrentBranch,
		showBranchPicker, setShowBranchPicker,
		branchPickerBranches, setBranchPickerBranches,
		branchPickerLoading, branchPickerSearch, setBranchPickerSearch,
		branchPickerRect,
		loadBranchPicker, openBranchPicker, switchBranch,
	}
}
