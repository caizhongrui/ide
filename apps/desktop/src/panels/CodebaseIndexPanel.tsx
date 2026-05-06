/*---------------------------------------------------------------------------------------------
 *  CodebaseIndexPanel — 项目知识库面板（B4 UI）
 *
 *  右侧 dock 面板，展示当前工作区的代码库索引：
 *    - 顶部：上次刷新时间 + 文件 / API / 模块 计数 + 刷新按钮
 *    - tab 1: 架构总结（markdown 渲染）
 *    - tab 2: 关键模块（按 dirPath 列表）
 *    - tab 3: 依赖图（from → to 的高频引用对）
 *    - 底部：自然语言搜索 API（codebase_search）
 *
 *  纯渲染：所有数据/操作通过 props 注入。
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal } from 'solid-js'
import type { Component } from 'solid-js'
import type {
	CodebaseIndexSnapshot,
	CodebaseSearchHit,
} from '@maxian/sdk'

export type CodebaseTab = 'architecture' | 'modules' | 'deps' | 'search'

export interface CodebaseIndexPanelProps {
	visible:        () => boolean
	snapshot:       () => CodebaseIndexSnapshot | null
	loading:        () => boolean
	progress:       () => string
	tab:            () => CodebaseTab
	setTab:         (t: CodebaseTab) => void
	searchQuery:    () => string
	setSearchQuery: (q: string) => void
	searchHits:     () => CodebaseSearchHit[]
	searchLoading:  () => boolean
	onClose:        () => void
	/** 触发刷新；默认增量；强制全量传 false */
	onRefresh:      (incremental: boolean) => void | Promise<void>
	onSearch:       (query: string) => void | Promise<void>
	onOpenFile:     (filePath: string, line?: number) => void
	/** 渲染 markdown（host 注入，复用现有 marked + dompurify pipeline） */
	renderMarkdown: (md: string) => string
}

const TABS: ({ value: CodebaseTab; label: string })[] = [
	{ value: 'architecture', label: '架构' },
	{ value: 'modules',      label: '模块' },
	{ value: 'deps',         label: '依赖' },
	{ value: 'search',       label: '搜索' },
]

function formatTime(ts: number): string {
	const diff = Date.now() - ts
	const sec = Math.floor(diff / 1000)
	if (sec < 60)  return `${sec}s 前`
	const min = Math.floor(sec / 60)
	if (min < 60)  return `${min}m 前`
	const hr = Math.floor(min / 60)
	if (hr < 24)   return `${hr}h 前`
	return new Date(ts).toLocaleString('zh-CN')
}

function symbolKindIcon(kind: string): string {
	switch (kind) {
		case 'function': return 'ƒ'
		case 'method':   return 'M'
		case 'class':    return 'C'
		case 'interface': return 'I'
		case 'type':     return 'T'
		case 'const':    return 'k'
		case 'export':   return 'e'
		default:         return '?'
	}
}

