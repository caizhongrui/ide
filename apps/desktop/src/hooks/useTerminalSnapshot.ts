/*---------------------------------------------------------------------------------------------
 *  useTerminalSnapshot — 终端状态快照管理（K11a-cont）
 *  封装：tabs 数组的增删改查 + active id + 折叠/可见性
 *--------------------------------------------------------------------------------------------*/

import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'

export interface TerminalTab {
	id:        string
	title:     string
	sessionId: string
}

export interface TerminalSnapshot {
	tabs:               Accessor<TerminalTab[]>
	activeId:           Accessor<string | null>
	visible:            Accessor<boolean>
	collapsed:          Accessor<boolean>
	addTab:             (tab: TerminalTab) => void
	removeTab:          (id: string) => void
	setActiveId:        (id: string | null) => void
	setVisible:         (v: boolean) => void
	setCollapsed:       (v: boolean) => void
	getTabsForSession:  (sessionId: string) => TerminalTab[]
	updateTabTitle:     (id: string, title: string) => void
}

export function useTerminalSnapshot(): TerminalSnapshot {
	const [tabs, setTabs] = createSignal<TerminalTab[]>([])
	const [activeId, setActiveId] = createSignal<string | null>(null)
	const [visible, setVisible] = createSignal(false)
	const [collapsed, setCollapsed] = createSignal(false)

	const addTab = (tab: TerminalTab): void => {
		setTabs((prev) => [...prev, tab])
	}

	const removeTab = (id: string): void => {
		setTabs((prev) => prev.filter((t) => t.id !== id))
		if (activeId() === id) {
			const remaining = tabs().filter((t) => t.id !== id)
			setActiveId(remaining[remaining.length - 1]?.id ?? null)
		}
	}

	const updateTabTitle = (id: string, title: string): void => {
		setTabs((prev) => prev.map((t) => t.id === id ? { ...t, title } : t))
	}

	const getTabsForSession = (sessionId: string): TerminalTab[] => {
		return tabs().filter((t) => t.sessionId === sessionId)
	}

	return {
		tabs,
		activeId,
		visible,
		collapsed,
		addTab,
		removeTab,
		setActiveId,
		setVisible,
		setCollapsed,
		getTabsForSession,
		updateTabTitle,
	}
}
