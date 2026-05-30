/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Auth Routes
 *
 *  POST /auth/configure  — 动态配置 AI 代理凭据（登录后由客户端调用）
 *  DELETE /auth/configure — 清除 AI 代理凭据（登出）
 *  GET /auth/status      — 查询当前 AI 配置状态
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';

export interface AiRuntimeConfig {
	apiUrl: string;
	/** base64 编码的用户名 */
	username: string;
	/** base64 编码的密码 */
	password: string;
}

export type SetAiConfigFn = (cfg: AiRuntimeConfig | null) => void;

export function AuthRoutes(setAiConfig: SetAiConfigFn, getAiConfig: () => AiRuntimeConfig | null) {
	const app = new Hono();

	/** 配置 AI 代理 */
	app.post('/auth/configure', async (c) => {
		let body: Record<string, string>;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}
		const { apiUrl, username, password } = body;
		if (!apiUrl || !username || !password) {
			return c.json({ error: 'Missing required fields: apiUrl, username, password' }, 400);
		}
		// 必须显式声明 type='proxy'，否则 pushAiCallLog 等下游会因 cfg.type !== 'proxy' 跳过
		setAiConfig({ type: 'proxy', apiUrl, username, password } as any);
		console.log('[Maxian Server] AI 代理已配置:', apiUrl);
		// F10: token 就绪后异步重新预热 scene-models。
		// 修复：sidecar 启动瞬间 server.getAiConfig() 返回 null（前端还没发 /auth/configure），
		// 启动预热拿到 0 个模型 → 前端 createEffect 拉清单也是 0 → retry 1 次（1.5s）后放弃
		// → ModelSelector 因 models 空不渲染。token 在这一刻才真正就绪，立即重新拉一次即可解决。
		try {
			const rerun = (globalThis as any).__maxianRerunScenePrefetch;
			if (typeof rerun === 'function') void rerun();
		} catch { /* ignore — 预热失败不影响 /auth/configure 响应 */ }
		return c.json({ ok: true });
	});

	/** 清除 AI 代理配置（登出） */
	app.delete('/auth/configure', (c) => {
		setAiConfig(null);
		console.log('[Maxian Server] AI 代理配置已清除');
		return c.json({ ok: true });
	});

	/** 查询当前 AI 配置状态 */
	app.get('/auth/status', (c) => {
		const cfg = getAiConfig();
		return c.json({
			configured: !!cfg,
			apiUrl: cfg?.apiUrl ?? null,
		});
	});

	return app;
}
