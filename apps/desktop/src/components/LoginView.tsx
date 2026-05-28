/*---------------------------------------------------------------------------------------------
 *  LoginView — 登录界面（沉浸式深色门面 · Code Aurora，参照九思）
 *
 *  设计：深邃星海底 + 多色 Aurora 柔光 + 网格 + 漂浮代码片段卡片，
 *  中央玻璃拟态卡片（logo 辉光），服务器地址收进右上齿轮。
 *--------------------------------------------------------------------------------------------*/

import { Show, createSignal } from 'solid-js'
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
	// 服务器地址默认收起；未配置（为空）时自动展开方便首次填写
	const [showServer, setShowServer] = createSignal(!props.apiUrl().trim())
	const canSubmit = () => !!props.username().trim() && !!props.password()

	return (
		<div class="auth-screen">
			{/* 深色 aurora 背景层 */}
			<div class="auth-bg">
				<div class="auth-bg-aurora auth-bg-aurora-1" />
				<div class="auth-bg-aurora auth-bg-aurora-2" />
				<div class="auth-bg-aurora auth-bg-aurora-3" />
			</div>

			{/* 网格 mask 叠加 */}
			<div class="auth-grid" />

			{/* 漂浮装饰：代码片段卡片 */}
			<div class="auth-snippet auth-snippet-1">
				<div class="auth-snippet-bar">
					<span class="auth-snippet-dot" style="background:#ef4444" />
					<span class="auth-snippet-dot" style="background:#f59e0b" />
					<span class="auth-snippet-dot" style="background:#10b981" />
				</div>
				<div class="auth-snippet-line"><span class="cm-kw">const</span> <span class="cm-var">agent</span> = <span class="cm-fn">create</span>()</div>
				<div class="auth-snippet-line"><span class="cm-kw">await</span> <span class="cm-var">agent</span>.<span class="cm-fn">run</span>(<span class="cm-str">"build"</span>)</div>
				<div class="auth-snippet-line"><span class="cm-com">// 码弦 · 智能编程</span></div>
			</div>
			<div class="auth-snippet auth-snippet-2">
				<div class="auth-snippet-bar">
					<span class="auth-snippet-dot" style="background:#ef4444" />
					<span class="auth-snippet-dot" style="background:#f59e0b" />
					<span class="auth-snippet-dot" style="background:#10b981" />
				</div>
				<div class="auth-snippet-line"><span class="cm-kw">function</span> <span class="cm-fn">code</span>() {`{`}</div>
				<div class="auth-snippet-line">&nbsp;&nbsp;<span class="cm-kw">return</span> <span class="cm-str">'码弦'</span></div>
				<div class="auth-snippet-line">{`}`}</div>
			</div>

			{/* 齿轮：服务器配置 */}
			<button
				class="auth-gear"
				classList={{ 'is-active': showServer() }}
				title="服务器配置"
				onClick={() => setShowServer((v) => !v)}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="3" />
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
				</svg>
			</button>

			{/* 中央卡片 */}
			<div class="auth-card">
				<div class="auth-head">
					<div class="auth-logo-wrap">
						<img class="auth-logo" src={props.logoUrl} alt="码弦" />
						<div class="auth-logo-glow" />
					</div>
					<div class="auth-brand">码弦</div>
					<div class="auth-tagline">
						<span class="auth-tagline-dot" />
						为开发者打造的智能编程伙伴
						<span class="auth-tagline-dot" />
					</div>
				</div>

				<div class="auth-body">
					<Show when={props.error()}>
						<div class="auth-error">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="10" />
								<line x1="12" y1="8" x2="12" y2="12" />
								<line x1="12" y1="16" x2="12.01" y2="16" />
							</svg>
							<span>{props.error()}</span>
						</div>
					</Show>

					<Show when={showServer()}>
						<div class="auth-field auth-server-field">
							<label class="auth-label">服务器地址</label>
							<input
								class="auth-input"
								type="url"
								placeholder="例如: http://10.205.81.162/api"
								value={props.apiUrl()}
								onInput={(e) => props.setApiUrl(e.currentTarget.value)}
								disabled={props.loading()}
							/>
						</div>
					</Show>

					<div class="auth-field">
						<label class="auth-label">用户名</label>
						<div class="auth-input-wrap">
							<svg class="auth-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
								<circle cx="12" cy="7" r="4" />
							</svg>
							<input
								class="auth-input has-icon"
								type="text"
								placeholder="请输入用户名"
								autocomplete="username"
								value={props.username()}
								onInput={(e) => props.setUsername(e.currentTarget.value)}
								disabled={props.loading()}
							/>
						</div>
					</div>

					<div class="auth-field">
						<label class="auth-label">密码</label>
						<div class="auth-input-wrap">
							<svg class="auth-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
								<path d="M7 11V7a5 5 0 0 1 10 0v4" />
							</svg>
							<input
								class="auth-input has-icon"
								type="password"
								placeholder="请输入密码"
								autocomplete="current-password"
								value={props.password()}
								onInput={(e) => props.setPassword(e.currentTarget.value)}
								disabled={props.loading()}
								onKeyDown={(e) => { if (e.key === "Enter") props.onSubmit() }}
							/>
						</div>
					</div>

					<label class="auth-remember">
						<input
							type="checkbox"
							checked={props.remember()}
							onChange={(e) => props.setRemember(e.currentTarget.checked)}
							disabled={props.loading()}
						/>
						<span>记住登录状态</span>
					</label>

					<button
						class="auth-btn"
						onClick={props.onSubmit}
						disabled={props.loading() || !canSubmit()}
					>
						<Show when={props.loading()} fallback={<>登 录</>}>
							<span class="spinner" style="width:14px;height:14px;border-width:1.5px;border-color:rgba(255,255,255,0.3);border-top-color:#fff" />
							登录中…
						</Show>
					</button>

					<div class="auth-foot">
						首次登录？请联系管理员获取账号
					</div>
				</div>
			</div>

			<div class="auth-copyright">© 2026 码弦 · 智能编程伙伴 · 匠心独运</div>
		</div>
	)
}
