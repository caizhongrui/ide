/*---------------------------------------------------------------------------------------------
 *  StatusBanners — 上下文压缩进度条 / 限流倒计时（K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { createSignal, createEffect, onCleanup, Show } from 'solid-js'
import type { Component } from 'solid-js'
import { AnimatedNumber } from '../components/AnimatedNumber'

/** 上下文压缩状态 */
export interface CompactingStateLike {
	tokensCurrent: number
	willLevel2:    boolean
	startedAt:     number
}

export interface CompactingBannerProps {
	state: () => CompactingStateLike | null
}

export const CompactingBanner: Component<CompactingBannerProps> = (props) => {
	const [now, setNow] = createSignal(Date.now())
	createEffect(() => {
		if (!props.state()) return
		const timer = setInterval(() => setNow(Date.now()), 200)
		onCleanup(() => clearInterval(timer))
	})
	const elapsed = (): string => {
		const s = props.state()
		if (!s) return '0.0'
		return ((now() - s.startedAt) / 1000).toFixed(1)
	}
	return (
		<Show when={props.state()}>
			{(s) => (
				<div class="rate-limit-banner" style="background:color-mix(in srgb, var(--accent) 10%, transparent);border-color:color-mix(in srgb, var(--accent) 30%, transparent);color:var(--accent)">
					<span class="todo-spinner" style="border-top-color:var(--accent)" />
					<span class="rate-limit-msg">
						正在压缩上下文（{s().willLevel2 ? 'LLM 总结' : '按类型剪枝'}，当前 {s().tokensCurrent.toLocaleString()} tokens）…
					</span>
					<span class="rate-limit-countdown">{elapsed()}s</span>
				</div>
			)}
		</Show>
	)
}

/** 限流状态 */
export interface RateLimitStateLike {
	active:   boolean
	resetAt:  number
	attempt:  number
	message:  string
}

export interface RateLimitBannerProps {
	state:    () => RateLimitStateLike
	onCancel: () => void
}

export const RateLimitBanner: Component<RateLimitBannerProps> = (props) => {
	const [now, setNow] = createSignal(Date.now())
	createEffect(() => {
		if (!props.state().active) return
		const timer = setInterval(() => setNow(Date.now()), 1000)
		onCleanup(() => clearInterval(timer))
	})
	const secondsLeft = (): number => Math.max(0, Math.ceil((props.state().resetAt - now()) / 1000))
	return (
		<Show when={props.state().active}>
			<div class="rate-limit-banner">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<polyline points="12 6 12 12 16 14" />
				</svg>
				<span class="rate-limit-msg">{props.state().message}</span>
				<span class="rate-limit-countdown">
					<Show when={secondsLeft() > 0} fallback="正在重试…">
						剩余 <AnimatedNumber value={secondsLeft()} duration={200} /> 秒
					</Show>
				</span>
				<span class="rate-limit-attempt">第 {props.state().attempt} 次尝试</span>
				<button class="rate-limit-cancel" onClick={props.onCancel}>取消</button>
			</div>
		</Show>
	)
}
