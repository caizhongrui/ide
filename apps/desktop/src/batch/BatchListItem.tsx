/*---------------------------------------------------------------------------------------------
 *  BatchListItem — 左侧批次列表中单个批次条目
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'
import type { TaskBatch, BatchStatus } from '@maxian/sdk'

interface Props {
	batch:    TaskBatch
	selected: boolean
	onClick:  () => void
}

const STATUS_LABELS: Record<BatchStatus, string> = {
	draft:         '草稿',
	running:       '执行中',
	paused:        '暂停',
	awaiting_user: '等决策',
	completed:     '完成',
	aborted:       '已取消',
}

const STATUS_ICONS: Record<BatchStatus, string> = {
	draft:         '✎',
	running:       '▶',
	paused:        '⏸',
	awaiting_user: '⚠',
	completed:     '✓',
	aborted:       '⊗',
}

function formatTime(ts: number): string {
	const d = new Date(ts)
	const now = new Date()
	const isToday = d.toDateString() === now.toDateString()
	const pad = (n: number) => n.toString().padStart(2, '0')
	if (isToday) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
	return `${d.getMonth() + 1}/${pad(d.getDate())}`
}

export const BatchListItem: Component<Props> = (props) => {
	const progress = (): number => {
		const total = props.batch.totalTasks
		if (total === 0) return 0
		const done = props.batch.completedCount + props.batch.failedCount + props.batch.skippedCount
		return Math.round((done / total) * 100)
	}

	return (
		<div
			class={`batch-list-item ${props.selected ? 'selected' : ''} batch-status-${props.batch.status}`}
			onClick={props.onClick}
		>
			<div class="batch-list-item-row1">
				<span class="batch-status-icon">{STATUS_ICONS[props.batch.status]}</span>
				<span class="batch-name" title={props.batch.name}>{props.batch.name}</span>
				<span class="batch-time">{formatTime(props.batch.updatedAt)}</span>
			</div>
			<div class="batch-list-item-row2">
				<span class="batch-status-label">{STATUS_LABELS[props.batch.status]}</span>
				<span class="batch-counts">
					{props.batch.completedCount}/{props.batch.totalTasks}
					<Show when={props.batch.failedCount > 0}>
						<span class="batch-failed-count"> · ✗{props.batch.failedCount}</span>
					</Show>
				</span>
			</div>
			<div class="batch-progress-bar">
				<div class="batch-progress-fill" style={{ width: `${progress()}%` }} />
			</div>
		</div>
	)
}
