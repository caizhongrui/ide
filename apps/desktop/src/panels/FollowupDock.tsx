/*---------------------------------------------------------------------------------------------
 *  FollowupDock — composer 上方"AI 建议追问 + 待发送队列"面板（P0-2，K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface FollowupDockProps {
	suggestions:           () => string[]
	queue:                 () => string[]
	collapsed:             () => boolean
	sending:               () => boolean
	setCollapsed:          (v: boolean | ((prev: boolean) => boolean)) => void
	setInput:              (s: string) => void
	setQueue:              (updater: (prev: string[]) => string[]) => void
	setSuggestions:        (updater: (prev: string[]) => string[]) => void
	send:                  () => Promise<void>
}

export const FollowupDock: Component<FollowupDockProps> = (props) => {
	const hasQueue = (): boolean => props.queue().length > 0
	return (
		<div class="followup-dock">
			<div class="followup-dock-header" onClick={() => props.setCollapsed((v) => !v)}>
				<svg class="todo-dock-arrow" classList={{ open: !props.collapsed() }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<polyline points="9 18 15 12 9 6" />
				</svg>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
					<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
				</svg>
				<span class="followup-dock-title">
					建议 & 队列
					<Show when={props.suggestions().length > 0}>
						<span class="followup-count">建议 {props.suggestions().length}</span>
					</Show>
					<Show when={hasQueue()}>
						<span class="followup-count followup-count-queued">已排队 {props.queue().length}</span>
					</Show>
				</span>
			</div>
			<Show when={!props.collapsed()}>
				<div class="followup-body">
					<Show when={props.suggestions().length > 0}>
						<div class="followup-section-title">AI 建议追问</div>
						<div class="followup-suggestions">
							<For each={props.suggestions()}>
								{(s) => (
									<div class="followup-suggestion">
										<span class="followup-text" onClick={() => props.setInput(s)}>{s}</span>
										<div class="followup-actions">
											<button class="followup-btn" onClick={() => props.setInput(s)} title="填入输入框">编辑</button>
											<button class="followup-btn followup-btn-primary" onClick={() => {
												props.setQueue((prev) => [...prev, s])
												props.setSuggestions((prev) => prev.filter((x) => x !== s))
											}} title="加入队列">入队</button>
										</div>
									</div>
								)}
							</For>
						</div>
					</Show>
					<Show when={hasQueue()}>
						<div class="followup-section-title">待发送队列</div>
						<div class="followup-queue">
							<For each={props.queue()}>
								{(q, i) => (
									<div class="followup-queue-item">
										<span class="followup-queue-idx">{i() + 1}</span>
										<span class="followup-text">{q}</span>
										<div class="followup-actions">
											<button class="followup-btn" onClick={() => {
												props.setInput(q)
												props.setQueue((prev) => prev.filter((_, idx) => idx !== i()))
											}}>取出</button>
											<button class="followup-btn followup-btn-danger" onClick={() => {
												props.setQueue((prev) => prev.filter((_, idx) => idx !== i()))
											}}>删除</button>
										</div>
									</div>
								)}
							</For>
							<div class="followup-queue-actions">
								<button class="followup-btn followup-btn-primary" onClick={async () => {
									// 依次发送队列
									const queue = props.queue()
									props.setQueue(() => [])
									for (const q of queue) {
										if (props.sending()) break  // 若中途收到新消息，停止
										props.setInput(q)
										await props.send()
										// 等待 AI 回完（简单轮询）
										while (props.sending()) await new Promise((r) => setTimeout(r, 500))
									}
								}} disabled={props.sending()}>依次发送</button>
								<button class="followup-btn" onClick={() => props.setQueue(() => [])}>清空</button>
							</div>
						</div>
					</Show>
				</div>
			</Show>
		</div>
	)
}
