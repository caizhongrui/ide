/*---------------------------------------------------------------------------------------------
 *  BatchCreateForm — 新建批次表单（modal）
 *
 *  功能：
 *  - 批次名 + 描述
 *  - 高级配置（max_concurrency / on_failure 默认 / token 预算 / autoApprove）折叠面板
 *  - 任务行编辑（项目下拉 + 标题 + prompt + mode + on_failure）
 *  - "+ 添加任务" / "📥 JSON 导入" 两种添加方式
 *  - "保存草稿" / "立即开始"
 *--------------------------------------------------------------------------------------------*/

import { createSignal, For, Show } from 'solid-js'
import type { Component } from 'solid-js'
import type { MaxianClient, Workspace, OnFailureStrategy } from '@maxian/sdk'

interface Props {
	client:     MaxianClient
	workspaces: Workspace[]
	onClose:    () => void
	onCreated:  (batchId: string) => void | Promise<void>
}

interface DraftTask {
	workspaceId: string
	title:       string
	prompt:      string
	mode:        string
	onFailure:   OnFailureStrategy | ''
	maxRetry:    number
}

const MODE_OPTIONS = ['code', 'explore', 'plan', 'ask']
const ON_FAILURE_OPTIONS: Array<{ v: OnFailureStrategy | ''; label: string }> = [
	{ v: '',            label: '继承批次默认' },
	{ v: 'pause',       label: '暂停（等决策）' },
	{ v: 'skip',        label: '跳过' },
	{ v: 'retry',       label: '自动重试' },
	{ v: 'abort_batch', label: '取消整批' },
]

