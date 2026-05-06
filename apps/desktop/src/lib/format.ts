/*---------------------------------------------------------------------------------------------
 *  纯展示层格式化工具（K11c 抽离自 App.tsx）
 *
 *  通用格式化、时间戳、文件路径短化、数字单位化、消息类型转换等。
 *  纯函数，零副作用，零 SolidJS 依赖。
 *--------------------------------------------------------------------------------------------*/

import type { StoredMessage } from '@maxian/sdk'
import type { UserInfo } from '../api'
import type { ChatMessage } from './types'

/** 时间戳 → "HH:MM"（zh-CN locale） */
export function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
}

/** 时间戳 → "yyyy-MM-dd HH:mm:ss" */
export function formatFullTime(ts?: number): string {
	if (!ts) return ''
	const d = new Date(ts)
	const pad = (n: number) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 用户名 → 单字母头像 */
export function userInitials(u: UserInfo): string {
	const n = u.nickName || u.userName || ""
	return n.slice(0, 1).toUpperCase() || "U"
}

/** 路径 → 最末段（用于 sidebar 等空间紧张处的展示） */
export function shortPath(p: string): string {
	if (!p) return "未知工作区"
	const parts = p.replace(/\\/g, "/").split("/")
	return parts[parts.length - 1] || p
}

/** 接收字符数 → 友好字符串（"123 字" / "1.2K 字"） */
export function formatRecv(n: number): string {
	if (n < 1000) return `${n} 字`
	return `${(n / 1000).toFixed(1)}K 字`
}

/**
 * 把 DB 存储的 StoredMessage 转换为前端 ChatMessage。
 * 'tool' 角色的 content 在 DB 里存的是 JSON（toolName/toolUseId/toolParams/toolResult/toolSuccess），
 * 需要解析为对应字段；'reasoning' 设置 charCount；其他角色字段直传。
 */
export function storedToChatMessage(m: StoredMessage): ChatMessage {
	if (m.role === 'tool') {
		try {
			const parsed = JSON.parse(m.content)
			return {
				id:          m.id,
				role:        'tool',
				content:     '',
				isPartial:   false,
				createdAt:   m.createdAt,
				toolName:    parsed.toolName    ?? 'unknown',
				toolUseId:   parsed.toolUseId   ?? m.id,
				toolParams:  parsed.toolParams  ?? {},
				toolResult:  parsed.toolResult  ?? '',
				toolSuccess: parsed.toolSuccess ?? true,
			}
		} catch {
			return {
				id:          m.id,
				role:        'tool',
				content:     m.content,
				isPartial:   false,
				createdAt:   m.createdAt,
				toolName:    'unknown',
				toolUseId:   m.id,
				toolSuccess: true,
			}
		}
	}
	if (m.role === 'reasoning') {
		return {
			id:        m.id,
			role:      'reasoning',
			content:   m.content,
			isPartial: false,
			createdAt: m.createdAt,
			charCount: m.content.length,
		}
	}
	return {
		id:        m.id,
		role:      m.role as ChatMessage["role"],
		content:   m.content,
		isPartial: false,
		createdAt: m.createdAt,
	}
}
