/*---------------------------------------------------------------------------------------------
 *  ToolErrorPanel — 工具调用失败时的可折叠错误摘要面板（K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { createSignal, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface ToolErrorPanelProps {
	result: string
}

const SUMMARY_LEN = 160

export const ToolErrorPanel: Component<ToolErrorPanelProps> = (props) => {
	const [open, setOpen] = createSignal(false)
	const isLong = (): boolean => props.result.length > SUMMARY_LEN
	// 错误摘要：取第一个非空行（通常是 "Error: xxx" 主错误信息）
	const summary = (): string => {
		const firstLine = props.result.split('\n').find((l) => l.trim().length > 0) ?? ''
		return firstLine.length > SUMMARY_LEN ? firstLine.slice(0, SUMMARY_LEN) + '…' : firstLine
	}
	return (
		<div class="tool-error-panel" onClick={(e) => e.stopPropagation()}>
			<div class="tool-error-summary">
				<span class="tool-error-icon">❌</span>
				<span class="tool-error-text">{open() ? '错误详情' : summary()}</span>
				<Show when={isLong() || props.result.includes('\n')}>
					<button
						class="tool-error-toggle"
						onClick={() => setOpen((v) => !v)}
						title={open() ? '折叠' : '展开完整错误'}
					>
						{open() ? '收起 ▴' : '展开 ▾'}
					</button>
				</Show>
			</div>
			<Show when={open()}>
				<pre class="tool-error-body">{props.result}</pre>
			</Show>
		</div>
	)
}
