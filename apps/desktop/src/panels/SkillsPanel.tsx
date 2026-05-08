/*---------------------------------------------------------------------------------------------
 *  SkillsPanel — 技能（.md 文档）面板（K11c-cont）
 *
 *  K11d: 增加"打开目录"能力，便于用户手动放入下载的技能 .md 文件：
 *    1. 头部新增"📁 打开 Skills 目录"按钮 → 默认指向用户级 ~/.maxian/skills/（不存在则自动创建）
 *    2. 每张技能卡片右侧新增文件夹图标 → 打开该技能所在目录
 *    3. 空态搜索目录列表中的每一项点击可直接打开该目录（不存在则创建后再打开）
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface SkillEntry {
	name:        string
	description: string
	path:        string
	source:      'workspace-maxian' | 'workspace-claude' | 'user-maxian' | 'user-claude'
	size:        number
}

export interface SkillsSearchedDir {
	path:   string
	source: string
	exists: boolean
}

export interface SkillsPanelProps {
	skills:        () => SkillEntry[]
	searchedDirs:  () => SkillsSearchedDir[]
	loading:       () => boolean
	onClose:       () => void
	onReload:      () => void | Promise<void>
	onOpenPreview: (path: string) => void
	/**
	 * 打开本地目录到系统资源管理器。path 支持 ~/ 前缀，也支持文件路径
	 * （文件路径会被自动转换到其所在目录）。目录不存在则自动创建。
	 */
	onOpenDir:     (path: string) => void | Promise<void>
	/** 打开"推荐技能库"对话框（K11d） */
	onOpenRecommended: () => void
}

const sourceLabel = (s: string): string =>
	s === 'workspace-maxian' ? '项目 .maxian' :
	s === 'workspace-claude' ? '项目 .claude' :
	s === 'user-maxian'      ? '用户 ~/.maxian' :
	s === 'user-claude'      ? '用户 ~/.claude' : s

/** 取出技能文件所在的目录（即 path 去掉最后一段文件名） */
const dirOf = (p: string): string => {
	const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
	return idx >= 0 ? p.slice(0, idx) : p
}

export const SkillsPanel: Component<SkillsPanelProps> = (props) => {
	return (
		<div class="file-tree-panel skills-panel">
			<div class="file-tree-header">
				<span class="file-tree-title">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M12 2l2.5 7.5H22l-6 4.5 2.5 7.5L12 17l-6.5 4.5L8 14 2 9.5h7.5z" />
					</svg>
					Skills ({props.skills().length})
				</span>
				<div style="display:flex;gap:4px;align-items:center">
					<button
						class="icon-btn"
						onClick={props.onOpenRecommended}
						title="📦 推荐技能库 — 一键安装内置的最佳实践技能"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
							<polyline points="3.27 6.96 12 12.01 20.73 6.96" />
							<line x1="12" y1="22.08" x2="12" y2="12" />
						</svg>
					</button>
					<button
						class="icon-btn"
						onClick={() => void props.onOpenDir('~/.maxian/skills/')}
						title="打开用户 Skills 目录（~/.maxian/skills/），可手动放入下载的 .md 文件"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
						</svg>
					</button>
					<button class="icon-btn" onClick={() => void props.onReload()} title="刷新">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="23 4 23 10 17 10" />
							<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
						</svg>
					</button>
					<button class="icon-btn" onClick={props.onClose} title="关闭">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			</div>
			<div class="file-tree-body">
				<Show when={props.loading()}>
					<div class="file-tree-empty">扫描中…</div>
				</Show>
				<Show when={!props.loading() && props.skills().length === 0}>
					<div class="skills-empty">
						<div style="margin-bottom:10px;color:var(--text-muted)">未找到任何技能文档</div>
						<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
							<button
								class="btn btn-primary"
								style="font-size:11px;padding:6px 10px"
								onClick={props.onOpenRecommended}
							>
								📦 浏览推荐技能库（一键安装最佳实践）
							</button>
							<button
								class="btn btn-ghost"
								style="font-size:11px;padding:6px 10px"
								onClick={() => void props.onOpenDir('~/.maxian/skills/')}
							>
								📁 打开 Skills 目录（手动放 .md）
							</button>
						</div>
						<div style="font-size:11px;color:var(--text-faint);line-height:1.7;text-align:left;padding:0 4px">
							在以下任一目录中创建 <code>.md</code> 文件（点击目录可直接打开）：
							<ul style="padding-left:18px;margin:6px 0;list-style:none">
								<For each={props.searchedDirs()}>
									{(d) => (
										<li
											style={`color:${d.exists ? 'var(--text-base)' : 'var(--text-faint)'};cursor:pointer;display:flex;align-items:center;gap:4px;padding:2px 0`}
											onClick={() => void props.onOpenDir(d.path)}
											title={d.exists ? '点击打开此目录' : '点击创建并打开此目录'}
										>
											<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0">
												<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
											</svg>
											<code style="font-size:10px">{d.path}</code>
											<Show when={d.exists}><span style="color:#22c55e;margin-left:2px">✓</span></Show>
										</li>
									)}
								</For>
							</ul>
							每个 md 文件顶部建议使用 YAML frontmatter：
							<pre style="background:var(--bg-subtle);padding:6px;border-radius:4px;margin-top:4px;font-size:10px">---{'\n'}name: my-skill{'\n'}description: 简短描述{'\n'}---{'\n'}
# Skill Content…</pre>
						</div>
					</div>
				</Show>
				<For each={props.skills()}>
					{(skill) => (
						<div
							class="file-tree-item skill-item"
							onClick={() => props.onOpenPreview(skill.path)}
							style="cursor:pointer;align-items:flex-start;padding:8px 12px;position:relative"
							title={skill.path}
						>
							<span class="skill-icon">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M12 2l2.5 7.5H22l-6 4.5 2.5 7.5L12 17l-6.5 4.5L8 14 2 9.5h7.5z" />
								</svg>
							</span>
							<div class="file-tree-item-info" style="gap:3px;flex:1;min-width:0">
								<span class="skill-name">{skill.name}</span>
								<Show when={skill.description}>
									<span class="skill-desc">{skill.description}</span>
								</Show>
								<span class="skill-source">{sourceLabel(skill.source)}</span>
							</div>
							<button
								class="icon-btn skill-open-dir-btn"
								style="opacity:0.55;padding:3px;flex-shrink:0;align-self:center"
								onClick={(e) => {
									e.stopPropagation()
									void props.onOpenDir(dirOf(skill.path))
								}}
								title={`打开所在目录：${dirOf(skill.path)}`}
							>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
								</svg>
							</button>
						</div>
					)}
				</For>
			</div>
		</div>
	)
}
