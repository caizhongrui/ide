/*---------------------------------------------------------------------------------------------
 *  Theme + Font 持久化与应用工具（K11a-2 抽离自 App.tsx）
 *
 *  通过 localStorage 持久化用户的主题（dark/light/system）和字体偏好；
 *  applyTheme / applyFont 在每次切换时把状态同步到 :root（CSS 变量 + data-theme attr）。
 *--------------------------------------------------------------------------------------------*/

import type { Theme } from './types'

export const THEME_KEY       = "maxian_theme"
export const FONT_FAMILY_KEY = "maxian_font_family"
export const FONT_SIZE_KEY   = "maxian_font_size"
export const DEFAULT_API_URL = "http://10.205.81.162/api"

export interface FontFamilyDef {
	value: string
	label: string
	css:   string
}

export const FONT_FAMILIES: FontFamilyDef[] = [
	{ value: "system",      label: "系统默认",       css: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
	{ value: "pingfang",    label: "PingFang SC",    css: "'PingFang SC', 'Hiragino Sans GB', sans-serif" },
	{ value: "msyahei",     label: "微软雅黑",       css: "'Microsoft YaHei', 'WenQuanYi Micro Hei', sans-serif" },
	{ value: "sourcehansans", label: "思源黑体",     css: "'Source Han Sans CN', 'Noto Sans CJK SC', 'PingFang SC', sans-serif" },
	{ value: "noto",        label: "Noto Sans",      css: "'Noto Sans', 'Noto Sans CJK SC', sans-serif" },
	{ value: "helvetica",   label: "Helvetica Neue", css: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
]

export function loadTheme(): Theme {
	return (localStorage.getItem(THEME_KEY) as Theme) || "dark"
}
export function applyTheme(t: Theme) {
	document.documentElement.setAttribute("data-theme", t)
	localStorage.setItem(THEME_KEY, t)
}

export function loadFontFamily(): string {
	return localStorage.getItem(FONT_FAMILY_KEY) || "system"
}
export function loadFontSize(): number {
	return parseInt(localStorage.getItem(FONT_SIZE_KEY) || "13", 10)
}
export function applyFont(family: string, size: number) {
	const def = FONT_FAMILIES.find(f => f.value === family) ?? FONT_FAMILIES[0]
	document.documentElement.style.setProperty("--font-sans", def.css)
	document.documentElement.style.setProperty("--font-size-base", `${size}px`)
}

/** 字节数 → 友好字符串（K/M/G） */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)}M`
	return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`
}
