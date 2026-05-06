/*---------------------------------------------------------------------------------------------
 *  Slash 命令定义（K11c 抽离自 App.tsx）
 *
 *  Composer 输入框首字符为 `/` 时触发的命令面板项。
 *  内置命令的执行逻辑在 App.tsx 的 execSlashCommand 里，本文件只放清单 + 类型。
 *--------------------------------------------------------------------------------------------*/

export interface SlashCommand {
	name:  string
	label: string
	desc:  string
	icon:  string
}

export const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "clear",    label: "清空会话",     desc: "清空当前对话所有消息",          icon: "🗑️" },
	{ name: "new",      label: "新建会话",     desc: "创建一个新的会话",              icon: "✏️" },
	{ name: "compact",  label: "压缩上下文",   desc: "手动压缩对话历史释放 token",    icon: "🗜" },
	{ name: "plan",     label: "计划模式",     desc: "切换到只规划不执行的模式",      icon: "📋" },
	{ name: "fork",     label: "分叉会话",     desc: "复制当前会话到新分支",          icon: "🔀" },
	{ name: "terminal", label: "打开终端",     desc: "打开集成终端 (⌘`)",            icon: "⚡" },
	{ name: "files",    label: "查看变更",     desc: "显示本次会话修改的文件",        icon: "📁" },
	{ name: "export",   label: "导出会话",     desc: "将对话历史导出为 Markdown",     icon: "💾" },
	{ name: "help",     label: "帮助",         desc: "显示可用命令列表",              icon: "❓" },
]
