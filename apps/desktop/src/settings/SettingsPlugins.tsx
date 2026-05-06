/*---------------------------------------------------------------------------------------------
 *  SettingsPlugins — 插件开发设置面板（K11c-7：从 App.tsx 切出）
 *--------------------------------------------------------------------------------------------*/

import { createSignal } from 'solid-js'
import type { Component } from 'solid-js'

export interface SettingsPluginsProps {
	pluginDevMarkdown: string
	renderMarkdown:    (md: string) => string
	showToast:         (opts: { message: string; kind?: 'info' | 'success' | 'warn' | 'error'; duration?: number }) => void
}

export const SettingsPlugins: Component<SettingsPluginsProps> = (props) => {
	const [pluginDir] = createSignal<string>('~/.maxian/plugins/')

	const openPluginDir = async (): Promise<void> => {
		try {
			const { Command } = await import('@tauri-apps/plugin-shell' as any)
			const pathMod = await import('@tauri-apps/api/path' as any)
			const home: string = pathMod.homeDir ? await pathMod.homeDir() : ''
			const target = `${home}/.maxian/plugins/`
			const cmd = new Command('open', [target])
			await cmd.execute()
		} catch {
			props.showToast({ message: '打开目录失败：请手动定位 ~/.maxian/plugins/', kind: 'warn' })
		}
	}

	const copyDevDoc = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(props.pluginDevMarkdown)
			props.showToast({ message: '插件开发文档已复制到剪贴板', kind: 'success', duration: 2000 })
		} catch {
			props.showToast({ message: '复制失败', kind: 'error' })
		}
	}

	return (
		<div class="settings-page">
			<h3>插件开发</h3>
			<div class="settings-section">
				<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
					<button class="btn btn-primary" onClick={openPluginDir}>📁 打开插件目录</button>
					<button class="btn btn-ghost" onClick={copyDevDoc}>📋 复制完整文档</button>
				</div>
				<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
					插件目录：<code style="background:var(--bg-subtle);padding:1px 5px;border-radius:3px">{pluginDir()}</code>
				</div>
			</div>
			<div
				class="md markdown-body"
				style="font-size:13px;line-height:1.7;padding:12px 14px;background:var(--bg-subtle);border-radius:8px;max-height:68vh;overflow:auto"
				innerHTML={props.renderMarkdown(props.pluginDevMarkdown)}
			/>
		</div>
	)
}
