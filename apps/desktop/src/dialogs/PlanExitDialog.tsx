/*---------------------------------------------------------------------------------------------
 *  PlanExitDialog — Agent 调用 plan_exit 工具时的"切换到 Build 模式"对话框（K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface PlanExitRequest {
	summary: string
	steps?:  string
}

export interface PlanExitDialogProps {
	request:        () => PlanExitRequest | null
	feedback:       () => string
	setFeedback:    (s: string) => void
	renderMarkdown: (md: string) => string
	onApprove:      () => void
	onReject:       () => void
}

export const PlanExitDialog: Component<PlanExitDialogProps> = (props) => {
	return (
		<Show when={props.request()}>
			{(req) => (
				<div class="approval-overlay">
					<div class="approval-dialog" style="max-width:640px;width:90vw;max-height:80vh;display:flex;flex-direction:column">
						<div class="approval-header">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
								<polyline points="9 11 12 14 22 4" />
								<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
							</svg>
							<span class="approval-title">AI 计划已就绪 — 是否切换到 Build 模式执行？</span>
						</div>
						<div class="approval-body" style="overflow-y:auto;flex:1">
							<div style="font-size:13px;color:var(--text-base);line-height:1.6;margin-bottom:12px">
								<strong>摘要</strong>
								<div style="margin-top:4px;padding:8px 10px;background:var(--bg-subtle);border-radius:6px;white-space:pre-wrap">
									{req().summary}
								</div>
							</div>
							<Show when={req().steps}>
								<div style="font-size:12.5px;color:var(--text-base);line-height:1.6">
									<strong>详细步骤</strong>
									<div
										class="md"
										innerHTML={props.renderMarkdown(req().steps ?? '')}
										style="margin-top:6px;padding:10px;background:var(--bg-subtle);border-radius:6px"
									/>
								</div>
							</Show>
							<div style="margin-top:12px">
								<label style="font-size:12px;color:var(--text-muted)">若不同意，请填写反馈让 AI 重新规划：</label>
								<textarea
									style="width:100%;min-height:50px;padding:8px 10px;margin-top:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg-base);font-size:12.5px;color:var(--text-base);outline:none;font-family:var(--font-sans);resize:vertical"
									placeholder="反馈（可选）…"
									value={props.feedback()}
									onInput={(e) => props.setFeedback(e.currentTarget.value)}
								/>
							</div>
						</div>
						<div class="approval-footer">
							<button class="approval-btn deny" onClick={props.onReject}>拒绝并反馈</button>
							<button class="approval-btn allow" onClick={props.onApprove}>开始执行</button>
						</div>
					</div>
				</div>
			)}
		</Show>
	)
}
