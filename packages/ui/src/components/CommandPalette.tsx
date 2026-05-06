/*---------------------------------------------------------------------------------------------
 *  CommandPalette + MentionDropdown — Slash 命令面板 + @ 文件提及面板（K10d）
 *
 *  这两个面板共用 .slash-palette 基础样式，所以放在同一个文件里。
 *  纯渲染：所有数据 + 选中状态 + 触发回调都通过 props 注入。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'
// @ts-expect-error vite ?inline → string
import css from './CommandPalette.css?inline'
import { injectStyleOnce } from './_injectStyle.js'

/** 锚点矩形：固定定位用 */
export interface PaletteRect {
	bottom: number
	left:   number
	width:  number
}

/** Slash 命令条目 */
export interface SlashCommandItem {
	name: string
	desc: string
	icon: string
}

export interface CommandPaletteProps {
	visible:    boolean
	rect:       PaletteRect
	commands:   SlashCommandItem[]
	activeIdx:  number
	onHover:    (idx: number) => void
	onSelect:   (name: string) => void
}

export const CommandPalette: Component<CommandPaletteProps> = (props) => {
	injectStyleOnce('maxian-ui-command-palette', css as string)

	return (
		<Show when={props.visible && props.commands.length > 0}>
			<div
				class="slash-palette"
				style={`position:fixed;bottom:${props.rect.bottom}px;left:${props.rect.left}px;width:${props.rect.width}px;z-index:9999`}
			>
				<For each={props.commands}>
					{(cmd, idx) => (
						<div
							class="slash-item"
							classList={{ active: props.activeIdx === idx() }}
							onMouseEnter={() => props.onHover(idx())}
							onMouseDown={(e) => { e.preventDefault(); props.onSelect(cmd.name) }}
						>
							<span class="slash-icon">{cmd.icon}</span>
							<div class="slash-item-text">
								<span class="slash-cmd-name">/{cmd.name}</span>
								<span class="slash-cmd-desc">{cmd.desc}</span>
							</div>
						</div>
					)}
				</For>
			</div>
		</Show>
	)
}

/** @ 文件提及条目（路径） */
export interface MentionDropdownProps {
	visible:        boolean
	rect:           PaletteRect
	files:          string[]
	activeIdx:      number
	/** 当前关键词（用于高亮匹配段） */
	query:          string
	/** 工作区名（header 显示） */
	workspaceName?: string
	/** 工作区文件总数（header 右侧统计） */
	totalFiles?:    number
	/** 是否在加载文件列表 */
	loading:        boolean
	onHover:        (idx: number) => void
	onSelect:       (file: string) => void
}

export const MentionDropdown: Component<MentionDropdownProps> = (props) => {
	injectStyleOnce('maxian-ui-command-palette', css as string)

	const renderName = (filename: string): string => {
		const q = props.query.toLowerCase()
		if (!q) return escapeHtml(filename)
		const i = filename.toLowerCase().indexOf(q)
		if (i < 0) return escapeHtml(filename)
		return `${escapeHtml(filename.slice(0, i))}<mark>${escapeHtml(filename.slice(i, i + q.length))}</mark>${escapeHtml(filename.slice(i + q.length))}`
	}

	return (
		<Show when={props.visible}>
			<div
				class="slash-palette mention-palette"
				style={`position:fixed;bottom:${props.rect.bottom}px;left:${props.rect.left}px;width:${props.rect.width}px;z-index:9999`}
			>
				<Show when={props.loading && props.files.length === 0}>
					<div class="slash-item mention-loading">
						<svg class="mention-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" stroke-width="2">
							<path d="M21 12a9 9 0 1 1-6.219-8.56" />
						</svg>
						<span style="color:var(--text-faint);font-size:12px">正在加载文件列表…</span>
					</div>
				</Show>

				<Show when={!props.loading && props.files.length === 0}>
					<div class="slash-item mention-empty">
						<span style="color:var(--text-faint);font-size:12px">未找到匹配文件</span>
					</div>
				</Show>

				<Show when={props.files.length > 0}>
					<div class="mention-header">
						<span>{props.workspaceName ?? '工作区'}</span>
						<span class="mention-count">{props.totalFiles ?? props.files.length} 个文件</span>
					</div>
					<div class="mention-list">
						<For each={props.files}>
							{(file, idx) => {
								const parts = file.split('/')
								const filename = parts.pop() ?? file
								const dir = parts.length > 0 ? parts.join('/') : ''
								return (
									<div
										class="slash-item"
										classList={{ active: props.activeIdx === idx() }}
										onMouseEnter={() => props.onHover(idx())}
										onMouseDown={(e) => { e.preventDefault(); props.onSelect(file) }}
									>
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" stroke-width="1.8" style="flex-shrink:0">
											<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
											<polyline points="14 2 14 8 20 8" />
										</svg>
										<div class="slash-item-text">
											<span class="slash-cmd-name" innerHTML={renderName(filename)} />
											<span class="slash-cmd-desc">{dir ? `/${dir}` : '/'}</span>
										</div>
									</div>
								)
							}}
						</For>
					</div>
				</Show>
			</div>
		</Show>
	)
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}
