/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Batch Routes（v0.2.16+）
 *
 *  批量任务调度 API：
 *    POST   /batches                     创建批次
 *    GET    /batches                     列出批次（status 过滤）
 *    GET    /batches/:id                 批次详情 + 全任务列表
 *    PATCH  /batches/:id                 改 status / 调度配置
 *    PATCH  /batches/:id/reorder         拖拽：传 taskIds 数组重写 position
 *    DELETE /batches/:id                 删除（连带 tasks，sessions 保留）
 *    GET    /batches/:id/tasks           任务列表（status 过滤）
 *    PATCH  /batches/:id/tasks/:tid      改 task（on_failure / 用户决策）
 *    POST   /batches/:id/tasks/:tid/retry  重试失败任务
 *    POST   /batches/:id/tasks/:tid/skip   跳过失败任务
 *    GET    /batches/:id/events          SSE 实时进度
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { TaskScheduler, BatchEvent } from '../taskScheduler.js';

const OnFailureSchema = z.enum(['pause', 'skip', 'retry', 'abort_batch']);
const BatchStatusSchema = z.enum(['draft', 'running', 'paused', 'awaiting_user', 'completed', 'aborted']);

const CreateBatchSchema = z.object({
	name:            z.string().min(1).max(200),
	description:     z.string().optional(),
	autoApprove:     z.boolean().optional(),
	maxConcurrency:  z.number().int().min(1).max(20).optional(),
	onFailure:       OnFailureSchema.optional(),
	tokenBudget:     z.number().int().positive().optional(),
	autoStart:       z.boolean().optional(),
	tasks: z.array(z.object({
		workspaceId:  z.string().min(1),
		title:        z.string().min(1).max(200),
		prompt:       z.string().min(1),
		mode:         z.string().optional(),
		template:     z.string().optional(),
		dependsOn:    z.array(z.string()).optional(),
		onFailure:    OnFailureSchema.optional(),
		maxRetry:     z.number().int().min(0).max(10).optional(),
	})).min(1),
});

const PatchBatchSchema = z.object({
	status:          BatchStatusSchema.optional(),
	name:            z.string().optional(),
	description:     z.string().optional(),
	autoApprove:     z.boolean().optional(),
	maxConcurrency:  z.number().int().min(1).max(20).optional(),
	onFailure:       OnFailureSchema.optional(),
	tokenBudget:     z.number().int().positive().nullable().optional(),
});

const PatchTaskSchema = z.object({
	onFailure:       OnFailureSchema.nullable().optional(),
	prompt:          z.string().optional(),
	title:           z.string().optional(),
	mode:            z.string().optional(),
});

const ReorderSchema = z.object({
	taskIds: z.array(z.string().min(1)),
});

/** 模块级 batchEvent 订阅器：sse 路由订阅这里，TaskScheduler emit 时分发 */
type BatchEventSubscriber = (event: BatchEvent) => void;
const batchSubscribers = new Map<string, Set<BatchEventSubscriber>>();   // batchId → subscribers

export function emitBatchEventToSubscribers(batchId: string, event: BatchEvent): void {
	const set = batchSubscribers.get(batchId);
	if (!set) return;
	for (const sub of set) {
		try { sub(event); } catch (err) {
			console.warn('[BatchRoutes] subscriber error:', err);
		}
	}
}

