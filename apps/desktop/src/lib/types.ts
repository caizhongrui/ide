/*---------------------------------------------------------------------------------------------
 *  Desktop 端核心数据类型（K11a-2 抽离自 App.tsx）
 *--------------------------------------------------------------------------------------------*/

export type Theme = "dark" | "light" | "system"

import type { FileChangeEntry } from './chatEventTypes'

/** 预览标签（右侧预览面板中的一个打开文件） */
export interface PreviewTab {
	path:      string                           // 文件路径（相对或绝对）
	title:     string                           // 标签页标题（basename）
	kind:      'text' | 'image' | 'audio' | 'video' | 'binary' | 'markdown'
	content:   string                           // 文本或 base64
	mimeType:  string
	size:      number
	error?:    string
	loading:   boolean
	viewMode:  'source' | 'diff' | 'rendered'   // markdown: source/rendered, 变更文件: source/diff
	changed?:  FileChangeEntry['action']        // 若该文件在会话中被修改过
	// diff 数据（懒加载）
	diffOriginal?: string | null
	diffCurrent?:  string
	diffLoading?:  boolean
	/** 外部变更检测（P0-4）: 监测到文件被外部修改时的时间戳 */
	extChangedAt?: number
	/** 跳转到行号（P0-1）: 加载完成后滚动定位 */
	pendingLine?: number
	/** 已加载时的磁盘 mtime（P0-4: 外部变更检测） */
	mtimeMs?: number
}

/** 附加图片 */
export interface AttachedImage {
	id:      string
	dataUrl: string  // base64 data URL
	name:    string
}

/** 把文件元信息分类为 PreviewTab.kind */
export function classifyFileKind(file: {
	isImage: boolean
	isAudio: boolean
	isVideo: boolean
	isBinary: boolean
	path:    string
	mimeType: string
}): PreviewTab['kind'] {
	if (file.isImage) return 'image'
	if (file.isAudio) return 'audio'
	if (file.isVideo) return 'video'
	if (file.isBinary) return 'binary'
	const ext = file.path.split('.').pop()?.toLowerCase() ?? ''
	if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown'
	return 'text'
}

/** 聊天消息（包含 user/assistant/tool/reasoning/system/error 多种 role） */
export interface ChatMessage {
	id:           string
	role:         "user" | "assistant" | "system" | "error" | "tool" | "reasoning"
	content:      string
	isPartial?:   boolean
	/** 创建时间戳（毫秒），live 消息用 Date.now()，DB 消息用 created_at */
	createdAt?:   number
	/** 工具调用专属字段 */
	toolName?:    string
	toolUseId?:   string
	toolSuccess?: boolean
	toolParams?:  Record<string, unknown>   // 工具原始参数（用于展示文件路径等）
	toolResult?:  string                    // 工具执行结果摘要
	liveOutput?:  string                    // 流式工具实时输出（bash 的 stdout/stderr）
	/** 思考过程专属字段 */
	charCount?:   number                    // 完成时的字符数
}
