/*---------------------------------------------------------------------------------------------
 *  ToastHost — 全局 toast 通知宿主（K11a 抽离自 App.tsx）
 *
 *  纯渲染：toast 列表 + dismiss 回调由 host 应用注入，组件不持有任何 signal。
 *  支持 4 种 kind（info/success/warn/error）+ 可选 action 按钮。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface ToastItem {
	id:        string
	message:   string
	kind:      'info' | 'success' | 'warn' | 'error'
	action?:   { label: string; onClick: () => void }
	duration:  number
}

export interface ToastHostProps {
	/** 当前要显示的所有 toasts（按出现顺序） */
	toasts:    () => ToastItem[]
	/** 用户点关闭按钮 / 点 action 后调用，移除指定 id 的 toast */
	onDismiss: (id: string) => void
}

export const ToastHost: Component<ToastHostProps> = (props) => {
	return (
		<div class="toast-host">
			<For each={props.toasts()}>
				{(t) => (
					<div class={`toast toast-${t.kind}`}>
						<div class="toast-icon">
							{t.kind === 'success' && (
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
									<polyline points="20 6 9 17 4 12"/>
								</svg>
							)}
							{t.kind === 'error' && (
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
									<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
								</svg>
							)}
							{t.kind === 'warn' && (
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
									<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
									<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
								</svg>
							)}
							{t.kind === 'info' && (
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
									<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
								</svg>
							)}
						</div>
						<div class="toast-msg">{t.message}</div>
						<Show when={t.action}>
							<button
								class="toast-action"
								onClick={() => { t.action!.onClick(); props.onDismiss(t.id) }}
							>
								{t.action!.label}
							</button>
						</Show>
						<button class="toast-close" onClick={() => props.onDismiss(t.id)} title="关闭">
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
								<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
							</svg>
						</button>
					</div>
				)}
			</For>
		</div>
	)
}
