/*---------------------------------------------------------------------------------------------
 *  WorkspaceExplorerPanel — 工作区文件树面板（K11c-cont）
 *  支持：搜索（扁平列表）/ 树模式（递归展开）/ 文件状态徽章（A / D / M）
 *--------------------------------------------------------------------------------------------*/

import { createMemo, For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface FileTreeNode {
	name:     string
	path:     string               // 相对工作区的完整路径
	isDir:    boolean
	children: FileTreeNode[]
}

export interface ChangedFileEntry {
	action: 'created' | 'modified' | 'deleted'
}

export function buildFileTree(paths: string[]): FileTreeNode {
	const root: FileTreeNode = { name: '', path: '', isDir: true, children: [] }
	for (const fullPath of paths) {
		const parts = fullPath.split('/').filter(Boolean)
		let cur = root
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]
			const isLast = i === parts.length - 1
			let child = cur.children.find((c) => c.name === part)
			if (!child) {
				child = {
					name:     part,
					path:     parts.slice(0, i + 1).join('/'),
					isDir:    !isLast,
					children: [],
				}
				cur.children.push(child)
			}
			cur = child
		}
	}
	// 排序：目录优先，同类按字母
	const sortRec = (n: FileTreeNode): void => {
		n.children.sort((a, b) => {
			if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
			return a.name.localeCompare(b.name)
		})
		n.children.forEach(sortRec)
	}
	sortRec(root)
	return root
}

export interface WorkspaceExplorerPanelProps {
	files:         () => string[]
	loading:       () => boolean
	changedFiles:  () => Map<string, ChangedFileEntry>
	expandedDirs:  () => Set<string>
	search:        () => string
	setSearch:     (v: string) => void
	toggleDir:     (path: string) => void
	onClose:       () => void
	onOpenPreview: (path: string) => void
}

export const WorkspaceExplorerPanel: Component<WorkspaceExplorerPanelProps> = (props) => {
	const q = (): string => props.search().trim().toLowerCase()

	// 搜索模式 vs 树模式
	const isSearching = (): boolean => q().length > 0
	const searchResults = (): string[] => {
		if (!isSearching()) return []
		return props.files()
			.filter((f) => f.toLowerCase().includes(q()))
			.slice(0, 300)
	}
	const tree = createMemo(() => buildFileTree(props.files()))

	// 渲染节点（递归）
	function renderNode(node: FileTreeNode, depth: number): any {
		if (!node.isDir) {
			const changed = props.changedFiles().get(node.path)?.action
			return (
				<div
					class="file-tree-item"
					onClick={() => props.onOpenPreview(node.path)}
					style={`cursor:pointer;padding-left:${8 + depth * 14}px`}
					title={node.path}
				>
					<Show when={changed} fallback={
						<span class="explorer-file-icon">
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
								<polyline points="14 2 14 8 20 8" />
							</svg>
						</span>
					}>
						<span class={`file-status-badge file-status-${changed}`}>
							{changed === 'created' ? 'A' : changed === 'deleted' ? 'D' : 'M'}
						</span>
					</Show>
					<span class="file-tree-filename">{node.name}</span>
				</div>
			)
		}
		const open = (): boolean => props.expandedDirs().has(node.path)
		return (
			<>
				<div
					class="file-tree-item file-tree-dir"
					onClick={() => props.toggleDir(node.path)}
					style={`cursor:pointer;padding-left:${8 + depth * 14}px`}
					title={node.path}
				>
					<svg
						class="file-tree-arrow"
						classList={{ open: open() }}
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
					>
						<polyline points="9 18 15 12 9 6" />
					</svg>
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						style="color:var(--accent);flex-shrink:0"
					>
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
					</svg>
					<span class="file-tree-filename">{node.name}</span>
					<span class="file-tree-dir-count">{node.children.length}</span>
				</div>
				<Show when={open()}>
					<For each={node.children}>
						{(child) => renderNode(child, depth + 1)}
					</For>
				</Show>
			</>
		)
	}

	return (
		<div class="file-tree-panel explorer-panel">
			<div class="file-tree-header">
				<span class="file-tree-title">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
					</svg>
					工作区文件 ({props.files().length})
				</span>
				<button class="icon-btn" onClick={props.onClose} title="关闭">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>
			<div class="explorer-search-wrap">
				<input
					class="explorer-search"
					placeholder="搜索文件…"
					value={props.search()}
					onInput={(e) => props.setSearch(e.currentTarget.value)}
				/>
			</div>
			<div class="file-tree-body">
				<Show when={props.loading()}>
					<div class="file-tree-empty">加载中…</div>
				</Show>

				{/* 搜索模式：扁平列表 */}
				<Show when={!props.loading() && isSearching()}>
					<Show when={searchResults().length === 0}>
						<div class="file-tree-empty">无匹配文件</div>
					</Show>
					<For each={searchResults()}>
						{(filePath) => {
							const filename = filePath.split('/').pop() ?? filePath
							const dir = filePath.slice(0, filePath.length - filename.length).replace(/\/$/, '')
							const changed = props.changedFiles().get(filePath)?.action
							return (
								<div
									class="file-tree-item"
									onClick={() => props.onOpenPreview(filePath)}
									style="cursor:pointer"
									title={filePath}
								>
									<Show when={changed} fallback={
										<span class="explorer-file-icon">
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
												<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
												<polyline points="14 2 14 8 20 8" />
											</svg>
										</span>
									}>
										<span class={`file-status-badge file-status-${changed}`}>
											{changed === 'created' ? 'A' : changed === 'deleted' ? 'D' : 'M'}
										</span>
									</Show>
									<div class="file-tree-item-info">
										<span class="file-tree-filename">{filename}</span>
										<Show when={dir}>
											<span class="file-tree-path">{dir}</span>
										</Show>
									</div>
								</div>
							)
						}}
					</For>
					<Show when={searchResults().length === 300}>
						<div class="file-tree-empty" style="font-size:11px;padding:8px 12px">
							仅显示前 300 条，请用搜索进一步过滤
						</div>
					</Show>
				</Show>

				{/* 树模式（默认） */}
				<Show when={!props.loading() && !isSearching()}>
					<Show when={props.files().length === 0}>
						<div class="file-tree-empty">工作区为空</div>
					</Show>
					<For each={tree().children}>
						{(node) => renderNode(node, 0)}
					</For>
				</Show>
			</div>
		</div>
	)
}
