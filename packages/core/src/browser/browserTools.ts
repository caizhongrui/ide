/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Browser Preview Tools (B5)
 *
 *  让 AI 在用户改前端代码时能"自己看效果"：
 *  - browser_open(url)：在桌面端的内嵌 Tauri 第二窗口里打开 url
 *  - browser_screenshot()：截图当前内嵌浏览器的可见区域，返回 base64 PNG
 *  - browser_console_logs()：读取 console.log/warn/error 流（最近 N 条）
 *  - browser_network_requests()：读取最近 N 个 HTTP 请求（含状态码、耗时）
 *  - browser_click(selector)：点击元素（CSS selector）
 *  - browser_fill(selector, value)：往 input/textarea 填值
 *  - browser_eval(script)：在页面里执行 JavaScript（同步返回结果）
 *  - browser_wait_for(selector, timeout?)：等待元素出现（直到 selector 命中或超时）
 *
 *  安全约束：
 *  - 仅允许 127.0.0.1 / localhost / file:// / Maxian dev server，其他 URL 必须用户授权（默认拒绝）
 *  - 任何修改型工具（click/fill/eval）执行前在桌面端 console 显式 log 操作
 *
 *  实现：
 *  - core 端只定义工具 + execute 通过 ctx.browserController 委托
 *  - 桌面端 Tauri Rust 侧实现 BrowserController（Tauri WebviewWindow + invoke 命令）
 *  - sidecar 在 Tauri 模式下通过 IPC 调到桌面 Rust 实现；非 Tauri 模式（如纯 server）
 *    退化为 puppeteer-style 自启 chromium（B5 V2 完善）
 *--------------------------------------------------------------------------------------------*/

import type { ToolDefinition, ToolExecutionContext } from '../tools/toolRegistry.js';

/**
 * 浏览器控制器接口（由 desktop / web / vscode 各自实现）
 */
export interface IBrowserController {
	open(url: string): Promise<{ ok: boolean; error?: string }>;
	close(): Promise<void>;
	screenshot(): Promise<{ mimeType: 'image/png'; base64: string; width: number; height: number }>;
	getConsoleLogs(maxEntries?: number): Promise<Array<{ level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string; timestamp: number }>>;
	getNetworkRequests(maxEntries?: number): Promise<Array<{ url: string; method: string; status?: number; durationMs?: number; timestamp: number }>>;
	click(selector: string): Promise<{ ok: boolean; error?: string }>;
	fill(selector: string, value: string): Promise<{ ok: boolean; error?: string }>;
	evaluate(script: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
	waitFor(selector: string, timeoutMs?: number): Promise<{ ok: boolean; foundAfterMs?: number; error?: string }>;
	currentUrl(): Promise<string | null>;
}

export interface BrowserAwareToolContext extends ToolExecutionContext {
	browserController?: IBrowserController;
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);

function isAllowedUrl(url: string): boolean {
	if (url.startsWith('file://')) return true;
	try {
		const u = new URL(url);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
		if (ALLOWED_HOSTS.has(u.hostname)) return true;
		if (u.hostname.endsWith('.local')) return true;
		return false;
	} catch {
		return false;
	}
}

export const BROWSER_OPEN_TOOL: ToolDefinition = {
	name: 'browser_open',
	displayName: '打开浏览器',
	description: '在桌面端内嵌浏览器中打开 URL（仅允许 127.0.0.1/localhost/.local；其它需用户授权）。',
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			url: { type: 'string', description: '要打开的 URL（http://localhost:3000 等）' },
		},
		required: ['url'],
	},
	execute: async (params, context) => {
		const ctx = context as BrowserAwareToolContext;
		const ctrl = ctx.browserController;
		if (!ctrl) return '错误：当前会话未挂载浏览器控制器（需要桌面端 Tauri 模式）';
		const url = String(params.url ?? '').trim();
		if (!url) return '错误：url 不能为空';
		if (!isAllowedUrl(url)) {
			return `安全拒绝：URL "${url}" 不在白名单内（仅允许 127.0.0.1/localhost/.local）。如需访问其他地址，请用户在桌面端"浏览器预览"面板手动输入 URL。`;
		}
		const r = await ctrl.open(url);
		if (!r.ok) return `打开失败：${r.error ?? '未知错误'}`;
		return `已在内嵌浏览器打开 ${url}`;
	},
};

