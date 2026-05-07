/*---------------------------------------------------------------------------------------------
 *  SubagentDashboard — 子代理任务编排面板（B1 UI）
 *
 *  右侧 dock 面板，按父代理 sessionId 分组展示所有子代理的实时状态：
 *    - 顶部：任务总数 + status 过滤（all / running / completed / failed / cancelled）
 *    - 列表：按 parentSessionId 分组的子代理卡片
 *    - 每张卡：subagentType / description / status badge / 时间 / 隔离 / 操作（取消 / 跳转）
 *    - 实时更新：通过 SSE task-update 事件刷新
 *
 *  交互：
 *    - 点 status badge 区域可展开查看 output / error 详情
 *    - 点"打开"跳转到 subagent session（host 处理路由）
 *    - 点"取消"对 running/queued 任务发 cancel
 *
 *  纯渲染：state + actions 全部由 host 注入。
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal, createMemo } from 'solid-js'
import type { Component } from 'solid-js'
import type { SubagentRecord, SubagentStatus } from '@maxian/sdk'

const STATUS_LABELS: Record<SubagentStatus, { label: string; color: string }> = {
	queued:    { label: '排队中',  color: '#9ca3af' },
	running:   { label: '运行中',  color: '#3b82f6' },
	completed: { label: '已完成',  color: '#22c55e' },
	failed:    { label: '失败',    color: '#ef4444' },
	cancelled: { label: '已取消',  color: '#6b7280' },
}

const STATUS_FILTERS: ({ value: SubagentStatus | 'all'; label: string })[] = [
	{ value: 'all',       label: '全部' },
	{ value: 'running',   label: '运行中' },
	{ value: 'completed', label: '已完成' },
	{ value: 'failed',    label: '失败' },
	{ value: 'cancelled', label: '已取消' },
]

function formatTime(ts: number): string {
	const diff = Date.now() - ts
	const sec = Math.floor(diff / 1000)
	if (sec < 60)  return `${sec}s 前`
	const min = Math.floor(sec / 60)
	if (min < 60)  return `${min}m 前`
	return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(start?: number, end?: number): string {
	if (!start) return '—'
	const e = end ?? Date.now()
	const sec = Math.floor((e - start) / 1000)
	if (sec < 60)   return `${sec}s`
	const min = Math.floor(sec / 60)
	const remSec = sec % 60
	if (min < 60)   return `${min}m${remSec > 0 ? ` ${remSec}s` : ''}`
	const hr = Math.floor(min / 60)
	return `${hr}h ${min % 60}m`
}

function shortSessionId(sid: string): string {
	return sid.length > 12 ? sid.slice(0, 8) : sid
}

export interface SubagentDashboardProps {
	visible:        () => boolean
	records:        () => SubagentRecord[]
	loading:        () => boolean
	statusFilter:   () => SubagentStatus | 'all'
	setStatusFilter:(s: SubagentStatus | 'all') => void
	/** 当前活动 session（用于在 grouping 里高亮） */
	activeSessionId: () => string | null | undefined
	/** session id → 显示名（host 提供，从 sessions 列表查） */
	sessionTitle:   (sessionId: string) => string
	onClose:        () => void
	onRefresh:      () => void | Promise<void>
	onCancel:       (taskId: string) => void | Promise<void>
	/** 跳转到子代理 session 完整对话（host 切换 activeSessionId） */
	onOpenSession:  (sessionId: string) => void
}

