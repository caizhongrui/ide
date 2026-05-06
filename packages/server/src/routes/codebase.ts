/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Codebase Index Routes (B4)
 *
 *  - GET    /codebase/:workspaceId                 当前工作区索引快照（架构 / 模块 / 文件树 / 依赖图）
 *  - POST   /codebase/:workspaceId/refresh         触发索引刷新（默认增量；body { incremental: false } 则全量）
 *  - POST   /codebase/:workspaceId/search          自然语言搜索 API
 *  - DELETE /codebase/:workspaceId                 清空该工作区索引
 *  - GET    /codebase/:workspaceId/refresh/events  SSE 进度流（rebuild 时实时推送 onProgress）
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ICodebaseIndex } from '@maxian/core/codebase-index';
import type { WorkspaceManager } from '../workspaceManager.js';

export function CodebaseRoutes(index: ICodebaseIndex, workspaces: WorkspaceManager) {
	const app = new Hono();

	app.get('/codebase/:workspaceId', async (c) => {
		const workspaceId = c.req.param('workspaceId');
		const snap = await index.getSnapshot(workspaceId);
		if (!snap) return c.json({ snapshot: null });
		return c.json({ snapshot: snap });
	});

	app.post('/codebase/:workspaceId/refresh', async (c) => {
		const workspaceId = c.req.param('workspaceId');
		const ws = workspaces.get(workspaceId);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		const body = await c.req.json().catch(() => ({})) as { incremental?: boolean };
		const incremental = body.incremental !== false;
		try {
			const t0 = Date.now();
			const snap = await index.rebuild(workspaceId, ws.path, { incremental });
			return c.json({ ok: true, snapshot: snap, durationMs: Date.now() - t0 });
		} catch (e) {
			const err = e as Error;
			console.error(`[CodebaseIndex] rebuild failed (workspaceId=${workspaceId}, path=${ws.path}):`, err.stack ?? err.message);
			return c.json({ ok: false, error: err.message, stack: err.stack }, 500);
		}
	});

	/** SSE 版本：rebuild 期间实时推送进度，前端可显示进度条 */
	app.get('/codebase/:workspaceId/refresh/events', (c) => {
		const workspaceId = c.req.param('workspaceId');
		const ws = workspaces.get(workspaceId);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		const incremental = c.req.query('incremental') !== 'false';
		return streamSSE(c, async (stream) => {
			const send = (event: string, data: unknown) => stream.writeSSE({
				event,
				data: JSON.stringify(data),
			});
			try {
				await send('start', { workspaceId, incremental, startedAt: Date.now() });
				const t0 = Date.now();
				const snap = await index.rebuild(workspaceId, ws.path, {
					incremental,
					onProgress: (msg) => { void send('progress', { message: msg, ts: Date.now() }) },
				});
				await send('done', {
					ok:         true,
					snapshot:   snap,
					durationMs: Date.now() - t0,
				});
			} catch (e) {
				await send('error', { message: (e as Error).message });
			}
		});
	});

	app.post('/codebase/:workspaceId/search', async (c) => {
		const workspaceId = c.req.param('workspaceId');
		const body = await c.req.json().catch(() => ({})) as {
			query?:      string;
			maxResults?: number;
		};
		if (!body.query || typeof body.query !== 'string' || body.query.trim() === '') {
			return c.json({ error: 'query required' }, 400);
		}
		const hits = await index.search(workspaceId, body.query.trim(), body.maxResults ?? 20);
		return c.json({ hits });
	});

	app.delete('/codebase/:workspaceId', async (c) => {
		const workspaceId = c.req.param('workspaceId');
		await index.delete(workspaceId);
		return c.json({ ok: true });
	});

	return app;
}
