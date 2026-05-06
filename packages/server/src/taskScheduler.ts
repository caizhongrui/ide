/*---------------------------------------------------------------------------------------------
 *  Maxian Server — TaskScheduler（批量任务调度器，v0.2.16+）
 *
 *  职责：
 *   - 给 batch 启动 / 暂停 / 恢复 / 取消（总入口 submitBatch / pauseBatch / abortBatch）
 *   - 调度策略：按 position ASC 取下一个 queued 任务；同 workspace 强制串行；
 *     跨 workspace 受 batch.max_concurrency 限制
 *   - 失败处理：task.on_failure → batch.on_failure 两级回退（pause / skip / retry / abort_batch）
 *   - 心跳：每 60s 写 last_heartbeat
 *   - 完成统计：实时维护 batch 的 completed_count / failed_count / tokens_used
 *
 *  本模块不直接跟 cli.ts agent loop 耦合，通过 SessionManager.runUntilDone() 抽象层调用。
 *  这样未来切换到云端调度器（CloudExecutor）时只换 ITaskExecutor 实现，业务逻辑不动。
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';
import type { SessionManager } from './sessionManager.js';
import type { BatchStatus, TaskStatus, OnFailureStrategy, TaskBatch, BatchTask, CreateBatchInput } from './types.js';

/** 任务正在跑的运行时状态（仅内存） */
interface TaskRuntime {
	taskId:        string;
	batchId:       string;
	sessionId:     string;
	workspaceId:   string;
	startedAt:     number;
	heartbeatTimer: ReturnType<typeof setInterval>;
	cancelled:     boolean;
}

export interface TaskSchedulerOptions {
	sessionManager: SessionManager;
	/** 创建一个新 session（需要由调用方桥接到现有的 createSession 逻辑） */
	createSession: (opts: {
		title:        string;
		workspaceId:  string;
		uiMode?:      'code' | 'chat';
		mode?:        string;
	}) => Promise<{ sessionId: string }>;
	/** 通知外部"任务状态变了"（批次 SSE 用） */
	emitBatchEvent?: (batchId: string, event: BatchEvent) => void;
}

export type BatchEvent =
	| { type: 'task_status_changed'; taskId: string; status: TaskStatus; failureReason?: string }
	| { type: 'task_progress';       taskId: string; tokensUsed: number }
	| { type: 'batch_progress';      completedCount: number; failedCount: number; skippedCount: number; tokensUsed: number }
	| { type: 'batch_status_changed'; status: BatchStatus }
	| { type: 'task_heartbeat';      taskId: string; lastHeartbeat: number };

const HEARTBEAT_INTERVAL_MS = 60_000;
const STUCK_THRESHOLD_MS    = 10 * 60 * 1000;  // 10 分钟无心跳判 stuck

export class TaskScheduler {
	private readonly opts: TaskSchedulerOptions;
	/** taskId → runtime（跑中的任务） */
	private readonly running = new Map<string, TaskRuntime>();
	/** workspaceId → 当前是否有跑中的任务（同 workspace 串行的简单锁） */
	private readonly workspaceBusy = new Set<string>();

	constructor(opts: TaskSchedulerOptions) {
		this.opts = opts;
	}

	// ════════════════════════════════════════════════════════════════════
	//  public API
	// ════════════════════════════════════════════════════════════════════

