/*---------------------------------------------------------------------------------------------
 *  Maxian Core — NodeTerminal（ITerminal 的 Node 实现）
 *
 *  K8d：把原本散在 bashTool / executeCommandTool 里的 child_process / shell 选择 / 超时 /
 *  取消 / 输出截断逻辑收敛到此 adapter。core 工具不再 `import 'node:child_process'`。
 *
 *  能力覆盖：
 *  - execute(cmd, opts)            短命令，等待完成
 *  - executeStream(cmd, opts)      流式 chunk yield，长命令
 *  - executeBackground(cmd, opts)  fire-and-forget，返回 PID
 *  - cancel(token)                 中断（taskkill /T /F on Windows，SIGTERM/SIGKILL on unix）
 *
 *  Windows shell 选择优先级（沿用 bashTool 逻辑）：
 *  1. MAXIAN_GIT_BASH_PATH 环境变量
 *  2. `where git` → 推导同根目录的 bash.exe
 *  3. `where bash`
 *  4. 几个常见硬编码默认路径
 *  5. PowerShell 7 / 内置 PowerShell（-NoLogo -NoProfile -NonInteractive -Command）
 *  6. null → 让 spawn 用 cmd.exe + shell:true 兜底
 *--------------------------------------------------------------------------------------------*/

import { spawn, exec, execSync, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
	ITerminal,
	ExecuteOptions,
	ExecuteResult,
	TerminalChunk,
} from '../interfaces/ITerminal.js';

