/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Sub-agent Routes (B1)
 *
 *  - GET    /subagents               列出全部子代理（可按 parent/status 过滤）
 *  - GET    /subagents/:id           单个状态查询
 *  - POST   /subagents/:id/cancel    取消（写 cancelled 信号；子代理 loop 自检退出）
 *  - GET    /subagents/events        SSE 任务编排事件流（任务编排面板订阅）
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SubagentManager, SubagentRecord } from '../subagentManager.js';

function recordToWire(r: SubagentRecord) {
	return {
		taskId:            r.taskId,
		parentSessionId:   r.parentSessionId,
		subagentSessionId: r.subagentSessionId,
		subagentType:      r.subagentType,
		description:       r.description,
		isolation:         r.isolation,
		background:        r.background,
		status:            r.status,
		createdAt:         r.createdAt,
		startedAt:         r.startedAt,
		finishedAt:        r.finishedAt,
		error:             r.error,
		output:            r.output,
		worktreePath:      r.worktreePath,
		worktreeBranch:    r.worktreeBranch,
	};
}

export function SubagentRoutes(mgr: SubagentManager) {
	const app = new Hono();

	app.get('/subagents', (c) => {
		const parent = c.req.query('parent');
		const status = c.req.query('status') as SubagentRecord['status'] | undefined;
		let list: SubagentRecord[] = parent
			? mgr.listByParent(parent)
			: mgr.listAll();
		if (status) list = list.filter(r => r.status === status);
		return c.json({ records: list.map(recordToWire) });
	});

	app.get('/subagents/:id', (c) => {
		const id = c.req.param('id');
		const r = mgr.get(id);
		if (!r) return c.json({ error: 'not found' }, 404);
		return c.json(recordToWire(r));
	});

	app.post('/subagents/:id/cancel', (c) => {
		const id = c.req.param('id');
		const r = mgr.get(id);
		if (!r) return c.json({ error: 'not found' }, 404);
		mgr.requestCancel(id);
		return c.json({ ok: true });
	});

	// SSE 任务编排事件流（任务编排面板订阅；events 实时反映 task-update）
	app.get('/subagents/events', (c) => {
		return streamSSE(c, async (outgoing) => {
			let aborted = false;
			const handler = (record: SubagentRecord): void => {
				if (aborted) return;
				try {
					void outgoing.writeSSE({
						event: 'task-update',
						data:  JSON.stringify(recordToWire(record)),
					});
				} catch { /* ignore */ }
			};
			mgr.on('task-update', handler);

			// 心跳保持连接
			const hb = setInterval(() => {
				if (aborted) return;
				void outgoing.writeSSE({
					event: 'heartbeat',
					data:  JSON.stringify({ ts: Date.now() }),
				}).catch(() => { aborted = true; });
			}, 15000);

			await new Promise<void>((resolve) => {
				outgoing.onAbort(() => {
					aborted = true;
					clearInterval(hb);
					mgr.off('task-update', handler);
					resolve();
				});
			});
		});
	});

	return app;
}
