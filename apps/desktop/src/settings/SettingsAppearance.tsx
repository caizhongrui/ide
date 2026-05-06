/*---------------------------------------------------------------------------------------------
 *  SettingsAppearance — 外观设置面板（K11c-1：从 App.tsx 切出）
 *
 *  纯渲染，状态/动作通过 props 注入。
 *--------------------------------------------------------------------------------------------*/

import { For } from 'solid-js'
import type { Component } from 'solid-js'

export type Theme = 'dark' | 'light' | 'system'

export interface FontFamilyDef {
	value: string
	label: string
	css:   string
}

export interface SettingsAppearanceProps {
	// 状态访问器（Solid signal getter）
	vimEnabled:  () => boolean
	theme:       () => Theme
	fontFamily:  () => string
	fontSize:    () => number
	fontFamilies: FontFamilyDef[]

	// 动作
	toggleVim:      (on: boolean) => void
	setTheme:       (t: Theme) => void
	setFontFamily:  (v: string) => void
	setFontSize:    (n: number) => void
}

export const SettingsAppearance: Component<SettingsAppearanceProps> = (props) => {
	return (
		<>
			<div class="settings-title">外观</div>

			{/* Vim 模式 */}
			<div class="settings-group">
				<div class="settings-group-title">编辑器</div>
				<div class="settings-card">
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">Vim 模式</div>
							<div class="settings-row-desc">
								在输入框启用 Vim 模态编辑（h/j/k/l 移动、i/a/o 进入 insert、Esc 回 normal、x/dd 删除、p 粘贴、w/b 按词跳转）
							</div>
						</div>
						<label class="toggle">
							<input
								type="checkbox"
								checked={props.vimEnabled()}
								onChange={(e) => props.toggleVim(e.currentTarget.checked)}
							/>
							<span class="toggle-track" />
						</label>
					</div>
				</div>
			</div>

			{/* Theme */}
			<div class="settings-group">
				<div class="settings-group-title">主题</div>
				<div class="settings-card">
					<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:16px">
						<div class="settings-row-label">
							<div class="settings-row-name">颜色主题</div>
							<div class="settings-row-desc">使用浅色、深色，或匹配系统设置</div>
						</div>
						<div class="theme-picker">
							<button
								class="theme-option"
								classList={{ active: props.theme() === 'light' }}
								onClick={() => props.setTheme('light')}
							>
								<div class="theme-preview theme-preview-light" />
								<span class="theme-label">浅色</span>
							</button>
							<button
								class="theme-option"
								classList={{ active: props.theme() === 'dark' }}
								onClick={() => props.setTheme('dark')}
							>
								<div class="theme-preview theme-preview-dark" />
								<span class="theme-label">深色</span>
							</button>
							<button
								class="theme-option"
								classList={{ active: props.theme() === 'system' }}
								onClick={() => props.setTheme('system')}
							>
								<div class="theme-preview theme-preview-system" />
								<span class="theme-label">系统</span>
							</button>
						</div>
						<div class="code-preview-wrap" style="width:100%">
							<div class="code-preview code-preview-light">
								<div class="code-preview-header">浅色预览</div>
								<div class="code-preview-body">
									<div class="code-line code-hl-del">
										<span class="code-ln">1</span>
										<span><span class="token-key">surface</span><span class="token-punct">: </span><span class="token-str">"sidebar"</span><span class="token-punct">,</span></span>
									</div>
									<div class="code-line">
										<span class="code-ln">2</span>
										<span><span class="token-key">contrast</span><span class="token-punct">: </span><span class="token-num">42</span><span class="token-punct">,</span></span>
									</div>
								</div>
							</div>
							<div class="code-preview code-preview-dark">
								<div class="code-preview-header">深色预览</div>
								<div class="code-preview-body">
									<div class="code-line code-hl-add">
										<span class="code-ln">1</span>
										<span><span class="token-key">surface</span><span class="token-punct">: </span><span class="token-str">"elevated"</span><span class="token-punct">,</span></span>
									</div>
									<div class="code-line">
										<span class="code-ln">2</span>
										<span><span class="token-key">contrast</span><span class="token-punct">: </span><span class="token-num">68</span><span class="token-punct">,</span></span>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Font */}
			<div class="settings-group">
				<div class="settings-group-title">字体</div>
				<div class="settings-card">
					{/* Font family */}
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">界面字体</div>
							<div class="settings-row-desc">应用 UI 使用的字体</div>
						</div>
						<select
							class="settings-select"
							value={props.fontFamily()}
							onChange={(e) => props.setFontFamily(e.currentTarget.value)}
						>
							<For each={props.fontFamilies}>
								{(f) => <option value={f.value}>{f.label}</option>}
							</For>
						</select>
					</div>

					{/* Font size */}
					<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:12px">
						<div class="settings-row-label">
							<div class="settings-row-name">字体大小</div>
							<div class="settings-row-desc">界面文字大小（11 – 18 px）</div>
						</div>
						<div class="font-size-control">
							<span class="font-size-label">A</span>
							<input
								type="range"
								min="11"
								max="18"
								step="1"
								class="font-size-slider"
								value={props.fontSize()}
								onInput={(e) => props.setFontSize(parseInt(e.currentTarget.value, 10))}
							/>
							<span class="font-size-label large">A</span>
							<input
								type="number"
								min="11"
								max="18"
								class="font-size-input"
								value={props.fontSize()}
								onInput={(e) => {
									const v = parseInt(e.currentTarget.value, 10)
									if (!isNaN(v) && v >= 11 && v <= 18) props.setFontSize(v)
								}}
							/>
							<span class="font-size-unit">px</span>
						</div>
						{/* Live preview */}
						<div
							class="font-preview"
							style={`font-family:${props.fontFamilies.find((f) => f.value === props.fontFamily())?.css ?? 'inherit'};font-size:${props.fontSize()}px`}
						>
							码弦 AI 编程助手 · Maxian 0.1.0
						</div>
					</div>
				</div>
			</div>
		</>
	)
}
