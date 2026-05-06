/*---------------------------------------------------------------------------------------------
 *  QuestionDialog — Agent 调用 question 工具时的澄清对话框（K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface QuestionRequest {
	question: string
	options:  string[]
	multi:    boolean
}

export interface QuestionDialogProps {
	request:           () => QuestionRequest | null
	answer:            () => string
	selected:          () => string[]
	setAnswer:         (s: string) => void
	toggleOption:      (o: string) => void
	onSubmit:          () => void
	onCancel:          () => void
}

export const QuestionDialog: Component<QuestionDialogProps> = (props) => {
	const req = props.request
	if (!req()) return null
	return (
		<Show when={req()}>
			{(r) => (
				<div class="approval-overlay">
					<div class="approval-dialog" style="max-width:560px;width:90vw">
						<div class="approval-header">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
								<circle cx="12" cy="12" r="10" />
								<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
								<line x1="12" y1="17" x2="12.01" y2="17" />
							</svg>
							<span class="approval-title">AI 请求澄清</span>
						</div>
						<div class="approval-body">
							<div style="white-space:pre-wrap;line-height:1.6;color:var(--text-base);font-size:13.5px;margin-bottom:12px">
								{r().question}
							</div>
							<Show when={r().options.length > 0}>
								<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
									<For each={r().options}>
										{(o) => {
											const checked = (): boolean => props.selected().includes(o)
											return (
												<label
													style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:var(--bg-subtle)"
													classList={{ 'question-option-checked': checked() }}
												>
													<input
														type={r().multi ? 'checkbox' : 'radio'}
														checked={checked()}
														onChange={() => props.toggleOption(o)}
														name="qq-opt"
													/>
													<span style="flex:1;font-size:12.5px">{o}</span>
												</label>
											)
										}}
									</For>
								</div>
							</Show>
							<textarea
								style="width:100%;min-height:60px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-subtle);font-size:12.5px;color:var(--text-base);outline:none;font-family:var(--font-sans);resize:vertical"
								placeholder={r().options.length > 0 ? '可选：补充说明…' : '回答…'}
								value={props.answer()}
								onInput={(e) => props.setAnswer(e.currentTarget.value)}
							/>
						</div>
						<div class="approval-footer">
							<button class="approval-btn deny" onClick={props.onCancel}>取消</button>
							<button
								class="approval-btn allow"
								disabled={props.answer().trim().length === 0 && props.selected().length === 0}
								onClick={props.onSubmit}
							>提交</button>
						</div>
					</div>
				</div>
			)}
		</Show>
	)
}
