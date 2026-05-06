/*---------------------------------------------------------------------------------------------
 *  SkillsPanel — 技能（.md 文档）面板（K11c-cont）
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
}

const sourceLabel = (s: string): string =>
	s === 'workspace-maxian' ? '项目 .maxian' :
	s === 'workspace-claude' ? '项目 .claude' :
	s === 'user-maxian'      ? '用户 ~/.maxian' :
	s === 'user-claude'      ? '用户 ~/.claude' : s

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
						<div style="font-size:11px;color:var(--text-faint);line-height:1.7;text-align:left;padding:0 4px">
							在以下任一目录中创建 <code>.md</code> 文件：
							<ul style="padding-left:18px;margin:6px 0">
								<For each={props.searchedDirs()}>
									{(d) => (
										<li style={`color:${d.exists ? 'var(--text-base)' : 'var(--text-faint)'}`}>
											<code style="font-size:10px">{d.path}</code>
											<Show when={d.exists}><span style="color:#22c55e;margin-left:4px">✓</span></Show>
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
							style="cursor:pointer;align-items:flex-start;padding:8px 12px"
							title={skill.path}
						>
							<span class="skill-icon">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M12 2l2.5 7.5H22l-6 4.5 2.5 7.5L12 17l-6.5 4.5L8 14 2 9.5h7.5z" />
								</svg>
							</span>
							<div class="file-tree-item-info" style="gap:3px">
								<span class="skill-name">{skill.name}</span>
								<Show when={skill.description}>
									<span class="skill-desc">{skill.description}</span>
								</Show>
								<span class="skill-source">{sourceLabel(skill.source)}</span>
							</div>
						</div>
					)}
				</For>
			</div>
		</div>
	)
}
