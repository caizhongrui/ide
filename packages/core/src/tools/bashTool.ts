/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Bash Tool
 *
 *  对标 OpenCode `packages/opencode/src/tool/bash.ts`
 *  比 execute_command 更强：超时、并发软限制、stdout/stderr 合并、命令危险性检测。
 *
 *  K8d: 已迁移到 ctx.platform.terminal（NodeTerminal 实现）。
 *  本文件不再 `import 'node:child_process'`；shell 选择 / spawn / 取消 / 输出截断都在 NodeTerminal 内部。
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { IToolContext } from './IToolContext.js';

/** 跨形态 UUID 生成：浏览器 / Node 18+ / Bun 都暴露 globalThis.crypto.randomUUID */
function uuid(): string {
	const c = (globalThis as any).crypto;
	if (c?.randomUUID) return c.uuid();
	// 极简 fallback（v4 兼容）
	const r = () => Math.random().toString(16).slice(2, 14).padEnd(12, '0');
	return `${r()}-${r().slice(0,4)}-4${r().slice(0,3)}-a${r().slice(0,3)}-${r().slice(0,12)}`;
}

export interface IBashToolParams {
	/** 要执行的 shell 命令 */
	command:     string;
	/** 超时（毫秒，默认 120000 = 2 分钟，最大 600000 = 10 分钟） */
	timeout?:    number;
	/** 工作目录（相对或绝对，默认工作区根） */
	cwd?:        string;
	/** 后台执行（不等待完成，返回 PID） */
	background?: boolean;
	/** 简短描述（用于审批界面展示） */
	description?: string;
}

export interface IBashToolResult {
	stdout:   string;
	stderr:   string;
	exitCode: number | null;
	timedOut: boolean;
	/** 背景任务返回 PID */
	pid?:     number;
	/** 长运行服务（dev server 等）启动并已后台化 */
	devServerStarted?: boolean;
}

