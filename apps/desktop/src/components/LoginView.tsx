/*---------------------------------------------------------------------------------------------
 *  LoginView — 登录界面（K11c 抽离自 App.tsx）
 *
 *  纯渲染：表单字段 / loading / error / 提交回调全部通过 props 注入。
 *  含登录卡片 + 服务器/用户名/密码输入 + 记住登录 + 提交按钮。
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface LoginViewProps {
	logoUrl:      string
	apiUrl:       () => string
	setApiUrl:    (v: string) => void
	username:     () => string
	setUsername:  (v: string) => void
	password:     () => string
	setPassword:  (v: string) => void
	remember:     () => boolean
	setRemember:  (v: boolean) => void
	error:        () => string
	loading:      () => boolean
	onSubmit:     () => void
}

export const LoginView: Component<LoginViewProps> = (props) => {
	return (
		<div class="login-screen">
			<div class="login-card">
				<div class="login-hero">
					<img class="login-avatar" src={props.logoUrl} alt="Maxian" />
					<div class="login-brand">码弦</div>
					<div class="login-sub">智能 AI 编程助手</div>
				</div>
				<div class="login-form">
					<Show when={props.error()}>
						<div class="login-error">{props.error()}</div>
					</Show>
					<div class="login-field">
						<label class="login-label">服务器地址</label>
						<input class="login-input" type="url" placeholder="例如: http://10.205.81.162/api"
							value={props.apiUrl()} onInput={(e) => props.setApiUrl(e.currentTarget.value)}
							disabled={props.loading()} />
					</div>
					<div class="login-field">
						<label class="login-label">用户名</label>
						<input class="login-input" type="text" placeholder="请输入用户名" autocomplete="username"
							value={props.username()} onInput={(e) => props.setUsername(e.currentTarget.value)}
							disabled={props.loading()} />
					</div>
					<div class="login-field">
						<label class="login-label">密码</label>
						<input class="login-input" type="password" placeholder="请输入密码" autocomplete="current-password"
							value={props.password()} onInput={(e) => props.setPassword(e.currentTarget.value)}
							disabled={props.loading()}
							onKeyDown={(e) => { if (e.key === "Enter") props.onSubmit() }} />
					</div>
					<label class="login-remember">
						<input type="checkbox" checked={props.remember()}
							onChange={(e) => props.setRemember(e.currentTarget.checked)} disabled={props.loading()} />
						记住登录状态
					</label>
					<button class="login-btn" onClick={props.onSubmit}
						disabled={props.loading() || !props.username().trim() || !props.password()}>
						<Show when={props.loading()} fallback="登录">
							<span class="spinner" style="width:14px;height:14px;border-width:1.5px;border-color:rgba(255,255,255,0.3);border-top-color:#fff" />
							登录中…
						</Show>
					</button>
				</div>
				<div class="login-footer">首次登录？请联系管理员获取账号</div>
			</div>
		</div>
	)
}
