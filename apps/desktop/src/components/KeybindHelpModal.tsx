/*---------------------------------------------------------------------------------------------
 *  KeybindHelpModal — ⌘/ 快捷键速查 modal（K11a 抽离自 App.tsx）
 *
 *  纯渲染：search query / 关闭回调通过 props 注入。
 *  快捷键列表 KEYBINDS 是常量，编译期 inline 即可（无需 host 注入）。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'

export interface Keybind {
	keys:     string
	desc:     string
	category: string
}

export const DEFAULT_KEYBINDS: Keybind[] = [
	{ keys: '⌘N',      desc: '新建会话',              category: '会话' },
	{ keys: '⌘W',      desc: '关闭当前会话',          category: '会话' },
	{ keys: '⌘[',      desc: '上一个会话',            category: '会话' },
	{ keys: '⌘]',      desc: '下一个会话',            category: '会话' },
	{ keys: '⌘K',      desc: '打开命令面板（/）',     category: '会话' },
	{ keys: '⌘Enter',  desc: '发送消息',              category: '输入' },
	{ keys: 'Esc',     desc: '中断 AI 生成',          category: '输入' },
	{ keys: '↑/↓',     desc: '输入框空时翻历史',      category: '输入' },
	{ keys: '@',       desc: '文件引用',              category: '输入' },
	{ keys: '/',       desc: '斜杠命令',              category: '输入' },
	{ keys: '⌘`',      desc: '切换终端',              category: '面板' },
	{ keys: '⌘,',      desc: '打开设置',              category: '面板' },
	{ keys: '⌘/',      desc: '显示快捷键速查',        category: '面板' },
	{ keys: 'j / k',   desc: '上下消息导航',          category: '消息' },
	{ keys: '↑/↓',     desc: '消息列表聚焦时上下移动', category: '消息' },
	{ keys: 'Enter',   desc: '展开/折叠当前消息',     category: '消息' },
]

export interface KeybindHelpModalProps {
	search:    () => string
	setSearch: (q: string) => void
	onClose:   () => void
	/** 可选自定义快捷键集（默认用 DEFAULT_KEYBINDS） */
	keybinds?: Keybind[]
}

export const KeybindHelpModal: Component<KeybindHelpModalProps> = (props) => {
	const all = () => props.keybinds ?? DEFAULT_KEYBINDS
	const q = () => props.search().trim().toLowerCase()
	const filtered = () => {
		const query = q()
		if (!query) return all()
		return all().filter(k =>
			k.keys.toLowerCase().includes(query) ||
			k.desc.toLowerCase().includes(query) ||
			k.category.toLowerCase().includes(query)
		)
	}
	const grouped = () => {
		const m = new Map<string, Keybind[]>()
		for (const k of filtered()) {
			if (!m.has(k.category)) m.set(k.category, [])
			m.get(k.category)!.push(k)
		}
		return Array.from(m.entries())
	}
	return (
		<div class="keybind-overlay" onClick={props.onClose}>
			<div class="keybind-modal" onClick={(e) => e.stopPropagation()}>
				<div class="keybind-header">
					<span class="keybind-title">键盘快捷键</span>
					<button class="icon-btn" onClick={props.onClose} title="关闭 (Esc)">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
						</svg>
					</button>
				</div>
				<input
					class="keybind-search"
					placeholder="搜索快捷键或功能…"
					value={props.search()}
					onInput={(e) => props.setSearch(e.currentTarget.value)}
					autofocus
				/>
				<div class="keybind-body">
					<For each={grouped()}>
						{([category, items]) => (
							<div class="keybind-group">
								<div class="keybind-group-title">{category}</div>
								<For each={items}>
									{(k) => (
										<div class="keybind-row">
											<span class="keybind-desc">{k.desc}</span>
											<kbd class="keybind-keys">{k.keys}</kbd>
										</div>
									)}
								</For>
							</div>
						)}
					</For>
					<Show when={filtered().length === 0}>
						<div class="keybind-empty">无匹配</div>
					</Show>
				</div>
			</div>
		</div>
	)
}
