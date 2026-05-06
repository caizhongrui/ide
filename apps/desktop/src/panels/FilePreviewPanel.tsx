/*---------------------------------------------------------------------------------------------
 *  FilePreviewPanel — 多标签文件预览面板（K11c-cont）
 *  支持：拖拽重排标签 / Markdown 源码↔渲染切换 / Diff 视图（unified+split）
 *      / 图片 / 音频 / 视频 / 二进制 / 外部变更检测横幅 / 行号 + 高亮
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'
import hljs from 'highlight.js/lib/common'
import { DiffViewer as SharedDiffViewer } from '@maxian/ui'

/** 文件变更动作 */
export type FileChangeAction = 'modified' | 'created' | 'deleted'

/** 预览标签（右侧预览面板中的一个打开文件） */
export interface PreviewTab {
	path:      string
	title:     string
	kind:      'text' | 'image' | 'audio' | 'video' | 'binary' | 'markdown'
	content:   string
	mimeType:  string
	size:      number
	error?:    string
	loading:   boolean
	viewMode:  'source' | 'diff' | 'rendered'
	changed?:  FileChangeAction
	diffOriginal?: string | null
	diffCurrent?:  string
	diffLoading?:  boolean
	extChangedAt?: number
	pendingLine?:  number
	mtimeMs?:      number
}

export interface FilePreviewPanelProps {
	tabs:                   () => PreviewTab[]
	activePath:             () => string | null
	width:                  () => number
	diffViewMode:           () => 'unified' | 'split'
	renderMarkdown:         (md: string) => string
	setActivePath:          (path: string) => void
	setWidth:               (w: number) => void
	setTabs:                (updater: (prev: PreviewTab[]) => PreviewTab[]) => void
	setDiffViewMode:        (m: 'unified' | 'split') => void
	closeTab:               (path: string) => void
	setTabViewMode:         (path: string, mode: 'source' | 'diff' | 'rendered') => void
	openInEditor:           (path: string) => void
	revertFile:             (path: string) => void
	reloadPreview:          (path: string) => void | Promise<void>
	clearAllTabs?:          () => void  // 默认实现：setTabs([]) + setActivePath(null)
}

/** 根据扩展名判定 highlight.js 语言（返回空则自动检测） */
function hljsLangFromPath(p: string): string | undefined {
	const ext = p.split('.').pop()?.toLowerCase() ?? ''
	const map: Record<string, string> = {
		ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
		mjs: 'javascript', cjs: 'javascript',
		py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
		c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
		cs: 'csharp', swift: 'swift', rb: 'ruby', php: 'php', scala: 'scala',
		sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
		json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
		xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
		css: 'css', scss: 'scss', less: 'less',
		sql: 'sql', dockerfile: 'dockerfile',
		vue: 'xml', svelte: 'xml',
	}
	return map[ext]
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c] as string))
}

