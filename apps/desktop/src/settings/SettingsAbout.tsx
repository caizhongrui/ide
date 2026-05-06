/*---------------------------------------------------------------------------------------------
 *  SettingsAbout — 关于面板（K11c-8：从 App.tsx 切出）
 *
 *  含：版本号 / 软件更新 / 诊断与维护（重算 token / 清错误记忆）/ 更新日志 / 开源信息
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal } from 'solid-js'
import type { Component } from 'solid-js'
import { CHANGELOG } from './changelog.js'

export interface SettingsAboutProps {
	logoUrl:           string
	appVersion:        string
	activeSessionId:   () => string | null
	getClient:         () => Promise<any>
	showToast:         (opts: { message: string; kind?: 'info' | 'success' | 'warn' | 'error'; duration?: number }) => void
	refreshSessions:   () => Promise<void>
}

export const SettingsAbout: Component<SettingsAboutProps> = (props) => {
	const [updateStatus, setUpdateStatus] = createSignal<'idle' | 'checking' | 'available' | 'none' | 'installing' | 'error'>('idle')
	const [updateMsg, setUpdateMsg] = createSignal('')

	const checkForUpdates = async (): Promise<void> => {
		setUpdateStatus('checking')
		setUpdateMsg('')
		try {
			if ((window as any).__TAURI_INTERNALS__) {
				const { check } = await import('@tauri-apps/plugin-updater' as any)
				const update = await check()
				if (update?.available) {
					setUpdateStatus('available')
					setUpdateMsg(`发现新版本 ${update.version}：${update.body ?? ''}`)
				} else {
					setUpdateStatus('none')
					setUpdateMsg('已是最新版本')
				}
			} else {
				setUpdateStatus('none')
				setUpdateMsg('浏览器环境不支持自动更新')
			}
		} catch (e) {
			setUpdateStatus('error')
			setUpdateMsg(String((e as Error)?.message ?? e))
		}
	}

	const installUpdate = async (): Promise<void> => {
		setUpdateStatus('installing')
		try {
			const { check } = await import('@tauri-apps/plugin-updater' as any)
			const update = await check()
			if (update?.available) {
				await update.downloadAndInstall()
				const { relaunch } = await import('@tauri-apps/plugin-process' as any)
				await relaunch()
			}
		} catch (e) {
			setUpdateStatus('error')
			setUpdateMsg(String((e as Error)?.message ?? e))
		}
	}

	const recalcTokens = async (): Promise<void> => {
		try {
			const c = await props.getClient()
			const r = await c.recalculateAllSessionTokens(true)
			props.showToast({ message: `Token 重算完成：${r.touched} 个会话已更新`, kind: 'info', duration: 3000 })
			await props.refreshSessions()
		} catch (e) {
			props.showToast({ message: `Token 重算失败：${(e as Error).message}`, kind: 'error', duration: 4000 })
		}
	}

	const pruneToolErrors = async (): Promise<void> => {
		const sid = props.activeSessionId()
		if (!sid) return
		try {
			const c = await props.getClient()
			const r = await c.pruneToolErrors(sid)
			if (r.ok) {
				props.showToast({ message: `已清除 ${r.pruned} 条错误记忆 (${r.before} → ${r.after} 条历史)`, kind: 'info', duration: 3500 })
			} else {
				props.showToast({ message: `清除失败：${r.error}`, kind: 'error', duration: 4000 })
			}
		} catch (e) {
			props.showToast({ message: `清除失败：${(e as Error).message}`, kind: 'error', duration: 4000 })
		}
	}

	return (
		<>
			<div class="settings-title">关于</div>
			<div style="display:flex;flex-direction:column;align-items:center;padding:32px 0 24px;gap:12px">
				<img class="about-logo" src={props.logoUrl} alt="Maxian" />
				<div style="font-size:20px;font-weight:700;color:var(--text-base)">码弦 Maxian</div>
				<div style="font-size:13px;color:var(--text-muted)">智能 AI 编程助手</div>
				<div style="font-size:12px;color:var(--text-faint)">版本 {props.appVersion}</div>
			</div>

			<div class="settings-group">
				<div class="settings-group-title">软件更新</div>
				<div class="settings-card">
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">检查更新</div>
							<div class="settings-row-desc">
								<Show when={updateMsg()}>
									<span style={updateStatus() === 'error' ? 'color:var(--error)' : updateStatus() === 'available' ? 'color:var(--accent)' : 'color:var(--text-muted)'}>
										{updateMsg()}
									</span>
								</Show>
								<Show when={!updateMsg()}>
									当前版本 {props.appVersion}
								</Show>
							</div>
						</div>
						<div style="display:flex;gap:6px">
							<Show when={updateStatus() === 'available'}>
								<button class="btn btn-primary" style="font-size:11px" onClick={installUpdate}>
									立即更新
								</button>
							</Show>
							<button
								class="btn btn-ghost"
								style="font-size:11px"
								onClick={checkForUpdates}
								disabled={updateStatus() === 'checking' || updateStatus() === 'installing'}
							>
								<Show when={updateStatus() === 'checking'} fallback="检查更新">
									<span class="spinner" style="width:10px;height:10px;border-width:1.5px" />
									检查中…
								</Show>
								<Show when={updateStatus() === 'installing'}>
									安装中…
								</Show>
							</button>
						</div>
					</div>
				</div>
			</div>

			<div class="settings-group">
				<div class="settings-group-title">诊断与维护</div>
				<div class="settings-card">
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">重新计算所有会话 Token 用量</div>
							<div class="settings-row-desc">从 history 内容按 char/4 估算回填 sessions 表，修复"会话列表 token 用量为 0"。误差 ±20%。</div>
						</div>
						<button class="settings-btn" onClick={recalcTokens}>重算 Token</button>
					</div>
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">清除当前会话的"工具失败记忆"</div>
							<div class="settings-row-desc">删除当前会话历史里的所有工具错误条目（require is not defined / Binary File / 等），让 AI 不再被旧的"已修复"错误污染推理。</div>
						</div>
						<button class="settings-btn" disabled={!props.activeSessionId()} onClick={pruneToolErrors}>清除错误记忆</button>
					</div>
				</div>
			</div>

			<div class="settings-group">
				<div class="settings-group-title">更新日志</div>
				<div class="settings-card">
					<For each={CHANGELOG}>
						{(entry, i) => (
							<div class="changelog-entry" classList={{ latest: i() === 0 }}>
								<div class="changelog-header">
									<span class="changelog-version">v{entry.version}</span>
									<Show when={i() === 0}>
										<span class="changelog-latest-badge">最新</span>
									</Show>
									<span class="changelog-date">{entry.date}</span>
								</div>
								<ul class="changelog-list">
									<For each={entry.changes}>
										{(c) => <li>{c}</li>}
									</For>
								</ul>
							</div>
						)}
					</For>
				</div>
			</div>

			<div class="settings-group">
				<div class="settings-group-title">开源信息</div>
				<div class="settings-card">
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">构建于</div>
							<div class="settings-row-desc">Tauri 2 · SolidJS · Hono · Zhongrui Cai</div>
						</div>
					</div>
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">版权</div>
							<div class="settings-row-desc">© 2025 天和智开 All rights reserved</div>
						</div>
					</div>
				</div>
			</div>
		</>
	)
}
