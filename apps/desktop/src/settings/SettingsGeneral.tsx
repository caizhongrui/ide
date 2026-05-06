/*---------------------------------------------------------------------------------------------
 *  SettingsGeneral — 常规设置面板（K11c-2：从 App.tsx 切出）
 *
 *  纯渲染，状态/动作通过 props 注入。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface SettingsGeneralProps {
	currentUser:     () => { email?: string; userName?: string } | null
	loginApiUrl:     () => string
	allowAlways:     () => Set<string>
	locale:          () => string
	toolLabels:      Record<string, string>
	handleLogout:    () => void | Promise<void>
	removeAllowAlways: (name: string) => void
	switchLocale:    (l: 'zh-CN' | 'en') => void
}

const KEYBOARD_SHORTCUTS: Array<[string, string]> = [
	['⌘↵', '发送消息'],
	['⌘N', '新建会话'],
	['⌘W', '关闭当前会话'],
	['⌘[', '上一个会话'],
	['⌘]', '下一个会话'],
	['⌘K', '命令面板 (/)'],
	['⌘`', '切换终端'],
	['⌘,', '打开设置'],
	['Esc', '停止生成 / 关闭面板'],
]

export const SettingsGeneral: Component<SettingsGeneralProps> = (props) => {
	return (
		<>
			<div class="settings-title">常规</div>
			<div class="settings-group">
				<div class="settings-group-title">账号</div>
				<div class="settings-card">
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">用户</div>
							<div class="settings-row-desc">
								{props.currentUser()?.email || props.currentUser()?.userName || '—'}
							</div>
						</div>
						<button
							class="btn btn-ghost"
							style="font-size:12px"
							onClick={() => props.handleLogout()}
						>退出登录</button>
					</div>
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">服务器</div>
							<div class="settings-row-desc">{props.loginApiUrl()}</div>
						</div>
					</div>
				</div>
			</div>

			<div class="settings-group">
				<div class="settings-group-title">键盘快捷键</div>
				<div class="settings-card">
					{KEYBOARD_SHORTCUTS.map(([key, desc]) => (
						<div class="settings-row">
							<div class="settings-row-label">
								<div class="settings-row-desc">{desc}</div>
							</div>
							<span style="font-size:11px;color:var(--text-faint);background:var(--bg-muted);padding:3px 8px;border-radius:4px;border:1px solid var(--border-strong);font-family:monospace">{key}</span>
						</div>
					))}
				</div>
			</div>

			<div class="settings-group">
				<div class="settings-group-title">权限记忆</div>
				<div class="settings-card">
					<Show
						when={props.allowAlways().size === 0}
						fallback={
							<For each={[...props.allowAlways()]}>
								{(toolName) => (
									<div class="settings-row">
										<div class="settings-row-label">
											<div class="settings-row-name">{props.toolLabels[toolName] ?? toolName}</div>
											<div class="settings-row-desc">已"总是允许"此工具，跳过审批对话框</div>
										</div>
										<button
											class="btn btn-ghost"
											onClick={() => props.removeAllowAlways(toolName)}
											style="color:#f87171;border-color:rgba(239,68,68,0.3)"
										>撤销</button>
									</div>
								)}
							</For>
						}
					>
						<div class="settings-row">
							<div class="settings-row-label">
								<div class="settings-row-desc">
									暂无"总是允许"的工具。在工具审批对话框点击"总是允许"后会显示在此。
								</div>
							</div>
						</div>
					</Show>
				</div>
			</div>

			<div class="settings-group">
				<div class="settings-group-title">界面语言</div>
				<div class="settings-card">
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">语言 / Language</div>
							<div class="settings-row-desc">切换界面语言（部分文字重启后生效）</div>
						</div>
						<div style="display:flex;gap:6px">
							<button
								class="btn btn-ghost"
								style={props.locale() === 'zh-CN' ? 'border-color:var(--accent);color:var(--accent)' : ''}
								onClick={() => props.switchLocale('zh-CN')}
							>
								中文
							</button>
							<button
								class="btn btn-ghost"
								style={props.locale() === 'en' ? 'border-color:var(--accent);color:var(--accent)' : ''}
								onClick={() => props.switchLocale('en')}
							>
								English
							</button>
						</div>
					</div>
				</div>
			</div>
		</>
	)
}
