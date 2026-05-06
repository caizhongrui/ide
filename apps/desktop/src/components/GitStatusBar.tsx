/*---------------------------------------------------------------------------------------------
 *  GitStatusBar — 左下角 git 分支显示 + 切分支弹窗（K11a 抽离自 App.tsx）
 *
 *  纯渲染：currentBranch / 分支列表 / 弹窗状态 / 切分支回调通过 props 注入；
 *  组件本身不调 server，全部副作用由 host 应用包装。
 *  ProcStats（进程资源监控）通过 children slot 传入，避免组件耦合 sidecar 模型。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component, JSX } from 'solid-js'

export interface GitStatusBarProps {
	/** 当前分支名；null = 非 git 仓库 */
	currentBranch:        () => string | null
	/** 是否正在显示分支选择器 */
	showBranchPicker:     () => boolean
	branchPickerBranches: () => string[]
	branchPickerLoading:  () => boolean
	branchPickerSearch:   () => string
	setBranchPickerSearch:(q: string) => void
	branchPickerRect:     () => { bottom: number; left: number }
	/** 是否处于活动 workspace（无则隐藏整个 bar） */
	hasWorkspace:         () => boolean
	/** 用户点分支按钮：host 决定加载分支列表 + 计算弹窗位置 */
	onOpenPicker:         (e: MouseEvent, btn: HTMLButtonElement) => void
	/** 用户切分支：host 调 server checkout */
	onSwitchBranch:       (branch: string) => void | Promise<void>
	/** 创建新分支按钮：host 跳转到 settings/worktree */
	onCreateBranch:       () => void
	/** 右侧 slot，typically <ProcStats /> */
	rightSlot?:           JSX.Element
}

export const GitStatusBar: Component<GitStatusBarProps> = (props) => {
	let gitBranchBtnRef: HTMLButtonElement | undefined

	return (
		<Show when={props.hasWorkspace()}>
			<div class="git-status-bar">
				<div class="git-status-left">
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-faint);flex-shrink:0">
						<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
					</svg>
					<Show when={props.currentBranch() !== null} fallback={
						<span class="git-status-text">非 Git 仓库</span>
					}>
						<button
							ref={gitBranchBtnRef}
							class="git-status-branch-btn"
							onClick={(e) => props.onOpenPicker(e, gitBranchBtnRef!)}
							title="切换分支"
						>
							{props.currentBranch()}
							<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<polyline points="6 9 12 15 18 9"/>
							</svg>
						</button>
					</Show>
				</div>
				{props.rightSlot}
			</div>
			{/* 分支选择弹窗 — fixed 定位避免被 overflow 裁剪 */}
			<Show when={props.showBranchPicker() && props.currentBranch() !== null}>
				<div
					class="branch-picker-popup"
					style={`position:fixed;bottom:${props.branchPickerRect().bottom}px;left:${props.branchPickerRect().left}px;z-index:9999`}
				>
					<div class="branch-picker-header">
						<input
							class="branch-picker-search"
							placeholder="搜索分支…"
							value={props.branchPickerSearch()}
							onInput={(e) => props.setBranchPickerSearch(e.currentTarget.value)}
							autofocus
						/>
					</div>
					<div class="branch-picker-list">
						<Show when={props.branchPickerLoading()}>
							<div class="branch-picker-loading">
								<span class="spinner" style="width:12px;height:12px;border-width:1.5px" />
							</div>
						</Show>
						<Show when={!props.branchPickerLoading()}>
							<For each={props.branchPickerBranches().filter(b => {
								const q = props.branchPickerSearch().toLowerCase()
								return !q || b.toLowerCase().includes(q)
							})}>
								{(b) => (
									<button
										class="branch-picker-item"
										classList={{ current: b === props.currentBranch() }}
										onClick={() => props.onSwitchBranch(b)}
									>
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;color:var(--text-faint)">
											<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
										</svg>
										<span class="branch-picker-name">{b}</span>
										<Show when={b === props.currentBranch()}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--accent);flex-shrink:0;margin-left:auto">
												<polyline points="20 6 9 17 4 12"/>
											</svg>
										</Show>
									</button>
								)}
							</For>
							<Show when={props.branchPickerBranches().filter(b => {
								const q = props.branchPickerSearch().toLowerCase()
								return !q || b.toLowerCase().includes(q)
							}).length === 0}>
								<div style="padding:10px 12px;font-size:11px;color:var(--text-faint)">无匹配分支</div>
							</Show>
						</Show>
					</div>
					<div class="branch-picker-footer">
						<button
							class="branch-picker-create-btn"
							onClick={props.onCreateBranch}
						>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
							</svg>
							创建并检出新分支…
						</button>
					</div>
				</div>
			</Show>
		</Show>
	)
}