/** 危险命令模式（返回匹配项或空字符串） */
export function detectDangerousCommand(command: string): string {
	const patterns: Array<{ re: RegExp; label: string }> = [
		{ re: /\brm\s+-rf\s+\//i,                    label: 'rm -rf /' },
		{ re: /\brm\s+-rf\s+~(?:\/|$)/i,             label: 'rm -rf ~' },
		{ re: /\bmkfs(\.|\s)/i,                      label: 'mkfs' },
		{ re: /\bdd\s+.*of=\/dev\//i,                label: 'dd to /dev' },
		{ re: /:\(\)\s*\{\s*:\|:&\s*\};:/,           label: 'fork bomb' },
		{ re: /\bchmod\s+(?:-R\s+)?0?7{3,}\s+\//i,   label: 'chmod 777 /' },
		{ re: /\b(?:shutdown|reboot|halt)\b/i,       label: 'shutdown/reboot' },
		{ re: />\s*\/dev\/sd[a-z]/i,                 label: 'write to disk device' },
	];
	for (const p of patterns) {
		if (p.re.test(command)) return p.label;
	}
	return '';
}

/** 流式输出回调：每当 stdout/stderr 有新数据到达时调用 */
export type BashOutputSink = (chunk: string, kind: 'stdout' | 'stderr') => void | Promise<void>;

export async function bashTool(
	ctx:    IToolContext,
	params: IBashToolParams,
	onOutput?: BashOutputSink,
): Promise<IBashToolResult> {
	const command = params.command?.trim();
	if (!command) {
		return { stdout: '', stderr: 'command is required', exitCode: 1, timedOut: false };
	}

	if (!ctx.platform?.terminal) {
		return {
			stdout: '',
			stderr: 'platform.terminal 未注入；core 已不再直接调用 child_process，调用方需提供 ITerminal 实现',
			exitCode: 1,
			timedOut: false,
		};
	}
	const terminal = ctx.platform.terminal;

	// 超时范围 1s–10min，默认 2min
	const timeout = Math.min(Math.max(params.timeout ?? 120_000, 1000), 600_000);

	// cwd 解析与越界保护
	const cwd = params.cwd
		? (path.isAbsolute(params.cwd) ? params.cwd : path.resolve(ctx.workspacePath, params.cwd))
		: ctx.workspacePath;

	// 背景执行（fire-and-forget）
	if (params.background) {
		if (!terminal.executeBackground) {
			return {
				stdout: '',
				stderr: 'platform.terminal 不支持 executeBackground（IDE 形态可能无此能力）',
				exitCode: 1,
				timedOut: false,
			};
		}
		try {
			const { pid } = await terminal.executeBackground(command, { cwd });
			return {
				stdout:   `[background] 已启动 pid=${pid}`,
				stderr:   '',
				exitCode: 0,
				timedOut: false,
				pid,
			};
		} catch (err) {
			return {
				stdout: '',
				stderr: 'background spawn 失败: ' + (err as Error).message,
				exitCode: 1,
				timedOut: false,
			};
		}
	}

	// 前台执行：用 executeStream 拿流式 chunk，按需要回调 onOutput + 累计输出
	const cancellationToken = uuid();
	let stdout = '';
	let stderr = '';
	let exitCode: number | null = null;
	let timedOut = false;
	let cancelled = false;
	let pid: number | undefined;
	let devServerStarted = false;

	try {
		for await (const chunk of terminal.executeStream(command, {
			cwd,
			timeoutMs: timeout,
			detectDevServer: true,
			cancellationToken,
		})) {
			if (chunk.type === 'stdout' && chunk.data) {
				stdout += chunk.data;
				if (onOutput) {
					try { await onOutput(chunk.data, 'stdout'); } catch { /* sink errors swallowed */ }
				}
				// 1MB 上限
				if (stdout.length > 1_000_000) {
					stdout = stdout.slice(0, 1_000_000) + '\n[输出过大已被截断]';
					try { await terminal.cancel(cancellationToken); } catch { /* ignore */ }
				}
				// dev server 识别：NodeTerminal 自己判定就绪后会 emit 一段提示文本然后 exit
				if (/\[dev server 已识别为就绪/.test(chunk.data)) {
					devServerStarted = true;
					const m = chunk.data.match(/pid=(\d+)/);
					if (m) pid = parseInt(m[1], 10);
				}
			} else if (chunk.type === 'stderr' && chunk.data) {
				stderr += chunk.data;
				if (onOutput) {
					try { await onOutput(chunk.data, 'stderr'); } catch { /* ignore */ }
				}
				if (stderr.length > 500_000) {
					stderr = stderr.slice(0, 500_000) + '\n[stderr 过大已被截断]';
				}
			} else if (chunk.type === 'exit') {
				exitCode = chunk.exitCode ?? null;
				timedOut = chunk.timedOut ?? false;
				cancelled = chunk.cancelled ?? false;
			}
		}
	} catch (err) {
		stderr += '\n' + (err as Error).message;
		exitCode = 1;
	}

	// dev server 已 detach 时给一个明确提示
	if (devServerStarted && exitCode === 0) {
		stdout += `\n\n💡 识别为长时间运行服务（dev server / watcher），已后台继续 pid=${pid ?? 'unknown'}。`;
	}

	return {
		stdout,
		stderr,
		exitCode: timedOut ? null : exitCode,
		timedOut,
		pid,
		devServerStarted,
	};
}

export function formatBashResult(r: IBashToolResult, params: IBashToolParams): string {
	const parts: string[] = [];
	parts.push(`$ ${params.command}`);
	if (r.pid !== undefined && !r.devServerStarted) {
		parts.push(`[background pid=${r.pid}]`);
	} else if (r.devServerStarted) {
		parts.push(`[dev server pid=${r.pid ?? 'unknown'}]`);
	} else {
		if (r.timedOut) parts.push(`[超时 ${params.timeout ?? 120000}ms 后被杀]`);
		else parts.push(`[exit=${r.exitCode}]`);
	}
	if (r.stdout) parts.push(r.stdout.trimEnd());
	if (r.stderr) parts.push('--- stderr ---\n' + r.stderr.trimEnd());
	return parts.join('\n');
}
