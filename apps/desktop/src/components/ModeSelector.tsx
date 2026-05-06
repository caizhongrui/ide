/*---------------------------------------------------------------------------------------------
 *  ModeSelector — 输入框旁的"操作模式"选择器（K11a 抽离自 App.tsx）
 *
 *  用户可在 4 种模式间切换：
 *    ask    询问权限（AI 工具调用前请求许可）
 *    code   接受编辑（默认；自动接受文件修改）
 *    plan   计划模式（AI 只规划不执行）
 *    bypass 跳过权限（跳过所有工具权限确认）
 *
 *  纯渲染：当前模式 / dropdown 状态 / 切换回调通过 props 注入。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export type ComposerMode = 'code' | 'ask' | 'plan' | 'bypass'

export interface ModeOption {
	id:    ComposerMode
	label: string
	desc:  string
	color: string
	paths: string[]
}

export const MODE_OPTIONS: ModeOption[] = [
	{
		id:    'ask',
		label: '询问权限',
		desc:  '工具调用时请求许可',
		color: '#a78bfa',
		paths: [
			"M9 12l2 2 4-4",
			"M21 12c.552 0 1.005-.45.95-1A10 10 0 0 0 12 2c-5.523 0-10 4.477-10 10a10 10 0 0 0 9 9.95c.55.05 1-.398 1-.95v-1c0-.552-.45-.998-.997-1.057A8 8 0 1 1 19.943 11a.998.998 0 0 0-.943.997V13c0 .552.45 1.005 1 .95V12z",
		],
	},
	{
		id:    'code',
		label: '接受编辑',
		desc:  '自动接受文件修改（默认）',
		color: '#34d399',
		paths: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
	},
	{
		id:    'plan',
		label: '计划模式',
		desc:  'AI 只规划，不执行操作',
		color: '#fbbf24',
		paths: [
			"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
			"M14 2v6h6", "M16 13H8", "M16 17H8", "M10 9H8",
		],
	},
	{
		id:    'bypass',
		label: '跳过权限',
		desc:  '跳过所有工具权限确认',
		color: '#f87171',
		paths: ["M5 12h14", "M12 5l7 7-7 7"],
	},
]

const ModeSvgIcon: Component<{ paths: string[]; color: string; size?: number }> = (props) => {
	const sz = props.size ?? 14
	return (
		<svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke={props.color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
			{props.paths.map(p => <path d={p} />)}
		</svg>
	)
}

export interface ModeSelectorProps {
	currentMode:        () => ComposerMode
	showDropdown:       () => boolean
	setShowDropdown:    (v: boolean | ((prev: boolean) => boolean)) => void
	/** 切换模式回调；host 负责更新 composerMode signal、调 server / 注入消息等副作用 */
	onSelectMode:       (mode: ComposerMode, prevMode: ComposerMode) => void | Promise<void>
}

export const ModeSelector: Component<ModeSelectorProps> = (props) => {
	const currentOpt = () => MODE_OPTIONS.find(o => o.id === props.currentMode()) ?? MODE_OPTIONS[1]
	return (
		<div class="mode-selector-wrap">
			<button
				class="mode-selector-btn"
				classList={{ open: props.showDropdown() }}
				onClick={(e) => {
					e.stopPropagation()
					props.setShowDropdown((v) => !v)
				}}
				title="选择操作模式"
			>
				<ModeSvgIcon paths={currentOpt().paths} color={currentOpt().color} size={12} />
				<span class="mode-selector-label">{currentOpt().label}</span>
				<svg class="mode-selector-chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<polyline points="6 9 12 15 18 9"/>
				</svg>
			</button>
			<Show when={props.showDropdown()}>
				<div class="mode-selector-popup">
					<For each={MODE_OPTIONS}>
						{(opt, idx) => (
							<button
								class="mode-option-item"
								classList={{ active: props.currentMode() === opt.id }}
								onClick={async (e) => {
									e.stopPropagation()
									const prevMode = props.currentMode()
									if (prevMode === opt.id) {
										props.setShowDropdown(false)
										return
									}
									props.setShowDropdown(false)
									await props.onSelectMode(opt.id, prevMode)
								}}
							>
								<span class="mode-option-num">{idx() + 1}</span>
								<ModeSvgIcon paths={opt.paths} color={opt.color} size={13} />
								<div class="mode-option-text">
									<span class="mode-option-label">{opt.label}</span>
									<span class="mode-option-desc">{opt.desc}</span>
								</div>
								<Show when={props.currentMode() === opt.id}>
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" style="flex-shrink:0;margin-left:auto">
										<polyline points="20 6 9 17 4 12"/>
									</svg>
								</Show>
							</button>
						)}
					</For>
				</div>
			</Show>
		</div>
	)
}
