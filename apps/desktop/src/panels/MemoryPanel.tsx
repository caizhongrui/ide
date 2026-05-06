/*---------------------------------------------------------------------------------------------
 *  MemoryPanel — AI 跨会话记忆管理面板（B3 UI）
 *
 *  右侧 dock 面板，列出所有记忆 + scope/category 过滤 + 编辑/删除/⭐/搜索功能。
 *  纯渲染：所有数据 + 操作回调由 host 注入。
 *
 *  布局：
 *    顶部：标题 + scope 切换（global / workspace / session / 全部）+ 关闭
 *    搜索栏：query 输入 + 触发 search（不在 query 时退化为 list）
 *    分类过滤：preference / convention / fact / style / tech-stack / other
 *    列表：每条记忆 卡片（content + 元数据 + 编辑/删除/⭐ 按钮）
 *    底部：手动添加按钮 + 清空按钮（带 scope 提示，starred 不会被清）
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal } from 'solid-js'
import type { Component } from 'solid-js'
import type { MemoryRecord, MemoryScope, MemoryCategory } from '@maxian/sdk'

const ALL_SCOPES: ({ value: MemoryScope | 'all'; label: string })[] = [
	{ value: 'all',       label: '全部' },
	{ value: 'global',    label: '全局' },
	{ value: 'workspace', label: '工作区' },
	{ value: 'session',   label: '会话' },
]

const ALL_CATEGORIES: ({ value: MemoryCategory | 'all'; label: string; color: string })[] = [
	{ value: 'all',         label: '全部',   color: '#6b7280' },
	{ value: 'preference',  label: '偏好',   color: '#a78bfa' },
	{ value: 'convention',  label: '约定',   color: '#22d3ee' },
	{ value: 'fact',        label: '事实',   color: '#fbbf24' },
	{ value: 'style',       label: '风格',   color: '#f472b6' },
	{ value: 'tech-stack',  label: '技术栈', color: '#34d399' },
	{ value: 'other',       label: '其他',   color: '#9ca3af' },
]

export interface MemoryPanelProps {
	visible:           () => boolean
	records:           () => MemoryRecord[]
	loading:           () => boolean
	scopeFilter:       () => MemoryScope | 'all'
	setScopeFilter:    (s: MemoryScope | 'all') => void
	categoryFilter:    () => MemoryCategory | 'all'
	setCategoryFilter: (c: MemoryCategory | 'all') => void
	searchQuery:       () => string
	setSearchQuery:    (q: string) => void
	onClose:           () => void
	onRefresh:         () => void | Promise<void>
	/** 触发语义搜索（query 非空时调，否则 host 应转回 list） */
	onSearch:          (q: string) => void | Promise<void>
	onToggleStarred:   (id: string, starred: boolean) => void | Promise<void>
	onEdit:            (id: string, content: string, category: MemoryCategory) => void | Promise<void>
	onDelete:          (id: string) => void | Promise<void>
	onCreate:          (input: { scope: MemoryScope; category: MemoryCategory; content: string }) => void | Promise<void>
	onClear:           (scope: MemoryScope | 'all') => void | Promise<void>
}

function categoryMeta(c: MemoryCategory) {
	return ALL_CATEGORIES.find(x => x.value === c) ?? ALL_CATEGORIES[ALL_CATEGORIES.length - 1]
}

function scopeLabel(s: MemoryScope) {
	return ALL_SCOPES.find(x => x.value === s)?.label ?? s
}

function formatTime(ts: number): string {
	const diff = Date.now() - ts
	const min = Math.floor(diff / 60_000)
	if (min < 1)   return '刚刚'
	if (min < 60)  return `${min} 分钟前`
	const hr = Math.floor(min / 60)
	if (hr < 24)   return `${hr} 小时前`
	const day = Math.floor(hr / 24)
	if (day < 30)  return `${day} 天前`
	return new Date(ts).toLocaleDateString('zh-CN')
}

