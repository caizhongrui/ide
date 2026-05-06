/*---------------------------------------------------------------------------------------------
 *  SettingsErrors — 错误日志面板（K11c-6：从 App.tsx 切出）
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface ErrorLogEntry {
	source:    string
	message:   string
	ts:        number
	sessionId?: string
}

export interface SettingsErrorsProps {
	errorLog:    () => ErrorLogEntry[]
	setErrorLog: (next: ErrorLogEntry[]) => void
}

export const SettingsErrors: Component<SettingsErrorsProps> = (props) => {
	return (
		<>
			<div class="settings-title">错误日志</div>
			<div class="settings-group">
				<div class="settings-group-title" style="display:flex;align-items:center;justify-content:space-between">
					<span>最近 50 条</span>
					<Show when={props.errorLog().length > 0}>
						<button class="btn btn-ghost" onClick={() => props.setErrorLog([])}>清空</button>
					</Show>
				</div>
				<div class="settings-card">
					<Show when={props.errorLog().length === 0}>
						<div class="settings-row"><div class="settings-row-desc">暂无错误</div></div>
					</Show>
					<For each={props.errorLog()}>
						{(err) => (
							<div class="settings-row">
								<div class="settings-row-label" style="min-width:0">
									<div class="settings-row-name" style="color:#f87171">
										[{err.source}] {err.message.slice(0, 200)}
									</div>
									<div class="settings-row-desc">
										{new Date(err.ts).toLocaleString('zh-CN')}
										{err.sessionId ? ` · session: ${err.sessionId.slice(0, 8)}` : ''}
									</div>
								</div>
							</div>
						)}
					</For>
				</div>
			</div>
		</>
	)
}