export const SubagentDashboard: Component<SubagentDashboardProps> = (props) => {
	const [expandedTask, setExpandedTask] = createSignal<string | null>(null)

	// 按 parentSessionId 分组（按时间倒序，最近开的父代理在最上面）
	const grouped = createMemo(() => {
		const filter = props.statusFilter()
		const list = filter === 'all'
			? props.records()
			: props.records().filter(r => r.status === filter)
		const map = new Map<string, SubagentRecord[]>()
		for (const r of list) {
			const arr = map.get(r.parentSessionId) ?? []
			arr.push(r)
			map.set(r.parentSessionId, arr)
		}
		// 按 parent 内最近创建的子代理时间排序父分组
		const groups = Array.from(map.entries()).map(([parent, items]) => ({
			parent,
			items: items.sort((a, b) => b.createdAt - a.createdAt),
			latest: Math.max(...items.map(i => i.createdAt)),
		}))
		groups.sort((a, b) => b.latest - a.latest)
		return groups
	})

	const counts = createMemo(() => {
		const c: Record<SubagentStatus | 'all', number> = {
			all: props.records().length,
			queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
		}
		for (const r of props.records()) c[r.status]++
		return c
	})

	const toggleExpand = (taskId: string) => {
		setExpandedTask(t => t === taskId ? null : taskId)
	}

	return (
		<Show when={props.visible()}>
			<aside class="subagent-panel">
				<header class="subagent-panel-header">
					<div class="subagent-panel-title">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="4" r="2" />
							<circle cx="5" cy="20" r="2" />
							<circle cx="19" cy="20" r="2" />
							<path d="M12 6v3" />
							<path d="M12 9l-7 9" />
							<path d="M12 9l7 9" />
						</svg>
						<span>子代理任务</span>
						<Show when={counts().running > 0}>
							<span class="subagent-running-pulse">
								<span class="pulse-dot" />
								{counts().running}
							</span>
						</Show>
					</div>
					<div class="subagent-panel-actions">
						<button class="icon-btn" onClick={() => void props.onRefresh()} title="刷新">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
								classList={{ spinning: props.loading() }}>
								<polyline points="1 4 1 10 7 10" />
								<polyline points="23 20 23 14 17 14" />
								<path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
							</svg>
						</button>
						<button class="icon-btn" onClick={props.onClose} title="关闭面板">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>
				</header>

				<div class="subagent-status-filter">
					<For each={STATUS_FILTERS}>
						{(f) => (
							<button
								class="subagent-filter-btn"
								classList={{ active: props.statusFilter() === f.value }}
								onClick={() => props.setStatusFilter(f.value)}
							>
								{f.label}
								<Show when={counts()[f.value as SubagentStatus | 'all'] > 0}>
									<span class="subagent-filter-count">{counts()[f.value as SubagentStatus | 'all']}</span>
								</Show>
							</button>
						)}
					</For>
				</div>

				<div class="subagent-panel-body">
					<Show when={props.loading() && grouped().length === 0}>
						<div class="subagent-empty">
							<span class="spinner" style="width:14px;height:14px;border-width:1.5px" />
							<span>加载中…</span>
						</div>
					</Show>
					<Show when={!props.loading() && grouped().length === 0}>
						<div class="subagent-empty">
							<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:var(--text-faint)">
								<rect x="2" y="3" width="20" height="14" rx="2" />
								<line x1="8" y1="21" x2="16" y2="21" />
								<line x1="12" y1="17" x2="12" y2="21" />
							</svg>
							<div class="subagent-empty-title">暂无子代理任务</div>
							<div class="subagent-empty-sub">主代理调 task() 工具时会在这里看到所有派出的子代理</div>
						</div>
					</Show>

					<For each={grouped()}>
						{(group) => (
							<div class="subagent-group">
								<div class="subagent-group-header"
									classList={{ active: props.activeSessionId() === group.parent }}>
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
									</svg>
									<button
										class="subagent-parent-link"
										onClick={() => props.onOpenSession(group.parent)}
										title={`打开父代理 ${group.parent}`}
									>
										{props.sessionTitle(group.parent) || `会话 ${shortSessionId(group.parent)}`}
									</button>
									<span class="subagent-group-count">{group.items.length}</span>
								</div>
								<For each={group.items}>
									{(r) => (
										<div class="subagent-card" classList={{ expanded: expandedTask() === r.taskId, [`status-${r.status}`]: true }}>
											<div class="subagent-card-row" onClick={() => toggleExpand(r.taskId)}>
												<span
													class="subagent-status-dot"
													style={`background: ${STATUS_LABELS[r.status].color}`}
													classList={{ pulsing: r.status === 'running' }}
												/>
												<div class="subagent-card-main">
													<div class="subagent-card-title">
														<span class="subagent-type">{r.subagentType}</span>
														<Show when={r.background}>
															<span class="subagent-bg-tag" title="后台模式">⚡bg</span>
														</Show>
														<Show when={r.isolation === 'worktree'}>
															<span class="subagent-iso-tag" title={`独立 worktree: ${r.worktreeBranch ?? r.worktreePath ?? ''}`}>
																🌿 {r.worktreeBranch?.replace('claude/', '') ?? 'worktree'}
															</span>
														</Show>
													</div>
													<Show when={r.description}>
														<div class="subagent-desc">{r.description}</div>
													</Show>
													<div class="subagent-meta">
														<span class="subagent-status-text" style={`color: ${STATUS_LABELS[r.status].color}`}>
															{STATUS_LABELS[r.status].label}
														</span>
														<span class="subagent-time">{formatTime(r.createdAt)}</span>
														<span class="subagent-duration">⏱ {formatDuration(r.startedAt, r.finishedAt)}</span>
													</div>
												</div>
												<div class="subagent-card-actions" onClick={(e) => e.stopPropagation()}>
													<Show when={r.status === 'running' || r.status === 'queued'}>
														<button
															class="subagent-cancel-btn"
															onClick={() => void props.onCancel(r.taskId)}
															title="取消该子代理"
														>
															<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
																<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
															</svg>
														</button>
													</Show>
													<button
														class="subagent-open-btn"
														onClick={() => props.onOpenSession(r.subagentSessionId)}
														title="打开子代理完整 session"
													>
														<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
															<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
															<polyline points="15 3 21 3 21 9" />
															<line x1="10" y1="14" x2="21" y2="3" />
														</svg>
													</button>
												</div>
											</div>
											<Show when={expandedTask() === r.taskId}>
												<div class="subagent-card-detail">
													<div class="subagent-detail-row">
														<span class="subagent-detail-label">Task ID</span>
														<code class="subagent-detail-val">{r.taskId}</code>
													</div>
													<div class="subagent-detail-row">
														<span class="subagent-detail-label">Session</span>
														<code class="subagent-detail-val">{r.subagentSessionId}</code>
													</div>
													<Show when={r.worktreePath}>
														<div class="subagent-detail-row">
															<span class="subagent-detail-label">Worktree</span>
															<code class="subagent-detail-val">{r.worktreePath}</code>
														</div>
													</Show>
													<Show when={r.error}>
														<div class="subagent-detail-error">
															<div class="subagent-detail-label" style="color:#ef4444">错误</div>
															<pre class="subagent-error-msg">{r.error}</pre>
														</div>
													</Show>
													<Show when={r.output}>
														<div class="subagent-detail-output">
															<div class="subagent-detail-label">输出摘要</div>
															<pre class="subagent-output-text">{r.output}</pre>
														</div>
													</Show>
												</div>
											</Show>
										</div>
									)}
								</For>
							</div>
						)}
					</For>
				</div>
			</aside>
		</Show>
	)
}
