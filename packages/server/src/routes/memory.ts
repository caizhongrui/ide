/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Memory Routes (B3)
 *
 *  - GET    /memory                  列出记忆（可按 scope/workspace/session 过滤）
 *  - GET    /memory/:id              单条详情
 *  - POST   /memory                  手动添加记忆
 *  - PUT    /memory/:id              更新（仅允许改 content / category）
 *  - PATCH  /memory/:id/star         标星 / 取消
 *  - DELETE /memory/:id              删除
 *  - POST   /memory/search           语义搜索（query embedding → top-K）
 *  - POST   /memory/clear            按 scope 批量清空（不会删 starred）
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import type {
	IMemoryStore,
	MemoryCategory,
	MemoryQuery,
	MemoryScope,
} from '@maxian/core/memory';

function isCategory(v: unknown): v is MemoryCategory {
	return typeof v === 'string' &&
		['preference', 'convention', 'fact', 'style', 'tech-stack', 'other'].includes(v);
}
function isScope(v: unknown): v is MemoryScope {
	return typeof v === 'string' && ['global', 'workspace', 'session'].includes(v);
}

export function MemoryRoutes(store: IMemoryStore) {
	const app = new Hono();

	app.get('/memory', async (c) => {
		const scopeQ      = c.req.query('scope');
		const workspaceId = c.req.query('workspace_id') ?? undefined;
		const sessionId   = c.req.query('session_id') ?? undefined;
		const filter: { scope?: MemoryScope; workspaceId?: string; sessionId?: string } = {};
		if (scopeQ && isScope(scopeQ)) filter.scope = scopeQ;
		if (workspaceId) filter.workspaceId = workspaceId;
		if (sessionId) filter.sessionId = sessionId;
		const records = await store.list(Object.keys(filter).length > 0 ? filter : undefined);
		return c.json({ records });
	});

	app.get('/memory/:id', async (c) => {
		const id = c.req.param('id');
		const r = await store.get(id);
		if (!r) return c.json({ error: 'not found' }, 404);
		return c.json({ record: r });
	});

	app.post('/memory', async (c) => {
		const body = await c.req.json().catch(() => ({})) as {
			scope?:       MemoryScope;
			workspaceId?: string;
			sessionId?:   string;
			category?:    MemoryCategory;
			content?:     string;
			source?:      'auto' | 'manual';
			starred?:     boolean;
		};
		if (!body.content || typeof body.content !== 'string' || body.content.trim() === '') {
			return c.json({ error: 'content required' }, 400);
		}
		if (!body.scope || !isScope(body.scope)) {
			return c.json({ error: 'scope required (global / workspace / session)' }, 400);
		}
		if (!body.category || !isCategory(body.category)) {
			return c.json({ error: 'category required (preference / convention / fact / style / tech-stack / other)' }, 400);
		}
		const created = await store.add({
			scope:       body.scope,
			workspaceId: body.workspaceId,
			sessionId:   body.sessionId,
			category:    body.category,
			content:     body.content.trim(),
			source:      body.source ?? 'manual',
			starred:     body.starred ?? false,
		});
		return c.json({ record: created });
	});

	app.put('/memory/:id', async (c) => {
		const id = c.req.param('id');
		const body = await c.req.json().catch(() => ({})) as {
			content?:  string;
			category?: MemoryCategory;
		};
		const existing = await store.get(id);
		if (!existing) return c.json({ error: 'not found' }, 404);
		// MemoryStore 没暴露独立的 update —— 用 delete + add 等价实现，保留 starred / scope。
		await store.delete(id);
		const updated = await store.add({
			scope:       existing.scope,
			workspaceId: existing.workspaceId,
			sessionId:   existing.sessionId,
			category:    (body.category && isCategory(body.category)) ? body.category : existing.category,
			content:     (typeof body.content === 'string' && body.content.trim()) ? body.content.trim() : existing.content,
			source:      existing.source,
			starred:     existing.starred,
		});
		return c.json({ record: updated });
	});

	app.patch('/memory/:id/star', async (c) => {
		const id = c.req.param('id');
		const body = await c.req.json().catch(() => ({})) as { starred?: boolean };
		if (typeof body.starred !== 'boolean') {
			return c.json({ error: 'starred (boolean) required' }, 400);
		}
		const ok = await store.setStarred(id, body.starred);
		if (!ok) return c.json({ error: 'not found' }, 404);
		const updated = await store.get(id);
		return c.json({ record: updated });
	});

	app.delete('/memory/:id', async (c) => {
		const id = c.req.param('id');
		const ok = await store.delete(id);
		if (!ok) return c.json({ error: 'not found' }, 404);
		return c.json({ ok: true });
	});

	app.post('/memory/search', async (c) => {
		const body = await c.req.json().catch(() => ({})) as Partial<MemoryQuery>;
		if (!body.query || typeof body.query !== 'string' || body.query.trim() === '') {
			return c.json({ error: 'query required' }, 400);
		}
		const result = await store.search({
			query:        body.query.trim(),
			scope:        (body.scope && isScope(body.scope)) ? body.scope : undefined,
			workspaceId:  body.workspaceId,
			sessionId:    body.sessionId,
			category:     (body.category && isCategory(body.category)) ? body.category : undefined,
			maxResults:   typeof body.maxResults === 'number' ? body.maxResults : 10,
			minScore:     typeof body.minScore === 'number' ? body.minScore : 0.05,
		});
		return c.json({ hits: result });
	});

	app.post('/memory/clear', async (c) => {
		const body = await c.req.json().catch(() => ({})) as {
			scope?:       MemoryScope;
			workspaceId?: string;
			sessionId?:   string;
		};
		const filter: { scope?: MemoryScope; workspaceId?: string; sessionId?: string } = {};
		if (body.scope && isScope(body.scope)) filter.scope = body.scope;
		if (body.workspaceId) filter.workspaceId = body.workspaceId;
		if (body.sessionId) filter.sessionId = body.sessionId;
		const removed = await store.clear(Object.keys(filter).length > 0 ? filter : undefined);
		return c.json({ removed });
	});

	return app;
}
