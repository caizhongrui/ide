/*---------------------------------------------------------------------------------------------
 *  SettingsKeybinds — 键盘快捷键设置面板（K11c-3：从 App.tsx 切出）
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal, createEffect, onCleanup } from 'solid-js'
import type { Component } from 'solid-js'

export type KeybindAction =
	| 'new-session' | 'close-session' | 'prev-session' | 'next-session'
	| 'cmd-palette' | 'slash-cmd' | 'terminal' | 'settings' | 'help' | 'global-search'

export interface KeybindEntry {
	action:     KeybindAction
	label:      string
	defaultKey: string
}

export interface SettingsKeybindsProps {
	keybindDefaults:  KeybindEntry[]
	customKeybinds:   () => Record<string, string>
	getKeybind:       (action: KeybindAction) => string
	setKeybind:       (action: KeybindAction, key: string) => void
	resetKeybind:     (action: KeybindAction) => void
	eventToKeybind:   (e: KeyboardEvent) => string
}

export const SettingsKeybinds: Component<SettingsKeybindsProps> = (props) => {
	const [recording, setRecording] = createSignal<KeybindAction | null>(null)
	const onKey = (e: KeyboardEvent): void => {
		const action = recording()
		if (!action) return
		e.preventDefault()
		if (e.key === 'Escape') { setRecording(null); return }
		if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
			props.setKeybind(action, props.eventToKeybind(e))
			setRecording(null)
		}
	}
	createEffect(() => {
		if (recording()) {
			window.addEventListener('keydown', onKey, true)
			onCleanup(() => window.removeEventListener('keydown', onKey, true))
		}
	})

	return (
		<>
			<div class="settings-title">键盘快捷键</div>
			<div class="settings-group">
				<div class="settings-group-title">绑定（点击录制新组合键，Esc 取消，macOS 的 mod = Cmd；其他 = Ctrl）</div>
				<div class="settings-card">
					<For each={props.keybindDefaults}>
						{(kb) => {
							const current  = () => props.getKeybind(kb.action)
							const isCustom = () => props.customKeybinds()[kb.action] !== undefined
							return (
								<div class="settings-row">
									<div class="settings-row-label">
										<div class="settings-row-name">{kb.label}</div>
										<div class="settings-row-desc">默认: <code>{kb.defaultKey}</code></div>
									</div>
									<div style="display:flex;gap:8px;align-items:center">
										<kbd class="keybind-keys" style="min-width:120px;text-align:center">
											{recording() === kb.action ? '正在录制… (Esc 取消)' : current()}
										</kbd>
										<button
											class="btn btn-ghost"
											onClick={() => setRecording(r => r === kb.action ? null : kb.action)}
										>
											{recording() === kb.action ? '取消' : '录制'}
										</button>
										<Show when={isCustom()}>
											<button class="btn btn-ghost" onClick={() => props.resetKeybind(kb.action)}>重置</button>
										</Show>
									</div>
								</div>
							)
						}}
					</For>
				</div>
			</div>
		</>
	)
}
