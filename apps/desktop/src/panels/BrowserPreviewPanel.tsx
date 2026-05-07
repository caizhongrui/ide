/*---------------------------------------------------------------------------------------------
 *  BrowserPreviewPanel — 内嵌浏览器预览面板（B5 UI）
 *
 *  右侧 dock 面板。功能：
 *    - URL bar：输入 URL 回车导航；back/forward/refresh
 *    - 内嵌 iframe 渲染 dev server / 任意网页（通过 sidecar 反向代理：/browser/proxy?url=...）
 *    - 三个 tab：Preview / Console / Network
 *    - Console：捕获 console.log/warn/error/info（inspector 注入）
 *    - Network：捕获 fetch / XHR（inspector 注入）
 *    - 截图按钮：抓 iframe DOM 渲染为 SVG（占位实现）
 *
 *  跨域处理（V2 演进）：
 *    iframe 不再直接 src=<目标 URL>；改为 src=<sidecar>/browser/proxy?url=<target>
 *    sidecar 反向代理上游响应：
 *      • 剥 X-Frame-Options / CSP frame-ancestors / COOP/COEP/CORP 等阻塞 iframe 的头
 *      • 在 HTML <head> 顶部注入 <base href="<upstream-origin>/"> 让相对 URL 仍走上游
 *      • 在同位置内联 inspector 脚本（console / fetch / XHR / cmd dispatcher）
 *    inspector 始终运行在 iframe origin 下（即 sidecar 这台），与 parent (Tauri webview) 跨域，
 *    全部用 postMessage 跨界通信，console / network / click / fill / eval 全部可用。
 *
 *  消息协议（与 iframe 注入脚本通信）：
 *    parent → iframe (postMessage):
 *      { type: 'maxian-cmd', cmdId, op: 'click'|'fill'|'eval'|'wait-for'|'screenshot', args }
 *    iframe → parent:
 *      { type: 'maxian-resp',     cmdId, ok, result?, error? }
 *      { type: 'maxian-console',  level, text, ts }
 *      { type: 'maxian-network',  method, url, status, durationMs, ts }
 *      { type: 'maxian-url-change', url, ts }    // pushState/replaceState/popstate/hashchange
 *      { type: 'maxian-injected', ts }            // 启动握手
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import type { Component } from 'solid-js'

export type BrowserTab = 'preview' | 'console' | 'network'

export interface BrowserConsoleEntry {
	level:     'log' | 'info' | 'warn' | 'error' | 'debug'
	text:      string
	timestamp: number
}

export interface BrowserNetworkEntry {
	method:     string
	url:        string
	status?:    number
	durationMs?:number
	timestamp:  number
}

export interface BrowserPreviewPanelProps {
	visible:           () => boolean
	onClose:           () => void
	/** 持久化用户上次打开的 URL（host 持有，跨开关保留）*/
	currentUrl:        () => string
	setCurrentUrl:     (url: string) => void
	/** 控制台日志（host 持有，便于 AI 工具调用拿数据）*/
	consoleLogs:       () => BrowserConsoleEntry[]
	pushConsoleLog:    (entry: BrowserConsoleEntry) => void
	clearConsoleLogs:  () => void
	/** 网络请求（同上）*/
	networkRequests:   () => BrowserNetworkEntry[]
	pushNetworkEntry:  (entry: BrowserNetworkEntry) => void
	clearNetworkEntries: () => void
	/** iframe ref setter — host 拿来给 AI 工具用（postMessage 命令 / 截图 / 等）*/
	setIframeRef:      (el: HTMLIFrameElement | null) => void
	/**
	 * 反向代理 URL 构造器：把目标 URL 包裹成 sidecar 的 /browser/proxy?url=...&auth=...
	 * 走 proxy 后 inspector 始终能注入，跨域 / X-Frame-Options 都不再阻塞。
	 */
	buildProxyUrl:     (target: string) => string
}

