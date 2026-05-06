/*---------------------------------------------------------------------------------------------
 *  FileChangesPanel — 当前会话变更文件列表面板（K10e）
 *
 *  原 desktop App.tsx 的 FileTreePanel；改为更准确的命名 FileChangesPanel（不是目录树，是 diff 列表）。
 *  纯渲染：所有数据 + 回调通过 props 注入。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'
// @ts-expect-error vite ?inline → string
import css from './FileChangesPanel.css?inline'
import { injectStyleOnce } from './_injectStyle.js'

/** 单个变更文件 */
export interface FileChangeEntry {
	path:   string
	action: 'created' | 'modified' | 'deleted'
}

export interface FileChangesPanelProps {
	files:  FileChangeEntry[]
	onClose:        () => void
	/** 打开预览 — viewMode 由宿主决定具体取值，常见有 'diff' / 'source' / 'rendered' / 'preview' 等 */
	onOpenPreview:  (path: string, opts?: { viewMode?: string }) => void
	onOpenInEditor: (path: string) => void
	onRevert:       (path: string) => void
}

export const FileChangesPanel: Component<FileChangesPanelProps> = (props) => {
	injectStyleOnce('maxian-ui-file-changes-panel', css as string)

	return (
		<div class="file-tree-panel">
			<div class="file-tree-header">
				<span class="file-tree-title">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
					</svg>
					文件变更 ({props.files.length})
				</span>
				<button class="icon-btn" onClick={props.onClose} title="关闭">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>
			<div class="file-tree-body">
				<Show
					when={props.files.length > 0}
					fallback={<div class="file-tree-empty">本次会话暂无文件变更</div>}
				>
					<For each={props.files}>
						{(entry) => {
							const filename = entry.path.split('/').pop() ?? entry.path
							const shortPathVal = entry.path.length > 50
								? '…' + entry.path.slice(-47)
								: entry.path
							return (
								<div
									class="file-tree-item"
									onClick={() => props.onOpenPreview(entry.path, { viewMode: 'diff' })}
									style="cursor:pointer"
								>
									<span class={`file-status-badge file-status-${entry.action}`}>
										{entry.action === 'created' ? 'A' : entry.action === 'deleted' ? 'D' : 'M'}
									</span>
									<div class="file-tree-item-info">
										<span class="file-tree-filename">{filename}</span>
										<span class="file-tree-path" title={entry.path}>{shortPathVal}</span>
									</div>
									<button
										class="file-open-btn"
										onClick={(e) => { e.stopPropagation(); props.onOpenInEditor(entry.path) }}
										title="在编辑器中打开"
									>
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
											<polyline points="15 3 21 3 21 9" />
											<line x1="10" y1="14" x2="21" y2="3" />
										</svg>
									</button>
									<Show when={entry.action !== 'deleted'}>
										<button
											class="file-revert-btn"
											onClick={(e) => { e.stopPropagation(); props.onRevert(entry.path) }}
											title="撤销此文件的修改"
										>
											↩
										</button>
									</Show>
								</div>
							)
						}}
					</For>
				</Show>
			</div>
		</div>
	)
}