export const CodebaseIndexPanel: Component<CodebaseIndexPanelProps> = (props) => {
	const [showFullArch, setShowFullArch] = createSignal(false)
	// deps 列表过滤 + 截断（避免几千条一次性渲染卡死 webview）
	const [depsFilter, setDepsFilter] = createSignal('')
	const [depsLimit, setDepsLimit] = createSignal(200)
	const filteredDeps = () => {
		const all = props.snapshot()?.deps ?? []
		const q = depsFilter().trim().toLowerCase()
		const filtered = q
			? all.filter(d =>
				d.from.toLowerCase().includes(q) ||
				d.to.toLowerCase().includes(q),
			)
			: all
		return filtered
	}
	const visibleDeps = () => filteredDeps().slice(0, depsLimit())
	// modules 也加过滤（少见但项目大时可能也有几十个）
	const [modulesFilter, setModulesFilter] = createSignal('')
	const filteredModules = () => {
		const all = props.snapshot()?.modules ?? []
		const q = modulesFilter().trim().toLowerCase()
		return q
			? all.filter(m =>
				m.dirPath.toLowerCase().includes(q) ||
				m.summary.toLowerCase().includes(q),
			)
			: all
	}

	const handleRefresh = async (full: boolean) => {
		await props.onRefresh(!full)   // incremental = !full
	}

	const onSearchKey = (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault()
			void props.onSearch(props.searchQuery())
		} else if (e.key === 'Escape') {
			props.setSearchQuery('')
		}
	}

	return (
		<Show when={props.visible()}>
			<aside class="codebase-panel">
				<header class="codebase-panel-header">
					<div class="codebase-panel-title">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="16 18 22 12 16 6" />
							<polyline points="8 6 2 12 8 18" />
						</svg>
						<span>项目知识库</span>
					</div>
					<button class="icon-btn" onClick={props.onClose} title="关闭面板">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</header>

				{/* Stats bar */}
				<div class="codebase-stats">
					<Show when={props.snapshot()} fallback={
						<div class="codebase-empty">
							<span class="codebase-empty-text">尚未建立索引</span>
							<button class="codebase-build-btn" onClick={() => handleRefresh(true)} disabled={props.loading()}>
								<Show when={props.loading()} fallback="立即构建">
									<span class="spinner" style="width:11px;height:11px;border-width:1.5px" />
									构建中…
								</Show>
							</button>
						</div>
					}>
						{(snap) => (
							<>
								<div class="codebase-stat">
									<span class="codebase-stat-num">{snap().fileCount}</span>
									<span class="codebase-stat-label">文件</span>
								</div>
								<div class="codebase-stat">
									<span class="codebase-stat-num">{snap().apiCount}</span>
									<span class="codebase-stat-label">API</span>
								</div>
								<div class="codebase-stat">
									<span class="codebase-stat-num">{snap().moduleCount}</span>
									<span class="codebase-stat-label">模块</span>
								</div>
								<div class="codebase-refresh">
									<span class="codebase-refresh-time" title={new Date(snap().lastIndexedAt).toLocaleString('zh-CN')}>
										{formatTime(snap().lastIndexedAt)}
									</span>
									<button
										class="icon-btn"
										onClick={() => handleRefresh(false)}
										disabled={props.loading()}
										title="增量刷新"
									>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
											classList={{ spinning: props.loading() }}>
											<polyline points="1 4 1 10 7 10" />
											<polyline points="23 20 23 14 17 14" />
											<path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
										</svg>
									</button>
									<button
										class="icon-btn codebase-rebuild-btn"
										onClick={() => handleRefresh(true)}
										disabled={props.loading()}
										title="全量重建（慢）"
									>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
											<polyline points="21 3 21 8 16 8" />
											<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
											<polyline points="3 21 3 16 8 16" />
										</svg>
									</button>
								</div>
							</>
						)}
					</Show>
				</div>

				{/* Progress bar (loading 时显示) */}
				<Show when={props.loading() && props.progress()}>
					<div class="codebase-progress">
						<span class="spinner" style="width:10px;height:10px;border-width:1.5px" />
						<span class="codebase-progress-msg">{props.progress()}</span>
					</div>
				</Show>

				{/* Tabs */}
				<Show when={props.snapshot()}>
					<div class="codebase-tabs">
						<For each={TABS}>
							{(t) => (
								<button
									class="codebase-tab"
									classList={{ active: props.tab() === t.value }}
									onClick={() => props.setTab(t.value)}
								>
									{t.label}
								</button>
							)}
						</For>
					</div>

					{/* Tab body */}
					<div class="codebase-panel-body">
						{/* === Architecture === */}
						<Show when={props.tab() === 'architecture'}>
							<Show
								when={props.snapshot()?.architecture}
								fallback={<div class="codebase-empty-text" style="padding:14px">暂无架构总结。点击右上角 ↻ 刷新生成。</div>}
							>
								{(arch) => {
									const full = arch()
									const isLong = full.length > 4000
									const shown = () => (showFullArch() || !isLong) ? full : full.slice(0, 4000)
									return (
										<div class="codebase-arch">
											<div class="codebase-arch-md" innerHTML={props.renderMarkdown(shown())} />
											<Show when={isLong}>
												<button
													class="codebase-arch-more"
													onClick={() => setShowFullArch(v => !v)}
												>
													{showFullArch() ? '收起' : `展开剩余 ${full.length - 4000} 字`}
												</button>
											</Show>
										</div>
									)
								}}
							</Show>
						</Show>

						{/* === Modules === */}
						<Show when={props.tab() === 'modules'}>
							<Show when={(props.snapshot()?.modules.length ?? 0) > 5}>
								<div class="codebase-list-filter">
									<input
										class="codebase-list-filter-input"
										placeholder="过滤模块（路径 / 摘要）…"
										value={modulesFilter()}
										onInput={(e) => setModulesFilter(e.currentTarget.value)}
									/>
									<span class="codebase-list-filter-count">
										{filteredModules().length} / {props.snapshot()?.modules.length}
									</span>
								</div>
							</Show>
							<For each={filteredModules()}>
								{(m) => (
									<div class="codebase-module">
										<div class="codebase-module-path">
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
												<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
											</svg>
											<code>{m.dirPath}</code>
										</div>
										<div class="codebase-module-summary">{m.summary}</div>
										<Show when={m.keyFiles.length > 0}>
											<div class="codebase-module-keyfiles">
												<For each={m.keyFiles}>
													{(f) => (
														<button
															class="codebase-keyfile-btn"
															onClick={() => props.onOpenFile(f)}
															title={`打开 ${f}`}
														>
															{f.split('/').pop()}
														</button>
													)}
												</For>
											</div>
										</Show>
									</div>
								)}
							</For>
							<Show when={(props.snapshot()?.modules.length ?? 0) === 0}>
								<div class="codebase-empty-text" style="padding:14px">尚未生成模块概要</div>
							</Show>
						</Show>

						{/* === Deps === */}
						<Show when={props.tab() === 'deps'}>
							<Show when={(props.snapshot()?.deps.length ?? 0) > 50}>
								<div class="codebase-list-filter">
									<input
										class="codebase-list-filter-input"
										placeholder="过滤依赖（from / to）…"
										value={depsFilter()}
										onInput={(e) => setDepsFilter(e.currentTarget.value)}
									/>
									<span class="codebase-list-filter-count">
										{visibleDeps().length} / {filteredDeps().length}
										<Show when={filteredDeps().length !== (props.snapshot()?.deps.length ?? 0)}>
											{` (共 ${props.snapshot()?.deps.length})`}
										</Show>
									</span>
								</div>
							</Show>
							<For each={visibleDeps()}>
								{(d) => (
									<div class="codebase-dep" title={`${d.from}\n→ ${d.to}\n（被引用 ${d.count} 次）`}>
										<code class="codebase-dep-from">{d.from}</code>
										<div class="codebase-dep-row2">
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:.6;flex-shrink:0">
												<line x1="5" y1="12" x2="19" y2="12" />
												<polyline points="12 5 19 12 12 19" />
											</svg>
											<code class="codebase-dep-to">{d.to}</code>
											<span class="codebase-dep-count">×{d.count}</span>
										</div>
									</div>
								)}
							</For>
							<Show when={visibleDeps().length < filteredDeps().length}>
								<button
									class="codebase-load-more"
									onClick={() => setDepsLimit(n => n + 200)}
								>
									加载更多（剩余 {filteredDeps().length - visibleDeps().length}）
								</button>
							</Show>
							<Show when={(props.snapshot()?.deps.length ?? 0) === 0}>
								<div class="codebase-empty-text" style="padding:14px">尚未分析依赖图</div>
							</Show>
						</Show>

						{/* === Search === */}
						<Show when={props.tab() === 'search'}>
							<div class="codebase-search-box">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<circle cx="11" cy="11" r="8" />
									<line x1="21" y1="21" x2="16.65" y2="16.65" />
								</svg>
								<input
									class="codebase-search-input"
									placeholder="自然语言搜索 API / 类 / 函数…"
									value={props.searchQuery()}
									onInput={(e) => props.setSearchQuery(e.currentTarget.value)}
									onKeyDown={onSearchKey}
								/>
								<Show when={props.searchLoading()}>
									<span class="spinner" style="width:11px;height:11px;border-width:1.5px" />
								</Show>
							</div>
							<For each={props.searchHits()}>
								{(hit) => (
									<button
										class="codebase-search-hit"
										onClick={() => props.onOpenFile(hit.entry.filePath, hit.entry.startLine)}
									>
										<div class="codebase-hit-row">
											<span class="codebase-symbol-kind" data-kind={hit.entry.symbolKind}>
												{symbolKindIcon(hit.entry.symbolKind)}
											</span>
											<span class="codebase-symbol-name">{hit.entry.symbolName}</span>
											<span class="codebase-hit-score">{(hit.score * 100).toFixed(0)}%</span>
										</div>
										<Show when={hit.entry.signature}>
											<code class="codebase-hit-sig">{hit.entry.signature}</code>
										</Show>
										<div class="codebase-hit-path">
											{hit.entry.filePath}:{hit.entry.startLine}
										</div>
										<Show when={hit.entry.docstring}>
											<div class="codebase-hit-doc">{hit.entry.docstring}</div>
										</Show>
									</button>
								)}
							</For>
							<Show when={props.searchQuery() && !props.searchLoading() && props.searchHits().length === 0}>
								<div class="codebase-empty-text" style="padding:14px">无匹配（试试更具体的关键词）</div>
							</Show>
							<Show when={!props.searchQuery() && props.searchHits().length === 0}>
								<div class="codebase-empty-text" style="padding:14px">输入关键词回车搜索</div>
							</Show>
						</Show>
					</div>
				</Show>
			</aside>
		</Show>
	)
}
