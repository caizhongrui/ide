/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Browser Bridge Controller (B5)
 *
 *  实现 IBrowserController：把 AI 工具的浏览器操作转换成命令队列 + 等前端 desktop
 *  从 SSE 长连接拉取并执行（在 iframe 里 postMessage 给注入的内容脚本），结果通过
 *  /browser/reply 回写到对应 future。
 *
 *  设计：
 *  - 单一全局 controller（一个时刻只有一个 desktop frontend 真在监听）
 *  - 命令保留 30s 超时，frontend 不在线时直接超时回错
 *  - console / network 流是 frontend 主动 push 上来的（POST /browser/event），sidecar 只 buffer
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IBrowserController } from '@maxian/core/browser';

interface PendingCmd {
	cmdId:    string;
	op:       string;
	args:     Record<string, unknown>;
	createdAt:number;
	resolve:  (result: { ok: boolean; result?: unknown; error?: string }) => void;
	reject:   (err: Error) => void;
	timer:    ReturnType<typeof setTimeout>;
}

const CMD_TIMEOUT_MS = 30_000;
const CONSOLE_BUFFER_MAX = 500;
const NETWORK_BUFFER_MAX = 500;

export interface BrowserConsoleEntry {
	level:     'log' | 'info' | 'warn' | 'error' | 'debug';
	text:      string;
	timestamp: number;
}

export interface BrowserNetworkEntry {
	method:     string;
	url:        string;
	status?:    number;
	durationMs?:number;
	timestamp:  number;
}

export class BrowserBridgeController extends EventEmitter implements IBrowserController {
	private pending: Map<string, PendingCmd> = new Map();
	private consoleBuffer: BrowserConsoleEntry[] = [];
	private networkBuffer: BrowserNetworkEntry[] = [];
	private _currentUrl: string | null = null;
	private hasFrontend = false;

	/** 给 SSE handler 用：前端 panel 打开时调，关闭时设 false */
	setFrontendActive(active: boolean): void {
		this.hasFrontend = active;
	}

	/** 给前端 SSE handler 用：拿到一条新命令的 promise */
	private enqueue(op: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		return new Promise((resolve, reject) => {
			if (!this.hasFrontend) {
				resolve({ ok: false, error: '桌面端浏览器面板未打开（请先在右上角点开浏览器图标）' });
				return;
			}
			const cmdId = randomUUID().slice(0, 12);
			const timer = setTimeout(() => {
				this.pending.delete(cmdId);
				resolve({ ok: false, error: `命令超时（${CMD_TIMEOUT_MS}ms 无响应）` });
			}, CMD_TIMEOUT_MS);
			const cmd: PendingCmd = { cmdId, op, args, createdAt: Date.now(), resolve, reject, timer };
			this.pending.set(cmdId, cmd);
			// 推 SSE 事件给前端
			this.emit('command', { cmdId, op, args });
		});
	}

	/** 前端 reply 处理 */
	resolveReply(cmdId: string, result: { ok: boolean; result?: unknown; error?: string }): boolean {
		const cmd = this.pending.get(cmdId);
		if (!cmd) return false;
		clearTimeout(cmd.timer);
		this.pending.delete(cmdId);
		cmd.resolve(result);
		return true;
	}

	pushConsoleEntry(entry: BrowserConsoleEntry): void {
		this.consoleBuffer.push(entry);
		if (this.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
			this.consoleBuffer = this.consoleBuffer.slice(-CONSOLE_BUFFER_MAX);
		}
	}

	pushNetworkEntry(entry: BrowserNetworkEntry): void {
		this.networkBuffer.push(entry);
		if (this.networkBuffer.length > NETWORK_BUFFER_MAX) {
			this.networkBuffer = this.networkBuffer.slice(-NETWORK_BUFFER_MAX);
		}
	}

	setCurrentUrl(url: string | null): void {
		this._currentUrl = url;
	}

	// ─── IBrowserController 实现 ─────────────────────────────────────────

	async open(url: string): Promise<{ ok: boolean; error?: string }> {
		if (!this.hasFrontend) {
			return { ok: false, error: '桌面端浏览器面板未打开' };
		}
		// open 不走命令队列，直接 emit 信号（前端见到后导航 iframe）
		this.emit('navigate', { url });
		this._currentUrl = url;
		// 给 iframe 加载留一点时间
		await new Promise((r) => setTimeout(r, 200));
		return { ok: true };
	}

	async close(): Promise<void> {
		this.emit('close', {});
		this._currentUrl = null;
	}

	async screenshot(): Promise<{ mimeType: 'image/png'; base64: string; width: number; height: number }> {
		const r = await this.enqueue('screenshot', {});
		if (!r.ok) {
			return { mimeType: 'image/png', base64: '', width: 0, height: 0 };
		}
		const data = r.result as { base64: string; width: number; height: number };
		return { mimeType: 'image/png', base64: data.base64, width: data.width, height: data.height };
	}

	async getConsoleLogs(maxEntries = 50): Promise<Array<{ level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string; timestamp: number }>> {
		// 直接返回 sidecar buffer 里最近的 N 条（前端实时 push 上来，无需转发）
		return this.consoleBuffer.slice(-maxEntries);
	}

	async getNetworkRequests(maxEntries = 30): Promise<Array<{ url: string; method: string; status?: number; durationMs?: number; timestamp: number }>> {
		return this.networkBuffer.slice(-maxEntries);
	}

	async click(selector: string): Promise<{ ok: boolean; error?: string }> {
		const r = await this.enqueue('click', { selector });
		return { ok: r.ok, error: r.error };
	}

	async fill(selector: string, value: string): Promise<{ ok: boolean; error?: string }> {
		const r = await this.enqueue('fill', { selector, value });
		return { ok: r.ok, error: r.error };
	}

	async evaluate(script: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		const r = await this.enqueue('eval', { script });
		return r;
	}

	async waitFor(selector: string, timeoutMs = 5000): Promise<{ ok: boolean; foundAfterMs?: number; error?: string }> {
		// 由前端注入脚本侧轮询；命令本身用 enqueue + 超时 = max(timeoutMs, CMD_TIMEOUT_MS) 复用
		const r = await this.enqueue('wait-for', { selector, timeoutMs });
		if (r.ok) {
			const data = r.result as { foundAfterMs?: number } | undefined;
			return { ok: true, foundAfterMs: data?.foundAfterMs };
		}
		return { ok: false, error: r.error };
	}

	async currentUrl(): Promise<string | null> {
		return this._currentUrl;
	}
}
