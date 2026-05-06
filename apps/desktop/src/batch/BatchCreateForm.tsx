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
import { createStore, produce } from 'solid-js/store'
import type { Component } from 'solid-js'
import type { MaxianClient, Workspace, OnFailureStrategy, TaskBatch, BatchTask } from '@maxian/sdk'

interface Props {
	client:     MaxianClient
	workspaces: Workspace[]
	/** 编辑现有 draft 批次时传入；undefined = 新建模式 */
	editingBatch?: { batch: TaskBatch; tasks: BatchTask[] }
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
	const isEditing = !!props.editingBatch

	// 编辑模式：从已有 batch + tasks 初始化
	const initBatch = props.editingBatch?.batch
	const initTasks: DraftTask[] = props.editingBatch?.tasks.map(t => ({
		workspaceId: t.workspaceId,
		title:       t.title,
		prompt:      t.prompt,
		mode:        t.mode,
		onFailure:   t.onFailure ?? '',
		maxRetry:    t.maxRetry,
	})) ?? [emptyTask(props.workspaces[0]?.id ?? '')]

	const [name, setName] = createSignal(initBatch?.name ?? '')
	const [description, setDescription] = createSignal(initBatch?.description ?? '')
	const [maxConcurrency, setMaxConcurrency] = createSignal(initBatch?.maxConcurrency ?? 3)
	const [batchOnFailure, setBatchOnFailure] = createSignal<OnFailureStrategy>(initBatch?.onFailure ?? 'pause')
	const [tokenBudget, setTokenBudget] = createSignal<number | ''>(initBatch?.tokenBudget ?? '')
	const [autoApprove, setAutoApprove] = createSignal(initBatch?.autoApprove ?? true)
	const [showAdvanced, setShowAdvanced] = createSignal(false)
	// 用 createStore 而非 createSignal：
	// <For> 按引用判等，setSignal(prev.map(...)) 会把改动行的 ref 换掉 → 该行卸载重建 → input 丢焦点 → 输一个字就不能再输入。
	// store 走细粒度路径访问，仅触发被改字段的依赖，不动 item 引用，input 保持挂载。
	const [tasks, setTasks] = createStore<DraftTask[]>(initTasks)
	const [importText, setImportText] = createSignal('')
	const [showImport, setShowImport] = createSignal(false)
	const [submitting, setSubmitting] = createSignal(false)
	const [error, setError] = createSignal('')

	function emptyTask(workspaceId: string): DraftTask {
		return { workspaceId, title: '', prompt: '', mode: 'code', onFailure: '', maxRetry: 3 }
	}

