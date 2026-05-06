/*---------------------------------------------------------------------------------------------
 *  GlobalCommandPalette — ⌘P 全局命令面板（K11a 抽离自 App.tsx）
 *
 *  注意：与 @maxian/ui 的 CommandPalette 同名但**职责完全不同**：
 *    - @maxian/ui CommandPalette = `/` slash 命令面板（聊天输入框内联弹出）
 *    - 本组件 = `⌘P` 全局搜索面板（顶层 modal，跨会话/文件/符号/命令）
 *
 *  纯渲染：query / idx / items / loading 状态由 host 应用持有，通过 props 注入。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface PaletteItem {
	type:     'session' | 'file' | 'symbol' | 'command'
	label:    string
	desc?:    string
	onSelect: () => void | Promise<void>
}

export interface GlobalCommandPaletteProps {
	query:        () => string
	setQuery:     (q: string) => void
	items:        () => PaletteItem[]
	idx:          () => number
	setIdx:       (idx: number | ((prev: number) => number)) => void
	loading:      () => boolean
	onClose:      () => void
}

export const GlobalCommandPalette: Component<GlobalCommandPaletteProps> = (props) => {
	return (
		<div class="keybind-overlay" onClick={props.onClose}>
			<div class="keybind-modal" onClick={(e) => e.stopPropagation()} style="width:640px">
				<div class="keybind-header">
					<span class="keybind-title">⌘P · 全局搜索</span>
					<button class="icon-btn" onClick={props.onClose} title="关闭 (Esc)">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
						</svg>
					</button>
				</div>
				<input
					class="keybind-search"
					placeholder="搜索会话、文件、符号、命令…"
					value={props.query()}
					onInput={(e) => props.setQuery(e.currentTarget.value)}
					autofocus
					onKeyDown={(e) => {
						const list = props.items()
						if (e.key === 'ArrowDown') {
							e.preventDefault()
							props.setIdx((i) => Math.min(i + 1, list.length - 1))
						} else if (e.key === 'ArrowUp') {
							e.preventDefault()
							props.setIdx((i) => Math.max(i - 1, 0))
						} else if (e.key === 'Enter') {
							e.preventDefault()
							const sel = list[props.idx()]
							if (sel) void sel.onSelect()
						} else if (e.key === 'Escape') {
							e.preventDefault()
							props.onClose()
						}
					}}
				/>
				<div class="keybind-body">
					<Show when={props.loading()}>
						<div class="keybind-empty" style="padding:10px">搜索中…</div>
					</Show>
					<Show when={!props.loading() && props.items().length === 0}>
						<div class="keybind-empty">无匹配</div>
					</Show>
					<For each={props.items()}>
						{(item, idx) => {
							const icon = item.type === 'session' ? '💬'
								: item.type === 'file'    ? '📄'
								: item.type === 'symbol'  ? '🔣'
								: '⚡'
							return (
								<div
									class="cmd-palette-item"
									classList={{ active: idx() === props.idx() }}
									onMouseEnter={() => props.setIdx(idx())}
									onClick={() => item.onSelect()}
								>
									<span class="cmd-palette-icon">{icon}</span>
									<div class="cmd-palette-text">
										<div class="cmd-palette-label">{item.label}</div>
										<Show when={item.desc}>
											<div class="cmd-palette-desc">{item.desc}</div>
										</Show>
									</div>
								</div>
							)
						}}
					</For>
				</div>
			</div>
		</div>
	)
}