	/** 创建批次（从 CreateBatchInput 转 DB 行 + 任务行） */
	createBatch(input: CreateBatchInput): TaskBatch {
		const db = getDb();
		const now = Date.now();
		const batchId = randomUUID();

		const txn = db.transaction(() => {
			db.prepare(`INSERT INTO task_batches
				(id, name, description, created_at, updated_at, status,
				 auto_approve, max_concurrency, on_failure, token_budget, total_tasks)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				batchId,
				input.name,
				input.description ?? null,
				now,
				now,
				input.autoStart ? 'running' : 'draft',
				input.autoApprove === false ? 0 : 1,
				input.maxConcurrency ?? 3,
				input.onFailure ?? 'pause',
				input.tokenBudget ?? null,
				input.tasks.length,
			);

			const insertTask = db.prepare(`INSERT INTO batch_tasks
				(id, batch_id, workspace_id, title, prompt, mode, template,
				 position, depends_on, status, created_at, on_failure, max_retry)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

			input.tasks.forEach((t, idx) => {
				insertTask.run(
					randomUUID(),
					batchId,
					t.workspaceId,
					t.title,
					t.prompt,
					t.mode ?? 'code',
					t.template ?? null,
					idx,                             // position 默认按数组顺序
					t.dependsOn && t.dependsOn.length > 0 ? JSON.stringify(t.dependsOn) : null,
					'queued',
					now,
					t.onFailure ?? null,
					t.maxRetry ?? 3,
				);
			});
		});
		txn();

		const batch = this.loadBatch(batchId)!;

		if (input.autoStart) {
			void this.tickScheduler(batchId);
		}

		return batch;
	}

	/** 启动批次（draft → running） */
	async submitBatch(batchId: string): Promise<void> {
		const db = getDb();
		const batch = this.loadBatch(batchId);
		if (!batch) throw new Error(`Batch ${batchId} not found`);
		if (batch.status === 'running') return;
		if (batch.status === 'aborted' || batch.status === 'completed') {
			throw new Error(`Batch ${batchId} 已是终态：${batch.status}，不能再启动`);
		}

		db.prepare(`UPDATE task_batches SET status = 'running', updated_at = ? WHERE id = ?`)
			.run(Date.now(), batchId);
		this.opts.emitBatchEvent?.(batchId, { type: 'batch_status_changed', status: 'running' });
		void this.tickScheduler(batchId);
	}

	/** 暂停批次（不取消跑中任务，等它们自然结束后不再调度新的） */
	async pauseBatch(batchId: string): Promise<void> {
		const db = getDb();
		db.prepare(`UPDATE task_batches SET status = 'paused', updated_at = ? WHERE id = ?`)
			.run(Date.now(), batchId);
		this.opts.emitBatchEvent?.(batchId, { type: 'batch_status_changed', status: 'paused' });
	}

	/** 恢复批次 */
	async resumeBatch(batchId: string): Promise<void> {
		await this.submitBatch(batchId);
	}

	/** 整批取消：取消所有跑中任务 + 把 queued 任务标 cancelled */
	async abortBatch(batchId: string): Promise<void> {
		const db = getDb();
		// 取消跑中
		const myRunning = [...this.running.values()].filter(r => r.batchId === batchId);
		for (const rt of myRunning) {
			rt.cancelled = true;
			try { await this.opts.sessionManager.cancelTask(rt.sessionId); } catch { /* ignore */ }
		}
		// 标记所有 queued 为 cancelled
		db.prepare(`UPDATE batch_tasks SET status = 'cancelled', finished_at = ?
			WHERE batch_id = ? AND status IN ('queued', 'failed')`)
			.run(Date.now(), batchId);
		db.prepare(`UPDATE task_batches SET status = 'aborted', updated_at = ? WHERE id = ?`)
			.run(Date.now(), batchId);
		this.opts.emitBatchEvent?.(batchId, { type: 'batch_status_changed', status: 'aborted' });
	}

	/** 重试单个失败任务（重排队头） */
	async retryTask(taskId: string): Promise<void> {
		const db = getDb();
		const task = this.loadTask(taskId);
		if (!task) throw new Error(`Task ${taskId} not found`);
		if (task.status !== 'failed' && task.status !== 'stuck') {
			throw new Error(`Task ${taskId} 状态 ${task.status}，不能重试`);
		}
		// 把 position 设为当前最小值 - 1 让它排到最前面
		const minPos = (db.prepare(`SELECT MIN(position) as mn FROM batch_tasks WHERE batch_id = ? AND status = 'queued'`)
			.get(task.batchId) as any)?.mn ?? 0;
		db.prepare(`UPDATE batch_tasks
			SET status = 'queued', failure_reason = NULL, failure_action = NULL,
			    started_at = NULL, finished_at = NULL, retry_count = retry_count + 1,
			    position = ?
			WHERE id = ?`).run(minPos - 1, taskId);
		this.opts.emitBatchEvent?.(task.batchId, { type: 'task_status_changed', taskId, status: 'queued' });
		// 如果 batch 此时是 awaiting_user，恢复 running
		const batch = this.loadBatch(task.batchId)!;
		if (batch.status === 'awaiting_user') {
			db.prepare(`UPDATE task_batches SET status = 'running', updated_at = ? WHERE id = ?`)
				.run(Date.now(), task.batchId);
			this.opts.emitBatchEvent?.(task.batchId, { type: 'batch_status_changed', status: 'running' });
		}
		void this.tickScheduler(task.batchId);
	}

	/** 跳过单个任务（用户决策） */
	async skipTask(taskId: string): Promise<void> {
		const db = getDb();
		const task = this.loadTask(taskId);
		if (!task) throw new Error(`Task ${taskId} not found`);
		db.prepare(`UPDATE batch_tasks SET status = 'skipped', failure_action = 'skip', finished_at = ? WHERE id = ?`)
			.run(Date.now(), taskId);
		db.prepare(`UPDATE task_batches SET skipped_count = skipped_count + 1, updated_at = ? WHERE id = ?`)
			.run(Date.now(), task.batchId);
		this.opts.emitBatchEvent?.(task.batchId, { type: 'task_status_changed', taskId, status: 'skipped' });
		// 恢复 batch 状态（若曾因此任务 awaiting_user）
		const batch = this.loadBatch(task.batchId)!;
		if (batch.status === 'awaiting_user') {
			db.prepare(`UPDATE task_batches SET status = 'running', updated_at = ? WHERE id = ?`)
				.run(Date.now(), task.batchId);
			this.opts.emitBatchEvent?.(task.batchId, { type: 'batch_status_changed', status: 'running' });
		}
		void this.tickScheduler(task.batchId);
		await this.checkBatchCompletion(task.batchId);
	}

	/**
	 * 替换 draft 批次内全部任务（仅 status='draft' 时允许）。
	 * 用途：编辑模式保存时，把整个 tasks 列表全替换。
	 */
	async replaceTasks(batchId: string, tasks: CreateBatchInput['tasks']): Promise<void> {
		const db = getDb();
		const batch = this.loadBatch(batchId);
		if (!batch) throw new Error(`Batch ${batchId} not found`);
		if (batch.status !== 'draft') {
			throw new Error(`仅草稿状态可替换任务（当前 ${batch.status}）`);
		}
		const txn = db.transaction(() => {
			// 删旧任务
			db.prepare(`DELETE FROM batch_tasks WHERE batch_id = ?`).run(batchId);
			// 插新任务
			const insert = db.prepare(`INSERT INTO batch_tasks
				(id, batch_id, workspace_id, title, prompt, mode, template,
				 position, depends_on, status, created_at, on_failure, max_retry)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			const now = Date.now();
			tasks.forEach((t, idx) => {
				insert.run(
					randomUUID(),
					batchId,
					t.workspaceId,
					t.title,
					t.prompt,
					t.mode ?? 'code',
					t.template ?? null,
					idx,
					t.dependsOn && t.dependsOn.length > 0 ? JSON.stringify(t.dependsOn) : null,
					'queued',
					now,
					t.onFailure ?? null,
					t.maxRetry ?? 3,
				);
			});
			// 更新 batch.total_tasks
			db.prepare(`UPDATE task_batches SET total_tasks = ?, updated_at = ? WHERE id = ?`)
				.run(tasks.length, now, batchId);
		});
		txn();
	}

	/** 重排：传入新顺序的 taskIds 数组 */
	async reorderTasks(batchId: string, taskIds: string[]): Promise<void> {
		const db = getDb();
		const txn = db.transaction(() => {
			const update = db.prepare(`UPDATE batch_tasks SET position = ? WHERE id = ? AND batch_id = ?`);
			taskIds.forEach((id, idx) => update.run(idx, id, batchId));
		});
		txn();
		db.prepare(`UPDATE task_batches SET updated_at = ? WHERE id = ?`).run(Date.now(), batchId);
	}

	// ════════════════════════════════════════════════════════════════════
	//  调度核心
	// ════════════════════════════════════════════════════════════════════

	/**
	 * 调度循环：扫 batch 的 queued 任务，按 position + 依赖检查 + 并发上限派发。
	 * 同步幂等：多次调用不会重复派发同一任务（running Map 去重）。
	 */
	private async tickScheduler(batchId: string): Promise<void> {
		const batch = this.loadBatch(batchId);
		if (!batch || batch.status !== 'running') return;

		// Token 预算检查
		if (batch.tokenBudget != null && batch.tokensUsed >= batch.tokenBudget) {
			await this.pauseBatch(batchId);
			console.warn(`[TaskScheduler] batch ${batchId} 触达 token 预算 ${batch.tokenBudget}，已暂停`);
			return;
		}

		// 并发上限检查
		const myRunning = [...this.running.values()].filter(r => r.batchId === batchId);
		if (myRunning.length >= batch.maxConcurrency) return;

		// 取下一个可执行任务
		const next = this.pickNextTask(batchId);
		if (!next) {
			// 没活了，看是否全部完成
			await this.checkBatchCompletion(batchId);
			return;
		}

		// 同 workspace 锁
		if (this.workspaceBusy.has(next.workspaceId)) {
			// 这个 workspace 当前有任务跑中，跳过本次（等它完成会触发新一轮 tick）
			return;
		}

		// 派发（不 await，并发跑）
		void this.runTask(next).then(() => this.tickScheduler(batchId));

		// 还能再调度一个（不同 workspace）就继续
		if (myRunning.length + 1 < batch.maxConcurrency) {
			setImmediate(() => this.tickScheduler(batchId));
		}
	}

	/**
	 * 取下一个可执行任务：
	 *   1. status='queued'
	 *   2. workspace 当前空闲
	 *   3. depends_on 全部 completed
	 *   4. 按 position ASC 取第一个
	 */
	private pickNextTask(batchId: string): BatchTask | null {
		const db = getDb();
		const rows = db.prepare(`SELECT * FROM batch_tasks
			WHERE batch_id = ? AND status = 'queued'
			ORDER BY position ASC`).all(batchId) as any[];

		for (const row of rows) {
			if (this.workspaceBusy.has(row.workspace_id)) continue;
			// 检查依赖
			if (row.depends_on) {
				const depIds = JSON.parse(row.depends_on) as string[];
				const allDone = this.checkDepsCompleted(depIds);
				if (!allDone) continue;
			}
			return this.rowToTask(row);
		}
		return null;
	}

	private checkDepsCompleted(depIds: string[]): boolean {
		if (!depIds || depIds.length === 0) return true;
		const db = getDb();
		const placeholders = depIds.map(() => '?').join(',');
		const rows = db.prepare(`SELECT id, status FROM batch_tasks WHERE id IN (${placeholders})`)
			.all(...depIds) as Array<{ id: string; status: string }>;
		// 全部 completed 或 skipped 才算 OK；任一 failed/cancelled 视为依赖失败
		return rows.length === depIds.length
			&& rows.every(r => r.status === 'completed' || r.status === 'skipped');
	}

	/** 单任务执行：创建 session → 启 auto-approve → 跑 agent loop → 写结果 */
	private async runTask(task: BatchTask): Promise<void> {
		const db = getDb();

		// 1. 标 running + 占 workspace 锁
		this.workspaceBusy.add(task.workspaceId);
		db.prepare(`UPDATE batch_tasks SET status = 'running', started_at = ?, last_heartbeat = ? WHERE id = ?`)
			.run(Date.now(), Date.now(), task.id);
		this.opts.emitBatchEvent?.(task.batchId, { type: 'task_status_changed', taskId: task.id, status: 'running' });

		try {
			// 2. 解析 session：同 batch + workspace 共享一个 session（节省 token，复用上下文）
			//    第一个 task 创建 session；后续 task 复用同一个 sessionId，发新 user 消息进去。
			const batch = this.loadBatch(task.batchId)!;
			const existing = db.prepare(`SELECT session_id FROM batch_tasks
				WHERE batch_id = ? AND workspace_id = ? AND session_id IS NOT NULL
				LIMIT 1`).get(task.batchId, task.workspaceId) as { session_id: string } | undefined;

			let sessionId: string;
			if (existing?.session_id) {
				sessionId = existing.session_id;
				console.log(`[TaskScheduler] 复用 session ${sessionId} (batch=${task.batchId} ws=${task.workspaceId})`);
			} else {
				const created = await this.opts.createSession({
					title:       batch.name,    // session 标题用 batch 名（一个 batch+workspace 一个 session）
					workspaceId: task.workspaceId,
					uiMode:      'code',
					mode:        task.mode,
				});
				sessionId = created.sessionId;
				console.log(`[TaskScheduler] 新建 session ${sessionId} (batch=${task.batchId} ws=${task.workspaceId})`);
			}
			db.prepare(`UPDATE batch_tasks SET session_id = ? WHERE id = ?`).run(sessionId, task.id);

			// 3. 启用 auto-approve（带黑名单）—— 即便 session 已启用过，重复设置无害
			if (batch.autoApprove) {
				const { HARD_DENY_PATTERNS } = await import('./autoApprove.js').catch(() => ({ HARD_DENY_PATTERNS: [] as RegExp[] }));
				this.opts.sessionManager.setAutoApprove(sessionId, {
					enabled: true,
					deny:    HARD_DENY_PATTERNS,
				});
			}

			// 4. 启心跳
			const heartbeatTimer = setInterval(() => {
				db.prepare(`UPDATE batch_tasks SET last_heartbeat = ? WHERE id = ?`)
					.run(Date.now(), task.id);
				this.opts.emitBatchEvent?.(task.batchId, {
					type: 'task_heartbeat', taskId: task.id, lastHeartbeat: Date.now(),
				});
			}, HEARTBEAT_INTERVAL_MS);

			// 5. runtime 注册
			const rt: TaskRuntime = {
				taskId: task.id, batchId: task.batchId, sessionId,
				workspaceId: task.workspaceId, startedAt: Date.now(),
				heartbeatTimer, cancelled: false,
			};
			this.running.set(task.id, rt);

			// 6. 跑 agent loop（阻塞等结束）
			//    Prompt 包装：在共享 session 里加任务分隔符，让 AI 清楚知道当前是新任务
			//    的开始，且能看到这是 batch 里的第几个任务（复用前面任务的 context）。
			const wsTasks = db.prepare(`SELECT id, title FROM batch_tasks
				WHERE batch_id = ? AND workspace_id = ?
				ORDER BY position ASC`).all(task.batchId, task.workspaceId) as Array<{ id: string; title: string }>;
			const taskIdx = wsTasks.findIndex(t => t.id === task.id) + 1;
			const taskTotal = wsTasks.length;
			const wrappedPrompt = taskTotal > 1
				? `── 任务 ${taskIdx}/${taskTotal}：${task.title} ──\n\n${task.prompt}`
				: task.prompt;
			const result = await this.opts.sessionManager.runUntilDone(sessionId, wrappedPrompt, task.mode);

			// 7. 清理 runtime
			clearInterval(heartbeatTimer);
			this.running.delete(task.id);
			this.workspaceBusy.delete(task.workspaceId);
			// ⚠️ 不要 clearAutoApprove —— 同 session 后续 task 仍需要 auto-approve
			//    session 真正结束（batch completed/aborted）时再清

			// 8. 写结果
			if (rt.cancelled) {
				db.prepare(`UPDATE batch_tasks SET status = 'cancelled', finished_at = ?, tokens_used = ? WHERE id = ?`)
					.run(Date.now(), result.tokensUsed, task.id);
				this.opts.emitBatchEvent?.(task.batchId, { type: 'task_status_changed', taskId: task.id, status: 'cancelled' });
			} else if (result.success) {
				db.prepare(`UPDATE batch_tasks SET status = 'completed', finished_at = ?,
					tokens_used = ?, result_summary = ? WHERE id = ?`)
					.run(Date.now(), result.tokensUsed, result.summary, task.id);
				db.prepare(`UPDATE task_batches SET completed_count = completed_count + 1,
					tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?`)
					.run(result.tokensUsed, Date.now(), task.batchId);
				this.opts.emitBatchEvent?.(task.batchId, { type: 'task_status_changed', taskId: task.id, status: 'completed' });
			} else {
				await this.handleFailure(task, result.error ?? '任务失败', result.tokensUsed);
			}
		} catch (err) {
			// 跑任务过程中的硬异常（创建 session 失败等）
			clearInterval(this.running.get(task.id)?.heartbeatTimer);
			this.running.delete(task.id);
			this.workspaceBusy.delete(task.workspaceId);
			await this.handleFailure(task, String((err as Error).message), 0);
		}

		this.emitBatchProgress(task.batchId);
	}

	/**
	 * 失败处理：按 task.on_failure → batch.on_failure 两级回退
	 */
	private async handleFailure(task: BatchTask, reason: string, tokensUsed: number): Promise<void> {
		const db = getDb();
		const batch = this.loadBatch(task.batchId)!;
		const strategy: OnFailureStrategy = task.onFailure ?? batch.onFailure;

		// 累计 token（即使失败也产生开销）
		db.prepare(`UPDATE task_batches SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?`)
			.run(tokensUsed, Date.now(), task.batchId);

		switch (strategy) {
			case 'skip': {
				db.prepare(`UPDATE batch_tasks SET status = 'skipped', failure_reason = ?,
					finished_at = ?, tokens_used = ? WHERE id = ?`)
					.run(reason, Date.now(), tokensUsed, task.id);
				db.prepare(`UPDATE task_batches SET skipped_count = skipped_count + 1 WHERE id = ?`)
					.run(task.batchId);
				this.opts.emitBatchEvent?.(task.batchId, {
					type: 'task_status_changed', taskId: task.id, status: 'skipped', failureReason: reason,
				});
				break;
			}
			case 'retry': {
				if (task.retryCount < task.maxRetry) {
					db.prepare(`UPDATE batch_tasks SET status = 'queued', retry_count = retry_count + 1,
						failure_reason = ?, started_at = NULL, finished_at = NULL, tokens_used = ? WHERE id = ?`)
						.run(reason, tokensUsed, task.id);
					this.opts.emitBatchEvent?.(task.batchId, {
						type: 'task_status_changed', taskId: task.id, status: 'queued',
					});
				} else {
					// 重试用尽 → 转为 pause（标记 failed 等用户）
					await this.markFailed(task, reason, tokensUsed);
				}
				break;
			}
			case 'abort_batch': {
				await this.markFailed(task, reason, tokensUsed);
				await this.abortBatch(task.batchId);
				break;
			}
			case 'pause':
			default: {
				await this.markFailed(task, reason, tokensUsed);
				// 不改 batch.status — 让其他任务继续跑（非冲突 workspace）
				// UI 行内显示 [重试][跳过][暂停整批] 让用户决策
				break;
			}
		}
	}

	private async markFailed(task: BatchTask, reason: string, tokensUsed: number): Promise<void> {
		const db = getDb();
		db.prepare(`UPDATE batch_tasks SET status = 'failed', failure_reason = ?,
			finished_at = ?, tokens_used = ? WHERE id = ?`)
			.run(reason, Date.now(), tokensUsed, task.id);
		db.prepare(`UPDATE task_batches SET failed_count = failed_count + 1, updated_at = ? WHERE id = ?`)
			.run(Date.now(), task.batchId);
		this.opts.emitBatchEvent?.(task.batchId, {
			type: 'task_status_changed', taskId: task.id, status: 'failed', failureReason: reason,
		});
	}

	/** 检查 batch 是否所有任务终态了 */
	private async checkBatchCompletion(batchId: string): Promise<void> {
		const db = getDb();
		const rest = (db.prepare(`SELECT COUNT(*) as c FROM batch_tasks
			WHERE batch_id = ? AND status IN ('queued', 'running')`)
			.get(batchId) as any).c as number;
		if (rest > 0) return;

		// 还有 failed 等用户决策的不算 completed
		const failedAwaitingUser = (db.prepare(`SELECT COUNT(*) as c FROM batch_tasks
			WHERE batch_id = ? AND status = 'failed'`).get(batchId) as any).c as number;

		const newStatus = failedAwaitingUser > 0 ? 'awaiting_user' : 'completed';
		db.prepare(`UPDATE task_batches SET status = ?, updated_at = ? WHERE id = ?`)
			.run(newStatus, Date.now(), batchId);
		this.opts.emitBatchEvent?.(batchId, { type: 'batch_status_changed', status: newStatus });
	}

	private emitBatchProgress(batchId: string): void {
		const batch = this.loadBatch(batchId);
		if (!batch) return;
		this.opts.emitBatchEvent?.(batchId, {
			type: 'batch_progress',
			completedCount: batch.completedCount,
			failedCount:    batch.failedCount,
			skippedCount:   batch.skippedCount,
			tokensUsed:     batch.tokensUsed,
		});
	}

	// ════════════════════════════════════════════════════════════════════
	//  DB row → 对象
	// ════════════════════════════════════════════════════════════════════

	loadBatch(batchId: string): TaskBatch | null {
		const db = getDb();
		const row = db.prepare(`SELECT * FROM task_batches WHERE id = ?`).get(batchId) as any;
		return row ? this.rowToBatch(row) : null;
	}

	loadTask(taskId: string): BatchTask | null {
		const db = getDb();
		const row = db.prepare(`SELECT * FROM batch_tasks WHERE id = ?`).get(taskId) as any;
		return row ? this.rowToTask(row) : null;
	}

	listBatches(filter?: { status?: BatchStatus }): TaskBatch[] {
		const db = getDb();
		const rows = filter?.status
			? db.prepare(`SELECT * FROM task_batches WHERE status = ? ORDER BY updated_at DESC`).all(filter.status) as any[]
			: db.prepare(`SELECT * FROM task_batches ORDER BY updated_at DESC`).all() as any[];
		return rows.map(r => this.rowToBatch(r));
	}

	listTasks(batchId: string): BatchTask[] {
		const db = getDb();
		const rows = db.prepare(`SELECT * FROM batch_tasks WHERE batch_id = ? ORDER BY position ASC`)
			.all(batchId) as any[];
		return rows.map(r => this.rowToTask(r));
	}

	private rowToBatch(row: any): TaskBatch {
		return {
			id:             row.id,
			name:           row.name,
			description:    row.description ?? undefined,
			createdAt:      row.created_at,
			updatedAt:      row.updated_at,
			status:         row.status,
			autoApprove:    row.auto_approve === 1,
			maxConcurrency: row.max_concurrency,
			onFailure:      row.on_failure,
			tokenBudget:    row.token_budget ?? undefined,
			totalTasks:     row.total_tasks,
			completedCount: row.completed_count,
			failedCount:    row.failed_count,
			skippedCount:   row.skipped_count,
			tokensUsed:     row.tokens_used,
		};
	}

	private rowToTask(row: any): BatchTask {
		return {
			id:             row.id,
			batchId:        row.batch_id,
			sessionId:      row.session_id ?? undefined,
			workspaceId:    row.workspace_id,
			title:          row.title,
			prompt:         row.prompt,
			mode:           row.mode,
			template:       row.template ?? undefined,
			position:       row.position,
			dependsOn:      row.depends_on ? JSON.parse(row.depends_on) : undefined,
			status:         row.status,
			createdAt:      row.created_at,
			startedAt:      row.started_at ?? undefined,
			finishedAt:     row.finished_at ?? undefined,
			lastHeartbeat:  row.last_heartbeat ?? undefined,
			onFailure:      row.on_failure ?? undefined,
			failureReason:  row.failure_reason ?? undefined,
			failureAction:  row.failure_action ?? undefined,
			retryCount:     row.retry_count,
			maxRetry:       row.max_retry,
			tokensUsed:     row.tokens_used,
			resultSummary:  row.result_summary ?? undefined,
			filesChanged:   row.files_changed ? JSON.parse(row.files_changed) : undefined,
		};
	}

	/** Sidecar 启动时调用：扫一遍所有 status='running' 的任务，看是否 stuck（>10min 无心跳） */
	async checkStuckTasksOnStartup(): Promise<void> {
		const db = getDb();
		const now = Date.now();
		const stuck = db.prepare(`SELECT * FROM batch_tasks
			WHERE status = 'running'
			  AND (last_heartbeat IS NULL OR last_heartbeat < ?)`)
			.all(now - STUCK_THRESHOLD_MS) as any[];
		for (const row of stuck) {
			db.prepare(`UPDATE batch_tasks SET status = 'stuck', failure_reason = ? WHERE id = ?`)
				.run('启动时检测：心跳超时（>10min 无活动）', row.id);
			console.warn(`[TaskScheduler] 任务 ${row.id} (${row.title}) 启动时被判 stuck`);
		}
	}
}
