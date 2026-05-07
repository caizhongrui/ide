/*---------------------------------------------------------------------------------------------
 *  McpToolPanel — MCP 工具索引面板（B2 UI）
 *
 *  显示 MCP server 运行态 + 全部已索引工具 + 自然语言搜索：
 *    - Servers section：每个挂载的 server 显示连接状态 / 工具数 / 错误（折叠 + 一键展开看工具详情）
 *    - Tools 全列表：按 server 分组，可按 server / 工具名 过滤
 *    - 搜索：自然语言（向量召回 + 余弦相似度），结果按 score 排序
 *
 *  纯渲染：state + actions 全部由 host 注入。
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal, createMemo } from 'solid-js'
import type { Component } from 'solid-js'

export interface McpServerRuntime {
	name:           string
	isConnected:    boolean
	isConnecting:   boolean
	error?:         string
	toolCount:      number
	resourceCount?: number
}

export interface McpToolEntry {
	toolId:      string
	serverName:  string
	rawToolName: string
	description: string
	inputSchema?: unknown
}

export interface McpToolHit {
	toolId:      string
	serverName:  string
	rawToolName: string
	description: string
	score:       number
}

export type McpTab = 'servers' | 'tools' | 'search'

export interface McpToolPanelProps {
	visible:           () => boolean
	servers:           () => McpServerRuntime[]
	tools:             () => McpToolEntry[]
	loading:           () => boolean
	tab:               () => McpTab
	setTab:            (t: McpTab) => void
	searchQuery:       () => string
	setSearchQuery:    (q: string) => void
	searchHits:        () => McpToolHit[]
	searchLoading:     () => boolean
	toolFilter:        () => string
	setToolFilter:     (q: string) => void
	onClose:           () => void
	onRefresh:         () => void | Promise<void>
	onSearch:          (query: string) => void | Promise<void>
	/** 跳转到 settings → MCP 配置面板 */
	onOpenSettings:    () => void
}

const TABS: ({ value: McpTab; label: string })[] = [
	{ value: 'servers', label: 'Servers' },
	{ value: 'tools',   label: '工具' },
	{ value: 'search',  label: '搜索' },
]

/** server 状态徽章颜色 */
function serverStatusColor(s: McpServerRuntime): string {
	if (s.isConnecting) return '#fbbf24'
	if (s.error)        return '#ef4444'
	return s.isConnected ? '#22c55e' : '#9ca3af'
}
function serverStatusText(s: McpServerRuntime): string {
	if (s.isConnecting) return '连接中…'
	if (s.error)        return '错误'
	return s.isConnected ? '已连接' : '未连接'
}

