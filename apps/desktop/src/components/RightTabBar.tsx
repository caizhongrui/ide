/*---------------------------------------------------------------------------------------------
 *  RightTabBar — 右侧竖向 tab 条（v0.2.24 from jiusi 0.3.2）
 *
 *  替换原顶部工具栏上的功能按钮：把所有右侧面板的开关挪到右边缘常驻的 40px 竖条，
 *  纯单开（任意时刻最多一个面板打开），消除多面板互相挤压。
 *
 *  顶部一个"展开所有思考"快捷动作（非面板，纯 toggle）；
 *  下面按顺序排列各功能 tab。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component, JSX } from 'solid-js'

export type RightPanelKey =
	| 'context'   | 'revert'   | 'filter'    | 'explorer'
	| 'skills'    | 'memory'   | 'codebase'  | 'browser'
	| 'mcp'       | 'subagent' | 'filetree'

export interface RightTabDef {
	key:    RightPanelKey
	title:  string
	icon:   JSX.Element
	/** 可选：右上角小角标数字（contextFiles 数 / running subagents 数 / changed files 数等） */
	badge?: () => number | null
}

export interface RightTabBarProps {
	active:              () => RightPanelKey | null
	onToggle:            (k: RightPanelKey) => void
	expandAllReasoning:  () => boolean
	onToggleExpandAll:   () => void
	/** 终端开关（独立 toggle，不参与 activeRightPanel 互斥） */
	terminalActive:      () => boolean
	onToggleTerminal:    () => void
	contextBadge:        () => number | null
	subagentBadge:       () => number | null
	filetreeBadge:       () => number | null
}

/** 按面板顺序排列的图标 + 标题，对齐原顶栏 */
function buildTabs(props: RightTabBarProps): RightTabDef[] {
	return [
		{
			key: 'context',
			title: '会话上下文',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M20 7h-3V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/>
					<line x1="8" y1="12" x2="16" y2="12"/>
				</svg>
			),
			badge: props.contextBadge,
		},
		{
			key: 'revert',
			title: '回退对话',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="1 4 1 10 7 10"/>
					<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
				</svg>
			),
		},
		{
			key: 'filter',
			title: '消息过滤',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
				</svg>
			),
		},
		{
			key: 'explorer',
			title: '文件浏览器',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>
				</svg>
			),
		},
		{
			key: 'skills',
			title: 'Skills 技能文档',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 2l2.5 7.5H22l-6 4.5 2.5 7.5L12 17l-6.5 4.5L8 14 2 9.5h7.5z"/>
				</svg>
			),
		},
		{
			key: 'memory',
			title: 'AI 记忆（跨会话偏好/约定）',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M9 12l2 2 4-4"/>
					<path d="M21 12c.552 0 1.005-.45.95-1A10 10 0 0 0 12 2c-5.523 0-10 4.477-10 10 0 5.523 4.477 10 10 10a10 10 0 0 0 9-5.95c.05-.55-.398-1-.95-1z"/>
				</svg>
			),
		},
		{
			key: 'codebase',
			title: '项目知识库（架构 / 模块 / API 索引）',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="16 18 22 12 16 6"/>
					<polyline points="8 6 2 12 8 18"/>
				</svg>
			),
		},
		{
			key: 'browser',
			title: '浏览器预览（dev server / localhost）',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10"/>
					<line x1="2" y1="12" x2="22" y2="12"/>
					<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
				</svg>
			),
		},
		{
			key: 'mcp',
			title: 'MCP 工具索引（已挂载 server / 工具列表 / 语义搜索）',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M9 2v6"/>
					<path d="M15 2v6"/>
					<path d="M6 8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>
					<path d="M12 17v5"/>
				</svg>
			),
		},
		{
			key: 'subagent',
			title: '子代理任务编排（task() 派出的并行子代理）',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="4" r="2"/>
					<circle cx="5" cy="20" r="2"/>
					<circle cx="19" cy="20" r="2"/>
					<path d="M12 6v3"/>
					<path d="M12 9l-7 9"/>
					<path d="M12 9l7 9"/>
				</svg>
			),
			badge: props.subagentBadge,
		},
		{
			key: 'filetree',
			title: '变更记录',
			icon: (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
				</svg>
			),
			badge: props.filetreeBadge,
		},
	]
}

export const RightTabBar: Component<RightTabBarProps> = (props) => {
	const tabs = buildTabs(props)

	return (
		<div class="right-tab-bar" role="tablist" aria-label="右侧面板">
			{/* 顶部独立动作 1：展开/折叠所有思考 */}
			<button
				class="right-tab-btn right-tab-action"
				classList={{ active: props.expandAllReasoning() }}
				onClick={props.onToggleExpandAll}
				data-tooltip={props.expandAllReasoning() ? '折叠所有思考' : '展开所有思考'}
				aria-pressed={props.expandAllReasoning()}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<Show when={props.expandAllReasoning()} fallback={
						<>
							<polyline points="6 9 12 15 18 9"/>
							<polyline points="6 4 12 10 18 4" opacity="0.4"/>
						</>
					}>
						<polyline points="18 15 12 9 6 15"/>
						<polyline points="18 20 12 14 6 20" opacity="0.4"/>
					</Show>
				</svg>
			</button>

			{/* 顶部独立动作 2：终端切换（独立 toggle，不参与互斥） */}
			<button
				class="right-tab-btn right-tab-action"
				classList={{ active: props.terminalActive() }}
				onClick={props.onToggleTerminal}
				data-tooltip="终端 (⌘`)"
				aria-pressed={props.terminalActive()}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
				</svg>
			</button>

			<div class="right-tab-divider" />

			{/* 11 个面板 tab（互斥单开） */}
			<For each={tabs}>
				{(t) => (
					<button
						class="right-tab-btn"
						classList={{ active: props.active() === t.key }}
						data-right-tab={t.key}
						onClick={() => props.onToggle(t.key)}
						data-tooltip={t.title}
						role="tab"
						aria-selected={props.active() === t.key}
					>
						{t.icon}
						<Show when={t.badge && (t.badge()! > 0)}>
							<span class="right-tab-badge">{t.badge!()}</span>
						</Show>
					</button>
				)}
			</For>
		</div>
	)
}
