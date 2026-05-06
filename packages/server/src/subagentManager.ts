/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Subagent Manager (B1)
 *
 *  作用：
 *  - 跟踪所有"已派出"的子代理状态（running / completed / failed / cancelled）
 *  - 支持 background 模式（task() 返回 task_id 后立即继续，主代理可查 task_status）
 *  - 控制并发上限（≤ 8 个 background 子代理并行）
 *  - 父任务取消时级联取消所有子代理
 *  - 暴露 SSE-friendly 事件流给桌面端任务编排面板
 *
 *  与 SessionManager 的关系：
 *  - 每个子代理本质上仍是一个 sidecar session（独立 sessionId / context window）
 *  - SubagentManager 在 SessionManager 之上加 metadata：parent / status / startedAt / etc
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { SubagentIsolation } from '@maxian/core/agents';

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentRecord {
	/** 子代理任务 id（不是 sessionId；sessionId 在 sessionManager 里独立分配） */
	taskId:           string;
	/** 父代理 sessionId（顶层主对话） */
	parentSessionId:  string;
	/** 子代理 sessionId（独立 context；workspace 由 isolation 决定是否共享） */
	subagentSessionId: string;
	/** 子代理类型（builtin name 或自定义 .maxian/agents 名） */
	subagentType:     string;
	/** 简短描述（给 UI 用） */
	description?:     string;
	/** 任务 prompt（给 LLM 看的） */
	prompt:           string;
	/** 隔离策略（运行时已 resolve；inherit/worktree） */
	isolation:        SubagentIsolation;
	/** 是否后台模式（true → 主代理立即拿 taskId 继续；false → 主代理 await 等结果） */
	background:       boolean;
	/** 状态 */
	status:           SubagentStatus;
	/** 创建时间 */
	createdAt:        number;
	/** 开始执行时间 */
	startedAt?:       number;
	/** 完成时间 */
	finishedAt?:      number;
	/** 错误（status=failed 时填） */
	error?:           string;
	/** 输出摘要（status=completed 时填，主代理只看到这个） */
	output?:          string;
	/** 实际工作目录（若 isolation=worktree 则是 worktree 路径，否则是父代理 workspace） */
	effectiveWorkspacePath: string;
	/** worktree 路径（仅 isolation=worktree 时有值；用于完成后 git worktree remove） */
	worktreePath?:    string;
	/** worktree 分支名（仅 isolation=worktree 时有值） */
	worktreeBranch?:  string;
	/** 取消信号 token（写入后子代理循环检测到会自动 break） */
	cancelled:        boolean;
}

export interface SubagentManagerEvents {
	/** 任务状态变化 — 桌面端编排面板订阅（含 created / status update / completed / failed） */
	'task-update': (record: SubagentRecord) => void;
}

export interface SubagentManagerOptions {
	/** 同时持有的 background 任务上限（completed/failed 不计入） */
	maxConcurrentBackground?: number;
}

export class SubagentManager extends EventEmitter {
	private records: Map<string, SubagentRecord> = new Map();
	private readonly maxConcurrentBackground: number;

	constructor(opts: SubagentManagerOptions = {}) {
		super();
		this.maxConcurrentBackground = opts.maxConcurrentBackground ?? 8;
	}

	// ─── 创建 / 查询 ──────────────────────────────────────────────────────────

	/**
	 * 创建一个子代理记录（在 spawnSubAgent 实际开跑之前调用，保证编排面板能看到 queued/running）
	 *
	 * @returns 失败时返回 reason（用于 task 工具回到主代理时给 LLM 看）
	 */
	create(opts: {
		parentSessionId:        string;
		subagentSessionId:      string;
		subagentType:           string;
		description?:           string;
		prompt:                 string;
		isolation:              SubagentIsolation;
		background:             boolean;
		effectiveWorkspacePath: string;
		worktreePath?:          string;
		worktreeBranch?:        string;
	}): { ok: true; record: SubagentRecord } | { ok: false; reason: string } {
		// 并发上限：仅对 background 任务限制（同步任务自然受限于父代理的 await）
		if (opts.background) {
			const activeBg = Array.from(this.records.values()).filter(
				r => r.background && (r.status === 'running' || r.status === 'queued'),
			).length;
			if (activeBg >= this.maxConcurrentBackground) {
				return {
					ok: false,
					reason: `并发上限：当前已有 ${activeBg} 个 background 子代理在跑（上限 ${this.maxConcurrentBackground}）。先等待其中一些完成或调小并发。`,
				};
			}
		}

		const taskId = `task_${Date.now()}_${randomUUID().slice(0, 6)}`;
		const record: SubagentRecord = {
			taskId,
			parentSessionId:        opts.parentSessionId,
			subagentSessionId:      opts.subagentSessionId,
			subagentType:           opts.subagentType,
			description:            opts.description,
			prompt:                 opts.prompt,
			isolation:              opts.isolation,
			background:             opts.background,
			status:                 'queued',
			createdAt:              Date.now(),
			effectiveWorkspacePath: opts.effectiveWorkspacePath,
			worktreePath:           opts.worktreePath,
			worktreeBranch:         opts.worktreeBranch,
			cancelled:              false,
		};
		this.records.set(taskId, record);
		this.emitUpdate(record);
		return { ok: true, record };
	}