export const BROWSER_SCREENSHOT_TOOL: ToolDefinition = {
	name: 'browser_screenshot',
	displayName: '浏览器截图',
	description: '截取当前内嵌浏览器的可见区域并返回 base64 PNG。AI 可看截图判断 UI 效果（前提是模型支持图像输入）。',
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: { type: 'object', properties: {} },
	execute: async (_params, context) => {
		const ctx = context as BrowserAwareToolContext;
		const ctrl = ctx.browserController;
		if (!ctrl) return '错误：浏览器控制器未挂载';
		try {
			const r = await ctrl.screenshot();
			// 返回结构化文本：包含 base64 + 元信息（前端可识别）
			// 真实的多模态注入在 cli.ts 工具结果转 ContentBlock 处理（image_url）
			return JSON.stringify({
				type:     'browser_screenshot',
				mimeType: r.mimeType,
				width:    r.width,
				height:   r.height,
				base64:   r.base64,
			});
		} catch (e) {
			return `截图失败：${(e as Error).message}`;
		}
	},
};

export const BROWSER_CONSOLE_LOGS_TOOL: ToolDefinition = {
	name: 'browser_console_logs',
	displayName: '浏览器控制台日志',
	description: '读取内嵌浏览器最近 N 条控制台日志（log/warn/error）。用于排查前端运行时错误。',
	group: 'read',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			max_entries: { type: 'number', description: '返回上限（默认 50）' },
		},
	},
	execute: async (params, context) => {
		const ctx = context as BrowserAwareToolContext;
		const ctrl = ctx.browserController;
		if (!ctrl) return '错误：浏览器控制器未挂载';
		const max = Math.min(Math.max(1, Number(params.max_entries) || 50), 500);
		try {
			const logs = await ctrl.getConsoleLogs(max);
			if (logs.length === 0) return '内嵌浏览器最近没有 console 日志';
			const lines = logs.map(l => {
				const time = new Date(l.timestamp).toISOString().slice(11, 23);
				return `[${time}] [${l.level.toUpperCase()}] ${l.text}`;
			});
			return lines.join('\n');
		} catch (e) {
			return `读 console 失败：${(e as Error).message}`;
		}
	},
};

export const BROWSER_NETWORK_REQUESTS_TOOL: ToolDefinition = {
	name: 'browser_network_requests',
	displayName: '浏览器网络请求',
	description: '读取内嵌浏览器最近 N 个 HTTP 请求（method/URL/status/duration）。用于排查 API 调用问题。',
	group: 'read',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			max_entries: { type: 'number', description: '返回上限（默认 50）' },
		},
	},
	execute: async (params, context) => {
		const ctx = context as BrowserAwareToolContext;
		const ctrl = ctx.browserController;
		if (!ctrl) return '错误：浏览器控制器未挂载';
		const max = Math.min(Math.max(1, Number(params.max_entries) || 50), 500);
		try {
			const reqs = await ctrl.getNetworkRequests(max);
			if (reqs.length === 0) return '内嵌浏览器最近没有网络请求';
			const lines = reqs.map(r => {
				const time = new Date(r.timestamp).toISOString().slice(11, 23);
				const status = r.status ?? '?';
				const dur = r.durationMs !== undefined ? `${r.durationMs}ms` : '-';
				return `[${time}] ${r.method} ${r.url} → ${status} (${dur})`;
			});
			return lines.join('\n');
		} catch (e) {
			return `读网络请求失败：${(e as Error).message}`;
		}
	},
};

