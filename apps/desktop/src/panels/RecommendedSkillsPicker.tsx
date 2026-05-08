/*---------------------------------------------------------------------------------------------
 *  RecommendedSkillsPicker — 内置推荐技能库选择器（K11d）
 *
 *  渲染：
 *    - 调 invoke('list_bundled_skills') 拿 manifest
 *    - 按 group 分类展示（core 默认勾选 + 已装提示，stack 用户按需勾选）
 *    - 点"安装" → invoke('install_bundled_skills', { args: { skill_ids } })
 *    - 安装结果通过 toast 反馈，并触发上层重新扫描
 *--------------------------------------------------------------------------------------------*/

import { createSignal, createEffect, For, Show } from 'solid-js'
import type { Component } from 'solid-js'

interface BundledSkill {
	id:          string
	file:        string
	name:        string
	description: string
	tags?:       string[]
}

interface BundledGroup {
	id:          string
	title:       string
	description: string
	autoInstall: boolean
	skills:      BundledSkill[]
}

interface BundledManifest {
	version:     number
	description: string
	groups:      BundledGroup[]
}

interface InstallResult {
	installed:  string[]
	skipped:    string[]
	failed:     [string, string][]
	target_dir: string
}

export interface RecommendedSkillsPickerProps {
	open:           () => boolean
	onClose:        () => void
	/** 已存在的 skill 名（用于显示已安装标记） */
	installedNames: () => Set<string>
	/** 安装完成后通知上层重新加载 skills 列表 */
	onInstalled:    () => void | Promise<void>
	/** Toast 反馈 */
	showToast:      (opts: { message: string; kind?: 'info' | 'success' | 'warn' | 'error'; duration?: number }) => void
}

