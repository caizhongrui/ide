/*---------------------------------------------------------------------------------------------
 *  BootScreens — 启动中 / 启动错误 屏幕（K11c 抽离自 App.tsx）
 *
 *  纯渲染：错误信息 / 重试与重新登录回调由 host 注入。
 *--------------------------------------------------------------------------------------------*/

import type { Component } from 'solid-js'

export interface BootingScreenProps {
	logoUrl: string
}

export const BootingScreen: Component<BootingScreenProps> = (props) => {
	return (
		<div class="boot-screen">
			<img class="boot-logo" src={props.logoUrl} alt="Maxian" />
			<div class="spinner" />
			<span>正在连接 Maxian Server…</span>
		</div>
	)
}

export interface BootErrorScreenProps {
	error:        () => string
	onLogout:     () => void
	onRetry:      () => void
}

export const BootErrorScreen: Component<BootErrorScreenProps> = (props) => {
	return (
		<div class="boot-screen">
			<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--error)" stroke-width="1.5">
				<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
			</svg>
			<span style="font-weight:600;color:var(--text-base)">启动失败</span>
			<pre>{props.error()}</pre>
			<div style="display:flex;gap:8px">
				<button class="btn btn-ghost" onClick={props.onLogout}>重新登录</button>
				<button class="btn btn-primary" onClick={props.onRetry}>重试</button>
			</div>
		</div>
	)
}
