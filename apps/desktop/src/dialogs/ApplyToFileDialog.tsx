/*---------------------------------------------------------------------------------------------
 *  ApplyToFileDialog — 把 AI 代码块写入指定文件的对话框（K11c-cont）
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface ApplyDialogState {
	open:    boolean
	code:    string
	lang?:   string
	target:  string
	mode:    'overwrite' | 'append'
	loading: boolean
	error?:  string
}

export interface ApplyToFileDialogProps {
	state:        () => ApplyDialogState
	setState:     (updater: (prev: ApplyDialogState) => ApplyDialogState) => void
	close:        () => void
	onConfirm:    () => void | Promise<void>
}

export const ApplyToFileDialog: Component<ApplyToFileDialogProps> = (props) => {
	return (
		<Show when={props.state().open}>
			<div
				class="approval-overlay"
				onClick={(e) => {
					if (e.target === e.currentTarget) props.close()
				}}
			>
				<div class="approval-dialog" style="max-width:600px;width:90vw;max-height:80vh;display:flex;flex-direction:column">
					<div class="approval-header">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
							<polyline points="14 2 14 8 20 8" />
							<line x1="12" y1="18" x2="12" y2="12" />
							<line x1="9" y1="15" x2="15" y2="15" />
						</svg>
						<span class="approval-title">应用代码到文件</span>
						<Show when={props.state().lang}>
							<span style="font-size:11px;color:var(--text-muted);margin-left:8px">({props.state().lang})</span>
						</Show>
					</div>
					<div class="approval-body" style="overflow-y:auto;flex:1">
						<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">目标文件（相对路径）</div>
						<input
							type="text"
							style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-base);font-size:12.5px;color:var(--text-base);outline:none;font-family:ui-monospace,Menlo,monospace"
							value={props.state().target}
							placeholder="例如：src/components/Button.tsx"
							onInput={(e) => props.setState((d) => ({ ...d, target: e.currentTarget.value }))}
						/>
						<div style="display:flex;gap:10px;margin-top:10px;font-size:12px;color:var(--text-base)">
							<label style="display:flex;align-items:center;gap:4px;cursor:pointer">
								<input
									type="radio"
									name="apply-mode"
									checked={props.state().mode === 'overwrite'}
									onChange={() => props.setState((d) => ({ ...d, mode: 'overwrite' }))}
								/> 覆盖写入
							</label>
							<label style="display:flex;align-items:center;gap:4px;cursor:pointer">
								<input
									type="radio"
									name="apply-mode"
									checked={props.state().mode === 'append'}
									onChange={() => props.setState((d) => ({ ...d, mode: 'append' }))}
								/> 追加到末尾
							</label>
						</div>
						<div style="margin-top:10px">
							<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">
								代码预览（{props.state().code.split('\n').length} 行，{props.state().code.length} 字符）
							</div>
							<pre style="max-height:260px;overflow:auto;padding:10px;background:var(--bg-subtle);border-radius:6px;font-size:11.5px;line-height:1.45;font-family:ui-monospace,Menlo,monospace;color:var(--text-base);white-space:pre;border:1px solid var(--border-subtle)">
								{props.state().code}
							</pre>
						</div>
						<Show when={props.state().error}>
							<div style="margin-top:8px;padding:6px 10px;background:rgba(255,80,80,0.12);color:#ffb0b0;border-radius:4px;font-size:12px">
								{props.state().error}
							</div>
						</Show>
					</div>
					<div class="approval-footer">
						<button class="approval-btn deny" disabled={props.state().loading} onClick={props.close}>取消</button>
						<button
							class="approval-btn allow"
							disabled={props.state().loading || !props.state().target.trim()}
							onClick={() => void props.onConfirm()}
						>{props.state().loading ? '写入中…' : '写入文件'}</button>
					</div>
				</div>
			</div>
		</Show>
	)
}