const COMMON_URLS = [
	'http://localhost:3000',
	'http://localhost:5173',
	'http://localhost:8080',
	'http://127.0.0.1:1420',
]

const LEVEL_COLOR: Record<BrowserConsoleEntry['level'], string> = {
	log:   '#9ca3af',
	info:  '#60a5fa',
	debug: '#a78bfa',
	warn:  '#fbbf24',
	error: '#ef4444',
}

function formatTime(ts: number): string {
	const d = new Date(ts)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// inspector 脚本由 sidecar /browser/proxy 内联到上游 HTML，前端不再需要手动注入。
// 见 packages/server/src/browserInspector.ts。

export const BrowserPreviewPanel: Component<BrowserPreviewPanelProps> = (props) => {
	let iframeRef: HTMLIFrameElement | undefined
	const [tab, setTab] = createSignal<BrowserTab>('preview')
	const [urlInput, setUrlInput] = createSignal(props.currentUrl())
	/** inspector 是否已经注入完成（收到 'maxian-injected' 握手）*/
	const [inspectorReady, setInspectorReady] = createSignal(false)
	/** proxy 加载错误信息（fetch 上游失败、无效 URL 等）*/
	const [loadError, setLoadError] = createSignal<string | null>(null)
	const [navigating, setNavigating] = createSignal(false)

	// 监听 iframe → parent 消息（inspector 上报 console/network/url-change）
	const onMessage = (ev: MessageEvent) => {
		const d = ev.data
		if (!d || typeof d !== 'object') return
		if (d.type === 'maxian-console') {
			props.pushConsoleLog({
				level:     d.level ?? 'log',
				text:      String(d.text ?? ''),
				timestamp: d.ts ?? Date.now(),
			})
		} else if (d.type === 'maxian-network') {
			props.pushNetworkEntry({
				method:     String(d.method ?? 'GET'),
				url:        String(d.url ?? ''),
				status:     typeof d.status === 'number' ? d.status : undefined,
				durationMs: typeof d.durationMs === 'number' ? d.durationMs : undefined,
				timestamp:  d.ts ?? Date.now(),
			})
		} else if (d.type === 'maxian-url-change') {
			// 内部 SPA 跳转 → 同步 URL 输入框（但不更新 props.currentUrl，避免触发 iframe reload）
			if (typeof d.url === 'string' && d.url) {
				setUrlInput(d.url)
			}
		} else if (d.type === 'maxian-injected') {
			setInspectorReady(true)
			setLoadError(null)
		}
		// maxian-resp 由 host 的命令 dispatcher 处理（AI 工具用），本面板忽略
	}

	onMount(() => {
		window.addEventListener('message', onMessage)
		setUrlInput(props.currentUrl())
	})
	onCleanup(() => {
		window.removeEventListener('message', onMessage)
		props.setIframeRef(null)
	})

	const navigate = (url: string) => {
		const trimmed = url.trim()
		if (!trimmed) return
		const finalUrl = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
		props.setCurrentUrl(finalUrl)
		setUrlInput(finalUrl)
		setNavigating(true)
		setInspectorReady(false)
		setLoadError(null)
	}

	const onIframeLoad = () => {
		setNavigating(false)
		// inspector 已经被 sidecar 内联到 HTML，不需要 parent 端再注入。
		// 如果 800ms 内没收到 'maxian-injected' 握手，认为上游响应非 HTML（PDF/图片）或 proxy 失败。
		setTimeout(() => {
			if (!inspectorReady()) {
				// 探测一次 iframe 是否其实有 maxian-injected 但消息丢失：尝试用 contentDocument 探测响应头
				try {
					const doc = iframeRef?.contentDocument
					// 同源（proxy origin == sidecar :4096，跟 :1420 也不同）— 实际 contentDocument 多半被浏览器拒
					if (doc && doc.querySelector('script[data-maxian-inspector]')) {
						setInspectorReady(true)
					}
				} catch {
					// ignore
				}
			}
		}, 800)
	}

	const refresh = () => {
		if (!iframeRef) return
		setNavigating(true)
		setInspectorReady(false)
		// 强制刷新：把 src 重新赋值
		const cur = iframeRef.src
		iframeRef.src = 'about:blank'
		setTimeout(() => {
			if (iframeRef) iframeRef.src = cur
		}, 50)
	}

	const screenshot = async () => {
		if (!iframeRef) return
		try {
			// 通过 inspector 抓 documentElement.outerHTML，再用 SVG foreignObject 渲染
			const cmdId = 'screenshot-' + Math.random().toString(36).slice(2)
			const respPromise = new Promise<{ html: string; w: number; h: number }>((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('截图超时（5s）')), 5000)
				const handler = (ev: MessageEvent) => {
					const d = ev.data
					if (!d || d.type !== 'maxian-resp' || d.cmdId !== cmdId) return
					clearTimeout(t)
					window.removeEventListener('message', handler)
					if (!d.ok) reject(new Error(d.error || '截图失败'))
					else resolve(d.result)
				}
				window.addEventListener('message', handler)
			})
			iframeRef.contentWindow?.postMessage({ type: 'maxian-cmd', cmdId, op: 'screenshot', args: {} }, '*')
			const { html, w, h } = await respPromise
			const cw = w || iframeRef.clientWidth
			const ch = h || iframeRef.clientHeight
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}">
				<foreignObject width="100%" height="100%">
					<div xmlns="http://www.w3.org/1999/xhtml">${html.replace(/<script[\s\S]*?<\/script>/g, '')}</div>
				</foreignObject>
			</svg>`
			const blob = new Blob([svg], { type: 'image/svg+xml' })
			const url = URL.createObjectURL(blob)
			const a = document.createElement('a')
			a.href = url
			a.download = `screenshot-${Date.now()}.svg`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
			URL.revokeObjectURL(url)
		} catch (e) {
			alert(`截图失败：${(e as Error).message}`)
		}
	}

	return (
		<Show when={props.visible()}>
			<aside class="browser-preview-panel">
				<header class="browser-panel-header">
					<div class="browser-panel-title">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10" />
							<line x1="2" y1="12" x2="22" y2="12" />
							<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
						</svg>
						<span>浏览器预览</span>
					</div>
					<button class="icon-btn" onClick={props.onClose} title="关闭面板">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</header>

				<div class="browser-toolbar">
					<button
						class="browser-tool-btn"
						onClick={refresh}
						disabled={!props.currentUrl()}
						title="刷新 (⌘R)"
					>
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
							classList={{ spinning: navigating() }}>
							<polyline points="23 4 23 10 17 10" />
							<polyline points="1 20 1 14 7 14" />
							<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
						</svg>
					</button>
					<input
						class="browser-url-input"
						type="text"
						placeholder="http://localhost:3000"
						value={urlInput()}
						list="browser-url-presets"
						onInput={(e) => setUrlInput(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								navigate(urlInput())
							}
						}}
					/>
					<datalist id="browser-url-presets">
						<For each={COMMON_URLS}>
							{(u) => <option value={u} />}
						</For>
					</datalist>
					<button class="browser-tool-btn" onClick={() => navigate(urlInput())} title="跳转">
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="5" y1="12" x2="19" y2="12" />
							<polyline points="12 5 19 12 12 19" />
						</svg>
					</button>
					<button class="browser-tool-btn" onClick={screenshot} title="截图（仅同源）">
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
							<circle cx="12" cy="13" r="4" />
						</svg>
					</button>
				</div>

				<Show when={loadError()}>
					<div class="browser-cors-warn">
						⚠ 加载失败：{loadError()}
					</div>
				</Show>
				<Show when={!loadError() && props.currentUrl() && !inspectorReady() && !navigating()}>
					<div class="browser-cors-warn" style="background: rgba(96, 165, 250, 0.1); border-color: rgba(96, 165, 250, 0.3); color: #93c5fd">
						ℹ Inspector 未就绪：上游响应可能非 HTML（PDF / 图片 / JSON），console / network 捕获不会工作。
					</div>
				</Show>

				<div class="browser-tabs">
					<button class="browser-tab" classList={{ active: tab() === 'preview' }} onClick={() => setTab('preview')}>
						预览
					</button>
					<button class="browser-tab" classList={{ active: tab() === 'console' }} onClick={() => setTab('console')}>
						Console
						<Show when={props.consoleLogs().length > 0}>
							<span class="browser-tab-badge">{props.consoleLogs().length}</span>
						</Show>
					</button>
					<button class="browser-tab" classList={{ active: tab() === 'network' }} onClick={() => setTab('network')}>
						Network
						<Show when={props.networkRequests().length > 0}>
							<span class="browser-tab-badge">{props.networkRequests().length}</span>
						</Show>
					</button>
				</div>

				<div class="browser-panel-body">
					{/* iframe 始终挂着；通过 display 切 visible */}
					<div class="browser-frame-wrap" style={tab() === 'preview' ? '' : 'display:none'}>
						<Show when={!props.currentUrl()}>
							<div class="browser-empty">
								<div class="browser-empty-title">输入 URL 开始预览</div>
								<div class="browser-empty-quick">
									<For each={COMMON_URLS}>
										{(u) => (
											<button class="browser-quick-link" onClick={() => navigate(u)}>{u}</button>
										)}
									</For>
								</div>
							</div>
						</Show>
						<Show when={props.currentUrl()}>
							<iframe
								class="browser-iframe"
								ref={(el) => {
									iframeRef = el
									props.setIframeRef(el)
								}}
								src={props.buildProxyUrl(props.currentUrl())}
								onLoad={onIframeLoad}
								sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
							/>
						</Show>
					</div>

					<Show when={tab() === 'console'}>
						<div class="browser-tab-pane">
							<div class="browser-pane-toolbar">
								<span class="browser-pane-count">{props.consoleLogs().length} 条</span>
								<button class="browser-pane-clear" onClick={props.clearConsoleLogs}>清空</button>
							</div>
							<div class="browser-log-list">
								<For each={props.consoleLogs()}>
									{(e) => (
										<div class="browser-log-row" style={`color: ${LEVEL_COLOR[e.level]}`}>
											<span class="browser-log-time">{formatTime(e.timestamp)}</span>
											<span class="browser-log-level">[{e.level}]</span>
											<span class="browser-log-text">{e.text}</span>
										</div>
									)}
								</For>
								<Show when={props.consoleLogs().length === 0}>
									<div class="browser-empty-text">暂无日志（页面 console 输出会实时显示）</div>
								</Show>
							</div>
						</div>
					</Show>

					<Show when={tab() === 'network'}>
						<div class="browser-tab-pane">
							<div class="browser-pane-toolbar">
								<span class="browser-pane-count">{props.networkRequests().length} 条</span>
								<button class="browser-pane-clear" onClick={props.clearNetworkEntries}>清空</button>
							</div>
							<div class="browser-net-list">
								<For each={props.networkRequests()}>
									{(e) => (
										<div class="browser-net-row" classList={{
											'status-2xx': (e.status ?? 0) >= 200 && (e.status ?? 0) < 300,
											'status-4xx': (e.status ?? 0) >= 400 && (e.status ?? 0) < 500,
											'status-5xx': (e.status ?? 0) >= 500,
											'status-err': e.status === 0,
										}}>
											<span class="browser-net-method">{e.method}</span>
											<span class="browser-net-status">{e.status || '—'}</span>
											<span class="browser-net-url" title={e.url}>{e.url}</span>
											<span class="browser-net-time">{e.durationMs ? `${e.durationMs}ms` : '—'}</span>
										</div>
									)}
								</For>
								<Show when={props.networkRequests().length === 0}>
									<div class="browser-empty-text">暂无网络请求（fetch / XHR 会实时记录）</div>
								</Show>
							</div>
						</div>
					</Show>
				</div>
			</aside>
		</Show>
	)
}
