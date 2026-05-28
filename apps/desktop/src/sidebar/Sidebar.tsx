/*---------------------------------------------------------------------------------------------
 *  Sidebar — 主侧边栏（Chat / Code / Task 三段切换 + 会话列表 + 用户信息）（K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { createMemo, For, Show } from 'solid-js'
import type { Component } from 'solid-js'
import type { SessionSummary, Workspace } from '@maxian/sdk'
import type { UserInfo } from '../api'
import { SessionItem } from './SessionItem'
import { SidebarUserSection } from './SidebarUserSection'

export interface WorkspaceGroup {
	workspace:     Workspace | null
	workspacePath: string
	sessions:      SessionSummary[]
}

export interface SidebarProps {
	// 用户/路由
	currentUser:        () => UserInfo | null
	globalMode:         () => 'chat' | 'code'
	showBatchPanel:     () => boolean
	showSettings:       () => boolean
	userExpanded:       () => boolean
	setUserExpanded:    (v: boolean | ((prev: boolean) => boolean)) => void
	setShowSettings:    (v: boolean) => void
	setSettingsTab:     (tab: any) => void
	leaveBatchPanelToMode: (mode: 'chat' | 'code') => void
	setShowBatchPanel:  (v: boolean) => void
	handleLogout:       () => void
	// 会话搜索/过滤
	sessions:           () => SessionSummary[]
	workspaces:         () => Workspace[]
	groupedSessions:    () => WorkspaceGroup[]
	sessionSearch:      () => string
	setSessionSearch:   (v: string) => void
	showArchived:       () => boolean
	setShowArchived:    (v: boolean | ((prev: boolean) => boolean)) => void
	collapsedGroups:    () => Set<string>
	toggleGroupCollapse: (wsId: string) => void
	// 会话操作
	activeSessionId:    () => string | null
	editingSessionId:   () => string | null
	editingSessionTitle: () => string
	setEditingSessionTitle: (v: string) => void
	selectSession:      (id: string) => void
	startRenameSession: (e: MouseEvent, s: SessionSummary) => void
	commitRenameSession: (id: string) => void
	cancelRenameSession: () => void
	togglePinSession:   (id: string, pinned: boolean) => void
	toggleArchiveSession: (id: string, archived: boolean) => void
	deleteSession:      (e: MouseEvent, id: string) => void
	createSession:      () => void
	pickFolder:         () => void
	// 多选删除（K-BulkDelete）
	sessionSelectMode:  () => boolean
	toggleSessionSelectMode: () => void
	selectedSessionIds: () => Set<string>
	toggleSessionSelected: (id: string) => void
	selectAllVisibleSessions: (visibleIds: string[]) => void
	bulkDeleteSelectedSessions: () => void | Promise<void>
	// 工作区操作
	editingWorkspaceId:  () => string | null
	editingWorkspaceName: () => string
	setEditingWorkspaceName: (v: string) => void
	createSessionInWorkspace: (e: MouseEvent, ws: Workspace) => void
	startRenameWorkspace: (e: MouseEvent, ws: Workspace) => void
	commitRenameWorkspace: (id: string) => void
	cancelRenameWorkspace: () => void
	deleteWorkspace:    (e: MouseEvent, ws: Workspace) => void
	// helper
	userInitials:       (u: UserInfo) => string
	shortPath:          (p: string) => string
}

export const Sidebar: Component<SidebarProps> = (props) => {
	// chat 模式下的平铺会话列表（置顶优先，按时间降序）+ 搜索 + 归档过滤
	const chatSessions = createMemo(() => {
		const q = props.sessionSearch().trim().toLowerCase()
		return props.sessions()
			.filter((s) => (s.uiMode ?? 'code') === 'chat')
			.filter((s) => props.showArchived() ? !!s.archived : !s.archived)
			.filter((s) => !q || (s.title ?? '').toLowerCase().includes(q))
			.sort((a, b) => {
				if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
				return b.updatedAt - a.updatedAt
			})
	})

	const renderSessionItem = (s: SessionSummary): any => (
		<SessionItem
			s={s}
			isActive={() => props.activeSessionId() === s.id && !props.showSettings()}
			editingSessionId={props.editingSessionId}
			editingSessionTitle={props.editingSessionTitle}
			setEditingSessionTitle={props.setEditingSessionTitle}
			onSelect={props.selectSession}
			onStartRename={props.startRenameSession}
			onCommitRename={props.commitRenameSession}
			onCancelRename={props.cancelRenameSession}
			onTogglePin={props.togglePinSession}
			onToggleArchive={props.toggleArchiveSession}
			onDelete={props.deleteSession}
			selectMode={props.sessionSelectMode}
			isSelected={() => props.selectedSessionIds().has(s.id)}
			onToggleSelected={props.toggleSessionSelected}
		/>
	)

	return (
		<aside class="sidebar">
			{/* Header */}
			<div class="sidebar-header">
				{/* 分段模式切换：Chat / Code / 任务批次 */}
				<div class="mode-segmented">
					<button
						class="mode-seg-btn"
						classList={{ active: props.globalMode() === 'chat' && !props.showBatchPanel() }}
						onClick={() => props.leaveBatchPanelToMode('chat')}
						title="Chat — 智能对话"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
						</svg>
						Chat
					</button>
					<button
						class="mode-seg-btn"
						classList={{ active: props.globalMode() === 'code' && !props.showBatchPanel() }}
						onClick={() => props.leaveBatchPanelToMode('code')}
						title="Code — 智能编码 Agent"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
							<polyline points="16 18 22 12 16 6" />
							<polyline points="8 6 2 12 8 18" />
						</svg>
						Code
					</button>
					<button
						class="mode-seg-btn"
						classList={{ active: props.showBatchPanel() }}
						onClick={() => props.setShowBatchPanel(true)}
						title="Task — 批量给项目派任务"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
							<rect x="3" y="3" width="7" height="7" />
							<rect x="14" y="3" width="7" height="7" />
							<rect x="3" y="14" width="7" height="7" />
							<rect x="14" y="14" width="7" height="7" />
						</svg>
						Task
					</button>
				</div>

				{/* 右侧操作按钮（批次模式不显示这俩，BatchPanel 自带"+ 新建"）*/}
				<Show when={!props.showBatchPanel()}>
					<div class="sidebar-actions">
						<Show when={props.globalMode() === 'chat'}>
							{/* Chat 模式：新建对话 */}
							<button class="icon-btn" onClick={props.createSession} title="新建对话 (⌘N)">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
								</svg>
							</button>
						</Show>
						<Show when={props.globalMode() === 'code'}>
							{/* Code 模式：添加项目 */}
							<button class="icon-btn" onClick={props.pickFolder} title="添加项目">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
									<line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
								</svg>
							</button>
						</Show>
					</div>
				</Show>
			</div>

			{/* 批次模式时不显示会话列表（让 BatchPanel 拥有自己的批次列表 + 详情）*/}
			<Show when={!props.showBatchPanel()}>
				{/* 会话搜索 + 归档切换 */}
				<div class="sidebar-search-wrap">
					<svg class="sidebar-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						class="sidebar-search-input"
						placeholder={props.showArchived() ? '在归档里搜索…' : '搜索会话…'}
						value={props.sessionSearch()}
						onInput={(e) => props.setSessionSearch(e.currentTarget.value)}
					/>
					<button
						class="sidebar-archive-toggle"
						classList={{ active: props.showArchived() }}
						onClick={() => props.setShowArchived((v) => !v)}
						title={props.showArchived() ? '查看活跃会话' : '查看已归档'}
						data-tip={props.showArchived() ? '查看活跃会话' : '查看已归档'}
					>
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="21 8 21 21 3 21 3 8" />
							<rect x="1" y="3" width="22" height="5" />
							<line x1="10" y1="12" x2="14" y2="12" />
						</svg>
					</button>
					{/* 批量删除入口（多选模式时图标高亮）—— 跟归档按钮并排在搜索栏 */}
					<button
						class="sidebar-archive-toggle sidebar-bulk-toggle"
						classList={{ active: props.sessionSelectMode() }}
						onClick={props.toggleSessionSelectMode}
						title={props.sessionSelectMode() ? '退出多选' : '批量删除（多选）'}
						data-tip={props.sessionSelectMode() ? '退出多选' : '批量删除（多选）'}
					>
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="3 6 5 6 21 6" />
							<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
							<path d="M10 11v6" /><path d="M14 11v6" />
							<path d="M9 6V4h6v2" />
						</svg>
					</button>
					<Show when={props.sessionSearch()}>
						<button
							class="sidebar-search-clear"
							onClick={() => props.setSessionSearch('')}
							title="清除"
							data-tip="清除"
						>
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
								<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</Show>
				</div>

				{/* 多选模式工具栏（K-BulkDelete）—— 紧凑版,适配 232px 窄边栏 */}
				<Show when={props.sessionSelectMode()}>
					<div class="sidebar-bulk-toolbar">
						<span class="sidebar-bulk-count" title="已选数量">
							<span class="sidebar-bulk-count-num">{props.selectedSessionIds().size}</span>
							<span class="sidebar-bulk-count-unit">已选</span>
						</span>
						<button
							class="sidebar-bulk-icon-btn"
							onClick={() => {
								const visibleIds: string[] = props.globalMode() === 'chat'
									? chatSessions().map(s => s.id)
									: props.groupedSessions().flatMap(g => g.sessions.map(s => s.id))
								props.selectAllVisibleSessions(visibleIds)
							}}
							title="全选 / 反选当前可见列表"
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3" y="3" width="18" height="18" rx="2" />
								<polyline points="8 12 11 15 16 9" />
							</svg>
						</button>
						<button
							class="sidebar-bulk-icon-btn sidebar-bulk-danger"
							classList={{ disabled: props.selectedSessionIds().size === 0 }}
							onClick={() => void props.bulkDeleteSelectedSessions()}
							title={props.selectedSessionIds().size > 0 ? `删除选中的 ${props.selectedSessionIds().size} 个会话` : '请先勾选要删除的会话'}
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="3 6 5 6 21 6" />
								<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
								<path d="M10 11v6" /><path d="M14 11v6" />
								<path d="M9 6V4h6v2" />
							</svg>
						</button>
						<button
							class="sidebar-bulk-icon-btn"
							onClick={props.toggleSessionSelectMode}
							title="退出多选模式"
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
								<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>
				</Show>

				{/* ── Chat 模式：平铺会话列表 ── */}
				<Show when={props.globalMode() === 'chat'}>
					<div class="sidebar-sessions">
						<Show when={chatSessions().length === 0}>
							<div class="sessions-empty-hint">
								<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="color:var(--text-faint)">
									<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
								</svg>
								<span>点击 + 新建对话</span>
							</div>
						</Show>
						<For each={chatSessions()}>
							{renderSessionItem}
						</For>
					</div>
				</Show>

				{/* ── Code 模式：按工作区分组 ── */}
				<Show when={props.globalMode() === 'code'}>
					<div class="sidebar-sessions">
						<Show when={props.workspaces().length === 0 && props.sessions().filter((s) => (s.uiMode ?? 'code') === 'code').length === 0}>
							<div class="sessions-empty-hint">
								<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="color:var(--text-faint)">
									<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
								</svg>
								<span>点击右上角 + 添加项目</span>
							</div>
						</Show>

						<For each={props.groupedSessions()}>
							{(group) => {
								const wsId = group.workspace?.id ?? group.workspacePath
								const isCollapsed = (): boolean => props.collapsedGroups().has(wsId)
								return (
									<div class="session-group">
										{/* Workspace group header */}
										<div
											class="session-group-header"
											onClick={() => props.toggleGroupCollapse(wsId)}
											title={group.workspacePath}
										>
											{/* Collapse arrow */}
											<svg
												class="group-collapse-arrow"
												classList={{ collapsed: isCollapsed() }}
												width="10" height="10" viewBox="0 0 24 24"
												fill="none" stroke="currentColor" stroke-width="2.5"
											>
												<polyline points="6 9 12 15 18 9" />
											</svg>

											{/* Name or rename input */}
											<Show
												when={props.editingWorkspaceId() === group.workspace?.id}
												fallback={
													<span class="session-group-name">
														{group.workspace?.name ?? props.shortPath(group.workspacePath)}
													</span>
												}
											>
												<input
													class="rename-input"
													value={props.editingWorkspaceName()}
													onInput={(e) => props.setEditingWorkspaceName(e.currentTarget.value)}
													onKeyDown={(e) => {
														e.stopPropagation()
														if (e.key === 'Enter')  props.commitRenameWorkspace(group.workspace!.id)
														if (e.key === 'Escape') props.cancelRenameWorkspace()
													}}
													onBlur={() => props.commitRenameWorkspace(group.workspace!.id)}
													onClick={(e) => e.stopPropagation()}
													ref={(el) => { setTimeout(() => { el?.focus(); el?.select() }, 10) }}
												/>
											</Show>

											{/* Hover actions: new session + rename */}
											<Show when={group.workspace && props.editingWorkspaceId() !== group.workspace.id}>
												<div class="session-group-actions">
													<button
														class="group-action-btn"
														onClick={(e) => { e.stopPropagation(); props.createSessionInWorkspace(e, group.workspace!) }}
														title="新建会话"
														data-tip="新建会话"
													>
														<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
															<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
														</svg>
													</button>
													<button
														class="group-action-btn"
														onClick={(e) => { e.stopPropagation(); props.startRenameWorkspace(e, group.workspace!) }}
														title="重命名项目"
														data-tip="重命名项目"
													>
														<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
															<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
															<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
														</svg>
													</button>
													<button
														class="group-action-btn del"
														onClick={(e) => props.deleteWorkspace(e, group.workspace!)}
														title="移除项目"
														data-tip="移除项目"
													>
														<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
															<polyline points="3 6 5 6 21 6" />
															<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
															<path d="M10 11v6" /><path d="M14 11v6" />
															<path d="M9 6V4h6v2" />
														</svg>
													</button>
												</div>
											</Show>
										</div>

										{/* Sessions in this group (hidden when collapsed) */}
										<Show when={!isCollapsed()}>
											<For each={group.sessions}>
												{renderSessionItem}
											</For>
											<Show when={group.sessions.length === 0 && group.workspace}>
												<div class="session-group-empty">暂无会话</div>
											</Show>
										</Show>
									</div>
								)
							}}
						</For>
					</div>
				</Show>

				{/* Bottom: User (collapsible) — 复用 SidebarUserSection 与 batch 模式共享一份实现 */}
				<SidebarUserSection
					currentUser={props.currentUser}
					userExpanded={props.userExpanded}
					setUserExpanded={props.setUserExpanded}
					showSettings={props.showSettings}
					setShowSettings={props.setShowSettings}
					setSettingsTab={props.setSettingsTab}
					handleLogout={props.handleLogout}
					userInitials={props.userInitials}
				/>
			</Show>
		</aside>
	)
}
