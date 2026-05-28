/*---------------------------------------------------------------------------------------------
 *  TokenUsageBar — 上下文 token 用量信息条（v0.2.25 from jiusi）
 *
 *  参考 Claude Code 风格：
 *  - 纯文本展示 `Context 194.0k / 1.0M (19%)`，不再用进度条占垂直空间
 *  - 百分比按阈值上色：< 50% 绿，< 80% 黄，≥ 80% 红
 *  - 当 ≥ 80% 显示"📦 压缩上下文"按钮，由 host 提供回调
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
	/** 触发压缩；返回 Promise resolve 后视为完成（用于内部 compacting 状态机） */
	onCompact?:   () => Promise<void>
}

/** 把 tokens 数字格式化成 `194.0k` / `1.0M` 形式 —— 与 Claude Code 一致 */
function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '0'
	if (n >= 1_000_000) {
		const v = n / 1_000_000
		// 1.0M / 1.25M 都保留 1-2 位小数，>10M 不带小数
		if (v >= 10) return `${Math.round(v)}M`
		return `${v.toFixed(v >= 1 ? 1 : 2)}M`
	}
	if (n >= 1_000) {
		const v = n / 1_000
		if (v >= 100) return `${Math.round(v)}k`
		return `${v.toFixed(1)}k`
	}
	return String(Math.round(n))
}

export const TokenUsageBar: Component<TokenUsageBarProps> = (props) => {
	injectStyleOnce('maxian-ui-token-usage-bar', css as string)

	const [compacting, setCompacting] = createSignal(false)
	const pct       = (): number => props.tokenLimit > 0 ? Math.min(100, (props.tokenUsed / props.tokenLimit) * 100) : 0
	/** 文字色阶：与原进度条一致（<50 绿, <80 黄, ≥80 红） */
	const pctLevel  = (): 'ok' | 'warn' | 'critical' =>
		pct() < 50 ? 'ok' : pct() < 80 ? 'warn' : 'critical'

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
		<Show when={props.tokenLimit > 0}>
			<div
				class="token-usage-row"
				title={`已使用 ${props.tokenUsed.toLocaleString()} / ${props.tokenLimit.toLocaleString()} tokens (${pct().toFixed(1)}%)`}
			>
				{/* 占位填充，把文字推到右边 */}
				<span class="token-usage-spacer" />
				<span class="token-usage-text">
					<span class="token-usage-label">Context</span>{' '}
					<span class="token-usage-numbers">
						{fmtTokens(props.tokenUsed)} / {fmtTokens(props.tokenLimit)}
					</span>{' '}
					<span class="token-usage-pct" data-level={pctLevel()}>
						({pct().toFixed(0)}%)
					</span>
				</span>
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
