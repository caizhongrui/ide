/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Tool Hook Runner
 *
 *  对标 Claude Code 的 PreToolUse / PostToolUse hook：
 *  - 项目根 .maxian/config.json 配 `hooks.PostToolUse.<toolName>` 为 shell 命令
 *  - 工具执行成功后自动跑该命令，把输出追加到工具结果尾部喂给 AI
 *
 *  典型用法：edit 后跑 `tsc --noEmit` → AI 立刻看到类型错自行修复
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';

export interface HookResult {
	/** 命令是否退出码 0 */
	ok:       boolean;
	/** 退出码（null = 信号杀死） */
	exitCode: number | null;
	/** 截断后的输出（stdout + stderr） */
	output:   string;
	/** 实际耗时（ms） */
	durationMs: number;
}

export interface RunHookOptions {
	cwd:          string;
	timeoutMs?:   number;   // 默认 30s
	maxOutBytes?: number;   // 默认 8KB
}

/**
 * 执行一个 hook 命令。永不抛错——失败时返回 ok=false 让调用方决定如何展示。
 */
export async function runHookCommand(cmd: string, opts: RunHookOptions): Promise<HookResult> {
	const timeoutMs   = opts.timeoutMs   ?? 30_000;
	const maxOutBytes = opts.maxOutBytes ?? 8 * 1024;
	const start = Date.now();

	return new Promise<HookResult>((resolve) => {
		const child = spawn('sh', ['-c', cmd], {
			cwd: opts.cwd,
			env: { ...process.env, MAXIAN_HOOK: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let buf      = '';
		let truncated = false;
		const onChunk = (chunk: Buffer): void => {
			if (truncated) return;
			const next = buf + chunk.toString('utf8');
			if (next.length > maxOutBytes) {
				buf = next.slice(0, maxOutBytes) + `\n... (输出超过 ${maxOutBytes} 字节，已截断)`;
				truncated = true;
				try { child.kill('SIGTERM'); } catch { /* ignore */ }
				return;
			}
			buf = next;
		};
		child.stdout?.on('data', onChunk);
		child.stderr?.on('data', onChunk);

		const timer = setTimeout(() => {
			try { child.kill('SIGTERM'); } catch { /* ignore */ }
			buf += `\n... (hook 超时 ${timeoutMs}ms 被终止)`;
		}, timeoutMs);

		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({
				ok:         code === 0,
				exitCode:   code,
				output:     buf,
				durationMs: Date.now() - start,
			});
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({
				ok:         false,
				exitCode:   null,
				output:     `hook 启动失败：${err.message}`,
				durationMs: Date.now() - start,
			});
		});
	});
}

/**
 * 把 hook 结果格式化成可附加到工具响应的 markdown 段。
 * AI 看到带 ❌ 的输出会主动修复；带 ✓ 的会跳过。
 */
export function formatHookResult(toolName: string, hookCmd: string, r: HookResult): string {
	const head = r.ok
		? `\n\n✓ PostToolUse hook（${toolName} → \`${hookCmd}\`）通过 · ${r.durationMs}ms`
		: `\n\n❌ PostToolUse hook（${toolName} → \`${hookCmd}\`）失败 · exit=${r.exitCode} · ${r.durationMs}ms`;
	if (!r.output.trim()) return head;
	return `${head}\n\`\`\`\n${r.output.trim()}\n\`\`\``;
}
