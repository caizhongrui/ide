/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Browser Bridge Routes (B5)
 *
 *  - GET    /browser/events        SSE：sidecar → frontend desktop（命令 / 导航 / 关闭）
 *  - POST   /browser/reply         frontend → sidecar：cmd 执行结果回写
 *  - POST   /browser/event         frontend → sidecar：实时 push console / network 流
 *  - GET    /browser/proxy         反向代理：剥 X-Frame-Options / CSP，HTML 注入 inspector
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { BrowserBridgeController } from '../browserBridge.js';
import { injectInspector } from '../browserInspector.js';

export function BrowserRoutes(bridge: BrowserBridgeController) {
	const app = new Hono();

	app.get('/browser/events', (c) => {
		bridge.setFrontendActive(true);
		return streamSSE(c, async (stream) => {
			const onCommand  = (cmd: { cmdId: string; op: string; args: Record<string, unknown> }) => {
				void stream.writeSSE({ event: 'command',  data: JSON.stringify(cmd)  });
			};
			const onNavigate = (n: { url: string }) => {
				void stream.writeSSE({ event: 'navigate', data: JSON.stringify(n) });
			};
			const onClose    = () => {
				void stream.writeSSE({ event: 'close-page', data: JSON.stringify({}) });
			};
			bridge.on('command',  onCommand);
			bridge.on('navigate', onNavigate);
			bridge.on('close',    onClose);

			// 心跳保持连接
			const hb = setInterval(() => {
				stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ ts: Date.now() }) }).catch(() => {});
			}, 15000);

			await new Promise<void>((resolve) => {
				stream.onAbort(() => {
					clearInterval(hb);
					bridge.off('command',  onCommand);
					bridge.off('navigate', onNavigate);
					bridge.off('close',    onClose);
					bridge.setFrontendActive(false);
					resolve();
				});
			});
		});
	});

	app.post('/browser/reply', async (c) => {
		const body = await c.req.json().catch(() => ({})) as { cmdId?: string; ok?: boolean; result?: unknown; error?: string };
		if (!body.cmdId || typeof body.ok !== 'boolean') {
			return c.json({ error: 'cmdId + ok required' }, 400);
		}
		const ok = bridge.resolveReply(body.cmdId, { ok: body.ok, result: body.result, error: body.error });
		return c.json({ ok });
	});

	// ─── 反向代理（解决跨域 iframe 注入问题）─────────────────────────────────
	//
	// iframe 直接加载第三方页面会有两个限制：
	//   1) X-Frame-Options / CSP frame-ancestors 阻止被 iframe
	//   2) 同源策略阻止 parent 注入脚本（contentWindow.eval 抛错）
	//
	// 走这个 proxy 后：
	//   - 上游响应里 X-Frame-Options / CSP 这些头被剥掉
	//   - HTML 顶部内联 inspector 脚本，因此无论上游是哪个 origin，
	//     脚本都跑在 iframe 自己的 origin 下（即 sidecar:4096 这个 proxy origin），
	//     用 postMessage 给 parent，跨域问题不再阻塞 console / network / eval。
	//   - 同时注入 <base href="<upstream-origin>/"> 让相对资源 (CSS/JS/图片/接口) 直连上游。
	//
	// 注意：这个 proxy 仅在 desktop 内嵌浏览器场景使用，对外没有暴露给互联网。
	// 调用方（BrowserPreviewPanel）应自行将 URL 限定在用户主动输入的范围内。
	app.get('/browser/proxy', async (c) => {
		const target = c.req.query('url');
		if (!target) {
			return c.text('missing url', 400);
		}

		let parsed: URL;
		try {
			parsed = new URL(target);
		} catch {
			return c.text('invalid url', 400);
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return c.text('only http(s) supported', 400);
		}

		// 把客户端 Range / Accept / Cookie 等转发上游（除了 host / referer / origin）
		const fwdHeaders: Record<string, string> = {};
		const reqHeaders = c.req.header();
		for (const [k, v] of Object.entries(reqHeaders)) {
			const lower = k.toLowerCase();
			if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'connection' || lower === 'content-length') continue;
			if (typeof v === 'string') fwdHeaders[k] = v;
		}

		let upstream: Response;
		try {
			upstream = await fetch(parsed.toString(), {
				method: 'GET',
				headers: fwdHeaders,
				redirect: 'follow',
			});
		} catch (e) {
			console.error('[browser/proxy] fetch 失败:', e);
			return c.text(`upstream fetch failed: ${(e as Error).message}`, 502);
		}

		// 防止 webview 缓存 proxy 响应（每次刷新一定走最新的 inspector）
		const FORCE_NO_CACHE = ['cache-control', 'pragma', 'expires', 'etag', 'last-modified'];
		// 复制响应头，剥掉所有阻挡 iframe / 注入的安全头
		const STRIP = new Set([
			'x-frame-options',
			'content-security-policy',
			'content-security-policy-report-only',
			'cross-origin-opener-policy',
			'cross-origin-embedder-policy',
			'cross-origin-resource-policy',
			'permissions-policy',
			'strict-transport-security',
			// hop-by-hop
			'connection',
			'transfer-encoding',
			'keep-alive',
			'proxy-authenticate',
			'proxy-authorization',
			'te',
			'trailers',
			'upgrade',
			// 已被我们重写
			'content-encoding',
			'content-length',
		]);
		const respHeaders: Record<string, string> = {};
		upstream.headers.forEach((v, k) => {
			const lower = k.toLowerCase();
			if (STRIP.has(lower)) return;
			if (FORCE_NO_CACHE.includes(lower)) return;
			respHeaders[k] = v;
		});
		// 标记这是 proxy 响应，方便排查
		respHeaders['x-maxian-proxy'] = '1';
		// 强制 webview 不缓存 proxy 响应（让用户每次刷新都拿到最新的 inspector）
		respHeaders['Cache-Control'] = 'no-store, no-cache, must-revalidate';
		respHeaders['Pragma'] = 'no-cache';

		const contentType = upstream.headers.get('content-type') ?? '';

		// 仅对 HTML / XHTML 注入；其他（JSON、JS、CSS、图片）原样转发
		if (/\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
			let body = await upstream.text();
			const upstreamOrigin = `${parsed.protocol}//${parsed.host}`;
			// 关键：把上游的 path+search+hash 一并传给 inspector，让它在脚本最早期
			// 用 history.replaceState 把 iframe 的 location 改写成上游路径，
			// 避免 Vue Router / React Router 等读取 location.pathname 看到 /browser/proxy 报错。
			const upstreamUri = (parsed.pathname || '/') + parsed.search + parsed.hash;
			// 构造 proxy URL 前缀（让 inspector 把 <a> 点击重写回 proxy）。
			// 沿用本次请求里看到的 host 头 + scheme，避免把 sidecar 私有 IP 写死。
			// 同时复用本次请求的 auth 查询串（如果存在），保持 iframe 内 fetch/click 能继续认证。
			const reqUrl = new URL(c.req.url);
			const authQuery = reqUrl.searchParams.get('auth');
			const proxyBase = `${reqUrl.protocol}//${reqUrl.host}/browser/proxy?` +
				(authQuery ? `auth=${encodeURIComponent(authQuery)}&` : '') +
				`url=`;
			body = injectInspector(body, upstreamOrigin, proxyBase, upstreamUri);
			respHeaders['content-type'] = contentType.includes('charset')
				? contentType
				: `${contentType.split(';')[0].trim()}; charset=utf-8`;
			return new Response(body, { status: upstream.status, headers: respHeaders });
		}

		// 二进制 / 文本：流式转发
		return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
	});

	app.post('/browser/event', async (c) => {
		const body = await c.req.json().catch(() => ({})) as {
			kind?:  'console' | 'network' | 'url-change' | 'injected';
			level?: string;
			text?:  string;
			method?:string;
			url?:   string;
			status?:number;
			durationMs?:number;
			timestamp?: number;
		};
		if (body.kind === 'console') {
			bridge.pushConsoleEntry({
				level:     (body.level as 'log' | 'info' | 'warn' | 'error' | 'debug') ?? 'log',
				text:      String(body.text ?? ''),
				timestamp: body.timestamp ?? Date.now(),
			});
		} else if (body.kind === 'network') {
			bridge.pushNetworkEntry({
				method:     String(body.method ?? 'GET'),
				url:        String(body.url ?? ''),
				status:     typeof body.status === 'number' ? body.status : undefined,
				durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
				timestamp:  body.timestamp ?? Date.now(),
			});
		} else if (body.kind === 'url-change') {
			bridge.setCurrentUrl(body.url ?? null);
		}
		return c.json({ ok: true });
	});

	return app;
}
