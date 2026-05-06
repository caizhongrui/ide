/*---------------------------------------------------------------------------------------------
 *  BatchPanel — 批量任务主面板（v0.2.16+）
 *
 *  布局：左侧批次列表 + 右侧批次详情。
 *  顶部"+ 新建批次"按钮调出 BatchCreateForm modal。
 *
 *  挂载点：App.tsx 顶导航第三 tab（"任务批次"）激活时显示。
 *--------------------------------------------------------------------------------------------*/

import { createSignal, createEffect, onCleanup, onMount, Show, For } from 'solid-js'
import type { Component } from 'solid-js'
import type { MaxianClient, TaskBatch, BatchTask, BatchEvent, Workspace } from '@maxian/sdk'
import { BatchListItem } from './BatchListItem'
import { BatchDetailPanel } from './BatchDetailPanel'
import { BatchCreateForm } from './BatchCreateForm'

interface Props {
	client:     MaxianClient
	workspaces: Workspace[]
	/** 当前 globalMode（chat/code），用于顶部三段式高亮 */
	currentMode:    'chat' | 'code'
	onSwitchToChat: () => void
	onSwitchToCode: () => void
	/** 看日志：关闭批次面板 + 切到对应会话 */
	onJumpToSession: (sessionId: string, workspaceId: string) => void
}

