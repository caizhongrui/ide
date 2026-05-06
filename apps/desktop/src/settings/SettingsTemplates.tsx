/*---------------------------------------------------------------------------------------------
 *  SettingsTemplates — 会话模板设置面板（K11c-4：从 App.tsx 切出）
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal } from 'solid-js'
import type { Component } from 'solid-js'

export interface SessionTemplate {
	name:     string
	content:  string
	tags?:    string[]
}

export interface SettingsTemplatesProps {
	sessionTemplates:    () => SessionTemplate[]
	addSessionTemplate:  (t: SessionTemplate) => void
	removeSessionTemplate: (name: string) => void
	showToast:           (opts: { message: string; kind?: 'info' | 'success' | 'warn' | 'error'; duration?: number }) => void
	createSession:       () => Promise<void>
	setInput:            (s: string) => void
	setShowSettings:     (b: boolean) => void
}

export const SettingsTemplates: Component<SettingsTemplatesProps> = (props) => {
	const [newName, setNewName] = createSignal('')
	const [newContent, setNewContent] = createSignal('')

	const saveNew = (): void => {
		if (!newName().trim() || !newContent().trim()) return
		props.addSessionTemplate({ name: newName().trim(), content: newContent().trim() })
		setNewName('')
		setNewContent('')
		props.showToast({ message: '模板已保存', kind: 'success' })
	}

	const useTemplate = async (t: SessionTemplate): Promise<void> => {
		await props.createSession()
		props.setInput(t.content)
		props.setShowSettings(false)
		props.showToast({ message: `已应用模板「${t.name}」`, kind: 'success', duration: 2500 })
	}

	return (
		<>
			<div class="settings-title">会话模板</div>
			<div class="settings-group">
				<div class="settings-group-title">已保存的模板</div>
				<div class="settings-card">
					<Show when={props.sessionTemplates().length === 0}>
						<div class="settings-row"><div class="settings-row-desc">暂无模板</div></div>
					</Show>
					<For each={props.sessionTemplates()}>
						{(t) => (
							<div class="settings-row">
								<div class="settings-row-label">
									<div class="settings-row-name">{t.name}</div>
									<div class="settings-row-desc" style="white-space:pre-wrap;max-width:500px">
										{t.content.slice(0, 160)}{t.content.length > 160 ? '…' : ''}
									</div>
								</div>
								<div style="display:flex;gap:6px">
									<button class="btn btn-primary" onClick={() => useTemplate(t)}>使用</button>
									<button
										class="btn btn-ghost"
										style="color:#f87171"
										onClick={() => props.removeSessionTemplate(t.name)}
									>删除</button>
								</div>
							</div>
						)}
					</For>
				</div>
			</div>
			<div class="settings-group">
				<div class="settings-group-title">新建模板</div>
				<div class="settings-card">
					<div class="settings-row">
						<div style="flex:1;display:flex;flex-direction:column;gap:6px">
							<input
								class="login-input"
								placeholder="模板名称"
								value={newName()}
								onInput={(e) => setNewName(e.currentTarget.value)}
							/>
							<textarea
								class="login-input"
								placeholder="模板内容（prompt 文本）"
								style="min-height:120px;font-family:inherit"
								value={newContent()}
								onInput={(e) => setNewContent(e.currentTarget.value)}
							/>
							<button
								class="btn btn-primary"
								disabled={!newName().trim() || !newContent().trim()}
								onClick={saveNew}
							>保存模板</button>
						</div>
					</div>
				</div>
			</div>
		</>
	)
}