export const FilePreviewPanel: Component<FilePreviewPanelProps> = (props) => {
	const active = (): PreviewTab | undefined => props.tabs().find((t) => t.path === props.activePath())

	// 拖动调整宽度
	let isDragging = false
	const onDragStart = (e: MouseEvent): void => {
		e.preventDefault()
		isDragging = true
		const startX = e.clientX
		const startW = props.width()
		const onMove = (ev: MouseEvent): void => {
			if (!isDragging) return
			const dx = startX - ev.clientX
			const next = Math.max(320, Math.min(1200, startW + dx))
			props.setWidth(next)
		}
		const onUp = (): void => {
			isDragging = false
			window.removeEventListener('mousemove', onMove)
			window.removeEventListener('mouseup', onUp)
		}
		window.addEventListener('mousemove', onMove)
		window.addEventListener('mouseup', onUp)
	}

	const handleClearAll = (): void => {
		if (props.clearAllTabs) {
			props.clearAllTabs()
		} else {
			props.setTabs(() => [])
		}
	}

	return (
		<div class="preview-panel" style={{ width: `${props.width()}px` }}>
			<div class="preview-panel-resizer" onMouseDown={onDragStart} />

			{/* 标签栏 — 支持拖拽重排（P2-18） */}
			<div class="preview-tabs">
				<For each={props.tabs()}>
					{(tab, idx) => (
						<div
							class="preview-tab"
							classList={{ active: tab.path === props.activePath() }}
							onClick={() => props.setActivePath(tab.path)}
							title={tab.path}
							draggable={true}
							onDragStart={(e) => {
								e.dataTransfer?.setData('text/x-tab-idx', String(idx()))
								e.dataTransfer!.effectAllowed = 'move'
								;(e.currentTarget as HTMLElement).classList.add('dragging')
							}}
							onDragEnd={(e) => {
								;(e.currentTarget as HTMLElement).classList.remove('dragging')
								document.querySelectorAll('.preview-tab.drag-over').forEach((el) => el.classList.remove('drag-over'))
							}}
							onDragOver={(e) => {
								e.preventDefault()
								e.dataTransfer!.dropEffect = 'move'
								;(e.currentTarget as HTMLElement).classList.add('drag-over')
							}}
							onDragLeave={(e) => {
								;(e.currentTarget as HTMLElement).classList.remove('drag-over')
							}}
							onDrop={(e) => {
								e.preventDefault()
								;(e.currentTarget as HTMLElement).classList.remove('drag-over')
								const from = Number(e.dataTransfer?.getData('text/x-tab-idx'))
								const to = idx()
								if (Number.isNaN(from) || from === to) return
								props.setTabs((prev) => {
									const next = [...prev]
									const [moved] = next.splice(from, 1)
									next.splice(to, 0, moved)
									return next
								})
							}}
						>
							<Show when={tab.changed}>
								<span class={`preview-tab-badge badge-${tab.changed}`}>
									{tab.changed === 'created' ? 'A' : tab.changed === 'deleted' ? 'D' : 'M'}
								</span>
							</Show>
							<span class="preview-tab-title">{tab.title}</span>
							<button
								class="preview-tab-close"
								onClick={(e) => { e.stopPropagation(); props.closeTab(tab.path) }}
								title="关闭"
							>
								<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
									<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
								</svg>
							</button>
						</div>
					)}
				</For>
				<div class="preview-tabs-spacer" />
				<button
					class="icon-btn preview-close-all"
					title="关闭所有标签"
					onClick={handleClearAll}
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>

			{/* 活动标签工具栏 */}
			<Show when={active()}>
				{(a) => (
					<div class="preview-toolbar">
						<div class="preview-toolbar-path" title={a().path}>{a().path}</div>
						<div class="preview-toolbar-actions">
							{/* Markdown: 源码 / 预览 切换 */}
							<Show when={a().kind === 'markdown'}>
								<div class="preview-segmented">
									<button
										classList={{ active: a().viewMode === 'rendered' }}
										onClick={() => props.setTabViewMode(a().path, 'rendered')}
									>预览</button>
									<button
										classList={{ active: a().viewMode === 'source' }}
										onClick={() => props.setTabViewMode(a().path, 'source')}
									>源码</button>
								</div>
							</Show>
							{/* 变更文件：源码 / Diff 切换 */}
							<Show when={a().changed && a().kind !== 'image' && a().kind !== 'binary'}>
								<div class="preview-segmented">
									<button
										classList={{ active: a().viewMode === 'diff' }}
										onClick={() => props.setTabViewMode(a().path, 'diff')}
									>Diff</button>
									<button
										classList={{ active: a().viewMode === 'source' }}
										onClick={() => props.setTabViewMode(a().path, 'source')}
									>源码</button>
								</div>
							</Show>
							{/* Diff 视图子模式：Unified / Split */}
							<Show when={a().viewMode === 'diff' && a().changed}>
								<div class="preview-segmented">
									<button
										classList={{ active: props.diffViewMode() === 'unified' }}
										onClick={() => props.setDiffViewMode('unified')}
										title="单栏统一视图"
									>Unified</button>
									<button
										classList={{ active: props.diffViewMode() === 'split' }}
										onClick={() => props.setDiffViewMode('split')}
										title="左右分栏对照"
									>Split</button>
								</div>
							</Show>
							{/* 外部编辑器 */}
							<button
								class="icon-btn"
								title="在编辑器中打开"
								onClick={() => props.openInEditor(a().path)}
							>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
									<polyline points="15 3 21 3 21 9" />
									<line x1="10" y1="14" x2="21" y2="3" />
								</svg>
							</button>
							{/* 撤销（仅变更文件） */}
							<Show when={a().changed && a().changed !== 'deleted'}>
								<button
									class="approval-btn allow"
									style="font-size:11px;padding:3px 10px"
									onClick={() => props.revertFile(a().path)}
								>↩ 撤销</button>
							</Show>
						</div>
					</div>
				)}
			</Show>

			{/* 外部变更提示（P0-4） */}
			<Show when={active()?.extChangedAt}>
				<div class="preview-extchange-banner">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
						<line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
					</svg>
					<span style="flex:1">该文件已被外部修改（本面板内容可能已过期）</span>
					<button onClick={() => { const p = props.activePath(); if (p) void props.reloadPreview(p) }}>重新加载</button>
					<button onClick={() => {
						const p = props.activePath()
						if (!p) return
						props.setTabs((prev) => prev.map((t) => t.path === p ? { ...t, extChangedAt: undefined } : t))
					}}>忽略</button>
				</div>
			</Show>

			{/* 内容区 */}
			<div class="preview-body">
				<Show when={active()} keyed fallback={
					<div class="preview-empty">
						<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
							<polyline points="14 2 14 8 20 8" />
						</svg>
						<div>未选择文件</div>
					</div>
				}>
					{(tab) => {
						if (tab.loading) return <div class="preview-loading">加载中…</div>
						if (tab.error && !tab.content) {
							return <div class="preview-error">{tab.error}</div>
						}

						// 二进制
						if (tab.kind === 'binary') {
							return (
								<div class="preview-binary">
									<div class="preview-binary-title">{tab.title}</div>
									<div class="preview-binary-desc">
										二进制文件（{(tab.size / 1024).toFixed(1)} KB · {tab.mimeType}）
									</div>
								</div>
							)
						}

						// 图片
						if (tab.kind === 'image') {
							const src = `data:${tab.mimeType};base64,${tab.content}`
							return (
								<div class="preview-image-wrap">
									<img class="preview-image" src={src} alt={tab.path} />
									<div class="preview-image-info">
										{tab.mimeType} · {(tab.size / 1024).toFixed(1)} KB
									</div>
								</div>
							)
						}

						// 音频
						if (tab.kind === 'audio') {
							const src = `data:${tab.mimeType};base64,${tab.content}`
							return (
								<div class="preview-media-wrap">
									<audio src={src} controls style="width:100%" />
								</div>
							)
						}

						// 视频
						if (tab.kind === 'video') {
							const src = `data:${tab.mimeType};base64,${tab.content}`
							return (
								<div class="preview-media-wrap">
									<video src={src} controls style="max-width:100%;max-height:80vh" />
								</div>
							)
						}

						// Diff 视图（K10f：抽到 @maxian/ui 的 SharedDiffViewer）
						if (tab.viewMode === 'diff') {
							if (tab.diffLoading) return <div class="preview-loading">加载 diff…</div>
							if (tab.diffOriginal === undefined) return <div class="preview-loading">加载 diff…</div>
							return (
								<SharedDiffViewer
									original={tab.diffOriginal}
									current={tab.diffCurrent ?? ''}
									viewMode={props.diffViewMode()}
									contextLines={3}
									maxLines={800}
								/>
							)
						}

						// Markdown 渲染模式（使用应用统一的 renderMarkdown，带 DOMPurify 清洗）
						if (tab.kind === 'markdown' && tab.viewMode === 'rendered') {
							const html = props.renderMarkdown(tab.content)
							return (
								<div class="preview-markdown-rendered markdown-body" innerHTML={html} />
							)
						}

						// 文本源码（含 markdown 源码）
						const lang = hljsLangFromPath(tab.path)
						let highlighted: string
						try {
							highlighted = lang
								? hljs.highlight(tab.content, { language: lang, ignoreIllegals: true }).value
								: hljs.highlightAuto(tab.content).value
						} catch {
							highlighted = escapeHtml(tab.content)
						}
						const lineCount = tab.content.split('\n').length
						const lineNums = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')
						return (
							<div class="preview-code-wrap">
								<pre class="preview-code-lineno">{lineNums}</pre>
								<pre class="preview-code"><code class="hljs" innerHTML={highlighted} /></pre>
							</div>
						)
					}}
				</Show>
			</div>
		</div>
	)
}
