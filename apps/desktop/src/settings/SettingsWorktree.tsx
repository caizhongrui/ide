/*---------------------------------------------------------------------------------------------
 *  SettingsWorktree — Git Worktree 管理面板（K11c-10：从 App.tsx 切出）
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal, onMount } from 'solid-js'
import type { Component } from 'solid-js'

export interface WorkspaceLike {
	id:   string
	name: string
	path: string
}

export interface WorktreeEntry {
	path:   string
	branch: string
	head:   string
	locked: boolean
}

export interface SettingsWorktreeProps {
	activeWorkspace:  () => WorkspaceLike | null
	getClient:        () => Promise<any>
	appConfirm:       (msg: string) => Promise<boolean>
}

export const SettingsWorktree: Component<SettingsWorktreeProps> = (props) => {
	const [worktrees, setWorktrees] = createSignal<WorktreeEntry[]>([])
	const [branches, setBranches] = createSignal<string[]>([])
	const [loading, setLoading] = createSignal(false)
	const [error, setError] = createSignal('')
	const [isGitRepo, setIsGitRepo] = createSignal(true)
	const [newBranch, setNewBranch] = createSignal('')
	const [fromBranch, setFromBranch] = createSignal('')
	const [creating, setCreating] = createSignal(false)

	const ws = props.activeWorkspace()

	onMount(async () => {
		if (!ws) return
		setLoading(true)
		try {
			const c = await props.getClient()
			const [wt, br] = await Promise.all([
				c.listWorktrees(ws.id),
				c.listBranches(ws.id),
			])
			const gitRepo = (wt as any).isGitRepo !== false
			setIsGitRepo(gitRepo)
			setWorktrees(wt.worktrees ?? [])
			setBranches(br.branches ?? [])
			if (br.branches?.length) setFromBranch(br.branches[0])
			if ((wt as any).error) setError((wt as any).error)
		} catch (e) {
			setError(String((e as Error)?.message ?? e))
		} finally {
			setLoading(false)
		}
	})

	const addWorktree = async (): Promise<void> => {
		if (!ws || !newBranch().trim()) return
		setCreating(true)
		setError('')
		try {
			const c = await props.getClient()
			const res = await c.createWorktree(ws.id, {
				branch: fromBranch(),
				newBranch: newBranch().trim(),
			})
			if (res.ok) {
				setNewBranch('')
				const wt = await c.listWorktrees(ws.id)
				setWorktrees(wt.worktrees ?? [])
			} else {
				setError(res.error ?? '创建失败')
			}
		} catch (e) {
			setError(String((e as Error)?.message ?? e))
		} finally {
			setCreating(false)
		}
	}

	const removeWorktree = async (wtPath: string): Promise<void> => {
		if (!ws) return
		const ok = await props.appConfirm(`确定要删除 Worktree？\n${wtPath}\n\n注意：只删除 worktree，不删除分支。`)
		if (!ok) return
		try {
			const c = await props.getClient()
			const res = await c.removeWorktree(ws.id, wtPath)
			if (res.ok) {
				const wt = await c.listWorktrees(ws.id)
				setWorktrees(wt.worktrees ?? [])
			} else {
				setError(res.error ?? '删除失败')
			}
		} catch (e) {
			setError(String((e as Error)?.message ?? e))
		}
	}

	return (
		<>
			<div class="settings-title">Git Worktree 管理</div>
			<Show when={!ws}>
				<div class="settings-group">
					<div style="color:var(--text-muted);padding:20px;text-align:center;font-size:13px">请先在左侧选择一个工作区</div>
				</div>
			</Show>
			<Show when={!!ws && !isGitRepo()}>
				<div class="settings-group">
					<div style="color:var(--text-muted);padding:20px;text-align:center;font-size:13px">
						<div style="font-size:24px;margin-bottom:8px">📁</div>
						当前工作区不是 Git 仓库<br />
						<span style="font-size:11px">Worktree 管理仅适用于 Git 仓库</span>
					</div>
				</div>
			</Show>
			<Show when={!!ws && isGitRepo()}>
				<Show when={error()}>
					<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#f87171">
						{error()}
					</div>
				</Show>
				<div class="settings-group">
					<div class="settings-group-title">当前 Worktrees</div>
					<div class="settings-card">
						<Show when={loading()}>
							<div style="text-align:center;padding:20px;color:var(--text-muted)">
								<span class="spinner" style="width:16px;height:16px" />
							</div>
						</Show>
						<Show when={!loading() && worktrees().length === 0}>
							<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">此仓库没有额外的 worktrees</div>
						</Show>
						<For each={worktrees()}>
							{(wt) => (
								<div class="settings-row" style="align-items:flex-start;gap:8px">
									<div class="settings-row-label" style="flex:1;min-width:0">
										<div class="settings-row-name" style="font-family:monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
											{wt.branch || '（分离 HEAD）'}
										</div>
										<div class="settings-row-desc" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">
											{wt.path} · {wt.head}
										</div>
									</div>
									<div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
										<Show when={wt.locked}>
											<span style="font-size:10px;color:var(--text-faint);background:var(--bg-muted);padding:1px 5px;border-radius:3px">锁定</span>
										</Show>
										<button
											class="btn btn-ghost"
											style="font-size:11px;padding:3px 8px"
											onClick={() => removeWorktree(wt.path)}
											disabled={wt.locked}
										>
											移除
										</button>
									</div>
								</div>
							)}
						</For>
					</div>
				</div>

				<div class="settings-group">
					<div class="settings-group-title">创建新 Worktree</div>
					<div class="settings-card">
						<div class="settings-row">
							<div class="settings-row-label">
								<div class="settings-row-name">新分支名</div>
								<div class="settings-row-desc">新 worktree 使用的分支名称</div>
							</div>
							<input
								class="settings-input"
								placeholder="feature/my-branch"
								value={newBranch()}
								onInput={(e) => setNewBranch(e.currentTarget.value)}
							/>
						</div>
						<div class="settings-row">
							<div class="settings-row-label">
								<div class="settings-row-name">基于分支</div>
								<div class="settings-row-desc">从哪个分支创建</div>
							</div>
							<select
								class="settings-select"
								value={fromBranch()}
								onChange={(e) => setFromBranch(e.currentTarget.value)}
							>
								<For each={branches()}>
									{(b) => <option value={b}>{b}</option>}
								</For>
							</select>
						</div>
						<div class="settings-row" style="justify-content:flex-end">
							<button
								class="btn btn-primary"
								onClick={addWorktree}
								disabled={!newBranch().trim() || creating()}
							>
								<Show when={creating()} fallback="创建 Worktree">
									<span class="spinner" style="width:12px;height:12px;border-width:1.5px;border-color:rgba(255,255,255,0.3);border-top-color:#fff" />
									创建中…
								</Show>
							</button>
						</div>
					</div>
				</div>
			</Show>
		</>
	)
}