export function BatchRoutes(scheduler: TaskScheduler) {
	const app = new Hono();

	// ── 创建批次 ────────────────────────────────────────────────────
	app.post('/batches', zValidator('json', CreateBatchSchema), (c) => {
		const input = c.req.valid('json');
		try {
			const batch = scheduler.createBatch(input);
			return c.json({ batch }, 201);
		} catch (err) {
			return c.json({ error: (err as Error).message }, 500);
		}
	});

	// ── 列出批次 ────────────────────────────────────────────────────
	app.get('/batches', (c) => {
		const status = c.req.query('status') as any;
		const batches = scheduler.listBatches(status ? { status } : undefined);
		return c.json({ batches });
	});

	// ── 批次详情 + 任务列表 ────────────────────────────────────────
	app.get('/batches/:id', (c) => {
		const id = c.req.param('id');
		const batch = scheduler.loadBatch(id);
		if (!batch) return c.json({ error: 'Batch not found' }, 404);
		const tasks = scheduler.listTasks(id);
		return c.json({ batch, tasks });
	});

	// ── 改 status / 调度配置 ───────────────────────────────────────
	app.patch('/batches/:id', zValidator('json', PatchBatchSchema), async (c) => {
		const id = c.req.param('id');
		const patch = c.req.valid('json');
		const batch = scheduler.loadBatch(id);
		if (!batch) return c.json({ error: 'Batch not found' }, 404);

		try {
			// 状态变更走专门接口
			if (patch.status) {
				if (patch.status === 'running')   await scheduler.submitBatch(id);
				else if (patch.status === 'paused') await scheduler.pauseBatch(id);
				else if (patch.status === 'aborted') await scheduler.abortBatch(id);
				else return c.json({ error: `不支持直接切到 ${patch.status} 状态` }, 400);
			}

			// 配置变更
			const { getDb } = await import('../database.js');
			const db = getDb();
			const sets: string[] = [];
			const vals: unknown[] = [];
			if (patch.name !== undefined)            { sets.push('name = ?');             vals.push(patch.name); }
			if (patch.description !== undefined)     { sets.push('description = ?');       vals.push(patch.description); }
			if (patch.autoApprove !== undefined)      { sets.push('auto_approve = ?');      vals.push(patch.autoApprove ? 1 : 0); }
			if (patch.maxConcurrency !== undefined)   { sets.push('max_concurrency = ?');   vals.push(patch.maxConcurrency); }
			if (patch.onFailure !== undefined)        { sets.push('on_failure = ?');        vals.push(patch.onFailure); }
			if (patch.tokenBudget !== undefined)      { sets.push('token_budget = ?');      vals.push(patch.tokenBudget); }
			if (sets.length > 0) {
				sets.push('updated_at = ?');
				vals.push(Date.now(), id);
				db.prepare(`UPDATE task_batches SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
			}
			return c.json({ batch: scheduler.loadBatch(id) });
		} catch (err) {
			return c.json({ error: (err as Error).message }, 500);
		}
	});

	// ── 拖拽重排 ────────────────────────────────────────────────────
	app.patch('/batches/:id/reorder', zValidator('json', ReorderSchema), async (c) => {
		const id = c.req.param('id');
		const { taskIds } = c.req.valid('json');
		try {
			await scheduler.reorderTasks(id, taskIds);
			return c.json({ ok: true, tasks: scheduler.listTasks(id) });
		} catch (err) {
			return c.json({ error: (err as Error).message }, 500);
		}
	});

	// ── 删除批次 ────────────────────────────────────────────────────
	app.delete('/batches/:id', async (c) => {
		const id = c.req.param('id');
		const batch = scheduler.loadBatch(id);
		if (!batch) return c.json({ error: 'Batch not found' }, 404);
		// 跑中先取消
		if (batch.status === 'running') {
			await scheduler.abortBatch(id);
		}
		const { getDb } = await import('../database.js');
		// CASCADE 会自动删 batch_tasks，sessions 保留（task.session_id FK 不带 CASCADE）
		getDb().prepare('DELETE FROM task_batches WHERE id = ?').run(id);
		return c.json({ ok: true });
	});

	// ── 任务列表（带状态过滤）─────────────────────────────────────
	app.get('/batches/:id/tasks', (c) => {
		const id = c.req.param('id');
		const status = c.req.query('status');
		let tasks = scheduler.listTasks(id);
		if (status) tasks = tasks.filter(t => t.status === status);
		return c.json({ tasks });
	});

	// ── 改单任务（on_failure / 内容编辑）──────────────────────────
	app.patch('/batches/:id/tasks/:tid', zValidator('json', PatchTaskSchema), async (c) => {
		const tid = c.req.param('tid');
		const patch = c.req.valid('json');
		const task = scheduler.loadTask(tid);
		if (!task) return c.json({ error: 'Task not found' }, 404);
		// running 状态不允许改 prompt / title / mode（只允许改 on_failure）
		if (task.status === 'running' && (patch.prompt || patch.title || patch.mode)) {
			return c.json({ error: '任务正在运行，不能修改内容' }, 400);
		}
		const { getDb } = await import('../database.js');
		const db = getDb();
		const sets: string[] = [];
		const vals: unknown[] = [];
		if (patch.onFailure !== undefined) { sets.push('on_failure = ?'); vals.push(patch.onFailure); }
		if (patch.prompt !== undefined)    { sets.push('prompt = ?');     vals.push(patch.prompt); }
		if (patch.title !== undefined)     { sets.push('title = ?');      vals.push(patch.title); }
		if (patch.mode !== undefined)      { sets.push('mode = ?');       vals.push(patch.mode); }
		if (sets.length > 0) {
			vals.push(tid);
			db.prepare(`UPDATE batch_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
		}
		return c.json({ task: scheduler.loadTask(tid) });
	});

	// ── 重试 / 跳过 ────────────────────────────────────────────────
	app.post('/batches/:id/tasks/:tid/retry', async (c) => {
		const tid = c.req.param('tid');
		try {
			await scheduler.retryTask(tid);
			return c.json({ task: scheduler.loadTask(tid) });
		} catch (err) {
			return c.json({ error: (err as Error).message }, 400);
		}
	});

	app.post('/batches/:id/tasks/:tid/skip', async (c) => {
		const tid = c.req.param('tid');
		try {
			await scheduler.skipTask(tid);
			return c.json({ task: scheduler.loadTask(tid) });
		} catch (err) {
			return c.json({ error: (err as Error).message }, 400);
		}
	});

	// ── SSE 实时进度 ────────────────────────────────────────────────
	app.get('/batches/:id/events', async (c) => {
		const id = c.req.param('id');
		if (!scheduler.loadBatch(id)) return c.json({ error: 'Batch not found' }, 404);

		return streamSSE(c, async (stream) => {
			let unsub: (() => void) | null = null;
			const queue: BatchEvent[] = [];
			let resolveNext: (() => void) | null = null;

			// 注册订阅
			const handler: BatchEventSubscriber = (event) => {
				queue.push(event);
				resolveNext?.();
			};
			let set = batchSubscribers.get(id);
			if (!set) { set = new Set(); batchSubscribers.set(id, set); }
			set.add(handler);
			unsub = () => {
				const s = batchSubscribers.get(id);
				s?.delete(handler);
				if (s && s.size === 0) batchSubscribers.delete(id);
			};

			// 心跳 + 事件流
			const heartbeat = setInterval(() => {
				queue.push({ type: 'task_heartbeat', taskId: '__hb__', lastHeartbeat: Date.now() } as any);
				resolveNext?.();
			}, 15_000);

			c.req.raw.signal.addEventListener('abort', () => {
				clearInterval(heartbeat);
				unsub?.();
				resolveNext?.();
			});

			try {
				while (!c.req.raw.signal.aborted) {
					if (queue.length === 0) {
						await new Promise<void>(r => { resolveNext = r; });
						resolveNext = null;
						continue;
					}
					const ev = queue.shift()!;
					await stream.writeSSE({ data: JSON.stringify(ev) });
				}
			} finally {
				clearInterval(heartbeat);
				unsub?.();
			}
		});
	});

	return app;
}
