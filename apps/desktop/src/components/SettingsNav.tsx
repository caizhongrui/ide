/*---------------------------------------------------------------------------------------------
 *  SettingsNav — 设置面板左侧导航（K11c 抽离自 App.tsx）
 *
 *  纯渲染：当前激活 tab 名 + 切 tab 回调 + 错误日志数量 通过 props 注入。
 *  支持的 tab id 由 host 自定义（与 SettingsTab 类型对齐即可）。
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'

export type SettingsTab =
	| 'general'
	| 'appearance'
	| 'worktree'
	| 'mcp'
	| 'keybinds'
	| 'templates'
	| 'usage'
	| 'errors'
	| 'plugins'
	| 'about'

export interface SettingsNavProps {
	tab:           () => SettingsTab
	setTab:        (t: SettingsTab) => void
	onClose:       () => void
	/** 错误日志条数，> 0 时在"错误日志"按钮显示 badge */
	errorCount:    () => number
}

export const SettingsNav: Component<SettingsNavProps> = (props) => {
	return (
		<nav class="settings-nav">
			<button class="settings-nav-back" onClick={props.onClose}>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="15 18 9 12 15 6"/>
				</svg>
				返回应用
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "general" }} onClick={() => props.setTab("general")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<circle cx="12" cy="12" r="3"/>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
				</svg>
				常规
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "appearance" }} onClick={() => props.setTab("appearance")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
				</svg>
				外观
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "worktree" }} onClick={() => props.setTab("worktree")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
				</svg>
				Git Worktree
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "mcp" }} onClick={() => props.setTab("mcp")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
				</svg>
				MCP Servers
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "keybinds" }} onClick={() => props.setTab("keybinds")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="8" y1="16" x2="16" y2="16"/>
				</svg>
				快捷键
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "templates" }} onClick={() => props.setTab("templates")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
				</svg>
				会话模板
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "usage" }} onClick={() => props.setTab("usage")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
				</svg>
				Token 用量
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "errors" }} onClick={() => props.setTab("errors")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
				</svg>
				错误日志
				<Show when={props.errorCount() > 0}>
					<span class="file-badge">{props.errorCount()}</span>
				</Show>
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "plugins" }} onClick={() => props.setTab("plugins")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
				</svg>
				插件开发
			</button>
			<button class="settings-nav-item" classList={{ active: props.tab() === "about" }} onClick={() => props.setTab("about")}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
				</svg>
				关于
			</button>
		</nav>
	)
}