export const McpToolPanel: Component<McpToolPanelProps> = (props) => {
	const [expandedServer, setExpandedServer] = createSignal<string | null>(null)
	const [showSchema, setShowSchema] = createSignal<string | null>(null)

	// Tools 按 server 分组（用于 'tools' tab）
	const toolsByServer = createMemo(() => {
		const filter = props.toolFilter().trim().toLowerCase()
		const byServer = new Map<string, McpToolEntry[]>()
		for (const t of props.tools()) {
			if (filter) {
				const hay = `${t.serverName} ${t.rawToolName} ${t.description}`.toLowerCase()
				if (!hay.includes(filter)) continue
			}
			const arr = byServer.get(t.serverName) ?? []
			arr.push(t)
			byServer.set(t.serverName, arr)
		}
		return Array.from(byServer.entries())
			.map(([server, items]) => ({
				server,
				items: items.sort((a, b) => a.rawToolName.localeCompare(b.rawToolName)),
			}))
			.sort((a, b) => a.server.localeCompare(b.server))
	})

	const totalConnected = () => props.servers().filter(s => s.isConnected).length
	const totalTools     = () => props.tools().length

	return (
		<Show when={props.visible()}>
			<aside class="mcp-panel">
				<header class="mcp-panel-header">
					<div class="mcp-panel-title">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M9 2v6" />
							<path d="M15 2v6" />
							<path d="M6 8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />
							<path d="M12 17v5" />
						</svg>
						<span>MCP 工具索引</span>
						<span class="mcp-count" title={`${totalConnected()} / ${props.servers().length} servers · ${totalTools()} tools`}>
							{totalConnected()}/{props.servers().length} · {totalTools()} 工具
						</span>
					</div>
					<div class="mcp-panel-actions">
						<button class="icon-btn" onClick={() => void props.onRefresh()} title="刷新">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
								classList={{ spinning: props.loading() }}>
								<polyline points="1 4 1 10 7 10" />
								<polyline points="23 20 23 14 17 14" />
								<path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
							</svg>
						</button>
						<button class="icon-btn" onClick={props.onOpenSettings} title="MCP 配置">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="12" cy="12" r="3" />
								<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
							</svg>
						</button>
						<button class="icon-btn" onClick={props.onClose} title="关闭面板">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>
				</header>

				<div class="mcp-tabs">
					<For each={TABS}>
						{(t) => (
							<button
								class="mcp-tab"
								classList={{ active: props.tab() === t.value }}
								onClick={() => props.setTab(t.value)}
							>
								{t.label}
							</button>
						)}
					</For>
				</div>

				<div class="mcp-panel-body">
					<Show when={props.servers().length === 0 && !props.loading()}>
						<div class="mcp-empty">
							<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:var(--text-faint)">
								<rect x="2" y="3" width="20" height="14" rx="2" />
							</svg>
							<div class="mcp-empty-title">尚未挂载 MCP server</div>
							<button class="mcp-config-btn" onClick={props.onOpenSettings}>
								去配置 MCP →
							</button>
						</div>
					</Show>

					{/* === Servers === */}
					<Show when={props.tab() === 'servers' && props.servers().length > 0}>
						<For each={props.servers()}>
							{(s) => (
								<div class="mcp-server-card">
									<div
										class="mcp-server-row"
										onClick={() => setExpandedServer(v => v === s.name ? null : s.name)}
									>
										<span
											class="mcp-status-dot"
											style={`background: ${serverStatusColor(s)}`}
											classList={{ pulsing: s.isConnecting }}
										/>
										<div class="mcp-server-main">
											<div class="mcp-server-name">{s.name}</div>
											<div class="mcp-server-meta">
												<span style={`color: ${serverStatusColor(s)}`}>{serverStatusText(s)}</span>
												<span>·</span>
												<span>{s.toolCount} 工具</span>
												<Show when={s.resourceCount}>
													<>
														<span>·</span>
														<span>{s.resourceCount} 资源</span>
													</>
												</Show>
											</div>
											<Show when={s.error}>
												<div class="mcp-server-error">{s.error}</div>
											</Show>
										</div>
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
											style={`opacity:.5;transform:rotate(${expandedServer() === s.name ? '180' : '0'}deg);transition:transform 150ms`}>
											<polyline points="6 9 12 15 18 9" />
										</svg>
									</div>
									<Show when={expandedServer() === s.name}>
										<div class="mcp-server-tools">
											<For each={props.tools().filter(t => t.serverName === s.name)}>
												{(t) => (
													<div class="mcp-tool-mini">
														<code class="mcp-tool-name">{t.rawToolName}</code>
														<span class="mcp-tool-desc">{t.description}</span>
													</div>
												)}
											</For>
										</div>
									</Show>
								</div>
							)}
						</For>
					</Show>

					{/* === Tools 全列表 === */}
					<Show when={props.tab() === 'tools'}>
						<Show when={props.tools().length > 8}>
							<div class="mcp-list-filter">
								<input
									class="mcp-list-filter-input"
									placeholder="过滤工具（server / 名称 / 描述）…"
									value={props.toolFilter()}
									onInput={(e) => props.setToolFilter(e.currentTarget.value)}
								/>
							</div>
						</Show>
						<For each={toolsByServer()}>
							{(group) => (
								<div class="mcp-tool-group">
									<div class="mcp-tool-group-header">
										<span class="mcp-tool-group-server">{group.server}</span>
										<span class="mcp-tool-group-count">{group.items.length}</span>
									</div>
									<For each={group.items}>
										{(t) => (
											<div class="mcp-tool-card">
												<div
													class="mcp-tool-card-row"
													onClick={() => setShowSchema(v => v === t.toolId ? null : t.toolId)}
												>
													<code class="mcp-tool-name">{t.rawToolName}</code>
													<span class="mcp-tool-desc">{t.description}</span>
												</div>
												<Show when={showSchema() === t.toolId && t.inputSchema}>
													<pre class="mcp-tool-schema">{JSON.stringify(t.inputSchema, null, 2)}</pre>
												</Show>
											</div>
										)}
									</For>
								</div>
							)}
						</For>
						<Show when={props.tools().length === 0 && !props.loading()}>
							<div class="mcp-empty-text" style="padding:14px">尚无已索引工具</div>
						</Show>
					</Show>

					{/* === Search === */}
					<Show when={props.tab() === 'search'}>
						<div class="mcp-search-box">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="11" cy="11" r="8" />
								<line x1="21" y1="21" x2="16.65" y2="16.65" />
							</svg>
							<input
								class="mcp-search-input"
								placeholder="自然语言搜工具（如 “截图” / “发邮件”）…"
								value={props.searchQuery()}
								onInput={(e) => props.setSearchQuery(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault()
										void props.onSearch(props.searchQuery())
									} else if (e.key === 'Escape') {
										props.setSearchQuery('')
									}
								}}
							/>
							<Show when={props.searchLoading()}>
								<span class="spinner" style="width:11px;height:11px;border-width:1.5px" />
							</Show>
						</div>
						<For each={props.searchHits()}>
							{(h) => (
								<div class="mcp-tool-card">
									<div class="mcp-tool-card-row">
										<code class="mcp-tool-name">{h.rawToolName}</code>
										<span class="mcp-tool-desc">{h.description}</span>
										<span class="mcp-hit-score">{(h.score * 100).toFixed(0)}%</span>
									</div>
									<div class="mcp-tool-from">来自 <code>{h.serverName}</code></div>
								</div>
							)}
						</For>
						<Show when={props.searchQuery() && !props.searchLoading() && props.searchHits().length === 0}>
							<div class="mcp-empty-text" style="padding:14px">无匹配（试试更具体的关键词）</div>
						</Show>
						<Show when={!props.searchQuery() && props.searchHits().length === 0}>
							<div class="mcp-empty-text" style="padding:14px">输入关键词回车 → 向量召回排序</div>
						</Show>
					</Show>
				</div>
			</aside>
		</Show>
	)
}