export const BatchPanel: Component<Props> = (props) => {
	const [batches, setBatches] = createSignal<TaskBatch[]>([])
	const [selectedBatchId, setSelectedBatchId] = createSignal<string | null>(null)
	const [currentBatchTasks, setCurrentBatchTasks] = createSignal<BatchTask[]>([])
	const [showCreateForm, setShowCreateForm] = createSignal(false)
	/** 编辑模式：传入则 form 进入编辑现有 batch 状态 */
	const [editingBatch, setEditingBatch] = createSignal<{ batch: TaskBatch; tasks: BatchTask[] } | null>(null)
	const [loading, setLoading] = createSignal(false)
	const [statusFilter, setStatusFilter] = createSignal<'all' | 'running' | 'paused' | 'completed' | 'aborted'>('all')

	let unsubBatchEvents: (() => void) | null = null

	/** 拉批次列表 */
	const refreshBatches = async (): Promise<void> => {
		try {
			const filter = statusFilter() === 'all' ? undefined : { status: statusFilter() as any }
			const res = await props.client.listBatches(filter)
			setBatches(res.batches)
		} catch (err) {
			console.error('[BatchPanel] 拉批次列表失败:', err)
		}
	}

	/** 拉某批次详情（含任务列表） */
	const loadBatchDetail = async (batchId: string): Promise<void> => {
		setLoading(true)
		try {
			const res = await props.client.getBatchDetail(batchId)
			setCurrentBatchTasks(res.tasks)
			// 同时把列表里这个批次更新一下（带最新统计）
			setBatches(prev => prev.map(b => b.id === batchId ? res.batch : b))
		} catch (err) {
			console.error('[BatchPanel] 拉批次详情失败:', err)
		} finally {
			setLoading(false)
		}
	}

	/** 选中批次 → 拉详情 + 订阅 SSE */
	const selectBatch = async (batchId: string): Promise<void> => {
		setSelectedBatchId(batchId)
		try { unsubBatchEvents?.() } catch { /* ignore */ }
		await loadBatchDetail(batchId)

		unsubBatchEvents = props.client.subscribeBatchEvents(
			batchId,
			(event: BatchEvent) => handleBatchEvent(batchId, event),
			(err) => console.warn('[BatchPanel] SSE error:', err),
		)
	}

	/** 处理 SSE 事件，实时更新本地状态 */
	const handleBatchEvent = (batchId: string, event: BatchEvent): void => {
		if (event.type === 'task_status_changed') {
			setCurrentBatchTasks(prev => prev.map(t =>
				t.id === event.taskId
					? { ...t, status: event.status, failureReason: event.failureReason ?? t.failureReason }
					: t,
			))
		} else if (event.type === 'task_progress') {
			setCurrentBatchTasks(prev => prev.map(t =>
				t.id === event.taskId ? { ...t, tokensUsed: event.tokensUsed } : t,
			))
		} else if (event.type === 'batch_progress') {
			setBatches(prev => prev.map(b => b.id === batchId
				? { ...b, completedCount: event.completedCount, failedCount: event.failedCount,
				    skippedCount: event.skippedCount, tokensUsed: event.tokensUsed }
				: b))
		} else if (event.type === 'batch_status_changed') {
			setBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: event.status } : b))
		} else if (event.type === 'task_heartbeat') {
			setCurrentBatchTasks(prev => prev.map(t =>
				t.id === event.taskId ? { ...t, lastHeartbeat: event.lastHeartbeat } : t,
			))
		}
	}

	onMount(() => { void refreshBatches() })
	createEffect(() => { statusFilter(); void refreshBatches() })
	onCleanup(() => { try { unsubBatchEvents?.() } catch { /* ignore */ } })

	const selectedBatch = (): TaskBatch | undefined =>
		batches().find(b => b.id === selectedBatchId())

	return (
		<div class="batch-panel-wrap">
			{/* 顶部三段式（替代原 sidebar header） */}
			<div class="batch-top-toolbar">
				<div class="mode-segmented">
					<button class="mode-seg-btn" onClick={props.onSwitchToChat} title="Chat — 智能对话">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
						</svg>
						Chat
					</button>
					<button class="mode-seg-btn" onClick={props.onSwitchToCode} title="Code — 智能编码 Agent">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
							<polyline points="16 18 22 12 16 6"/>
							<polyline points="8 6 2 12 8 18"/>
						</svg>
						Code
					</button>
					<button class="mode-seg-btn active" title="Task — 批量给项目派任务">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
							<rect x="3" y="3" width="7" height="7"/>
							<rect x="14" y="3" width="7" height="7"/>
							<rect x="3" y="14" width="7" height="7"/>
							<rect x="14" y="14" width="7" height="7"/>
						</svg>
						Task
					</button>
				</div>
			</div>

			<div class="batch-panel">
			{/* 左侧：批次列表 */}
			<aside class="batch-list-pane">
				<header class="batch-list-header">
					<h3>任务批次</h3>
					<button class="btn-primary" onClick={() => setShowCreateForm(true)}>
						+ 新建
					</button>
				</header>
				<div class="batch-list-filter">
					<For each={[
						{ k: 'all', label: '全部' },
						{ k: 'running', label: '执行中' },
						{ k: 'paused', label: '暂停' },
						{ k: 'completed', label: '完成' },
					] as const}>
						{(f) => (
							<button
								class={`btn-chip ${statusFilter() === f.k ? 'active' : ''}`}
								onClick={() => setStatusFilter(f.k as any)}
							>
								{f.label}
							</button>
						)}
					</For>
				</div>
				<div class="batch-list-body">
					<Show when={batches().length === 0}>
						<div class="batch-empty">暂无批次</div>
					</Show>
					<For each={batches()}>
						{(b) => (
							<BatchListItem
								batch={b}
								selected={selectedBatchId() === b.id}
								onClick={() => void selectBatch(b.id)}
							/>
						)}
					</For>
				</div>
			</aside>

			{/* 右侧：批次详情 */}
			<main class="batch-detail-pane">
				<Show when={selectedBatch()} fallback={
					<div class="batch-empty-detail">从左侧选一个批次查看详情，或点"+ 新建"创建新批次</div>
				}>
					{(batch) => (
						<BatchDetailPanel
							client={props.client}
							batch={batch()}
							tasks={currentBatchTasks()}
							workspaces={props.workspaces}
							loading={loading()}
							onRefresh={() => void loadBatchDetail(batch().id)}
							onTasksUpdated={(tasks) => setCurrentBatchTasks(tasks)}
							onEditBatch={() => setEditingBatch({ batch: batch(), tasks: currentBatchTasks() })}
							onJumpToSession={props.onJumpToSession}
						/>
					)}
				</Show>
			</main>

			{/* 新建批次表单 */}
			<Show when={showCreateForm()}>
				<BatchCreateForm
					client={props.client}
					workspaces={props.workspaces}
					onClose={() => setShowCreateForm(false)}
					onCreated={async (batchId) => {
						setShowCreateForm(false)
						await refreshBatches()
						await selectBatch(batchId)
					}}
				/>
			</Show>

			{/* 编辑现有 draft 批次表单（reuse 同一个组件，传 editingBatch） */}
			<Show when={editingBatch()}>
				{(eb) => (
					<BatchCreateForm
						client={props.client}
						workspaces={props.workspaces}
						editingBatch={eb()}
						onClose={() => setEditingBatch(null)}
						onCreated={async (batchId) => {
							setEditingBatch(null)
							await refreshBatches()
							await loadBatchDetail(batchId)
						}}
					/>
				)}
			</Show>
			</div>
		</div>
	)
}