export const BROWSER_CLICK_TOOL: ToolDefinition = {
	name: 'browser_click',
	displayName: '浏览器点击',
	description: '在内嵌浏览器中点击元素（CSS selector）。',
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			selector: { type: 'string', description: 'CSS selector（如 button#submit / .nav-item:nth-child(3)）' },
		},
		required: ['selector'],
	},
	execute: async (params, context) => {
		const ctx = context as BrowserAwareToolContext;
		const ctrl = ctx.browserController;
		if (!ctrl) return '错误：浏览器控制器未挂载';
		const sel = String(params.selector ?? '').trim();
		if (!sel) return '错误：selector 不能为空';
		const r = await ctrl.click(sel);
		return r.ok ? `已点击 ${sel}` : `点击失败：${r.error ?? '未知'}`;
	},
};

export const BROWSER_FILL_TOOL: ToolDefinition = {
	name: 'browser_fill',
	displayName: '浏览器填值',
	description: '往 input / textarea / contenteditable 元素填入文本值。',
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			selector: { type: 'string', description: 'CSS selector' },
			value:    { type: 'string', description: '要填入的文本' },
		},
		required: ['selector', 'value'],
	},
	execute: async (params, context) => {
		const ctx = context as BrowserAwareToolContext;
		const ctrl = ctx.browserController;
		if (!ctrl) return '错误：浏览器控制器未挂载';
		const sel = String(params.selector ?? '').trim();
		const val = String(params.value ?? '');
		if (!sel) return '错误：selector 不能为空';
		const r = await ctrl.fill(sel, val);
		return r.ok ? `已填值到 ${sel}` : `填值失败：${r.error ?? '未知'}`;
	},
};

export const BROWSER_EVAL_TOOL: ToolDefinition = {
	name: 'browser_eval',
	displayName: '浏览器执行 JS',
	description: '在内嵌浏览器页面中执行 JavaScript 表达式，返回结果（JSON 序列化）。慎用，避免破坏性脚本。',
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			script: { type: 'string', description: 'JavaScript 代码（应为返回值的表达式或异步 IIFE）' },
		},
		required: ['script'],
	},
	execute: async (params, context) => {
		const ctx = context as BrowserAwareToolContext;
		const ctrl = ctx.browserController;
		if (!ctrl) return '错误：浏览器控制器未挂载';
		const script = String(params.script ?? '').trim();
		if (!script) return '错误：script 不能为空';
		const r = await ctrl.evaluate(script);
		if (!r.ok) return `执行失败：${r.error ?? '未知'}`;
		try {
			return `执行结果：\n\`\`\`json\n${JSON.stringify(r.result, null, 2)}\n\`\`\``;
		} catch {
			return `执行结果（非 JSON）：${String(r.result)}`;
		}
	},
};

export const BROWSER_WAIT_FOR_TOOL: ToolDefinition = {
	name: 'browser_wait_for',
	displayName: '浏览器等待元素',
	description: '等待 CSS selector 在页面中出现（用于异步 SPA 加载场景）。',
	group: 'agent',
	source: 'builtin',
	alwaysAvailable: true,
	inputSchema: {
		type: 'object',
		properties: {
			selector:  { type: 'string', description: 'CSS selector' },
			timeout_ms: { type: 'number', description: '超时（默认 5000ms）' },
		},
		required: ['selector'],
	},
	execute: async (params, context) => {
		const ctx = context as BrowserAwareToolContext;
		const ctrl = ctx.browserController;
		if (!ctrl) return '错误：浏览器控制器未挂载';
		const sel = String(params.selector ?? '').trim();
		const tm  = Math.min(Math.max(100, Number(params.timeout_ms) || 5000), 60000);
		const r = await ctrl.waitFor(sel, tm);
		if (r.ok) return `${sel} 在 ${r.foundAfterMs}ms 内出现`;
		return `等待超时：${r.error ?? `${sel} 在 ${tm}ms 内未出现`}`;
	},
};

export const BROWSER_TOOLS: ToolDefinition[] = [
	BROWSER_OPEN_TOOL,
	BROWSER_SCREENSHOT_TOOL,
	BROWSER_CONSOLE_LOGS_TOOL,
	BROWSER_NETWORK_REQUESTS_TOOL,
	BROWSER_CLICK_TOOL,
	BROWSER_FILL_TOOL,
	BROWSER_EVAL_TOOL,
	BROWSER_WAIT_FOR_TOOL,
];
