/*---------------------------------------------------------------------------------------------
 *  ModelSelector — 模型选择器（v0.2.25 K-MultiModel）
 *
 *  挂在 composer 上方，跟 ModeSelector 并排。
 *  点击 button 弹下拉清单；选某个 model 触发 onSelect(modelName)。
 *  models 为空时整个组件返回 null（隐藏，sidecar 走默认 businessCode + priority pool）。
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import type { Component } from 'solid-js'
import type { SceneModel } from '@maxian/sdk'

export interface ModelSelectorProps {
	models:       () => SceneModel[]
	currentModel: () => string | null
	loading:      () => boolean
	onSelect:     (modelName: string) => void | Promise<void>
}

export const ModelSelector: Component<ModelSelectorProps> = (props) => {
	const [open, setOpen] = createSignal(false)
	let panelRef: HTMLDivElement | undefined
	let btnRef: HTMLButtonElement | undefined

	// 点外面关闭
	const handleDocClick = (e: MouseEvent): void => {
		if (!open()) return
		const t = e.target as Node | null
		if (t && (panelRef?.contains(t) || btnRef?.contains(t))) return
		setOpen(false)
	}
	onMount(() => document.addEventListener('click', handleDocClick))
	onCleanup(() => document.removeEventListener('click', handleDocClick))

	const currentName = (): string => {
		const code = props.currentModel()
		if (!code) {
			// 未指定 → 显示默认模型名（若清单里有 isDefault=1 的）
			const def = props.models().find(m => m.isDefault === 1)
			return def ? `${def.model} (默认)` : '默认模型'
		}
		return code
	}

	const fmtCtx = (n?: number): string => {
		if (!n) return ''
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
		if (n >= 1000) return `${(n / 1000).toFixed(0)}K`
		return `${n}`
	}

	return (
		<Show when={props.models().length > 0}>
			<div class="model-selector">
				<button
					ref={el => (btnRef = el)}
					class="model-selector-btn"
					classList={{ open: open() }}
					onClick={() => setOpen(v => !v)}
					title="切换模型"
				>
					<span class="model-selector-btn-name">{currentName()}</span>
					<svg
						class="model-selector-btn-caret"
						width="10" height="10" viewBox="0 0 24 24"
						fill="none" stroke="currentColor" stroke-width="2.5"
						stroke-linecap="round" stroke-linejoin="round"
					>
						<polyline points="6 9 12 15 18 9"/>
					</svg>
				</button>
				<Show when={open()}>
					<div class="model-selector-panel" ref={el => (panelRef = el)}>
						<Show when={props.loading()}>
							<div class="model-selector-loading">加载模型清单...</div>
						</Show>
						<Show when={!props.loading() && props.models().length === 0}>
							<div class="model-selector-empty">无可用模型</div>
						</Show>
						<For each={props.models()}>
							{(m) => (
								<div
									class="model-selector-item"
									classList={{
										active:         props.currentModel() === m.model,
										'default-marker': m.isDefault === 1 && props.currentModel() !== m.model,
									}}
									onClick={() => {
										setOpen(false)
										void props.onSelect(m.model)
									}}
								>
									<span class="model-selector-item-name">{m.model}</span>
									<span class="model-selector-item-provider">{m.provider}</span>
									<Show when={m.contextWindow}>
										<span class="model-selector-item-ctx">{fmtCtx(m.contextWindow)}</span>
									</Show>
									<Show when={m.supportVision === 1}>
										<span class="model-selector-item-vision" title="支持图片输入">
											<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
												<circle cx="8.5" cy="8.5" r="1.5"/>
												<polyline points="21 15 16 10 5 21"/>
											</svg>
										</span>
									</Show>
								</div>
							)}
						</For>
					</div>
				</Show>
			</div>
		</Show>
	)
}
