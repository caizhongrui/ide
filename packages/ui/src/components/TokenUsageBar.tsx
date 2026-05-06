/*---------------------------------------------------------------------------------------------
 *  TokenUsageBar — 上下文 token 用量条 + 主动压缩按钮（K10c）
 *
 *  纯渲染组件：
 *  - 进度条颜色按 used/limit 比例自动调（< 50% 绿，< 80% 黄，>= 80% 红）
 *  - 达到 80% 时显示「📦 压缩上下文」按钮，由 host 应用提供 onCompact 回调
 *  - 隐含逻辑（compacting 状态、disabled 条件）由 host 通过 props 传入
 *--------------------------------------------------------------------------------------------*/

import { Show, createSignal } from 'solid-js'
import type { Component } from 'solid-js'
// @ts-expect-error vite ?inline → string
import css from './TokenUsageBar.css?inline'
import { injectStyleOnce } from './_injectStyle.js'

export interface TokenUsageBarProps {
	/** 已使用 tokens */
	tokenUsed:    number
	/** 配额上限 */
	tokenLimit:   number
	/** 是否禁用压缩按钮（如 sending 中、无活跃会话等） */
	compactDisabled?: boolean
	/** 触发压缩；返回的 Promise resolve 后视为完成（用于内部 compacting 状态机） */
	onCompact?:   () => Promise<void>
}

export const TokenUsageBar: Component<TokenUsageBarProps> = (props) => {
	injectStyleOnce('maxian-ui-token-usage-bar', css as string)

	const [compacting, setCompacting] = createSignal(false)
	const pct   = () => props.tokenLimit > 0 ? Math.min(100, (props.tokenUsed / props.tokenLimit) * 100) : 0
	const color = () => pct() < 50 ? '#22c55e' : pct() < 80 ? '#f59e0b' : '#ef4444'

	const handleCompact = async (): Promise<void> => {
		if (!props.onCompact || compacting() || props.compactDisabled) return
		try {
			setCompacting(true)
			await props.onCompact()
		} finally {
			setCompacting(false)
		}
	}

	return (
		<Show when={props.tokenUsed > 0}>
			<div class="token-usage-row">
				<div
					class="token-usage-bar"
					title={`已使用 ${props.tokenUsed.toLocaleString()} / ${props.tokenLimit.toLocaleString()} tokens (${pct().toFixed(1)}%)`}
				>
					<div
						class="token-usage-fill"
						style={{
							width: `${pct()}%`,
							background: color(),
							transition: 'width 400ms ease-out, background 300ms',
						}}
					/>
				</div>
				<Show when={pct() >= 80 && !!props.onCompact}>
					<button
						class="token-compact-btn"
						classList={{ critical: pct() >= 90 }}
						disabled={compacting() || props.compactDisabled}
						onClick={() => void handleCompact()}
						title="主动压缩当前会话上下文，释放 token 配额（保留关键工具结果，省略中间步骤摘要）"
					>
						{compacting() ? '压缩中…' : '📦 压缩上下文'}
					</button>
				</Show>
			</div>
		</Show>
	)
}
