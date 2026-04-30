/*---------------------------------------------------------------------------------------------
 *  BatchTaskTable — 批次内任务表格
 *
 *  功能：
 *  - 状态颜色 + 图标
 *  - 拖拽排序（HTML5 native drag）：仅 queued + 草稿 / 跑中 batch 的 queued 行可拖
 *  - 行内 on_failure 下拉
 *  - 失败行展开 [重试][跳过][暂停整批]
 *--------------------------------------------------------------------------------------------*/

import { createSignal, For, Show } from 'solid-js'
import type { Component } from 'solid-js'
import type { MaxianClient, TaskBatch, BatchTask, TaskStatus, OnFailureStrategy, Workspace } from '@maxian/sdk'

interface Props {
	client:         MaxianClient
	batch:          TaskBatch
	tasks:          BatchTask[]
	workspaces:     Workspace[]
	onTasksUpdated: (tasks: BatchTask[]) => void
}

const STATUS_ICONS: Record<TaskStatus, string> = {
	queued:    '⏸',
	running:   '⏳',
	completed: '✓',
	failed:    '✗',
	skipped:   '⊘',
	cancelled: '⊗',
	stuck:     '⚠',
}
const STATUS_LABELS: Record<TaskStatus, string> = {
	queued:    '等待',
	running:   '跑中',
	completed: '完成',
	failed:    '失败',
	skipped:   '跳过',
	cancelled: '已取消',
	stuck:     '卡死',
}

const ON_FAILURE_OPTIONS: Array<{ value: OnFailureStrategy | ''; label: string }> = [
	{ value: '',            label: '用批次默认' },
	{ value: 'pause',       label: '暂停（等决策）' },
	{ value: 'skip',        label: '跳过' },
	{ value: 'retry',       label: '自动重试' },
	{ value: 'abort_batch', label: '取消整批' },
]

