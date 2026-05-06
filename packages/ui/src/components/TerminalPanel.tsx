/*---------------------------------------------------------------------------------------------
 *  TerminalPanel — 集成终端面板（K10b：从 desktop App.tsx 抽到 @maxian/ui）
 *
 *  纯渲染组件，所有状态 + xterm 实例化 + PTY 通信都由 host 应用（App.tsx）持有，通过 props 注入。
 *  设计原则：
 *  - allTabs 是全部终端 tab 的列表，被 <For> 渲染（每个 tab 一个 <div id="term-body-{id}">）
 *    这样 xterm canvas 永远不会因 SolidJS rerender 卸载，避免切会话/换 tab 时内容丢失。
 *  - sessionTabs 是当前会话的 tab 子集，仅用于 header 标签栏显示。
 *  - 所有交互（resize / 切 tab / 关 tab / 新建 / 折叠 / 关闭面板）都通过回调外抛。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'
// @ts-expect-error vite ?inline → string
import css from './TerminalPanel.css?inline'
import { injectStyleOnce } from './_injectStyle.js'

/** 集成终端 Tab（与 desktop 端 TerminalTab 同型） */
export interface TerminalTab {
	id:        string
	title:     string
	sessionId: string   // 所属会话 ID，用于多会话终端隔离
}

export interface TerminalPanelProps {
	/** 全部 tab 列表（用于 <For> 渲染所有 xterm DOM 容器，不会被卸载） */
	allTabs:        TerminalTab[]
	/** 当前会话过滤后的 tab 列表（仅用于 header 标签栏显示） */
	sessionTabs:    TerminalTab[]
	/** 当前激活的 tab id */
	activeTermId:   string | null
	/** 是否折叠 */
	collapsed:      boolean
	/** 当前高度（px），仅在非折叠时生效 */
	height:         number

	// ── 回调（host 应用持有真实状态/PTY 句柄，UI 仅外抛事件）──
	/** 拖拽 resize 起手 */
	onResizeStart:    (e: PointerEvent) => void
	/** 切到指定 tab */
	onSwitchTab:      (id: string) => void
	/** 关闭某个 tab（伴随 PTY 终止） */
	onCloseTab:       (id: string, e: MouseEvent) => void
	/** 新建 tab（一般是当前会话起一个新 PTY） */
	onAddTab:         () => void
	/** 切换折叠 / 展开 */
	onToggleCollapse: () => void
	/** 关闭整个面板（关掉当前会话所有 tab + 隐藏面板） */
	onClose:          () => void
}

export const TerminalPanel: Component<TerminalPanelProps> = (props) => {
	injectStyleOnce('maxian-ui-terminal-panel', css as string)

	return (
		<div
			class="terminal-panel"
			classList={{ collapsed: props.collapsed }}
			style={!props.collapsed ? `height:${props.height}px` : ''}
		>
			{/* 拖拽 resize handle */}
			<div class="terminal-resize-handle" onPointerDown={props.onResizeStart} />

			{/* 顶部 header */}
			<div class="terminal-panel-header">
				<div class="terminal-tabs">
					<For each={props.sessionTabs}>
						{(tab) => (
							<div
								class="terminal-tab"
								classList={{ active: props.activeTermId === tab.id }}
								onClick={() => props.onSwitchTab(tab.id)}
							>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="4 17 10 11 4 5" />
									<line x1="12" y1="19" x2="20" y2="19" />
								</svg>
								{tab.title}
								<span class="terminal-tab-close" onClick={(e) => props.onCloseTab(tab.id, e)}>✕</span>
							</div>
						)}
					</For>
					<button class="terminal-panel-btn" onClick={props.onAddTab} title="新建终端">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
					</button>
				</div>
				<div class="terminal-panel-actions">
					<button
						class="terminal-panel-btn"
						onClick={props.onToggleCollapse}
						title={props.collapsed ? '展开' : '折叠'}
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<Show when={props.collapsed} fallback={<polyline points="18 15 12 9 6 15" />}>
								<polyline points="6 9 12 15 18 9" />
							</Show>
						</svg>
					</button>
					<button class="terminal-panel-btn" onClick={props.onClose} title="关闭终端">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			</div>

			{/* 终端内容区 — 渲染【所有】会话的 term-body div，CSS 控制可见性，
			    避免 SolidJS rerender 把 xterm canvas 卸载丢失内容。 */}
			<div class="terminal-body" style={props.collapsed ? 'display:none' : ''}>
				<For each={props.allTabs}>
					{(tab) => (
						<div
							id={`term-body-${tab.id}`}
							class="terminal-xterm"
							style={props.activeTermId === tab.id ? '' : 'display:none'}
						/>
					)}
				</For>
			</div>
		</div>
	)
}
