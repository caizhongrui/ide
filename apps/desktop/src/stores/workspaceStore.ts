/*---------------------------------------------------------------------------------------------
 *  workspaceStore — 工作区列表 + 当前活动工作区状态容器（K11b-cont）
 *--------------------------------------------------------------------------------------------*/

import { createSignal, createMemo } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { Workspace } from '@maxian/sdk'

export interface WorkspaceStore {
	workspaces:           Accessor<Workspace[]>
	activeWorkspaceId:    Accessor<string | null>
	activeWorkspace:      Accessor<Workspace | null>
	editingWorkspaceId:   Accessor<string | null>
	editingWorkspaceName: Accessor<string>
	setWorkspaces:        (next: Workspace[] | ((prev: Workspace[]) => Workspace[])) => void
	setActiveWorkspaceId: (id: string | null) => void
	setEditingWorkspaceId: (id: string | null) => void
	setEditingWorkspaceName: (v: string) => void
	startRenameWorkspace: (id: string, currentName: string) => void
	cancelRenameWorkspace: () => void
}

export function createWorkspaceStore(): WorkspaceStore {
	const [workspaces, setWorkspaces] = createSignal<Workspace[]>([])
	const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string | null>(null)
	const [editingWorkspaceId, setEditingWorkspaceId] = createSignal<string | null>(null)
	const [editingWorkspaceName, setEditingWorkspaceName] = createSignal('')

	const activeWorkspace = createMemo((): Workspace | null => {
		const id = activeWorkspaceId()
		if (!id) return null
		return workspaces().find((w) => w.id === id) ?? null
	})

	const startRenameWorkspace = (id: string, currentName: string): void => {
		setEditingWorkspaceId(id)
		setEditingWorkspaceName(currentName)
	}

	const cancelRenameWorkspace = (): void => {
		setEditingWorkspaceId(null)
	}

	return {
		workspaces,
		activeWorkspaceId,
		activeWorkspace,
		editingWorkspaceId,
		editingWorkspaceName,
		setWorkspaces,
		setActiveWorkspaceId,
		setEditingWorkspaceId,
		setEditingWorkspaceName,
		startRenameWorkspace,
		cancelRenameWorkspace,
	}
}
