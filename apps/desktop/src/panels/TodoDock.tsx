/*---------------------------------------------------------------------------------------------
 *  TodoDock — composer 上方任务清单进度条（P0-1，K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'
import { AnimatedNumber } from '../components/AnimatedNumber'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
	id:      string
	content: string
	status:  TodoStatus
}

export interface TodoDockProps {
	todos:               () => TodoItem[]
	leftover:            () => boolean
	collapsed:           () => boolean
	setCollapsed:        (v: boolean | ((prev: boolean) => boolean)) => void
}

export const TodoDock: Component<TodoDockProps> = (props) => {
	const total      = (): number => props.todos().length
	const completed  = (): number => props.todos().filter((t) => t.status === 'completed').length
	const cancelled  = (): number => props.todos().filter((t) => t.status === 'cancelled').length
	const inProgress = (): TodoItem | undefined => props.todos().find((t) => t.status === 'in_progress')
	const pct        = (): number => total() === 0 ? 0 : Math.round(((completed() + cancelled()) / total()) * 100)
	// AI 提前结束未收尾的项目数
	const leftoverCount = (): number => props.todos().filter((t) => t.status === 'in_progress' || t.status === 'pending').length

	return (
		<div class="todo-dock" classList={{ 'todo-dock-leftover': props.leftover() }}>
			<div class="todo-dock-header" onClick={() => props.setCollapsed((v) => !v)}>
				<svg class="todo-dock-arrow" classList={{ open: !props.collapsed() }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<polyline points="9 18 15 12 9 6" />
				</svg>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
					<polyline points="9 11 12 14 22 4" />
					<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
				</svg>
				<span class="todo-dock-title">任务清单</span>
				<span class="todo-dock-counter">
					<AnimatedNumber value={completed()} duration={400} /> / {total()}
				</span>
				<div class="todo-dock-progress">
					<div class="todo-dock-progress-fill" style={{ width: `${pct()}%` }} />
				</div>
				<Show when={props.leftover() && leftoverCount() > 0}>
					<span class="todo-dock-leftover-badge" title="AI 在调用 attempt_completion 前未把这些 todo 收尾。任务已结束，但这些项目可能未真正完成。">
						⚠ AI 提前结束，{leftoverCount()} 项未收尾
					</span>
				</Show>
				<Show when={inProgress() && props.collapsed() && !props.leftover()}>
					<span class="todo-dock-current" title={inProgress()!.content}>
						· {inProgress()!.content}
					</span>
				</Show>
			</div>
			<Show when={!props.collapsed()}>
				<div class="todo-dock-list">
					<For each={props.todos()}>
						{(t) => (
							<div class={`todo-item todo-${t.status}`} classList={{ 'todo-leftover': props.leftover() && (t.status === 'in_progress' || t.status === 'pending') }}>
								<span class="todo-checkbox">
									<Show when={t.status === 'completed'}>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12" /></svg>
									</Show>
									<Show when={t.status === 'cancelled'}>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
									</Show>
									<Show when={t.status === 'in_progress' && !props.leftover()}>
										<span class="todo-spinner" />
									</Show>
									<Show when={(t.status === 'in_progress' || t.status === 'pending') && props.leftover()}>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="opacity:0.55"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
									</Show>
								</span>
								<span class="todo-content">{t.content}</span>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	)
}