export const BatchTaskTable: Component<Props> = (props) => {
	const [draggingId, setDraggingId] = createSignal<string | null>(null)
	const [dragOverId, setDragOverId] = createSignal<string | null>(null)

	const canDragTask = (task: BatchTask): boolean => {
		// 草稿状态全部可拖；其他状态只 queued 行可拖
		if (props.batch.status === 'draft') return true
		return task.status === 'queued'
	}

	const wsName = (id: string): string =>
		props.workspaces.find(w => w.id === id)?.name ?? id.slice(0, 8)

	const onDragStart = (e: DragEvent, task: BatchTask): void => {
		if (!canDragTask(task)) {
			e.preventDefault()
			return
		}
		setDraggingId(task.id)
		e.dataTransfer!.effectAllowed = 'move'
	}

	const onDragOver = (e: DragEvent, task: BatchTask): void => {
		if (!draggingId()) return
		if (!canDragTask(task)) return
		e.preventDefault()
		setDragOverId(task.id)
	}

	const onDrop = async (e: DragEvent, target: BatchTask): Promise<void> => {
		e.preventDefault()
		const sourceId = draggingId()
		setDraggingId(null)
		setDragOverId(null)
		if (!sourceId || sourceId === target.id) return

		const ordered = [...props.tasks]
		const sIdx = ordered.findIndex(t => t.id === sourceId)
		const tIdx = ordered.findIndex(t => t.id === target.id)
		if (sIdx < 0 || tIdx < 0) return

		const [moved] = ordered.splice(sIdx, 1)
		ordered.splice(tIdx, 0, moved)

		// 乐观更新
		props.onTasksUpdated(ordered.map((t, i) => ({ ...t, position: i })))
		try {
			const res = await props.client.reorderBatchTasks(props.batch.id, ordered.map(t => t.id))
			props.onTasksUpdated(res.tasks)
		} catch (err) {
			console.error('[BatchTaskTable] reorder 失败:', err)
			// 回滚（重拉）
			const r = await props.client.getBatchDetail(props.batch.id)
			props.onTasksUpdated(r.tasks)
		}
	}

	const onChangeOnFailure = async (task: BatchTask, value: string): Promise<void> => {
		try {
			const res = await props.client.updateBatchTask(props.batch.id, task.id, {
				onFailure: (value === '' ? null : value as OnFailureStrategy),
			})
			props.onTasksUpdated(props.tasks.map(t => t.id === task.id ? res.task : t))
		} catch (err) {
			console.error('[BatchTaskTable] update task 失败:', err)
		}
	}

	const onRetryTask = async (task: BatchTask): Promise<void> => {
		try {
			const res = await props.client.retryBatchTask(props.batch.id, task.id)
			props.onTasksUpdated(props.tasks.map(t => t.id === task.id ? res.task : t))
		} catch (err) {
			console.error('[BatchTaskTable] retry 失败:', err)
		}
	}

	const onSkipTask = async (task: BatchTask): Promise<void> => {
		try {
			const res = await props.client.skipBatchTask(props.batch.id, task.id)
			props.onTasksUpdated(props.tasks.map(t => t.id === task.id ? res.task : t))
		} catch (err) {
			console.error('[BatchTaskTable] skip 失败:', err)
		}
	}

	const onPauseBatch = async (): Promise<void> => {
		await props.client.updateBatch(props.batch.id, { status: 'paused' })
	}

	return (
		<div class="batch-task-table">
			<div class="batch-task-table-head">
				<span class="col-drag" />
				<span class="col-num">#</span>
				<span class="col-status">状态</span>
				<span class="col-workspace">项目</span>
				<span class="col-title">标题</span>
				<span class="col-on-failure">失败时</span>
				<span class="col-tokens">Token</span>
				<span class="col-action">操作</span>
			</div>
			<div class="batch-task-table-body">
				<For each={props.tasks}>
					{(task, index) => {
						const draggable = canDragTask(task)
						return (
							<div
								class={`batch-task-row batch-task-${task.status} ${dragOverId() === task.id ? 'drag-over' : ''}`}
								classList={{
									'is-dragging': draggingId() === task.id,
									'no-drag': !draggable,
								}}
								draggable={draggable}
								onDragStart={(e) => onDragStart(e, task)}
								onDragOver={(e) => onDragOver(e, task)}
								onDrop={(e) => void onDrop(e, task)}
								onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
							>
								<span class="col-drag" title={draggable ? '拖拽改变顺序' : '此任务状态下不能拖拽'}>
									{draggable ? '⋮' : ''}
								</span>
								<span class="col-num">{index() + 1}</span>
								<span class={`col-status status-${task.status}`} title={STATUS_LABELS[task.status]}>
									<span class="status-icon">{STATUS_ICONS[task.status]}</span>
									<span class="status-label">{STATUS_LABELS[task.status]}</span>
								</span>
								<span class="col-workspace" title={wsName(task.workspaceId)}>
									{wsName(task.workspaceId)}
								</span>
								<span class="col-title">
									<span class="task-title-text" title={task.title}>{task.title}</span>
									<Show when={task.status === 'failed' && task.failureReason}>
										<div class="task-failure-reason" title={task.failureReason}>
											↳ {task.failureReason!.slice(0, 60)}{task.failureReason!.length > 60 ? '...' : ''}
										</div>
									</Show>
								</span>
								<span class="col-on-failure">
									<select
										value={task.onFailure ?? ''}
										disabled={task.status === 'completed' || task.status === 'cancelled'}
										onChange={(e) => void onChangeOnFailure(task, e.currentTarget.value)}
									>
										<For each={ON_FAILURE_OPTIONS}>
											{(opt) => <option value={opt.value}>{opt.label}</option>}
										</For>
									</select>
								</span>
								<span class="col-tokens">
									{task.tokensUsed > 0 ? `${(task.tokensUsed / 1000).toFixed(1)}K` : '-'}
									<Show when={task.retryCount > 0}>
										<span class="task-retry-badge" title="重试次数">×{task.retryCount}</span>
									</Show>
								</span>
								<span class="col-action">
									<Show when={task.status === 'failed' && !task.failureAction}>
										<div class="task-failed-actions">
											<button class="btn-mini" onClick={() => void onRetryTask(task)}>重试</button>
											<button class="btn-mini" onClick={() => void onSkipTask(task)}>跳过</button>
											<button class="btn-mini btn-mini-danger" onClick={() => void onPauseBatch()}>暂停</button>
										</div>
									</Show>
									<Show when={task.status === 'stuck'}>
										<button class="btn-mini" onClick={() => void onRetryTask(task)}>重试</button>
									</Show>
									<Show when={task.sessionId && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')}>
										<button class="btn-mini btn-mini-ghost" onClick={() => {
											// 跳到 session（外部 handler 注入：todo 集成 router）
											console.log('[BatchTaskTable] 跳到 session:', task.sessionId)
										}}>📝 看日志</button>
									</Show>
								</span>
							</div>
						)
					}}
				</For>
			</div>
		</div>
	)
}
