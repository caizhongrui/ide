/*---------------------------------------------------------------------------------------------
 *  ContextPanel — 会话上下文面板（K11c-cont）
 *  显示：@文件引用 / 待发送图片 / 会话内已变更文件
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface AttachedImageLike {
	id:      string
	dataUrl: string
	name:    string
}

export interface ChangedFileEntryLike {
	path:   string
	action: 'created' | 'modified' | 'deleted'
}

export interface ContextPanelProps {
	contextFiles:      () => string[]
	attachedImages:    () => AttachedImageLike[]
	changedFiles:      () => Map<string, ChangedFileEntryLike>
	onClose:           () => void
	onOpenPreview:     (path: string, opts?: { viewMode?: 'source' | 'diff' | 'rendered' }) => void
	onRemoveImage:     (id: string) => void
}

export const ContextPanel: Component<ContextPanelProps> = (props) => {
	return (
		<div class="file-tree-panel context-panel">
			<div class="file-tree-header">
				<span class="file-tree-title">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M20 7h-3V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z" />
					</svg>
					会话上下文
				</span>
				<button class="icon-btn" onClick={props.onClose} title="关闭">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>
			<div class="file-tree-body">
				{/* 文件引用 */}
				<Show when={props.contextFiles().length > 0}>
					<div class="context-section-title">@ 文件引用 ({props.contextFiles().length})</div>
					<For each={props.contextFiles()}>
						{(f) => (
							<div class="file-tree-item" onClick={() => props.onOpenPreview(f)} style="cursor:pointer" title={f}>
								<span class="explorer-file-icon">
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
										<polyline points="14 2 14 8 20 8" />
									</svg>
								</span>
								<span class="file-tree-filename">{f.split('/').pop()}</span>
								<span class="file-tree-path" style="margin-left:auto;font-size:10px">{f}</span>
							</div>
						)}
					</For>
				</Show>

				{/* 当前输入框附加图片（未发送） */}
				<Show when={props.attachedImages().length > 0}>
					<div class="context-section-title">待发送图片 ({props.attachedImages().length})</div>
					<div style="padding:4px 12px;display:flex;flex-wrap:wrap;gap:6px">
						<For each={props.attachedImages()}>
							{(img) => (
								<div style="position:relative">
									<img src={img.dataUrl} style="width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border)" alt={img.name} />
									<button
										style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:#ef4444;color:#fff;border:none;font-size:10px;cursor:pointer;line-height:1"
										onClick={() => props.onRemoveImage(img.id)}
									>×</button>
								</div>
							)}
						</For>
					</div>
				</Show>

				{/* 已变更文件（会话内） */}
				<Show when={props.changedFiles().size > 0}>
					<div class="context-section-title">已修改文件 ({props.changedFiles().size})</div>
					<For each={[...props.changedFiles().values()]}>
						{(entry) => (
							<div class="file-tree-item" onClick={() => props.onOpenPreview(entry.path, { viewMode: 'diff' })} style="cursor:pointer" title={entry.path}>
								<span class={`file-status-badge file-status-${entry.action}`}>
									{entry.action === 'created' ? 'A' : entry.action === 'deleted' ? 'D' : 'M'}
								</span>
								<span class="file-tree-filename">{entry.path.split('/').pop()}</span>
							</div>
						)}
					</For>
				</Show>

				<Show when={props.contextFiles().length === 0 && props.attachedImages().length === 0 && props.changedFiles().size === 0}>
					<div class="file-tree-empty">
						<div style="margin-bottom:10px">暂无附加上下文</div>
						<div style="font-size:11px;color:var(--text-faint);padding:0 12px;line-height:1.6">
							· 在输入框输入 <code style="background:var(--bg-subtle);padding:1px 4px;border-radius:3px">@</code> 引用工作区文件<br />
							· 拖拽或粘贴图片到输入框<br />
							· AI 修改的文件会自动追踪
						</div>
					</div>
				</Show>
			</div>
		</div>
	)
}