export const MemoryPanel: Component<MemoryPanelProps> = (props) => {
	const [editingId, setEditingId] = createSignal<string | null>(null)
	const [editContent, setEditContent] = createSignal('')
	const [editCategory, setEditCategory] = createSignal<MemoryCategory>('preference')
	const [showCreate, setShowCreate] = createSignal(false)
	const [createContent, setCreateContent] = createSignal('')
	const [createScope, setCreateScope] = createSignal<MemoryScope>('global')
	const [createCategory, setCreateCategory] = createSignal<MemoryCategory>('preference')

	const filtered = () => {
		const cat = props.categoryFilter()
		const list = props.records()
		if (cat === 'all') return list
		return list.filter(r => r.category === cat)
	}

	const startEdit = (r: MemoryRecord) => {
		setEditingId(r.id)
		setEditContent(r.content)
		setEditCategory(r.category)
	}
	const cancelEdit = () => {
		setEditingId(null)
		setEditContent('')
	}
	const submitEdit = async () => {
		const id = editingId()
		if (!id) return
		const c = editContent().trim()
		if (!c) { cancelEdit(); return }
		await props.onEdit(id, c, editCategory())
		cancelEdit()
	}

	const submitCreate = async () => {
		const c = createContent().trim()
		if (!c) return
		await props.onCreate({
			scope:    createScope(),
			category: createCategory(),
			content:  c,
		})
		setShowCreate(false)
		setCreateContent('')
	}

	const onClearClick = async () => {
		const sc = props.scopeFilter()
		const label = sc === 'all' ? '所有 scope' : scopeLabel(sc as MemoryScope)
		if (!window.confirm(`清空 ${label} 范围内的记忆（标星记忆不会被删除）？`)) return
		await props.onClear(sc)
	}

	return (
		<Show when={props.visible()}>
			<aside class="memory-panel">
				<header class="memory-panel-header">
					<div class="memory-panel-title">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M9 12l2 2 4-4" />
							<path d="M21 12c.552 0 1.005-.45.95-1A10 10 0 0 0 12 2c-5.523 0-10 4.477-10 10 0 5.523 4.477 10 10 10a10 10 0 0 0 9-5.95c.05-.55-.398-1-.95-1z" />
						</svg>
						<span>AI 记忆</span>
						<span class="memory-count">{props.records().length}</span>
					</div>
					<button class="icon-btn" onClick={props.onClose} title="关闭面板">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</header>

				<div class="memory-panel-toolbar">
					<div class="memory-scope-tabs">
						<For each={ALL_SCOPES}>
							{(s) => (
								<button
									class="memory-scope-tab"
									classList={{ active: props.scopeFilter() === s.value }}
									onClick={() => props.setScopeFilter(s.value)}
								>
									{s.label}
								</button>
							)}
						</For>
					</div>
				</div>

				<div class="memory-search-bar">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						class="memory-search-input"
						placeholder="语义搜索记忆…（空 = 列出全部）"
						value={props.searchQuery()}
						onInput={(e) => props.setSearchQuery(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								void props.onSearch(props.searchQuery())
							} else if (e.key === 'Escape') {
								props.setSearchQuery('')
								void props.onRefresh()
							}
						}}
					/>
					<Show when={props.searchQuery()}>
						<button
							class="memory-search-clear"
							onClick={() => { props.setSearchQuery(''); void props.onRefresh() }}
							title="清空搜索 (Esc)"
						>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</Show>
				</div>

				<div class="memory-category-filter">
					<For each={ALL_CATEGORIES}>
						{(cat) => (
							<button
								class="memory-cat-chip"
								classList={{ active: props.categoryFilter() === cat.value }}
								style={`--cat-color: ${cat.color}`}
								onClick={() => props.setCategoryFilter(cat.value)}
							>
								{cat.label}
							</button>
						)}
					</For>
				</div>

				<div class="memory-panel-body">
					<Show when={props.loading()}>
						<div class="memory-empty">
							<span class="spinner" style="width:14px;height:14px;border-width:1.5px" />
							<span>加载中…</span>
						</div>
					</Show>
					<Show when={!props.loading() && filtered().length === 0}>
						<div class="memory-empty">
							<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:var(--text-faint)">
								<circle cx="12" cy="12" r="10" />
								<path d="M9 12l2 2 4-4" />
							</svg>
							<div class="memory-empty-title">尚无记忆</div>
							<div class="memory-empty-sub">AI 在对话中会自动捕获你的偏好和约定，也可手动添加。</div>
						</div>
					</Show>
					<For each={filtered()}>
						{(r) => (
							<Show
								when={editingId() === r.id}
								fallback={
									<div class="memory-card" classList={{ starred: r.starred }}>
										<div class="memory-card-meta">
											<span class="memory-cat-badge" style={`background: ${categoryMeta(r.category).color}20; color: ${categoryMeta(r.category).color}`}>
												{categoryMeta(r.category).label}
											</span>
											<span class="memory-scope-badge">{scopeLabel(r.scope)}</span>
											<span class="memory-source-badge" classList={{ auto: r.source === 'auto' }}>
												{r.source === 'auto' ? '🤖 自动' : '✋ 手动'}
											</span>
											<span class="memory-time">{formatTime(r.createdAt)}</span>
											<Show when={r.accessCount > 0}>
												<span class="memory-access-count" title={`最近召回：${formatTime(r.lastAccessedAt)}`}>
													召回 {r.accessCount} 次
												</span>
											</Show>
										</div>
										<div class="memory-card-content">{r.content}</div>
										<div class="memory-card-actions">
											<button
												class="memory-action-btn"
												classList={{ active: r.starred }}
												onClick={() => void props.onToggleStarred(r.id, !r.starred)}
												title={r.starred ? '取消标星' : '标星（永久保留）'}
											>
												<svg width="12" height="12" viewBox="0 0 24 24" fill={r.starred ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2">
													<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
												</svg>
											</button>
											<button class="memory-action-btn" onClick={() => startEdit(r)} title="编辑">
												<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
													<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
													<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
												</svg>
											</button>
											<button
												class="memory-action-btn danger"
												onClick={async () => {
													if (window.confirm('确定删除这条记忆？')) await props.onDelete(r.id)
												}}
												title="删除"
											>
												<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
													<polyline points="3 6 5 6 21 6" />
													<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
												</svg>
											</button>
										</div>
									</div>
								}
							>
								<div class="memory-card editing">
									<select
										class="memory-cat-select"
										value={editCategory()}
										onChange={(e) => setEditCategory(e.currentTarget.value as MemoryCategory)}
									>
										<For each={ALL_CATEGORIES.filter(c => c.value !== 'all')}>
											{(c) => <option value={c.value}>{c.label}</option>}
										</For>
									</select>
									<textarea
										class="memory-edit-textarea"
										value={editContent()}
										onInput={(e) => setEditContent(e.currentTarget.value)}
										autofocus
										rows="3"
									/>
									<div class="memory-card-actions">
										<button class="memory-action-btn primary" onClick={submitEdit}>保存</button>
										<button class="memory-action-btn" onClick={cancelEdit}>取消</button>
									</div>
								</div>
							</Show>
						)}
					</For>
				</div>

				<footer class="memory-panel-footer">
					<button class="memory-add-btn" onClick={() => setShowCreate(v => !v)}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
						</svg>
						{showCreate() ? '收起' : '添加记忆'}
					</button>
					<button class="memory-clear-btn" onClick={onClearClick}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="3 6 5 6 21 6" />
							<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
						</svg>
						清空（保留 ⭐）
					</button>
				</footer>

				<Show when={showCreate()}>
					<div class="memory-create-form">
						<div class="memory-create-row">
							<select
								class="memory-cat-select"
								value={createScope()}
								onChange={(e) => setCreateScope(e.currentTarget.value as MemoryScope)}
							>
								<For each={ALL_SCOPES.filter(s => s.value !== 'all')}>
									{(s) => <option value={s.value}>{s.label}</option>}
								</For>
							</select>
							<select
								class="memory-cat-select"
								value={createCategory()}
								onChange={(e) => setCreateCategory(e.currentTarget.value as MemoryCategory)}
							>
								<For each={ALL_CATEGORIES.filter(c => c.value !== 'all')}>
									{(c) => <option value={c.value}>{c.label}</option>}
								</For>
							</select>
						</div>
						<textarea
							class="memory-edit-textarea"
							placeholder="例如：用户偏好 2 空格缩进；项目用 Vue 3 组合式 API；…"
							value={createContent()}
							onInput={(e) => setCreateContent(e.currentTarget.value)}
							rows="3"
						/>
						<div class="memory-create-actions">
							<button class="memory-action-btn primary" onClick={submitCreate}>保存</button>
							<button
								class="memory-action-btn"
								onClick={() => { setShowCreate(false); setCreateContent('') }}
							>
								取消
							</button>
						</div>
					</div>
				</Show>
			</aside>
		</Show>
	)
}
