/*---------------------------------------------------------------------------------------------
 *  SettingsMcp — MCP Servers 设置面板（B2 重写：HTTP/SSE 协议 + 同步 sidecar）
 *
 *  - 配置字段：name + url + headers + enabled + description
 *  - 持久化：localStorage 缓存 + sidecar SQLite（PUT /config/mcp）
 *  - 显示运行时状态：已连接 / 连接中 / 失败 + 工具数量
 *  - 保存按钮：批量同步到 sidecar，sidecar 重新连接所有 enabled 的 server 并重建工具索引
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal, onMount, createMemo } from 'solid-js'
import type { Component } from 'solid-js'

/** 与 server `/config/mcp` API + core McpServerConfig 对齐 */
export interface McpServer {
	id:          string  // 仅前端 list-key（sidecar 用 name 做唯一）
	name:        string
	url:         string
	headers:     Record<string, string>
	enabled:     boolean
	description: string
}

/** 服务器运行时状态（sidecar 返回） */
interface McpRuntime {
	name:         string
	isConnected:  boolean
	isConnecting: boolean
	error?:       string
	toolCount:    number
}

const MCP_CONFIG_KEY = 'maxian_mcp_servers'

function loadMcpServersLocal(): McpServer[] {
	try {
		const raw = localStorage.getItem(MCP_CONFIG_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw) as Partial<McpServer>[]
		return parsed.map(s => ({
			id:          s.id ?? Math.random().toString(36).slice(2),
			name:        s.name ?? '',
			url:         s.url ?? '',
			headers:     s.headers ?? {},
			enabled:     s.enabled !== false,
			description: s.description ?? '',
		})).filter(s => s.name && s.url)
	} catch {
		return []
	}
}

function saveMcpServersLocal(servers: McpServer[]): void {
	localStorage.setItem(MCP_CONFIG_KEY, JSON.stringify(servers))
}

/** 把 headers Record 转成可编辑文本（每行 KEY=VALUE） */
function headersToText(h: Record<string, string>): string {
	return Object.entries(h).map(([k, v]) => `${k}=${v}`).join('\n')
}

function parseHeadersText(text: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const line of text.split('\n')) {
		const idx = line.indexOf('=')
		if (idx > 0) {
			const k = line.slice(0, idx).trim()
			const v = line.slice(idx + 1).trim()
			if (k) out[k] = v
		}
	}
	return out
}

interface SettingsMcpProps {
	getClient?:  () => Promise<{
		getMcpConfig: () => Promise<{ configs: McpServer[]; runtime: McpRuntime[]; toolIndexSize: number }>
		setMcpConfig: (configs: Array<Omit<McpServer, 'id'>>) => Promise<{ ok: boolean; runtime: McpRuntime[] }>
	}>
	showToast?: (msg: { message: string; kind?: 'success' | 'error' | 'info' }) => void
}