	const addTask = (): void => {
		setTasks(produce((arr: DraftTask[]) => {
			arr.push(emptyTask(props.workspaces[0]?.id ?? ''))
		}))
	}
	const removeTask = (idx: number): void => {
		setTasks(produce((arr: DraftTask[]) => {
			arr.splice(idx, 1)
		}))
	}
	const updateTask = (idx: number, patch: Partial<DraftTask>): void => {
		// 用 produce 显式 mutate 字段：避免 setTasks(idx, partial) 在某些情况下被 TS / store
		// 错误识别为整对象替换 → 字段路径不通知 → UI 不更新
		setTasks(produce((arr: DraftTask[]) => {
			if (arr[idx]) Object.assign(arr[idx], patch)
		}))
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
			// store 整体替换：用 reconcile 风格——直接给数组形态写入
			setTasks(produce(arr => { arr.length = 0; arr.push(...imported) }))
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
		const validTasks = tasks.filter(t => t.title.trim() && t.prompt.trim() && t.workspaceId)
		if (validTasks.length === 0) {
			setError('至少加一个任务（含项目 + 标题 + prompt）')
			return
		}
		const taskPayload = validTasks.map(t => ({
			workspaceId: t.workspaceId,
			title:       t.title.trim(),
			prompt:      t.prompt.trim(),
			mode:        t.mode,
			onFailure:   (t.onFailure || undefined) as OnFailureStrategy | undefined,
			maxRetry:    t.maxRetry,
		}))
		setSubmitting(true)
		try {
			let batchId: string
			if (isEditing && initBatch) {
				// 编辑模式：先 PATCH batch 配置，再 POST replace-tasks
				await props.client.updateBatch(initBatch.id, {
					name:           name().trim(),
					description:    description().trim() || undefined,
					maxConcurrency: maxConcurrency(),
					onFailure:      batchOnFailure(),
					tokenBudget:    tokenBudget() === '' ? null : Number(tokenBudget()),
					autoApprove:    autoApprove(),
				})
				await props.client.replaceBatchTasks(initBatch.id, taskPayload)
				batchId = initBatch.id
				// 编辑后如果用户点"立即开始"，再发一次 status='running'
				if (autoStart) {
					await props.client.updateBatch(initBatch.id, { status: 'running' })
				}
			} else {
				// 新建模式
				const res = await props.client.createBatch({
					name:           name().trim(),
					description:    description().trim() || undefined,
					maxConcurrency: maxConcurrency(),
					onFailure:      batchOnFailure(),
					tokenBudget:    tokenBudget() === '' ? undefined : Number(tokenBudget()),
					autoApprove:    autoApprove(),
					autoStart,
					tasks: taskPayload,
				})
				batchId = res.batch.id
			}
			await props.onCreated(batchId)
		} catch (err) {
			setError(`${isEditing ? '保存' : '创建'}失败：${(err as Error).message}`)
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<div class="batch-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}>
			<div class="batch-modal">
				<header class="batch-modal-header">
					<h2>{isEditing ? '编辑任务批次' : '新建任务批次'}</h2>
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
						<label>任务列表（{tasks.length}）</label>
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

					<For each={tasks}>
						{(task, idx) => (
							<div class="form-task-card">
								<div class="form-task-card-head">
									<span class="form-task-badge">#{idx() + 1}</span>
									<span class="form-task-ws-pill" title="所属项目">
										{props.workspaces.find(w => w.id === task.workspaceId)?.name ?? '(未选项目)'}
									</span>
									<span class="form-task-spacer" />
									<button class="form-task-delete" onClick={() => removeTask(idx())} title="删除此任务">
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<polyline points="3 6 5 6 21 6"/>
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
										</svg>
									</button>
								</div>
								<input
									class="form-task-title"
									value={task.title}
									onInput={(e) => updateTask(idx(), { title: e.currentTarget.value })}
									placeholder="任务标题（如：修 OrderService 的 NPE）"
								/>
								<textarea
									class="form-task-prompt"
									rows="3"
									value={task.prompt}
									onInput={(e) => updateTask(idx(), { prompt: e.currentTarget.value })}
									placeholder="给 AI 的初始指令：要做什么、上下文（错误堆栈/相关文件）、约束（不要改 X / 必须保留 Y）"
								/>
								<div class="form-task-options">
									<label class="form-task-opt">
										<span class="form-task-opt-label">项目</span>
										<select value={task.workspaceId} onChange={(e) => updateTask(idx(), { workspaceId: e.currentTarget.value })}>
											<For each={props.workspaces}>
												{(w) => <option value={w.id}>{w.name}</option>}
											</For>
										</select>
									</label>
									<label class="form-task-opt">
										<span class="form-task-opt-label">模式</span>
										<select value={task.mode} onChange={(e) => updateTask(idx(), { mode: e.currentTarget.value })}>
											<For each={MODE_OPTIONS}>{(m) => <option value={m}>{m}</option>}</For>
										</select>
									</label>
									<label class="form-task-opt">
										<span class="form-task-opt-label">失败时</span>
										<select value={task.onFailure} onChange={(e) => updateTask(idx(), { onFailure: e.currentTarget.value as any })}>
											<For each={ON_FAILURE_OPTIONS}>{(o) => <option value={o.v}>{o.label}</option>}</For>
										</select>
									</label>
								</div>
							</div>
						)}
					</For>

					<Show when={error()}>
						<div class="form-error">{error()}</div>
					</Show>
				</div>

				<footer class="batch-modal-footer">
					<button class="btn-ghost" onMouseDown={props.onClose}>取消</button>
					{/*
						⚠️ 关键：用 onMouseDown 而不是 onClick。原因：
						用户在某 input/select 里编辑，点"保存"时浏览器先 fire blur → 该 input 的 onChange
						触发 store 更新 → store 通知触发部分重渲染 → 期间按钮位置可能微动 →
						mouseup 落在新位置但 mousedown 锁的是旧位置 → click 事件不 fire → 必须再点一次。
						用 mousedown 直接捕获按下动作，绕过这个时序坑。
					*/}
					<button class="btn-secondary" disabled={submitting()} onMouseDown={() => void handleSubmit(false)}>
						{isEditing ? '💾 保存修改' : '保存草稿'}
					</button>
					<button class="btn-primary" disabled={submitting()} onMouseDown={() => void handleSubmit(true)}>
						{submitting() ? '提交中...' : (isEditing ? '💾 保存并开始' : '▶ 立即开始')}
					</button>
				</footer>
			</div>
		</div>
	)
}
