/*---------------------------------------------------------------------------------------------
 *  BatchDetailPanel — 右侧批次详情：头部统计 + 任务表格
 *--------------------------------------------------------------------------------------------*/

import { Show, createMemo } from 'solid-js'
import type { Component } from 'solid-js'
import type { MaxianClient, TaskBatch, BatchTask, Workspace } from '@maxian/sdk'
import { BatchTaskTable } from './BatchTaskTable'

interface Props {
	client:     MaxianClient
	batch:      TaskBatch
	tasks:      BatchTask[]
	workspaces: Workspace[]
	loading:    boolean
	onRefresh:  () => void
	onTasksUpdated: (tasks: BatchTask[]) => void
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	const sec = ms / 1000
	if (sec < 60) return `${sec.toFixed(1)}s`
	const min = sec / 60
	if (min < 60) return `${min.toFixed(1)}min`
	const hr = min / 60
	return `${hr.toFixed(1)}h`
}

function fmtTokens(n: number): string {
	if (n < 1000) return n.toString()
	if (n < 1000_000) return `${(n / 1000).toFixed(1)}K`
	return `${(n / 1000_000).toFixed(2)}M`
}

export const BatchDetailPanel: Component<Props> = (props) => {
	const totalDuration = createMemo(() => {
		const tasks = props.tasks
		if (tasks.length === 0) return 0
		const min = tasks.reduce((acc, t) => Math.min(acc, t.startedAt ?? Infinity), Infinity)
		const max = tasks.reduce((acc, t) => Math.max(acc, t.finishedAt ?? Date.now()), 0)
		if (min === Infinity || max === 0) return 0
		return max - min
	})

	const isActionable = (): boolean =>
		props.batch.status === 'running' || props.batch.status === 'paused' || props.batch.status === 'awaiting_user'

	const handlePause = async (): Promise<void> => {
		await props.client.updateBatch(props.batch.id, { status: 'paused' })
		props.onRefresh()
	}
	const handleResume = async (): Promise<void> => {
		await props.client.updateBatch(props.batch.id, { status: 'running' })
		props.onRefresh()
	}
	const handleAbort = async (): Promise<void> => {
		const ok = window.confirm(`确定取消整批 "${props.batch.name}"？跑中的任务会被打断，已完成的不影响。`)
		if (!ok) return
		await props.client.updateBatch(props.batch.id, { status: 'aborted' })
		props.onRefresh()
	}
	const handleDelete = async (): Promise<void> => {
		const ok = window.confirm(`确定删除批次 "${props.batch.name}"？关联 sessions 不会删，但批次记录会丢。`)
		if (!ok) return
		await props.client.deleteBatch(props.batch.id)
		// 让父组件刷新（通过 onRefresh + 切到无选中态）
		props.onRefresh()
	}

	return (
		<div class="batch-detail">
			{/* 头部 */}
			<header class="batch-detail-header">
				<div class="batch-detail-title-row">
					<h2 class="batch-detail-title">{props.batch.name}</h2>
					<span class={`batch-status-tag batch-status-${props.batch.status}`}>
						{props.batch.status}
					</span>
				</div>
				<Show when={props.batch.description}>
					<p class="batch-detail-desc">{props.batch.description}</p>
				</Show>
				<div class="batch-detail-stats">
					<span>总 <b>{props.batch.totalTasks}</b></span>
					<span class="stat-completed">✓ <b>{props.batch.completedCount}</b></span>
					<span class="stat-failed">✗ <b>{props.batch.failedCount}</b></span>
					<span class="stat-skipped">⊘ <b>{props.batch.skippedCount}</b></span>
					<span>Token <b>{fmtTokens(props.batch.tokensUsed)}</b></span>
					<Show when={totalDuration() > 0}>
						<span>耗时 <b>{fmtDuration(totalDuration())}</b></span>
					</Show>
					<Show when={props.batch.tokenBudget}>
						<span class={props.batch.tokensUsed >= (props.batch.tokenBudget ?? Infinity) * 0.8 ? 'stat-warn' : ''}>
							预算 {fmtTokens(props.batch.tokensUsed)} / {fmtTokens(props.batch.tokenBudget!)}
						</span>
					</Show>
				</div>
				<div class="batch-detail-actions">
					<Show when={props.batch.status === 'draft'}>
						<button class="btn-primary" onClick={handleResume}>▶ 开始</button>
					</Show>
					<Show when={props.batch.status === 'running'}>
						<button class="btn-secondary" onClick={handlePause}>⏸ 暂停</button>
					</Show>
					<Show when={props.batch.status === 'paused' || props.batch.status === 'awaiting_user'}>
						<button class="btn-primary" onClick={handleResume}>▶ 继续</button>
					</Show>
					<Show when={isActionable()}>
						<button class="btn-danger" onClick={handleAbort}>⊗ 取消整批</button>
					</Show>
					<button class="btn-ghost" onClick={() => props.onRefresh()}>🔄 刷新</button>
					<Show when={props.batch.status === 'completed' || props.batch.status === 'aborted' || props.batch.status === 'draft'}>
						<button class="btn-ghost" onClick={handleDelete}>🗑 删除</button>
					</Show>
				</div>
			</header>

			{/* 任务表格 */}
			<BatchTaskTable
				client={props.client}
				batch={props.batch}
				tasks={props.tasks}
				workspaces={props.workspaces}
				onTasksUpdated={props.onTasksUpdated}
			/>
		</div>
	)
}
