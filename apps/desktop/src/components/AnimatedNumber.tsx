/*---------------------------------------------------------------------------------------------
 *  AnimatedNumber — 数字 ease-out-cubic 平滑过渡（K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { createSignal, createEffect, onCleanup } from 'solid-js'
import type { Component, JSX } from 'solid-js'

export interface AnimatedNumberProps {
	value:    number
	duration?: number
}

export const AnimatedNumber: Component<AnimatedNumberProps> = (props): JSX.Element => {
	const [display, setDisplay] = createSignal(props.value)
	createEffect(() => {
		const target = props.value
		const start = display()
		if (start === target) return
		const dur = props.duration ?? 500
		const t0 = performance.now()
		let rafId = 0
		const tick = (now: number): void => {
			const p = Math.min(1, (now - t0) / dur)
			const eased = 1 - Math.pow(1 - p, 3)  // easeOutCubic
			setDisplay(Math.round(start + (target - start) * eased))
			if (p < 1) rafId = requestAnimationFrame(tick)
		}
		rafId = requestAnimationFrame(tick)
		onCleanup(() => cancelAnimationFrame(rafId))
	})
	return <>{display().toLocaleString()}</> as unknown as JSX.Element
}
