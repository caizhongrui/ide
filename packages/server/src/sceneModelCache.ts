/*---------------------------------------------------------------------------------------------
 *  K-MultiModel (v0.2.25) — Scene Model Meta Cache
 *
 *  按 (businessCode, model) → SceneModelMeta 索引的两级缓存。
 *  由 /scene-models/:code 透传路由 hit 后同步更新；getAiHandler 创建 handler 前
 *  按 (sess.uiMode → businessCode, sess.model) 查这个缓存拿 supportVision 等 meta。
 *--------------------------------------------------------------------------------------------*/

export interface SceneModelMeta {
	id:             number;
	businessCode:   string;
	provider:       string;
	model:          string;
	isDefault:      number;        // 0 / 1
	priority?:      number;
	temperature?:   number;
	maxTokens?:     number;
	supportVision?: number;        // 0 / 1
	contextWindow?: number;
}

// 二级缓存：businessCode → (model → meta)
const cache = new Map<string, Map<string, SceneModelMeta>>();

export function getSceneModel(businessCode: string, model: string | null | undefined): SceneModelMeta | null {
	if (!model) return null;
	const inner = cache.get(businessCode);
	if (!inner) return null;
	return inner.get(model) ?? null;
}

export function getSceneModels(businessCode: string): SceneModelMeta[] {
	const inner = cache.get(businessCode);
	return inner ? Array.from(inner.values()) : [];
}

/**
 * 取某场景的默认模型（isDefault=1 那行）。
 * 用户没主动选 model 时，sidecar 据此为 AiProxyHandler 设置 supportsVision —— 跟
 * 前端"未选时显示 (默认) 模型"的视觉/能力保持一致，避免前端隐藏图片按钮但 sidecar
 * 乐观不降级历史图片导致 400。
 */
export function getSceneDefaultModel(businessCode: string): SceneModelMeta | null {
	const inner = cache.get(businessCode);
	if (!inner) return null;
	for (const m of inner.values()) {
		if (m.isDefault === 1) return m;
	}
	return null;
}

export function setSceneModelList(businessCode: string, models: SceneModelMeta[]): void {
	const inner = new Map<string, SceneModelMeta>();
	for (const m of models) {
		if (m.model) inner.set(m.model, m);
	}
	cache.set(businessCode, inner);
}

export function getCacheStats(): { businessCodes: number; totalModels: number } {
	let totalModels = 0;
	for (const inner of cache.values()) totalModels += inner.size;
	return { businessCodes: cache.size, totalModels };
}