export const RecommendedSkillsPicker: Component<RecommendedSkillsPickerProps> = (props) => {
	const [manifest, setManifest] = createSignal<BundledManifest | null>(null)
	const [loading, setLoading] = createSignal(false)
	const [installing, setInstalling] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)
	const [selected, setSelected] = createSignal<Set<string>>(new Set())

	// 打开时拉 manifest（首次或每次都拉，反正很快）
	createEffect(() => {
		if (!props.open()) return
		setError(null)
		setLoading(true)
		void (async () => {
			try {
				const core = await import('@tauri-apps/api/core' as any)
				const invoke = core.invoke as <T>(cmd: string, args?: any) => Promise<T>
				const m = await invoke<BundledManifest>('list_bundled_skills')
				setManifest(m)
				// 默认勾选所有 stack 组里的"未安装"项
				const defaultSel = new Set<string>()
				const installed = props.installedNames()
				for (const g of m.groups) {
					if (g.autoInstall) continue
					for (const s of g.skills) {
						if (!installed.has(s.id)) defaultSel.add(s.id)
					}
				}
				setSelected(defaultSel)
			} catch (e) {
				setError(`无法加载内置技能库：${(e as Error).message ?? e}`)
			} finally {
				setLoading(false)
			}
		})()
	})

	const toggle = (id: string): void => {
		setSelected(prev => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}

	const selectAllInGroup = (group: BundledGroup): void => {
		setSelected(prev => {
			const next = new Set(prev)
			for (const s of group.skills) next.add(s.id)
			return next
		})
	}

	const clearAllInGroup = (group: BundledGroup): void => {
		setSelected(prev => {
			const next = new Set(prev)
			for (const s of group.skills) next.delete(s.id)
			return next
		})
	}

	const doInstall = async (): Promise<void> => {
		const ids = Array.from(selected())
		if (ids.length === 0) {
			props.showToast({ message: '请先勾选要安装的技能', kind: 'warn' })
			return
		}
		setInstalling(true)
		try {
			const core = await import('@tauri-apps/api/core' as any)
			const invoke = core.invoke as <T>(cmd: string, args?: any) => Promise<T>
			const result = await invoke<InstallResult>('install_bundled_skills', {
				args: { skill_ids: ids, target: 'user', overwrite: false },
			})
			const okCount = result.installed.length
			const skipCount = result.skipped.length
			const failCount = result.failed.length
			let msg = `安装完成：新装 ${okCount} 个`
			if (skipCount > 0) msg += `，已存在跳过 ${skipCount} 个`
			if (failCount > 0) msg += `，${failCount} 个失败`
			props.showToast({
				message: msg,
				kind: failCount > 0 ? 'warn' : 'success',
				duration: 4000,
			})
			await props.onInstalled()
			if (failCount === 0) props.onClose()
		} catch (e) {
			props.showToast({
				message: `安装失败：${(e as Error).message ?? e}`,
				kind: 'error',
				duration: 5000,
			})
		} finally {
			setInstalling(false)
		}
	}

	const isInstalled = (skill: BundledSkill): boolean => props.installedNames().has(skill.id)

	return (
		<Show when={props.open()}>
			<div
				class="modal-backdrop"
				style="position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;display:flex;align-items:center;justify-content:center"
				onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
			>
				<div
					class="modal-panel"
					style="background:var(--bg-base);border:1px solid var(--border-base);border-radius:10px;width:min(720px, 92vw);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.35)"
				>
					{/* 头部 */}
					<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border-base)">
						<div>
							<div style="font-size:14px;font-weight:600;color:var(--text-base)">📦 推荐技能库</div>
							<div style="font-size:11px;color:var(--text-muted);margin-top:2px">
								勾选要安装的技能，安装到 <code>~/.maxian/skills/maxian-builtin/</code>
							</div>
						</div>
						<button
							class="icon-btn"
							onClick={props.onClose}
							title="关闭"
							style="padding:6px"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>

					{/* 内容 */}
					<div style="flex:1;overflow-y:auto;padding:14px 18px">
						<Show when={loading()}>
							<div style="text-align:center;color:var(--text-muted);padding:40px">加载中…</div>
						</Show>
						<Show when={!loading() && error()}>
							<div style="color:#ef4444;padding:12px;background:rgba(239,68,68,0.08);border-radius:6px;font-size:12px">
								{error()}
							</div>
						</Show>
						<Show when={!loading() && manifest()}>
							<For each={manifest()!.groups}>
								{(group) => (
									<div style="margin-bottom:18px">
										<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
											<div>
												<div style="font-size:12px;font-weight:600;color:var(--text-base)">
													{group.title}
													<Show when={group.autoInstall}>
														<span style="margin-left:6px;font-size:10px;color:#22c55e;background:rgba(34,197,94,0.12);padding:1px 6px;border-radius:3px;font-weight:500">已默认安装</span>
													</Show>
												</div>
												<div style="font-size:11px;color:var(--text-muted);margin-top:2px">{group.description}</div>
											</div>
											<div style="display:flex;gap:6px;font-size:11px">
												<button
													class="btn btn-ghost"
													style="padding:3px 8px;font-size:11px"
													onClick={() => selectAllInGroup(group)}
												>
													全选
												</button>
												<button
													class="btn btn-ghost"
													style="padding:3px 8px;font-size:11px"
													onClick={() => clearAllInGroup(group)}
												>
													清空
												</button>
											</div>
										</div>
										<div style="display:flex;flex-direction:column;gap:6px">
											<For each={group.skills}>
												{(skill) => {
													const installed = isInstalled(skill)
													const checked = (): boolean => selected().has(skill.id)
													return (
														<label
															style={`display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-subtle);border:1px solid ${checked() ? 'var(--accent)' : 'var(--border-base)'};border-radius:6px;cursor:pointer;transition:border-color 0.15s`}
														>
															<input
																type="checkbox"
																checked={checked()}
																onChange={() => toggle(skill.id)}
																style="margin-top:2px;flex-shrink:0"
															/>
															<div style="flex:1;min-width:0">
																<div style="display:flex;align-items:center;gap:6px">
																	<span style="font-size:12px;font-weight:600;color:var(--text-base)">{skill.name}</span>
																	<Show when={installed}>
																		<span style="font-size:10px;color:#22c55e;background:rgba(34,197,94,0.12);padding:1px 5px;border-radius:3px">已安装</span>
																	</Show>
																</div>
																<div style="font-size:11px;color:var(--text-muted);margin-top:3px;line-height:1.5">{skill.description}</div>
																<Show when={skill.tags && skill.tags.length > 0}>
																	<div style="display:flex;gap:4px;margin-top:5px;flex-wrap:wrap">
																		<For each={skill.tags!}>
																			{(t) => (
																				<span style="font-size:9px;color:var(--text-faint);background:var(--bg-base);padding:1px 5px;border-radius:3px;border:1px solid var(--border-base)">
																					{t}
																				</span>
																			)}
																		</For>
																	</div>
																</Show>
															</div>
														</label>
													)
												}}
											</For>
										</div>
									</div>
								)}
							</For>
						</Show>
					</div>

					{/* 底部操作 */}
					<div style="padding:12px 18px;border-top:1px solid var(--border-base);display:flex;align-items:center;justify-content:space-between;gap:8px">
						<div style="font-size:11px;color:var(--text-muted)">
							已勾选 <strong style="color:var(--text-base)">{selected().size}</strong> 个
						</div>
						<div style="display:flex;gap:8px">
							<button
								class="btn btn-ghost"
								onClick={props.onClose}
								disabled={installing()}
							>
								取消
							</button>
							<button
								class="btn btn-primary"
								onClick={() => void doInstall()}
								disabled={installing() || selected().size === 0}
							>
								{installing() ? '安装中…' : `安装 ${selected().size} 个技能`}
							</button>
						</div>
					</div>
				</div>
			</div>
		</Show>
	)
}
