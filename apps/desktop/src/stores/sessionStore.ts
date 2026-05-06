/*---------------------------------------------------------------------------------------------
 *  sessionStore — 会话列表 + 选中会话状态容器（K11b-cont）
 *--------------------------------------------------------------------------------------------*/

import { createSignal, createMemo } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { SessionSummary, Workspace } from '@maxian/sdk'

export interface WorkspaceGroupItem {
	workspace:     Workspace | null
	workspacePath: string
	sessions:      SessionSummary[]
}

export interface SessionStore {
	// 状态
	sessions:           Accessor<SessionSummary[]>
	activeSessionId:    Accessor<string | null>
	editingSessionId:   Accessor<string | null>
	editingSessionTitle: Accessor<string>
	sessionSearch:      Accessor<string>
	showArchived:       Accessor<boolean>
	collapsedGroups:    Accessor<Set<string>>
	// 派生（按 ui mode + 工作区分组）
	groupedSessions: (
		workspaces: Workspace[],
		uiMode: 'chat' | 'code',
	) => WorkspaceGroupItem[]
	// 写入
	setSessions:         (next: SessionSummary[] | ((prev: SessionSummary[]) => SessionSummary[])) => void
	setActiveSessionId:  (id: string | null) => void
	setEditingSessionId: (id: string | null) => void
	setEditingSessionTitle: (v: string) => void
	setSessionSearch:    (v: string) => void
	setShowArchived:     (v: boolean | ((prev: boolean) => boolean)) => void
	toggleGroupCollapse: (wsId: string) => void
	// 编辑流程便利方法
	startRename:         (id: string, currentTitle: string) => void
	cancelRename:        () => void
}

export function createSessionStore(): SessionStore {
	const [sessions, setSessions] = createSignal<SessionSummary[]>([])
	const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
	const [editingSessionId, setEditingSessionId] = createSignal<string | null>(null)
	const [editingSessionTitle, setEditingSessionTitle] = createSignal('')
	const [sessionSearch, setSessionSearch] = createSignal('')
	const [showArchived, setShowArchived] = createSignal(false)
	const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set())

	const toggleGroupCollapse = (wsId: string): void => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev)
			if (next.has(wsId)) next.delete(wsId)
			else next.add(wsId)
			return next
		})
	}

	const groupedSessions = (workspaces: Workspace[], uiMode: 'chat' | 'code'): WorkspaceGroupItem[] => {
		const groups: WorkspaceGroupItem[] = []
		const groupMap = new Map<string, SessionSummary[]>()
		const q = sessionSearch().trim().toLowerCase()

		const filtered = sessions().filter((s) => {
			if ((s.uiMode ?? 'code') !== uiMode) return false
			if (!showArchived() && s.archived) return false
			if (showArchived() && !s.archived) return false
			if (!q) return true
			return (s.title ?? '').toLowerCase().includes(q)
		})

		for (const s of filtered) {
			const path = s.workspacePath ?? ''
			if (!groupMap.has(path)) groupMap.set(path, [])
			groupMap.get(path)!.push(s)
		}

		// Known workspaces first
		for (const ws of workspaces) {
			const sList = groupMap.get(ws.path) ?? []
			groups.push({ workspace: ws, workspacePath: ws.path, sessions: sList })
			groupMap.delete(ws.path)
		}

		// Unknown workspace paths (orphaned sessions)
		groupMap.forEach((sList, path) => {
			if (sList.length > 0) {
				groups.push({ workspace: null, workspacePath: path, sessions: sList })
			}
		})

		return groups
	}

	const startRename = (id: string, currentTitle: string): void => {
		setEditingSessionId(id)
		setEditingSessionTitle(currentTitle)
	}

	const cancelRename = (): void => {
		setEditingSessionId(null)
	}

	return {
		sessions,
		activeSessionId,
		editingSessionId,
		editingSessionTitle,
		sessionSearch,
		showArchived,
		collapsedGroups,
		groupedSessions,
		setSessions,
		setActiveSessionId,
		setEditingSessionId,
		setEditingSessionTitle,
		setSessionSearch,
		setShowArchived,
		toggleGroupCollapse,
		startRename,
		cancelRename,
	}
}