// ─── 常量 ───────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS  = 120_000;     // 2 min
const MAX_TIMEOUT_MS      = 600_000;     // 10 min
const DEFAULT_MAX_BYTES   = 50_000;
const DEFAULT_MAX_LINES   = 2000;
const STDERR_HARD_CAP     = 500_000;     // 防 stderr 单独爆掉
const STDOUT_HARD_CAP     = 1_000_000;   // 防止 dev server 类无限输出
const ANSI_RE             = /\x1B(?:\[[0-?]*[ -/]*[@-~])|\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[=>]/g;

function stripAnsi(s: string): string {
	if (!s) return s;
	return s.replace(ANSI_RE, '');
}

// ─── Windows shell 选择（沿用 bashTool 原逻辑）────────────────────
function whichOnWindows(bin: string): string | null {
	if (process.platform !== 'win32') return null;
	try {
		const out = execSync(`where ${bin}`, {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).toString().trim();
		const first = out.split(/\r?\n/).find(Boolean);
		return first && fs.existsSync(first) ? first : null;
	} catch {
		return null;
	}
}

interface ShellChoice {
	shell:      string;
	prefixArgs: string[];
}

function pickWindowsShell(): ShellChoice | null {
	if (process.platform !== 'win32') return null;

	// 1. 环境变量显式覆盖
	const envOverride = process.env.MAXIAN_GIT_BASH_PATH;
	if (envOverride && fs.existsSync(envOverride)) {
		return { shell: envOverride, prefixArgs: ['-lc'] };
	}

	// 2. `where git` → 推导 bash.exe（典型 Git for Windows 安装）
	const gitExe = whichOnWindows('git');
	if (gitExe) {
		const gitRoot = path.resolve(path.dirname(gitExe), '..');
		const candidates = [
			path.join(gitRoot, 'bin', 'bash.exe'),
			path.join(gitRoot, 'usr', 'bin', 'bash.exe'),
		];
		for (const p of candidates) {
			if (fs.existsSync(p)) return { shell: p, prefixArgs: ['-lc'] };
		}
	}

	// 3. `where bash`（msys / wsl / scoop / choco 等）
	const bashExe = whichOnWindows('bash');
	if (bashExe) return { shell: bashExe, prefixArgs: ['-lc'] };

	// 4. 几个常见默认路径
	const hardcoded = [
		'C:\\Program Files\\Git\\bin\\bash.exe',
		'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
		'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
	];
	for (const p of hardcoded) {
		try { if (fs.existsSync(p)) return { shell: p, prefixArgs: ['-lc'] }; } catch { /* ignore */ }
	}

	// 5. PowerShell
	const psCandidates = [
		whichOnWindows('pwsh'),
		whichOnWindows('powershell'),
		'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
		process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : '',
	].filter(Boolean) as string[];
	for (const p of psCandidates) {
		try {
			if (fs.existsSync(p)) {
				return { shell: p, prefixArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] };
			}
		} catch { /* ignore */ }
	}

	// 6. null → 上层退回 cmd.exe
	return null;
}

// ─── 长运行服务检测（dev server / watcher）─────────────────────────
const DEV_SERVER_PATTERNS: RegExp[] = [
	/\b(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/i,
	/\bvite(\s|$)/i,
	/\bnext\s+(dev|start)\b/i,
	/\bwebpack(-dev-server)?\s+(serve|--serve)\b/i,
	/\bnuxt\s+dev\b/i,
	/\brollup\s+-w\b/i,
	/\bnodemon\b/i,
	/\btail\s+-f\b/i,
	/\bflask\s+run\b/i,
	/\buvicorn\b/i,
	/\bgunicorn\b/i,
	/\bdocker\s+logs\s+-f\b/i,
	/\bkubectl\s+logs\s+-f\b/i,
];

function isDevServerCommand(cmd: string): boolean {
	return DEV_SERVER_PATTERNS.some((re) => re.test(cmd));
}

// ─── 取消（终止进程树）────────────────────────────────────────────
function killProcessTree(child: ChildProcess): void {
	if (process.platform === 'win32' && child.pid) {
		try {
			exec(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true } as any, () => { /* swallow */ });
		} catch { /* ignore */ }
	} else {
		try { child.kill('SIGTERM'); } catch { /* ignore */ }
		setTimeout(() => {
			try { child.kill('SIGKILL'); } catch { /* ignore */ }
		}, 2000);
	}
}

// ─── NodeTerminal ─────────────────────────────────────────────────
export class NodeTerminal implements ITerminal {
	/** token → ChildProcess（cancel 时 lookup） */
	private readonly running = new Map<string, ChildProcess>();

	/**
	 * 短命令执行。
	 * 内部共用 executeStream 的 chunk 流，等待 exit 事件后返回 ExecuteResult。
	 */
	async execute(command: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
		const startTime = Date.now();
		const timeoutMs = clampTimeout(options.timeoutMs);
		const maxBytes  = options.maxOutputBytes ?? DEFAULT_MAX_BYTES;
		const maxLines  = options.maxOutputLines ?? DEFAULT_MAX_LINES;
		const detectDev = options.detectDevServer ?? false;

		let stdout = '';
		let stderr = '';
		let stdoutLines = 0;
		let stderrLines = 0;
		let truncatedStdout = false;
		let truncatedStderr = false;

		try {
			for await (const chunk of this.executeStream(command, options)) {
				if (chunk.type === 'stdout' && chunk.data) {
					stdout += chunk.data;
					stdoutLines += (chunk.data.match(/\n/g) ?? []).length;
					if (stdout.length > maxBytes && !truncatedStdout) {
						stdout = stdout.slice(0, maxBytes) + '\n[stdout 已按 maxOutputBytes 截断]';
						truncatedStdout = true;
					}
					if (stdoutLines > maxLines && !truncatedStdout) {
						stdout = stdout.split('\n').slice(0, maxLines).join('\n') + '\n[stdout 已按 maxOutputLines 截断]';
						truncatedStdout = true;
					}
				} else if (chunk.type === 'stderr' && chunk.data) {
					stderr += chunk.data;
					stderrLines += (chunk.data.match(/\n/g) ?? []).length;
					if (stderr.length > maxBytes && !truncatedStderr) {
						stderr = stderr.slice(0, maxBytes) + '\n[stderr 已按 maxOutputBytes 截断]';
						truncatedStderr = true;
					}
				} else if (chunk.type === 'exit') {
					return {
						exitCode: chunk.exitCode ?? null,
						stdout,
						stderr,
						timedOut: chunk.timedOut ?? false,
						cancelled: chunk.cancelled ?? false,
						devServerStarted: false,   // executeStream 不做 dev server detect；调用方主动用 detectDevServer 模式
						durationMs: Date.now() - startTime,
					};
				}
			}
		} catch (err) {
			return {
				exitCode: 1,
				stdout,
				stderr: stderr + '\n' + (err as Error).message,
				timedOut: false,
				cancelled: false,
				devServerStarted: false,
				durationMs: Date.now() - startTime,
			};
		}

		// 不应到这（executeStream 总会 yield exit）
		return {
			exitCode: null,
			stdout,
			stderr,
			timedOut: false,
			cancelled: false,
			devServerStarted: false,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * 流式执行：每段 stdout/stderr 立即 yield；最后 yield 一个 exit chunk。
	 * 支持 detectDevServer：识别为 dev server 后 idle-detach（3s 无输出视为就绪）。
	 */
	async *executeStream(command: string, options: ExecuteOptions = {}): AsyncIterable<TerminalChunk> {
		const cwd       = options.cwd ?? process.cwd();
		const timeoutMs = clampTimeout(options.timeoutMs);
		const detectDev = (options.detectDevServer ?? false) && isDevServerCommand(command);
		const token     = options.cancellationToken ?? randomUUID();
		const winShell  = pickWindowsShell();

		const queue: TerminalChunk[] = [];
		const wakers: Array<() => void> = [];
		let finished = false;
		let timedOut = false;
		let cancelled = false;

		const enqueue = (c: TerminalChunk) => {
			queue.push(c);
			const w = wakers.shift();
			if (w) w();
		};

		const spawnOpts: any = {
			cwd,
			env: { ...process.env, ...options.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32' && detectDev,
			windowsHide: true,
		};

		const child = winShell
			? spawn(winShell.shell, [...winShell.prefixArgs, command], spawnOpts)
			: spawn(command, { ...spawnOpts, shell: true });

		this.running.set(token, child);

		// 输出限额（防止 dev server 类无限输出爆炸）
		let stdoutTotal = 0;
		let stderrTotal = 0;

		// dev server idle 检测
		const startTime = Date.now();
		let lastOutputTime = Date.now();
		const IDLE_MS  = 3000;
		const MIN_WAIT = 2500;
		const idleChecker = detectDev ? setInterval(() => {
			if (finished) return;
			const elapsed = Date.now() - startTime;
			const idleFor = Date.now() - lastOutputTime;
			if (elapsed >= MIN_WAIT && idleFor >= IDLE_MS) {
				// 视为就绪：标记为 devServerStarted 并 detach（unref + 关闭 stdin/stdout 监听）
				try { child.unref(); } catch { /* ignore */ }
				try { child.stdout?.removeAllListeners('data'); } catch { /* ignore */ }
				try { child.stderr?.removeAllListeners('data'); } catch { /* ignore */ }
				enqueue({ type: 'stdout', data: `\n[dev server 已识别为就绪，pid=${child.pid}，已后台运行]\n` });
				enqueue({ type: 'exit', exitCode: 0, cancelled: false, timedOut: false });
				if (idleChecker) clearInterval(idleChecker);
				finished = true;
			}
		}, 500) : null;

		// 超时杀进程树
		const killTimer = timeoutMs > 0 ? setTimeout(() => {
			if (finished) return;
			timedOut = true;
			killProcessTree(child);
		}, timeoutMs) : null;

		child.stdout?.on('data', (d: Buffer) => {
			lastOutputTime = Date.now();
			const chunk = stripAnsi(d.toString('utf8'));
			stdoutTotal += chunk.length;
			if (stdoutTotal > STDOUT_HARD_CAP) {
				if (!detectDev) killProcessTree(child);
				return;
			}
			enqueue({ type: 'stdout', data: chunk });
		});

		child.stderr?.on('data', (d: Buffer) => {
			lastOutputTime = Date.now();
			const chunk = stripAnsi(d.toString('utf8'));
			stderrTotal += chunk.length;
			if (stderrTotal > STDERR_HARD_CAP) return;
			enqueue({ type: 'stderr', data: chunk });
		});

		child.on('error', (e: Error) => {
			if (finished) return;
			enqueue({ type: 'stderr', data: '\n' + e.message });
			enqueue({ type: 'exit', exitCode: 1, cancelled, timedOut });
			finished = true;
			if (killTimer) clearTimeout(killTimer);
			if (idleChecker) clearInterval(idleChecker);
		});

		child.on('close', (code: number | null) => {
			if (finished) return;
			enqueue({ type: 'exit', exitCode: timedOut ? null : code, cancelled, timedOut });
			finished = true;
			if (killTimer) clearTimeout(killTimer);
			if (idleChecker) clearInterval(idleChecker);
		});

		// 把 ChildProcess 注册到 running，cancel(token) 时 lookup
		try {
			while (true) {
				if (queue.length === 0 && !finished) {
					await new Promise<void>((resolve) => wakers.push(resolve));
				}
				while (queue.length > 0) {
					const c = queue.shift()!;
					yield c;
					if (c.type === 'exit') {
						return;
					}
				}
				if (finished) return;
			}
		} finally {
			this.running.delete(token);
		}
	}

	/**
	 * 中断指定 token 的命令。
	 * Windows: taskkill /T /F 杀整棵进程树。
	 * Unix: SIGTERM → 2s 后 SIGKILL。
	 */
	async cancel(token: string): Promise<void> {
		const child = this.running.get(token);
		if (!child) return;
		killProcessTree(child);
		this.running.delete(token);
	}

	/**
	 * 后台启动命令（fire-and-forget）。
	 * Windows: detached=false（避免孤儿进程），靠 unref() 让父进程不等子进程。
	 * Unix: detached=true 让子进程脱离父进程组。
	 */
	async executeBackground(command: string, options: ExecuteOptions = {}): Promise<{ pid: number }> {
		const cwd      = options.cwd ?? process.cwd();
		const winShell = pickWindowsShell();

		const spawnOpts: any = {
			cwd,
			env: { ...process.env, ...options.env },
			detached: process.platform !== 'win32',
			stdio: 'ignore',
			windowsHide: true,
		};

		const child = winShell
			? spawn(winShell.shell, [...winShell.prefixArgs, command], spawnOpts)
			: spawn(command, { ...spawnOpts, shell: true });

		child.unref();
		const pid = child.pid;
		if (typeof pid !== 'number') {
			throw new Error('background spawn 启动失败，未拿到 PID');
		}
		return { pid };
	}
}

function clampTimeout(t?: number): number {
	if (t === undefined) return DEFAULT_TIMEOUT_MS;
	if (t <= 0) return 0;   // 0 = 不超时
	return Math.min(Math.max(t, 1000), MAX_TIMEOUT_MS);
}
