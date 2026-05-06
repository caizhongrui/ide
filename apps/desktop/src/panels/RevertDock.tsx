/*---------------------------------------------------------------------------------------------
 *  RevertDock — 显示最近用户消息，一键回退到某条（P1-11，K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface RevertDockMessage {
	id:      string
	content: string
	role:    string
}

export interface RevertDockProps {
	messages:        () => RevertDockMessage[]
	onClose:         () => void
	onRevertTo:      (msgId: string) => void | Promise<void>
}

export const RevertDock: Component<RevertDockProps> = (props) => {
	// 只显示 user 消息（回退点）
	const userMsgs = (): RevertDockMessage[] => props.messages().filter((m) => m.role === 'user').slice(-5).reverse()
	return (
		<div class="revert-dock">
			<div class="revert-dock-header">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
					<polyline points="1 4 1 10 7 10" />
					<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
				</svg>
				<span class="revert-dock-title">回退对话</span>
				<span class="revert-dock-hint">选择要回退到的用户消息（该消息及其后将被删除）</span>
				<button class="icon-btn" onClick={props.onClose}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>
			<div class="revert-dock-list">
				<Show when={userMsgs().length === 0}>
					<div class="revert-dock-empty">暂无用户消息</div>
				</Show>
				<For each={userMsgs()}>
					{(m, i) => (
						<div class="revert-dock-item">
							<span class="revert-dock-idx">#{userMsgs().length - i()}</span>
							<span class="revert-dock-msg" title={m.content}>{m.content.slice(0, 120)}{m.content.length > 120 ? '…' : ''}</span>
							<button class="approval-btn deny" style="padding:4px 12px;font-size:12px" onClick={() => void props.onRevertTo(m.id)}>
								回退到这里
							</button>
						</div>
					)}
				</For>
			</div>
		</div>
	)
}