export const SettingsMcp: Component<SettingsMcpProps> = (props) => {
	const [mcpServers, setMcpServers] = createSignal<McpServer[]>(loadMcpServersLocal())
	const [runtime, setRuntime] = createSignal<McpRuntime[]>([])
	const [toolIndexSize, setToolIndexSize] = createSignal(0)
	const [syncing, setSyncing] = createSignal(false)
	const [dirty, setDirty] = createSignal(false)
	const [lastSyncError, setLastSyncError] = createSignal('')

	// Add form
	const [showAddForm, setShowAddForm] = createSignal(false)
	const [newName, setNewName] = createSignal('')
	const [newUrl, setNewUrl] = createSignal('')
	const [newHeaders, setNewHeaders] = createSignal('')
	const [newDescription, setNewDescription] = createSignal('')

	// Edit form
	const [editingId, setEditingId] = createSignal<string | null>(null)
	const [editUrl, setEditUrl] = createSignal('')
	const [editHeaders, setEditHeaders] = createSignal('')
	const [editDescription, setEditDescription] = createSignal('')

	const runtimeByName = createMemo(() => {
		const map = new Map<string, McpRuntime>()
		for (const r of runtime()) map.set(r.name, r)
		return map
	})

	/** 启动时尝试从 sidecar 拉一份当前配置覆盖本地（sidecar 是真相源） */
	onMount(async () => {
		if (!props.getClient) return
		try {
			const c = await props.getClient()
			const { configs, runtime: rt, toolIndexSize: idx } = await c.getMcpConfig()
			// sidecar 配置覆盖本地（保留 localStorage 作 fallback；本地新增未保存的不会丢，因为这里是初始化时一次性同步）
			const list: McpServer[] = configs.map(c => ({
				id:          Math.random().toString(36).slice(2),
				name:        c.name,
				url:         c.url,
				headers:     c.headers ?? {},
				enabled:     c.enabled,
				description: c.description ?? '',
			}))
			setMcpServers(list)
			saveMcpServersLocal(list)
			setRuntime(rt)
			setToolIndexSize(idx)
			setDirty(false)
		} catch (e) {
			// sidecar 不可达 → 维持本地缓存
			console.warn('[SettingsMcp] 拉取 sidecar MCP 配置失败:', e)
		}
	})

	const refreshRuntime = async (): Promise<void> => {
		if (!props.getClient) return
		try {
			const c = await props.getClient()
			const { runtime: rt, toolIndexSize: idx } = await c.getMcpConfig()
			setRuntime(rt)
			setToolIndexSize(idx)
		} catch (e) {
			console.warn('[SettingsMcp] 刷新运行时状态失败:', e)
		}
	}

	const toggleServer = (id: string): void => {
		const updated = mcpServers().map((s) => s.id === id ? { ...s, enabled: !s.enabled } : s)
		setMcpServers(updated)
		saveMcpServersLocal(updated)
		setDirty(true)
	}

	const deleteServer = (id: string): void => {
		const updated = mcpServers().filter((s) => s.id !== id)
		setMcpServers(updated)
		saveMcpServersLocal(updated)
		setDirty(true)
	}

	const addServer = (): void => {
		const name = newName().trim()
		const url = newUrl().trim()
		if (!name || !url) return
		// 简单 URL 校验
		try { new URL(url) } catch {
			props.showToast?.({ message: 'URL 格式不合法', kind: 'error' })
			return
		}
		// 避免重名
		if (mcpServers().some(s => s.name === name)) {
			props.showToast?.({ message: `已存在同名 server "${name}"`, kind: 'error' })
			return
		}

		const server: McpServer = {
			id:          Math.random().toString(36).slice(2),
			name,
			url,
			headers:     parseHeadersText(newHeaders()),
			enabled:     true,
			description: newDescription().trim(),
		}
		const updated = [...mcpServers(), server]
		setMcpServers(updated)
		saveMcpServersLocal(updated)
		setNewName('')
		setNewUrl('')
		setNewHeaders('')
		setNewDescription('')
		setShowAddForm(false)
		setDirty(true)
	}

	const startEdit = (srv: McpServer): void => {
		setEditingId(srv.id)
		setEditUrl(srv.url)
		setEditHeaders(headersToText(srv.headers))
		setEditDescription(srv.description)
	}

	const cancelEdit = (): void => { setEditingId(null) }

	const commitEdit = (id: string): void => {
		const url = editUrl().trim()
		if (!url) return
		try { new URL(url) } catch {
			props.showToast?.({ message: 'URL 格式不合法', kind: 'error' })
			return
		}
		const updated = mcpServers().map(s => s.id === id ? {
			...s,
			url,
			headers:     parseHeadersText(editHeaders()),
			description: editDescription().trim(),
		} : s)
		setMcpServers(updated)
		saveMcpServersLocal(updated)
		setEditingId(null)
		setDirty(true)
	}

	/** 把当前列表全量同步到 sidecar；服务端会重连所有 enabled 的 server */
	const syncToSidecar = async (): Promise<void> => {
		if (!props.getClient) {
			props.showToast?.({ message: 'sidecar 未就绪', kind: 'error' })
			return
		}
		setSyncing(true)
		setLastSyncError('')
		try {
			const c = await props.getClient()
			const payload: Array<Omit<McpServer, 'id'>> = mcpServers().map(s => ({
				name:        s.name,
				url:         s.url,
				headers:     s.headers,
				enabled:     s.enabled,
				description: s.description,
			}))
			const res = await c.setMcpConfig(payload)
			setRuntime(res.runtime)
			setDirty(false)
			// 等几秒让 server 把工具索引建好再 refresh
			setTimeout(() => void refreshRuntime(), 1500)
			const enabled = mcpServers().filter(s => s.enabled).length
			const connected = res.runtime.filter(r => r.isConnected).length
			props.showToast?.({
				message: `MCP 配置已同步：${connected}/${enabled} 已连接`,
				kind:    connected === enabled ? 'success' : 'info',
			})
		} catch (e) {
			const msg = (e as Error).message
			setLastSyncError(msg)
			props.showToast?.({ message: `同步失败：${msg}`, kind: 'error' })
		} finally {
			setSyncing(false)
		}
	}

	return (
		<>
			<div class="settings-title">MCP Servers</div>
			<div class="settings-group">
				<div class="settings-group-title" style="display:flex;align-items:center;justify-content:space-between">
					<span>已配置的 MCP 服务器</span>
					<div style="display:flex;gap:6px;align-items:center">
						<Show when={dirty()}>
							<span style="font-size:11px;color:var(--accent)">未保存</span>
						</Show>
						<button
							class="btn btn-primary"
							style="font-size:11px"
							onClick={() => void syncToSidecar()}
							disabled={syncing() || !dirty()}
						>
							{syncing() ? '同步中…' : '保存到 sidecar'}
						</button>
						<button class="btn btn-ghost" style="font-size:11px" onClick={() => void refreshRuntime()} disabled={syncing()}>
							刷新状态
						</button>
						<button class="btn btn-ghost" style="font-size:11px" onClick={() => setShowAddForm((v) => !v)}>
							{showAddForm() ? '取消' : '+ 添加'}
						</button>
					</div>
				</div>
				<Show when={lastSyncError()}>
					<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#f87171;font-family:monospace">
						{lastSyncError()}
					</div>
				</Show>
				<div class="settings-card">
					<Show when={mcpServers().length === 0 && !showAddForm()}>
						<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">
							暂无 MCP 服务器配置<br />
							<span style="font-size:11px">MCP (Model Context Protocol) 让 AI 访问外部工具与数据源（HTTP/SSE）</span>
						</div>
					</Show>

					<For each={mcpServers()}>
						{(srv) => {
							const rt = (): McpRuntime | undefined => runtimeByName().get(srv.name)
							const statusColor = (): string => {
								const r = rt()
								if (!r) return 'var(--text-faint)'
								if (r.isConnected) return '#22c55e'
								if (r.isConnecting) return 'var(--accent)'
								if (r.error) return '#f87171'
								return 'var(--text-muted)'
							}
							const statusText = (): string => {
								const r = rt()
								if (!r) return '未同步'
								if (r.isConnected) return `已连接 · ${r.toolCount} 工具`
								if (r.isConnecting) return '连接中…'
								if (r.error) return `失败：${r.error.slice(0, 60)}`
								return '已禁用'
							}
							return (
								<div class="settings-row" style="align-items:flex-start;flex-direction:column;gap:8px">
									<Show when={editingId() === srv.id} fallback={
										<>
											<div style="display:flex;width:100%;align-items:flex-start;gap:8px">
												<div class="settings-row-label" style="flex:1;min-width:0">
													<div class="settings-row-name" style="display:flex;align-items:center;gap:8px">
														<span>{srv.name}</span>
														<span style={`font-size:10px;padding:1px 6px;border-radius:8px;background:${statusColor()}22;color:${statusColor()};white-space:nowrap`}>
															{statusText()}
														</span>
													</div>
													<div class="settings-row-desc" style="font-family:monospace;font-size:11px;word-break:break-all">
														{srv.url}
													</div>
													<Show when={srv.description}>
														<div style="font-size:11px;color:var(--text-faint);margin-top:2px">
															{srv.description}
														</div>
													</Show>
													<Show when={Object.keys(srv.headers).length > 0}>
														<div style="font-size:10px;color:var(--text-faint);margin-top:2px">
															headers: {Object.keys(srv.headers).join(', ')}
														</div>
													</Show>
												</div>
												<div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
													<button
														class="btn btn-ghost"
														style={`font-size:11px;${srv.enabled ? 'color:var(--accent)' : ''}`}
														onClick={() => toggleServer(srv.id)}
													>
														{srv.enabled ? '已启用' : '已禁用'}
													</button>
													<button class="btn btn-ghost" style="font-size:11px" onClick={() => startEdit(srv)}>
														编辑
													</button>
													<button
														class="btn btn-ghost"
														style="font-size:11px;color:var(--error)"
														onClick={() => deleteServer(srv.id)}
													>
														删除
													</button>
												</div>
											</div>
										</>
									}>
										<div style="width:100%;display:flex;flex-direction:column;gap:8px">
											<div style="font-size:12px;font-weight:600;color:var(--text-muted)">编辑 {srv.name}</div>
											<input
												class="settings-input"
												placeholder="https://mcp.example.com/sse"
												value={editUrl()}
												onInput={(e) => setEditUrl(e.currentTarget.value)}
											/>
											<textarea
												class="settings-input"
												style="height:50px;resize:vertical;font-family:monospace;font-size:11px"
												placeholder={'Authorization=Bearer xxx\nX-Custom=value'}
												value={editHeaders()}
												onInput={(e) => setEditHeaders(e.currentTarget.value)}
											/>
											<input
												class="settings-input"
												placeholder="（可选）描述：让 AI 大致了解这个 server 提供什么能力"
												value={editDescription()}
												onInput={(e) => setEditDescription(e.currentTarget.value)}
											/>
											<div style="display:flex;gap:6px;justify-content:flex-end">
												<button class="btn btn-ghost" style="font-size:11px" onClick={cancelEdit}>取消</button>
												<button class="btn btn-primary" style="font-size:11px" onClick={() => commitEdit(srv.id)}>
													保存
												</button>
											</div>
										</div>
									</Show>
								</div>
							)
						}}
					</For>

					<Show when={showAddForm()}>
						<div style="border-top:1px solid var(--border);padding-top:12px;margin-top:8px;display:flex;flex-direction:column;gap:10px">
							<div style="font-size:12px;font-weight:600;color:var(--text-muted)">添加 MCP 服务器</div>
							<div class="settings-row">
								<span class="settings-row-name" style="width:80px;flex-shrink:0">名称</span>
								<input
									class="settings-input"
									placeholder="figma / github / context7…"
									value={newName()}
									onInput={(e) => setNewName(e.currentTarget.value)}
								/>
							</div>
							<div class="settings-row">
								<span class="settings-row-name" style="width:80px;flex-shrink:0">URL</span>
								<input
									class="settings-input"
									placeholder="https://mcp.example.com/sse 或 https://api.example.com/mcp"
									value={newUrl()}
									onInput={(e) => setNewUrl(e.currentTarget.value)}
								/>
							</div>
							<div class="settings-row" style="align-items:flex-start">
								<span class="settings-row-name" style="width:80px;flex-shrink:0;padding-top:4px">Headers</span>
								<textarea
									class="settings-input"
									style="height:60px;resize:vertical;font-family:monospace;font-size:11px"
									placeholder={'Authorization=Bearer xxx\nX-Custom=value'}
									value={newHeaders()}
									onInput={(e) => setNewHeaders(e.currentTarget.value)}
								/>
							</div>
							<div class="settings-row">
								<span class="settings-row-name" style="width:80px;flex-shrink:0">描述</span>
								<input
									class="settings-input"
									placeholder="（可选）让 AI 知道这个 server 提供什么能力"
									value={newDescription()}
									onInput={(e) => setNewDescription(e.currentTarget.value)}
								/>
							</div>
							<div style="display:flex;justify-content:flex-end">
								<button
									class="btn btn-primary"
									style="font-size:12px"
									onClick={addServer}
									disabled={!newName().trim() || !newUrl().trim()}
								>
									添加
								</button>
							</div>
						</div>
					</Show>
				</div>
			</div>

			<Show when={runtime().length > 0}>
				<div class="settings-group">
					<div class="settings-group-title">运行时索引</div>
					<div class="settings-card">
						<div class="settings-row">
							<div class="settings-row-label">
								<div class="settings-row-name">已索引工具总数</div>
								<div class="settings-row-desc">来自所有已连接 server 的 MCP 工具元数据，可被 mcp_tool_search 召回</div>
							</div>
							<div style="font-size:14px;font-weight:600;color:var(--accent)">{toolIndexSize()}</div>
						</div>
					</div>
				</div>
			</Show>

			<div class="settings-group">
				<div class="settings-group-title">说明</div>
				<div class="settings-card">
					<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:6px">
						<div class="settings-row-desc" style="line-height:1.7">
							MCP (Model Context Protocol) 是 Anthropic 提供的标准协议，让 AI 与外部工具/数据源交互。
							当前使用 HTTP/SSE 传输（不支持 stdio）。<br />
							配置保存后会立即同步到 sidecar，sidecar 重新连接所有 enabled 的 server 并把它们的工具元数据加入索引。
							AI 默认通过懒加载元工具（mcp_tool_search/load）按需使用，
							不会让 50+ MCP 工具撑爆主对话 context。<br />
							<a href="https://modelcontextprotocol.io" target="_blank" style="color:var(--accent);text-decoration:none">了解更多 →</a>
						</div>
					</div>
				</div>
			</div>
		</>
	)
}
