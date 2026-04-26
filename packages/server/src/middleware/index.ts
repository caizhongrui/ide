/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Middleware
 *--------------------------------------------------------------------------------------------*/

import type { Context, Next } from 'hono';

/** 当前服务端协议版本（与 X-Maxian-Protocol header 对齐） */
export const SERVER_PROTOCOL_VERSION = 1 as const;

/**
 * 协议版本中间件 —— 当前阶段（K3）只**记录**客户端协议版本，**不拒绝**。
 * 未来 protocol 升到 v2 等破坏性改动时，把 logging-only 改为 426 拒绝。
 *
 * 客户端约定：每个请求带 header `X-Maxian-Protocol: 1`
 * 协议变更见 docs/protocol/CHANGELOG.md
 */
export function ProtocolMiddleware() {
	const warnedClients = new Set<string>();
	return async (c: Context, next: Next) => {
		const clientProto = c.req.header('x-maxian-protocol');
		if (clientProto && clientProto !== String(SERVER_PROTOCOL_VERSION)) {
			// 不一致只警告一次（避免日志刷屏）
			const key = `${c.req.header('user-agent') ?? 'unknown'}|${clientProto}`;
			if (!warnedClients.has(key)) {
				warnedClients.add(key);
				console.warn(
					`[Protocol] 客户端协议版本 ${clientProto} 与服务端 ${SERVER_PROTOCOL_VERSION} 不一致 ` +
					`(UA=${c.req.header('user-agent') ?? 'unknown'}). 当前为 logging-only，未来可能拒绝。`,
				);
			}
		}
		// 总是把 server 协议版本回给客户端（便于客户端检测漂移）
		c.header('X-Maxian-Protocol', String(SERVER_PROTOCOL_VERSION));
		return next();
	};
}

/** 认证 Middleware — 基于 Basic Auth，密码由 password 参数控制 */
export function AuthMiddleware(expectedUser?: string, expectedPass?: string) {
	return async (c: Context, next: Next) => {
		if (!expectedPass) {
			// 未设置密码 = 免认证模式（本地开发/单机使用）
			return next();
		}

		// 优先 Authorization header；SSE 场景退而求其次读 ?auth= query（EventSource 无法带头）
		let authToken = c.req.header('authorization');
		if (!authToken || !authToken.startsWith('Basic ')) {
			const queryAuth = c.req.query('auth');
			if (queryAuth) authToken = 'Basic ' + queryAuth;
		}

		if (!authToken || !authToken.startsWith('Basic ')) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		try {
			const decoded = atob(authToken.slice(6));
			const [user, pass] = decoded.split(':');
			if (user !== expectedUser || pass !== expectedPass) {
				return c.json({ error: 'Unauthorized' }, 401);
			}
		} catch {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		return next();
	};
}

/** 日志 Middleware */
export async function LoggerMiddleware(c: Context, next: Next) {
	const start = Date.now();
	const { method, path } = c.req;
	try {
		await next();
	} finally {
		const duration = Date.now() - start;
		const status = c.res.status;
		console.log(`[${new Date().toISOString()}] ${method} ${path} ${status} ${duration}ms`);
	}
}

/** CORS Middleware */
export function CorsMiddleware(allowedOrigins?: string[] | boolean) {
	return async (c: Context, next: Next) => {
		const origin = c.req.header('origin');
		let allowOrigin = '';

		if (allowedOrigins === true) {
			// tauri://localhost、http://localhost:1420、无 origin 的原生 XHR 请求均放行
			allowOrigin = origin ?? '*';
		} else if (Array.isArray(allowedOrigins)) {
			allowOrigin = origin && allowedOrigins.includes(origin) ? origin : '';
		}

		if (allowOrigin) {
			c.header('Access-Control-Allow-Origin', allowOrigin);
			c.header('Vary', 'Origin');
			c.header('Access-Control-Allow-Credentials', 'true');
			c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Cache-Control');
			c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
		}

		if (c.req.method === 'OPTIONS') {
			return c.body(null, 204);
		}

		return next();
	};
}

/** 错误处理 */
export async function ErrorMiddleware(err: Error, c: Context) {
	console.error('[Server] Unhandled error:', err);
	return c.json({
		error: err.message || 'Internal Server Error',
		stack: process.env['MAXIAN_DEBUG'] ? err.stack : undefined,
	}, 500);
}
