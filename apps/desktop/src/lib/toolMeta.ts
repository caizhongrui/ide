/*---------------------------------------------------------------------------------------------
 *  工具名称 → 中文标签 / SVG 图标 / subtitle 摘要 映射（K11a-2 抽离自 App.tsx）
 *--------------------------------------------------------------------------------------------*/

/** 工具名 → 中文标签 */
export const TOOL_LABELS: Record<string, string> = {
	read_file:       "读取文件",
	write_to_file:   "写入文件",
	edit:            "编辑文件",
	multiedit:       "多处编辑",
	search_files:    "搜索文件",
	list_files:      "列出目录",
	execute_command: "执行命令",
	todo_write:      "更新任务",
	web_fetch:       "获取网页",
	load_skill:      "加载技能",
}

/** 工具名 → SVG path（codicon 风格 24×24 viewBox） */
export const TOOL_ICONS: Record<string, string> = {
	read_file:       "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z",
	write_to_file:   "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
	edit:            "M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83zM3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z",
	multiedit:       "M3 17.25V21h3.75l11.06-11.06-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83zM7 4h2v2H7zm0 4h2v2H7zm0 4h2v2H7z",
	search_files:    "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
	list_files:      "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
	execute_command: "M8 5v14l11-7z",
	todo_write:      "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z",
	web_fetch:       "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
}

export function getToolLabel(name: string): string {
	return TOOL_LABELS[name] ?? name
}

/** 根据工具名 + 参数生成单行 subtitle，用于消息列表里工具卡片的副标题 */
export function getToolSubtitle(name: string, params?: Record<string, unknown>): string {
	if (!params) return ""
	switch (name) {
		case "read_file":
		case "write_to_file":
		case "edit":
		case "multiedit":
			return (params.path as string) || ""
		case "search_files": {
			const p = (params.path as string) || ""
			const r = (params.regex as string) || ""
			return p && r ? `${p}  ·  ${r}` : (p || r)
		}
		case "list_files":
			return (params.path as string) || ""
		case "execute_command": {
			const cmd = (params.command as string) || ""
			return cmd.length > 72 ? cmd.slice(0, 72) + "…" : cmd
		}
		case "todo_write": {
			const todos = params.todos as Array<{ status: string; content: string }> | undefined
			if (!todos) return ""
			const inProgress = todos.find(t => t.status === 'in_progress')
			if (inProgress) return `正在: ${inProgress.content}`
			const done = todos.filter(t => t.status === 'completed').length
			return `${done}/${todos.length} 已完成`
		}
		case "web_fetch":
			return (params.url as string) || ""
		default:
			return ""
	}
}
