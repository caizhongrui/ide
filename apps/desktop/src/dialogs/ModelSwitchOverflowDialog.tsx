/*---------------------------------------------------------------------------------------------
 *  ModelSwitchOverflowDialog — 切模型上下文超额提示（v0.2.25 K-MultiModel）
 *
 *  切到 contextWindow 更小的模型时，若当前 token 用量 > 新模型上限 × 0.85 弹出。
 *  三个选项：压缩后切换 / 直接切换 / 取消。
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'

export type OverflowDecision = 'compact' | 'force' | 'cancel'

export interface ModelSwitchOverflowDialogProps {
	open:                () => boolean
	currentTokens:       () => number
	targetDisplayName:   () => string
	targetContextWindow: () => number
	onDecision:          (d: OverflowDecision) => void
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	if (n >= 1000) return `${(n / 1000).toFixed(0)}K`
	return `${n}`
}

export const ModelSwitchOverflowDialog: Component<ModelSwitchOverflowDialogProps> = (props) => {
	return (
		<Show when={props.open()}>
			<div
				class="approval-overlay"
				onClick={() => props.onDecision('cancel')}
			>
				<div
					class="approval-dialog"
					style="max-width:560px;width:90vw"
					onClick={(e) => e.stopPropagation()}
				>
					<div class="approval-header">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2">
							<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
							<line x1="12" y1="9" x2="12" y2="13"/>
							<line x1="12" y1="17" x2="12.01" y2="17"/>
						</svg>
						<span class="approval-title">当前对话可能超出目标模型上下文</span>
					</div>
					<div class="approval-body" style="font-size:13px;color:var(--text-base);line-height:1.7">
						<p style="margin:0 0 8px">
							当前已用约 <strong>{fmtTokens(props.currentTokens())}</strong> tokens，
							目标模型 <strong>"{props.targetDisplayName()}"</strong> 上限{' '}
							<strong>{fmtTokens(props.targetContextWindow())}</strong> tokens。
						</p>
						<p style="margin:0 0 8px;color:var(--text-muted)">
							切换后超出部分可能被截断或返回错误。建议先压缩上下文。
						</p>
					</div>
					<div class="approval-actions" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 16px">
						<button
							class="btn-secondary"
							onClick={() => props.onDecision('cancel')}
						>
							取消
						</button>
						<button
							class="btn-secondary"
							onClick={() => props.onDecision('force')}
						>
							直接切换
						</button>
						<button
							class="btn-primary"
							onClick={() => props.onDecision('compact')}
						>
							压缩后切换（推荐）
						</button>
					</div>
				</div>
			</div>
		</Show>
	)
}
