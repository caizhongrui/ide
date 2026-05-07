/*---------------------------------------------------------------------------------------------
 *  SidebarUserSection — 侧边栏底部用户信息块（chat/code/task 模式共用）
 *
 *  从 Sidebar.tsx 拆出，让 BatchPanel.tsx 也能复用同一份"折叠 → 展开 → 设置/退出"交互。
 *  样式仍走原来的 .sidebar-user / .sidebar-user-collapsed / .sidebar-user-expanded 等类，
 *  这样无论挂在哪个父容器里，外观都跟 .sidebar 自己的底部完全一致。
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'
import type { UserInfo } from '../api'

export interface SidebarUserSectionProps {
	currentUser:     () => UserInfo | null
	userExpanded:    () => boolean
	setUserExpanded: (v: boolean | ((prev: boolean) => boolean)) => void
	showSettings:    () => boolean
	setShowSettings: (v: boolean) => void
	setSettingsTab:  (tab: any) => void
	handleLogout:    () => void
	userInitials:    (user: UserInfo) => string
}

export const SidebarUserSection: Component<SidebarUserSectionProps> = (props) => {
	return (
		<div class="sidebar-user">
			<Show when={props.currentUser()}>
				{(user) => (
					<>
						<div
							class="sidebar-user-collapsed"
							classList={{ expanded: props.userExpanded() }}
							onClick={() => props.setUserExpanded((v) => !v)}
						>
							<div class="sidebar-user-avatar">{props.userInitials(user())}</div>
							<span class="sidebar-user-name-min">{user().nickName || user().userName}</span>
							<svg
								class="sidebar-chevron"
								classList={{ up: props.userExpanded() }}
								width="12" height="12" viewBox="0 0 24 24"
								fill="none" stroke="currentColor" stroke-width="2.5"
							>
								<polyline points="18 15 12 9 6 15" />
							</svg>
						</div>

						<Show when={props.userExpanded()}>
							<div class="sidebar-user-expanded">
								<div class="sidebar-user-details">
									<div class="sidebar-user-avatar large">{props.userInitials(user())}</div>
									<div class="sidebar-user-text">
										<div class="sidebar-user-fullname">{user().nickName || user().userName}</div>
										<div class="sidebar-user-email">{user().email || user().userName}</div>
									</div>
								</div>
								<div class="sidebar-user-actions">
									<button
										class="sidebar-action-btn"
										classList={{ active: props.showSettings() }}
										onClick={() => {
											props.setShowSettings(true)
											props.setSettingsTab('appearance')
											props.setUserExpanded(false)
										}}
									>
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
											<circle cx="12" cy="12" r="3" />
											<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
										</svg>
										设置
									</button>
									<button class="sidebar-action-btn danger" onClick={props.handleLogout}>
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
											<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
											<polyline points="16 17 21 12 16 7" />
											<line x1="21" y1="12" x2="9" y2="12" />
										</svg>
										退出登录
									</button>
								</div>
							</div>
						</Show>
					</>
				)}
			</Show>
		</div>
	)
}
