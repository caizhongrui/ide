/*---------------------------------------------------------------------------------------------
 *  SessionItem — 侧边栏单条会话卡片（K11c-cont）
 *  支持：状态 dot / 双击改名 / 置顶 / 归档 / 删除
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'
import type { SessionSummary } from '@maxian/sdk'

export interface SessionItemProps {
	s:                      SessionSummary
	isActive:               () => boolean
	editingSessionId:       () => string | null
	editingSessionTitle:    () => string
	setEditingSessionTitle: (v: string) => void
	onSelect:               (id: string) => void
	onStartRename:          (e: MouseEvent, s: SessionSummary) => void
	onCommitRename:         (id: string) => void
	onCancelRename:         () => void
	onTogglePin:            (id: string, pinned: boolean) => void
	onToggleArchive:        (id: string, archived: boolean) => void
	onDelete:               (e: MouseEvent, id: string) => void
	// 多选删除模式（K-BulkDelete）— 可选 props
	selectMode?:            () => boolean
	isSelected?:            () => boolean
	onToggleSelected?:      (id: string) => void
}

export const SessionItem: Component<SessionItemProps> = (props) => {
	const s = (): SessionSummary => props.s
	const isSelectMode = () => props.selectMode?.() ?? false
	const isSelected   = () => props.isSelected?.() ?? false
	return (
		<div
			class="session-item"
			classList={{
				active: props.isActive() && !isSelectMode(),
				'session-item-selected': isSelectMode() && isSelected(),
				'session-item-selectmode': isSelectMode(),
			}}
			onClick={() => {
				// 多选模式下点击切换选中，不进入会话
				if (isSelectMode()) {
					if (props.onToggleSelected) props.onToggleSelected(s().id)
					return
				}
				if (props.editingSessionId() !== s().id) props.onSelect(s().id)
			}}
		>
			{/* 多选模式的复选框（取代 status dot） */}
			<Show when={isSelectMode()} fallback={
				<div class="session-status">
					<Show
						when={s().status === 'running'}
						fallback={
							<div
								class="session-status-dot"
								classList={{ error: s().status === 'error', done: s().status === 'done' }}
							/>
						}
					>
						<div class="session-status-spinner" />
					</Show>
				</div>
			}>
				<div class="session-checkbox" classList={{ checked: isSelected() }}>
					<Show when={isSelected()}>
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					</Show>
				</div>
			</Show>

			{/* Title or rename input (双击标题直接改名) */}
			<Show
				when={props.editingSessionId() === s().id}
				fallback={
					<span
						class="session-title"
						onDblClick={(e) => props.onStartRename(e, s())}
					>{s().title || s().id.slice(0, 8)}</span>
				}
			>
				<input
					class="rename-input"
					value={props.editingSessionTitle()}
					onInput={(e) => props.setEditingSessionTitle(e.currentTarget.value)}
					onKeyDown={(e) => {
						e.stopPropagation()
						if (e.key === 'Enter')  props.onCommitRename(s().id)
						if (e.key === 'Escape') props.onCancelRename()
					}}
					onBlur={() => props.onCommitRename(s().id)}
					onClick={(e) => e.stopPropagation()}
					ref={(el) => { setTimeout(() => { el?.focus(); el?.select() }, 10) }}
				/>
			</Show>

			{/* 置顶图标（始终显示，已置顶才亮） */}
			<Show when={s().pinned}>
				<span class="session-pin-badge" title="已置顶">📌</span>
			</Show>
			<Show when={s().archived}>
				<span class="session-archive-badge" title="已归档">🗃</span>
			</Show>

			{/* Hover actions（多选模式下隐藏，避免误操作） */}
			<div class="session-item-actions" style={isSelectMode() ? 'display:none' : undefined}>
				<button
					class="item-action-btn"
					onClick={(e) => { e.stopPropagation(); props.onTogglePin(s().id, !s().pinned) }}
					title={s().pinned ? '取消置顶' : '置顶'}
					data-tip={s().pinned ? '取消置顶' : '置顶'}
				>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={s().pinned ? 'var(--accent)' : 'currentColor'} stroke-width="2">
						<line x1="12" y1="17" x2="12" y2="22" />
						<path d="M5 17h14a2 2 0 0 0 1.84-2.75L17 7h-10L3.16 14.25A2 2 0 0 0 5 17z" />
					</svg>
				</button>
				<button
					class="item-action-btn"
					onClick={(e) => { e.stopPropagation(); props.onToggleArchive(s().id, !s().archived) }}
					title={s().archived ? '取消归档' : '归档'}
					data-tip={s().archived ? '取消归档' : '归档'}
				>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="21 8 21 21 3 21 3 8" />
						<rect x="1" y="3" width="22" height="5" />
						<line x1="10" y1="12" x2="14" y2="12" />
					</svg>
				</button>
				<button
					class="item-action-btn"
					onClick={(e) => props.onStartRename(e, s())}
					title="重命名"
					data-tip="重命名"
				>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
						<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
					</svg>
				</button>
				<button
					class="item-action-btn del"
					onClick={(e) => props.onDelete(e, s().id)}
					title="删除"
					data-tip="删除"
				>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="3 6 5 6 21 6" />
						<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
						<path d="M10 11v6" /><path d="M14 11v6" />
						<path d="M9 6V4h6v2" />
					</svg>
				</button>
			</div>
		</div>
	)
}