export const BatchCreateForm: Component<Props> = (props) => {
	const [name, setName] = createSignal('')
	const [description, setDescription] = createSignal('')
	const [maxConcurrency, setMaxConcurrency] = createSignal(3)
	const [batchOnFailure, setBatchOnFailure] = createSignal<OnFailureStrategy>('pause')
	const [tokenBudget, setTokenBudget] = createSignal<number | ''>('')
	const [autoApprove, setAutoApprove] = createSignal(true)
	const [showAdvanced, setShowAdvanced] = createSignal(false)
	const [tasks, setTasks] = createSignal<DraftTask[]>([emptyTask(props.workspaces[0]?.id ?? '')])
	const [importText, setImportText] = createSignal('')
	const [showImport, setShowImport] = createSignal(false)
	const [submitting, setSubmitting] = createSignal(false)
	const [error, setError] = createSignal('')

	function emptyTask(workspaceId: string): DraftTask {
		return { workspaceId, title: '', prompt: '', mode: 'code', onFailure: '', maxRetry: 3 }
	}

	const addTask = (): void => {
		setTasks(prev => [...prev, emptyTask(props.workspaces[0]?.id ?? '')])
	}
	const removeTask = (idx: number): void => {
		setTasks(prev => prev.filter((_, i) => i !== idx))
	}
	const updateTask = (idx: number, patch: Partial<DraftTask>): void => {
		setTasks(prev => prev.map((t, i) => i === idx ? { ...t, ...patch } : t))
	}

	const importJson = (): void => {
		try {
			const data = JSON.parse(importText().trim())
			if (!Array.isArray(data)) throw new Error('JSON 必须是任务对象数组')
			const imported: DraftTask[] = []
			for (const item of data) {
				if (!item.workspaceId && !item.workspace) {
					throw new Error('每个任务必须有 workspaceId（或 workspace 名）')
				}
				const wsId = item.workspaceId
					?? props.workspaces.find(w => w.name === item.workspace || w.path.endsWith(item.workspace))?.id
				if (!wsId) throw new Error(`找不到 workspace: ${item.workspace}`)
				if (!item.title || !item.prompt) throw new Error('每个任务必须有 title 和 prompt')
				imported.push({
					workspaceId: wsId,
					title:       String(item.title),
					prompt:      String(item.prompt),
					mode:        item.mode ?? 'code',
					onFailure:   item.onFailure ?? '',
					maxRetry:    item.maxRetry ?? 3,
				})
			}
			setTasks(imported)
			setImportText('')
			setShowImport(false)
			setError('')
		} catch (err) {
			setError(`JSON 解析失败：${(err as Error).message}`)
		}
	}

	const handleSubmit = async (autoStart: boolean): Promise<void> => {
		setError('')
		if (!name().trim()) {
			setError('请填批次名')
			return
		}
		const validTasks = tasks().filter(t => t.title.trim() && t.prompt.trim() && t.workspaceId)
		if (validTasks.length === 0) {
			setError('至少加一个任务（含项目 + 标题 + prompt）')
			return
		}
		setSubmitting(true)
		try {
			const res = await props.client.createBatch({
				name:           name().trim(),
				description:    description().trim() || undefined,
				maxConcurrency: maxConcurrency(),
				onFailure:      batchOnFailure(),
				tokenBudget:    tokenBudget() === '' ? undefined : Number(tokenBudget()),
				autoApprove:    autoApprove(),
				autoStart,
				tasks: validTasks.map(t => ({
					workspaceId: t.workspaceId,
					title:       t.title.trim(),
					prompt:      t.prompt.trim(),
					mode:        t.mode,
					onFailure:   t.onFailure || undefined,
					maxRetry:    t.maxRetry,
				})),
			})
			await props.onCreated(res.batch.id)
		} catch (err) {
			setError(`创建失败：${(err as Error).message}`)
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<div class="batch-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}>
			<div class="batch-modal">
				<header class="batch-modal-header">
					<h2>新建任务批次</h2>
					<button class="btn-ghost" onClick={props.onClose}>×</button>
				</header>

				<div class="batch-modal-body">
					{/* 基础字段 */}
					<div class="form-group">
						<label>批次名 *</label>
						<input value={name()} onInput={(e) => setName(e.currentTarget.value)}
							placeholder="如：周一类型修复" maxLength={200} />
					</div>
					<div class="form-group">
						<label>描述（可选）</label>
						<textarea value={description()} onInput={(e) => setDescription(e.currentTarget.value)}
							rows="2" placeholder="批次目标 / 备注" />
					</div>

					{/* 高级配置 */}
					<button class="btn-toggle-advanced" onClick={() => setShowAdvanced(v => !v)}>
						{showAdvanced() ? '▾' : '▸'} 高级配置
					</button>
					<Show when={showAdvanced()}>
						<div class="form-advanced">
							<div class="form-row">
								<label>并发上限</label>
								<input type="number" min={1} max={20} value={maxConcurrency()}
									onInput={(e) => setMaxConcurrency(Number(e.currentTarget.value) || 3)} />
							</div>
							<div class="form-row">
								<label>失败默认策略</label>
								<select value={batchOnFailure()} onChange={(e) => setBatchOnFailure(e.currentTarget.value as OnFailureStrategy)}>
									<option value="pause">暂停（等决策）</option>
									<option value="skip">跳过</option>
									<option value="retry">自动重试</option>
									<option value="abort_batch">取消整批</option>
								</select>
							</div>
							<div class="form-row">
								<label>Token 预算</label>
								<input type="number" min={0} value={tokenBudget()}
									onInput={(e) => setTokenBudget(e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))}
									placeholder="留空 = 无限" />
							</div>
							<div class="form-row">
								<label>
									<input type="checkbox" checked={autoApprove()}
										onChange={(e) => setAutoApprove(e.currentTarget.checked)} />
									Auto-approve（自动通过工具调用，黑名单仍硬拦）
								</label>
							</div>
						</div>
					</Show>

					{/* 任务列表 */}
					<div class="form-tasks-header">
						<label>任务列表（{tasks().length}）</label>
						<div class="form-tasks-actions">
							<button class="btn-ghost" onClick={addTask}>+ 添加任务</button>
							<button class="btn-ghost" onClick={() => setShowImport(v => !v)}>📥 JSON 导入</button>
						</div>
					</div>

					<Show when={showImport()}>
						<div class="form-import">
							<textarea
								class="form-import-textarea"
								rows="6"
								value={importText()}
								onInput={(e) => setImportText(e.currentTarget.value)}
								placeholder='[{"workspaceId":"...","title":"...","prompt":"...","mode":"code"}]'
							/>
							<div class="form-import-actions">
								<button class="btn-secondary" onClick={importJson}>解析导入</button>
								<button class="btn-ghost" onClick={() => setShowImport(false)}>取消</button>
							</div>
						</div>
					</Show>

					<For each={tasks()}>
						{(task, idx) => (
							<div class="form-task-row">
								<div class="form-task-num">{idx() + 1}</div>
								<div class="form-task-fields">
									<div class="form-task-row1">
										<select value={task.workspaceId} onChange={(e) => updateTask(idx(), { workspaceId: e.currentTarget.value })}>
											<For each={props.workspaces}>
												{(w) => <option value={w.id}>{w.name}</option>}
											</For>
										</select>
										<input value={task.title} onInput={(e) => updateTask(idx(), { title: e.currentTarget.value })}
											placeholder="任务标题" />
										<select value={task.mode} onChange={(e) => updateTask(idx(), { mode: e.currentTarget.value })}>
											<For each={MODE_OPTIONS}>{(m) => <option value={m}>{m}</option>}</For>
										</select>
										<select value={task.onFailure} onChange={(e) => updateTask(idx(), { onFailure: e.currentTarget.value as any })}>
											<For each={ON_FAILURE_OPTIONS}>{(o) => <option value={o.v}>{o.label}</option>}</For>
										</select>
										<button class="btn-mini btn-mini-danger" onClick={() => removeTask(idx())}>×</button>
									</div>
									<textarea
										class="form-task-prompt"
										rows="3"
										value={task.prompt}
										onInput={(e) => updateTask(idx(), { prompt: e.currentTarget.value })}
										placeholder="给 AI 的初始指令（要做什么、上下文、约束）"
									/>
								</div>
							</div>
						)}
					</For>

					<Show when={error()}>
						<div class="form-error">{error()}</div>
					</Show>
				</div>

				<footer class="batch-modal-footer">
					<button class="btn-ghost" onClick={props.onClose}>取消</button>
					<button class="btn-secondary" disabled={submitting()} onClick={() => void handleSubmit(false)}>
						保存草稿
					</button>
					<button class="btn-primary" disabled={submitting()} onClick={() => void handleSubmit(true)}>
						{submitting() ? '提交中...' : '▶ 立即开始'}
					</button>
				</footer>
			</div>
		</div>
	)
}
