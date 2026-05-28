/*---------------------------------------------------------------------------------------------
 *  K-MultiModel (v0.2.25) — /scene-models/:code route
 *
 *  透传云端 GET /ai/proxy/scene-models/:businessCode 给客户端使用，
 *  同时同步 sceneModelCache（getAiHandler 据此拿 supportVision 等 meta）。
 *  2 min 内存缓存避免每次切会话都打云端。
 *
 *  返回字段（每行）：
 *    id / businessCode / provider / model / isDefault / priority /
 *    temperature / maxTokens / supportVision / contextWindow
 *--------------------------------------------------------------------------------------------*/

import type { Hono } from 'hono';
import { setSceneModelList, type SceneModelMeta } from '../sceneModelCache.js';

const TTL_MS = 2 * 60 * 1000;
const _cacheByCode = new Map<string, { ts: number; data: SceneModelMeta[] }>();

export interface SceneModelsRouteDeps {
	getAiConfig: () => { apiUrl: string; username: string; password: string } | null;
}

export function registerSceneModelsRoute(app: Hono, deps: SceneModelsRouteDeps): void {
	app.get('/scene-models/:code', async (c) => {
		const code = c.req.param('code');
		// cache hit
		const cached = _cacheByCode.get(code);
		if (cached && Date.now() - cached.ts < TTL_MS) {
			return c.json({ models: cached.data, cached: true });
		}
		const cfg = deps.getAiConfig();
		if (!cfg) {
			return c.json({ models: [], cached: false, error: 'AI 服务未配置' });
		}
		try {
			const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
			const url  = `${cfg.apiUrl.replace(/\/$/, '')}/ai/proxy/scene-models/${encodeURIComponent(code)}`;
			const res  = await fetch(url, {
				headers: { Authorization: `Basic ${auth}` },
				signal:  AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				console.warn(`[scene-models] upstream ${code} → ${res.status}`);
				return c.json({ models: [], cached: false, error: `upstream ${res.status}` });
			}
			const body = await res.json() as { code?: number; data?: SceneModelMeta[]; rows?: SceneModelMeta[] };
			// 后端列表接口可能用 data 也可能用 rows
			const raw = body.data ?? body.rows ?? [];
			// 防御：normalize 字段名（驼峰 / 下划线两种都接）
			const data: SceneModelMeta[] = raw.map((r: any) => ({
				id:             r.id,
				businessCode:   r.businessCode ?? r.business_code ?? code,
				provider:       r.provider,
				model:          r.model,
				isDefault:      r.isDefault ?? r.is_default ?? 0,
				priority:       r.priority,
				temperature:    r.temperature,
				maxTokens:      r.maxTokens ?? r.max_tokens,
				supportVision:  r.supportVision ?? r.support_vision ?? 0,
				contextWindow:  r.contextWindow ?? r.context_window,
			}));
			_cacheByCode.set(code, { ts: Date.now(), data });
			setSceneModelList(code, data);
			console.log(`[scene-models] ${code} → ${data.length} 个模型，已同步 sceneModelCache`);
			return c.json({ models: data, cached: false });
		} catch (e) {
			console.error('[scene-models] 拉取失败', e);
			const stale = _cacheByCode.get(code);
			return c.json({
				models: stale?.data ?? [],
				cached: !!stale,
				error:  (e as Error).message,
			});
		}
	});
}

/** 主动刷新某个 businessCode 的缓存（启动预热用） */
export async function prefetchSceneModels(
	businessCode: string,
	cfg: { apiUrl: string; username: string; password: string },
): Promise<void> {
	try {
		const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
		const url  = `${cfg.apiUrl.replace(/\/$/, '')}/ai/proxy/scene-models/${encodeURIComponent(businessCode)}`;
		const res  = await fetch(url, {
			headers: { Authorization: `Basic ${auth}` },
			signal:  AbortSignal.timeout(10_000),
		});
		if (!res.ok) return;
		const body = await res.json() as { data?: SceneModelMeta[]; rows?: SceneModelMeta[] };
		const raw = body.data ?? body.rows ?? [];
		const data: SceneModelMeta[] = raw.map((r: any) => ({
			id:             r.id,
			businessCode:   r.businessCode ?? r.business_code ?? businessCode,
			provider:       r.provider,
			model:          r.model,
			isDefault:      r.isDefault ?? r.is_default ?? 0,
			priority:       r.priority,
			temperature:    r.temperature,
			maxTokens:      r.maxTokens ?? r.max_tokens,
			supportVision:  r.supportVision ?? r.support_vision ?? 0,
			contextWindow:  r.contextWindow ?? r.context_window,
		}));
		_cacheByCode.set(businessCode, { ts: Date.now(), data });
		setSceneModelList(businessCode, data);
		console.log(`[scene-models] 预热 ${businessCode} → ${data.length} 个模型`);
	} catch (e) {
		console.warn(`[scene-models] 预热 ${businessCode} 失败:`, (e as Error).message);
	}
}