	/** 标记任务进入 running 状态 */
	markRunning(taskId: string): void {
		const r = this.records.get(taskId);
		if (!r) return;
		r.status = 'running';
		r.startedAt = Date.now();
		this.emitUpdate(r);
	}

	/** 任务正常完成 */
	markCompleted(taskId: string, output: string): void {
		const r = this.records.get(taskId);
		if (!r) return;
		r.status = 'completed';
		r.finishedAt = Date.now();
		r.output = output;
		this.emitUpdate(r);
	}

	/** 任务失败 */
	markFailed(taskId: string, error: string): void {
		const r = this.records.get(taskId);
		if (!r) return;
		r.status = 'failed';
		r.finishedAt = Date.now();
		r.error = error;
		this.emitUpdate(r);
	}

	/** 任务被取消（父代理取消 / 用户主动） */
	markCancelled(taskId: string): void {
		const r = this.records.get(taskId);
		if (!r) return;
		r.status = 'cancelled';
		r.cancelled = true;
		r.finishedAt = Date.now();
		this.emitUpdate(r);
	}

	/** 写 cancelled 信号（子代理循环里轮询） */
	requestCancel(taskId: string): void {
		const r = this.records.get(taskId);
		if (!r) return;
		r.cancelled = true;
		this.emitUpdate(r);
	}

	/** 查询单个 */
	get(taskId: string): SubagentRecord | undefined {
		return this.records.get(taskId);
	}

	/** 列出所有 */
	listAll(): SubagentRecord[] {
		return Array.from(this.records.values()).sort((a, b) => b.createdAt - a.createdAt);
	}

	/** 列出某 parent session 的子任务 */
	listByParent(parentSessionId: string): SubagentRecord[] {
		return this.listAll().filter(r => r.parentSessionId === parentSessionId);
	}

	/** 列出 active（queued/running）任务 */
	listActive(): SubagentRecord[] {
		return this.listAll().filter(r => r.status === 'queued' || r.status === 'running');
	}

	// ─── 取消传播 ─────────────────────────────────────────────────────────────

	/**
	 * 父任务取消时调用：把所有 active 的子任务都标 cancelled。
	 *
	 * 子代理 loop 内会轮询 record.cancelled，看到后退出循环。
	 * worktree 如果存在会在 cleanup() 中被清理。
	 */
	cancelAllByParent(parentSessionId: string): string[] {
		const cancelled: string[] = [];
		for (const r of this.records.values()) {
			if (r.parentSessionId === parentSessionId && (r.status === 'queued' || r.status === 'running')) {
				r.cancelled = true;
				cancelled.push(r.taskId);
				this.emitUpdate(r);
			}
		}
		return cancelled;
	}

	// ─── GC ────────────────────────────────────────────────────────────────────

	/** 清理 N 小时前已结束的记录（避免内存泄漏；UI 仍能拿到最近一段历史） */
	gc(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
		const now = Date.now();
		let removed = 0;
		for (const [k, r] of this.records) {
			if (r.status !== 'queued' && r.status !== 'running') {
				const age = now - (r.finishedAt ?? r.createdAt);
				if (age > maxAgeMs) {
					this.records.delete(k);
					removed++;
				}
			}
		}
		return removed;
	}

	private emitUpdate(record: SubagentRecord): void {
		this.emit('task-update', record);
	}
}
