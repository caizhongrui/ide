/*---------------------------------------------------------------------------------------------
 *  useTokenUsage — 当前会话 token 用量追踪（K11a-cont）
 *  封装：tokenUsed signal / tokenLimit signal / reset / handle 后端 token_usage 事件
 *--------------------------------------------------------------------------------------------*/

import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'

export interface TokenUsage {
	tokenUsed:    Accessor<number>
	tokenLimit:   Accessor<number>
	setTokenUsed: (n: number) => void
	setTokenLimit: (n: number) => void
	reset:        () => void
	/** 收到后端 token_usage 事件时调用：自动更新 used + 必要时调整 limit */
	onEvent:      (used: number, limit?: number) => void
}

export interface UseTokenUsageOptions {
	/** 默认 limit（后端尚未上报 limit 时使用）。默认 1_000_000 */
	defaultLimit?: number
}

export function useTokenUsage(opts: UseTokenUsageOptions = {}): TokenUsage {
	const [tokenUsed, setTokenUsed] = createSignal(0)
	// tokenLimit 由后端根据实际模型窗口上报（token_usage 事件的 limit 字段）
	const [tokenLimit, setTokenLimit] = createSignal(opts.defaultLimit ?? 1_000_000)

	const reset = (): void => {
		setTokenUsed(0)
	}

	const onEvent = (used: number, limit?: number): void => {
		setTokenUsed(used)
		// 后端上报的 limit 作为真实上下文窗口大小（覆盖前端默认）
		if (typeof limit === 'number' && limit > 0 && limit !== tokenLimit()) {
			setTokenLimit(limit)
		}
	}

	return {
		tokenUsed,
		tokenLimit,
		setTokenUsed,
		setTokenLimit,
		reset,
		onEvent,
	}
}
