/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Execute Command Tool - 增强版
 *
 * 性能优化（借鉴 Cline CommandOrchestrator）：
 * - 输出缓冲与分块（避免大输出内存问题）
 * - 流式输出收集（实时反馈）
 * - 后台任务支持
 * - 智能输出截断（保留首尾关键信息）
 * - 超时控制与进程管理
 * - 常见命令优化（npm、yarn、git 等）
 *
 * K8d: 已迁移到 ctx.platform.terminal（NodeTerminal 实现）。
 * 本文件不再 `import 'child_process'`；shell 选择 / spawn / 取消 / 输出截断都在 NodeTerminal 内部。
 * Windows 错误识别 + 命令建议 + 输出格式化逻辑保留在本文件。
 */

import * as path from 'path';

/** 跨形态 UUID 生成：浏览器 / Node 18+ / Bun 都暴露 globalThis.crypto.randomUUID */
function uuid(): string {
	const c = (globalThis as any).crypto;
	if (c?.randomUUID) return c.uuid();
	const r = () => Math.random().toString(16).slice(2, 14).padEnd(12, '0');
	return `${r()}-${r().slice(0,4)}-4${r().slice(0,3)}-a${r().slice(0,3)}-${r().slice(0,12)}`;
}

import type { IToolContext } from './IToolContext.js';
import type { ToolResponse } from '../types/toolTypes.js';

// ========== 配置常量 ==========
const EXECUTE_CONFIG = {
	/** 默认超时（60秒） */
	DEFAULT_TIMEOUT: 60000,

	/** 最大超时（10分钟） */
	MAX_TIMEOUT: 600000,

	/** 最大输出长度（字符） */
	MAX_OUTPUT_LENGTH: 50000,

	/** 最大输出行数 */
	MAX_OUTPUT_LINES: 2000,

	/** 输出截断时保留的首尾行数 */
	SUMMARY_LINES_TO_KEEP: 100,

	/** 危险命令模式 */
	DANGEROUS_COMMANDS: [
		/rm\s+-rf\s+[\/~]/i,
		/rm\s+-rf\s+\*/i,
		/mkfs/i,
		/dd\s+if=/i,
		/:(){ :|:& };:/,
		/>\s*\/dev\/sd/i,
		/chmod\s+-R\s+777\s+\//i,
	],

	/** 长时间运行命令模式（需要更长超时） */
	LONG_RUNNING_COMMANDS: [
		/npm\s+(install|i|ci)/i,
		/yarn(\s+install)?$/i,
		/pnpm\s+install/i,
		/pip\s+install/i,
		/cargo\s+build/i,
		/mvn\s+(clean\s+)?install/i,
		/gradle\s+build/i,
		/make(\s+|$)/i,
		/docker\s+build/i,
	],
};

// ========== 输出缓冲 ==========

/**
 * 输出缓冲器
 */
class OutputBuffer {
	private lines: string[] = [];
	private totalBytes = 0;
	private truncated = false;

	constructor(
		private maxLines: number,
		private maxBytes: number
	) { }

	append(data: string): void {
		if (this.truncated) return;

		const newLines = data.split('\n');
		for (const line of newLines) {
			if (this.lines.length >= this.maxLines || this.totalBytes >= this.maxBytes) {
				this.truncated = true;
				return;
			}

			this.lines.push(line);
			this.totalBytes += line.length + 1;
		}
	}

	getOutput(): { content: string; truncated: boolean; lineCount: number } {
		return {
			content: this.lines.join('\n'),
			truncated: this.truncated,
			lineCount: this.lines.length,
		};
	}
}

// ========== 命令分析 ==========

/**
 * 检查是否为危险命令
 */
function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
	for (const pattern of EXECUTE_CONFIG.DANGEROUS_COMMANDS) {
		if (pattern.test(command)) {
			return {
				dangerous: true,
				reason: `命令匹配危险模式: ${pattern.toString()}`,
			};
		}
	}
	return { dangerous: false };
}

/**
 * 检查是否为长时间运行命令
 */
function isLongRunningCommand(command: string): boolean {
	return EXECUTE_CONFIG.LONG_RUNNING_COMMANDS.some(pattern => pattern.test(command));
}

/**
 * 解析命令获取程序名
 */
function getCommandProgram(command: string): string {
	// 处理环境变量前缀
	const cleanCmd = command.replace(/^[A-Z_]+=\S+\s+/g, '');
	// 获取第一个单词
	const match = cleanCmd.match(/^\s*(\S+)/);
	return match ? match[1] : '';
}

/**
 * 检测当前是否为 Windows 系统
 */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Windows 下常见的命令不存在错误（中英文系统均覆盖）
 */
const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
	// 英文系统
	'is not recognized as an internal or external command',
	'is not recognized as the name of a cmdlet',
	'command not found',
	'The term',
	'cannot be loaded because running scripts is disabled',
	// 中文系统
	'不是内部或外部命令',
	'无法识别',
	'不是命令、opcode 或脚本',
	'找不到',
];

/**
 * Windows 下常见的权限/访问拒绝错误
 */
const WINDOWS_PERMISSION_DENIED_PATTERNS = [
	'Access is denied',
	'access denied',
	'拒绝访问',
	'不允许',
	'permission denied',
];

/**
 * Windows 下常见的文件/目录不存在错误
 */
const WINDOWS_FILE_NOT_FOUND_PATTERNS = [
	'The system cannot find',
	'系统找不到',
	'找不到指定的路径',
	'找不到指定的文件',
	'ENOENT',
];

/**
 * 检测输出中是否包含 Windows 错误关键词（即使 exit code 为 0）
 */
function detectWindowsErrorInOutput(stdout: string, stderr: string): { hasError: boolean; errorType: string } {
	if (!IS_WINDOWS) return { hasError: false, errorType: '' };

	const combined = (stderr + '\n' + stdout).toLowerCase();

	const unixCommandsOnWindows = [
		{ pattern: "'ls' is not recognized", msg: 'unix-command' },
		{ pattern: "'cat' is not recognized", msg: 'unix-command' },
		{ pattern: "'rm' is not recognized", msg: 'unix-command' },
		{ pattern: "'grep' is not recognized", msg: 'unix-command' },
		{ pattern: "'find' is not recognized", msg: 'unix-command' },
		{ pattern: "'touch' is not recognized", msg: 'unix-command' },
		{ pattern: "'chmod' is not recognized", msg: 'unix-command' },
		{ pattern: "'mv' is not recognized", msg: 'unix-command' },
		{ pattern: "'cp' is not recognized", msg: 'unix-command' },
		{ pattern: "'which' is not recognized", msg: 'unix-command' },
		{ pattern: "'clear' is not recognized", msg: 'unix-command' },
		{ pattern: "'ls' 不是内部或外部命令", msg: 'unix-command' },
		{ pattern: "'cat' 不是内部或外部命令", msg: 'unix-command' },
		{ pattern: "'rm' 不是内部或外部命令", msg: 'unix-command' },
		{ pattern: "'grep' 不是内部或外部命令", msg: 'unix-command' },
	];

	for (const { pattern, msg } of unixCommandsOnWindows) {
		if (combined.includes(pattern.toLowerCase())) {
			return { hasError: true, errorType: msg };
		}
	}

	for (const pattern of WINDOWS_COMMAND_NOT_FOUND_PATTERNS) {
		if (combined.includes(pattern.toLowerCase())) {
			return { hasError: true, errorType: 'command-not-found' };
		}
	}

	for (const pattern of WINDOWS_PERMISSION_DENIED_PATTERNS) {
		if (combined.includes(pattern.toLowerCase())) {
			return { hasError: true, errorType: 'permission-denied' };
		}
	}

	for (const pattern of WINDOWS_FILE_NOT_FOUND_PATTERNS) {
		if (combined.includes(pattern.toLowerCase())) {
			return { hasError: true, errorType: 'file-not-found' };
		}
	}

	return { hasError: false, errorType: '' };
}

/**
 * 获取命令建议
 */
function getCommandSuggestions(command: string, error: string, stdout: string = ''): string[] {
	const suggestions: string[] = [];
	const program = getCommandProgram(command);
	const combined = error + '\n' + stdout;

	if (IS_WINDOWS) {
		const unixToWindowsMap: Record<string, string> = {
			'ls': 'dir 或 Get-ChildItem（PowerShell）',
			'cat': 'type（CMD）或 Get-Content（PowerShell）',
			'rm': 'del（文件）或 rmdir /s /q（目录）',
			'grep': 'findstr（CMD）或 Select-String（PowerShell）',
			'find': 'dir /s /b（CMD）或 Get-ChildItem -Recurse（PowerShell）',
			'touch': 'type nul > file.txt（CMD）或 New-Item（PowerShell）',
			'mv': 'move（CMD）或 Move-Item（PowerShell）',
			'cp': 'copy（CMD）或 Copy-Item（PowerShell）',
			'chmod': 'Windows 不支持 chmod，可使用 icacls',
			'which': 'where（CMD）或 Get-Command（PowerShell）',
			'clear': 'cls（CMD）或 Clear-Host（PowerShell）',
			'export': 'set VAR=value（CMD）或 $env:VAR="value"（PowerShell）',
			'echo': '语法正确，但变量引用用 %VAR%（CMD）或 $env:VAR（PowerShell）',
		};

		if (unixToWindowsMap[program]) {
			suggestions.push(`Windows 不支持 "${program}" 命令，请改用: ${unixToWindowsMap[program]}`);
		}

		if (
			WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some(p => combined.toLowerCase().includes(p.toLowerCase())) ||
			combined.includes('not recognized')
		) {
			if (!unixToWindowsMap[program]) {
				suggestions.push(`请确保 "${program}" 已安装并在系统 PATH 中`);
				suggestions.push('在 PowerShell 中运行 where <命令名> 检查是否可用');
			}
		}

		if (WINDOWS_PERMISSION_DENIED_PATTERNS.some(p => combined.toLowerCase().includes(p.toLowerCase()))) {
			suggestions.push('请以管理员权限运行（右键 → 以管理员身份运行）');
		}

		if (WINDOWS_FILE_NOT_FOUND_PATTERNS.some(p => combined.toLowerCase().includes(p.toLowerCase()))) {
			suggestions.push('请检查文件路径是否正确，注意 Windows 路径使用反斜杠 \\');
		}
	} else {
		// Unix/macOS 错误处理
		if (combined.includes('command not found') || combined.includes('not recognized')) {
			if (program === 'node' || program === 'npm') {
				suggestions.push('请确保已安装 Node.js');
			} else if (program === 'python' || program === 'python3') {
				suggestions.push('请确保已安装 Python');
			} else if (program === 'git') {
				suggestions.push('请确保已安装 Git');
			} else {
				suggestions.push(`请确保 ${program} 已安装并在 PATH 中`);
			}
		}

		if (combined.includes('permission denied')) {
			suggestions.push('尝试添加执行权限: chmod +x <file>');
			if (!command.startsWith('sudo')) {
				suggestions.push('或使用 sudo 提升权限');
			}
		}
	}

	if (combined.includes('ENOENT')) {
		suggestions.push('请检查文件或目录路径是否正确');
	}

	if (combined.includes('ETIMEDOUT') || combined.includes('timeout')) {
		suggestions.push('命令执行超时，尝试增加超时时间或检查网络连接');
	}

	return suggestions;
}

// ========== 主函数 ==========

/** 流式输出回调：stdout/stderr 到达时实时调用（用于前端展示） */
export type CommandOutputSink = (chunk: string, kind: 'stdout' | 'stderr') => void | Promise<void>;

export async function executeCommandTool(
	ctx: IToolContext,
	params: any,
	onOutput?: CommandOutputSink,
): Promise<ToolResponse> {
	const command = params.command;
	const customCwd = params.cwd;
	const background = params.background === 'true' || params.background === true;

	if (!command) {
		return 'Error: No command provided';
	}

	if (!ctx.platform?.terminal) {
		return 'Error: platform.terminal 未注入；core 已不再直接调用 child_process，调用方需提供 ITerminal 实现。';
	}

	// 检查危险命令
	const dangerCheck = isDangerousCommand(command);
	if (dangerCheck.dangerous) {
		return `⚠️ 危险命令被阻止\n\n命令: ${command}\n原因: ${dangerCheck.reason}\n\n如果确实需要执行此命令，请手动在终端中运行。`;
	}

	try {
		// 确定工作目录
		let workingDir: string;
		if (!customCwd) {
			workingDir = ctx.workspacePath;
		} else if (path.isAbsolute(customCwd)) {
			workingDir = customCwd;
		} else {
			workingDir = path.resolve(ctx.workspacePath, customCwd);
		}

		// 检查目录是否存在（K8e: async via platform.fs）
		if (ctx.platform?.fs) {
			const exists = await ctx.platform.fs.exists(workingDir);
			if (!exists) {
				return `Error: Working directory does not exist: ${workingDir}`;
			}
		}

		// 确定超时时间
		const timeout = isLongRunningCommand(command)
			? EXECUTE_CONFIG.MAX_TIMEOUT
			: EXECUTE_CONFIG.DEFAULT_TIMEOUT;

		console.log(`[ExecuteCommand] 执行命令: ${command}`);
		console.log(`[ExecuteCommand] 工作目录: ${workingDir}`);
		console.log(`[ExecuteCommand] 超时时间: ${timeout}ms`);
		console.log(`[ExecuteCommand] 后台模式: ${background}`);

		// 后台任务模式
		if (background) {
			return await executeBackgroundCommand(ctx, command, workingDir);
		}

		// 前台任务模式
		return await executeForegroundCommand(ctx, command, workingDir, timeout, onOutput);

	} catch (error: any) {
		const errorMessage = error.message || String(error);
		const suggestions = getCommandSuggestions(command, errorMessage, '');

		const output = [
			`❌ 命令执行失败`,
			'',
			`命令: ${command}`,
			`错误: ${errorMessage}`,
		];

		if (suggestions.length > 0) {
			output.push('');
			output.push('💡 建议:');
			suggestions.forEach(s => output.push(`  - ${s}`));
		}

		return output.join('\n');
	}
}

/**
 * 执行前台命令（K8d: 走 ctx.platform.terminal.executeStream）
 */
async function executeForegroundCommand(
	ctx: IToolContext,
	command: string,
	workingDir: string,
	timeout: number,
	onOutput?: CommandOutputSink,
): Promise<ToolResponse> {
	const terminal = ctx.platform!.terminal;
	const startTime = Date.now();
	const stdoutBuffer = new OutputBuffer(
		EXECUTE_CONFIG.MAX_OUTPUT_LINES,
		EXECUTE_CONFIG.MAX_OUTPUT_LENGTH
	);
	const stderrBuffer = new OutputBuffer(
		EXECUTE_CONFIG.MAX_OUTPUT_LINES / 2,
		EXECUTE_CONFIG.MAX_OUTPUT_LENGTH / 2
	);

	const cancellationToken = uuid();
	let exitCode: number | null = null;
	let timedOut = false;
	let devServerStarted = false;
	let devServerPid: string | undefined;

	try {
		for await (const chunk of terminal.executeStream(command, {
			cwd: workingDir,
			timeoutMs: timeout,
			detectDevServer: true,
			cancellationToken,
		})) {
			if (chunk.type === 'stdout' && chunk.data) {
				stdoutBuffer.append(chunk.data);
				if (onOutput) {
					try { await onOutput(chunk.data, 'stdout'); } catch { /* ignore */ }
				}
				// dev server detect：NodeTerminal 检测到 idle 后会推一段标记文本然后 exit
				if (/\[dev server 已识别为就绪/.test(chunk.data)) {
					devServerStarted = true;
					const m = chunk.data.match(/pid=(\d+)/);
					if (m) devServerPid = m[1];
				}
			} else if (chunk.type === 'stderr' && chunk.data) {
				stderrBuffer.append(chunk.data);
				if (onOutput) {
					try { await onOutput(chunk.data, 'stderr'); } catch { /* ignore */ }
				}
			} else if (chunk.type === 'exit') {
				exitCode = chunk.exitCode ?? null;
				timedOut = chunk.timedOut ?? false;
			}
		}
	} catch (error) {
		const elapsed = Date.now() - startTime;
		return [
			`❌ 命令启动失败`,
			'',
			`命令: ${command}`,
			`工作目录: ${workingDir}`,
			`错误: ${(error as Error).message}`,
			`耗时: ${formatDuration(elapsed)}`,
		].join('\n');
	}

	const elapsed = Date.now() - startTime;
	const stdout = stdoutBuffer.getOutput();
	const stderr = stderrBuffer.getOutput();

	ctx.didEditFile = true;

	// dev server 模式：返回简短说明 + 部分输出
	if (devServerStarted) {
		const base = formatCommandResult(
			command, workingDir,
			0, stdout, stderr, elapsed, timeout,
		);
		const note = `\n\n💡 此命令被识别为长时间运行的服务（dev server / watcher / tail -f 等），已在后台继续运行（pid=${devServerPid ?? 'unknown'}）。上方输出为前 ${Math.round(elapsed / 1000)}s 捕获到的内容，服务仍在运行，不会被自动终止。`;
		return base + note;
	}

	if (timedOut) {
		return formatCommandResult(command, workingDir, -1, stdout, stderr, elapsed, timeout) +
			'\n\n⚠️ 已达超时阈值，进程被强制终止。';
	}

	return formatCommandResult(
		command,
		workingDir,
		exitCode ?? -1,
		stdout,
		stderr,
		elapsed,
		timeout
	);
}

/**
 * 执行后台命令（K8d: 走 ctx.platform.terminal.executeBackground）
 */
async function executeBackgroundCommand(
	ctx: IToolContext,
	command: string,
	workingDir: string,
): Promise<ToolResponse> {
	const terminal = ctx.platform!.terminal;
	if (!terminal.executeBackground) {
		return 'Error: platform.terminal 不支持 executeBackground（IDE 形态可能无此能力）';
	}

	try {
		const { pid } = await terminal.executeBackground(command, { cwd: workingDir });
		return [
			`🚀 后台任务已启动`,
			'',
			`命令: ${command}`,
			`工作目录: ${workingDir}`,
			`PID: ${pid}`,
			'',
			'💡 提示：后台进程已脱离父进程组，不会被本会话取消时连带杀掉。',
			'   如需终止，请手动使用 kill 或 task manager。',
		].join('\n');
	} catch (err) {
		return `❌ 后台任务启动失败：${(err as Error).message}`;
	}
}

// ========== 输出格式化 ==========

/**
 * 格式化命令结果
 */
function formatCommandResult(
	command: string,
	workingDir: string,
	exitCode: number,
	stdout: { content: string; truncated: boolean; lineCount: number },
	stderr: { content: string; truncated: boolean; lineCount: number },
	elapsed: number,
	timeout: number
): string {
	// Windows 下即使 exit code 为 0，也可能通过输出内容检测到错误
	const windowsOutputError = detectWindowsErrorInOutput(stdout.content, stderr.content);
	const isSuccess = exitCode === 0 && !windowsOutputError.hasError;
	const isTimeout = elapsed >= timeout - 1000;

	let failReason = '';
	if (exitCode !== 0) {
		failReason = ` (退出码: ${exitCode})`;
	} else if (windowsOutputError.hasError) {
		failReason = ` (Windows 指令错误，退出码为 0 但输出含错误信息)`;
	}

	const header = [
		isSuccess ? `✅ 命令执行成功` : `❌ 命令执行失败${failReason}`,
		'',
		`命令: ${command}`,
		`工作目录: ${workingDir}`,
		`耗时: ${formatDuration(elapsed)}${isTimeout ? ' (接近超时)' : ''}`,
	];

	const output: string[] = [...header];

	const BYTE_LIMIT = 30 * 1024;
	const BYTE_HEAD = 10 * 1024;
	const BYTE_TAIL = 10 * 1024;

	if (stdout.content.trim()) {
		const stdoutBytes = Buffer.byteLength(stdout.content, 'utf8');
		const needsByteTruncate = stdoutBytes > BYTE_LIMIT;
		const truncatedLabel = (stdout.truncated || needsByteTruncate) ? ' (已截断)' : '';
		output.push('');
		output.push(`📤 输出${truncatedLabel} (${stdout.lineCount} 行):`);
		output.push('```');

		let content = stdout.content;
		if (stdout.truncated) {
			content = truncateOutput(content, EXECUTE_CONFIG.SUMMARY_LINES_TO_KEEP);
		}
		if (Buffer.byteLength(content, 'utf8') > BYTE_LIMIT) {
			content = truncateByBytes(content, BYTE_LIMIT, BYTE_HEAD, BYTE_TAIL);
		}
		output.push(content);

		output.push('```');
	}

	if (stderr.content.trim()) {
		const stderrBytes = Buffer.byteLength(stderr.content, 'utf8');
		const needsByteTruncate = stderrBytes > BYTE_LIMIT;
		const truncatedLabel = (stderr.truncated || needsByteTruncate) ? ' (已截断)' : '';
		output.push('');
		output.push(`⚠️ 错误输出${truncatedLabel} (${stderr.lineCount} 行):`);
		output.push('```');

		let content = stderr.content;
		if (stderr.truncated) {
			content = truncateOutput(content, EXECUTE_CONFIG.SUMMARY_LINES_TO_KEEP / 2);
		}
		if (Buffer.byteLength(content, 'utf8') > BYTE_LIMIT) {
			content = truncateByBytes(content, BYTE_LIMIT, BYTE_HEAD, BYTE_TAIL);
		}
		output.push(content);

		output.push('```');
	}

	if (!isSuccess) {
		const suggestions = getCommandSuggestions(command, stderr.content, stdout.content);
		if (suggestions.length > 0) {
			output.push('');
			output.push('💡 建议:');
			suggestions.forEach(s => output.push(`  - ${s}`));
		}

		if (windowsOutputError.hasError && exitCode === 0) {
			output.push('');
			output.push('⚠️ 注意: 此命令返回了退出码 0，但输出中包含错误信息，任务实际上未成功执行。');
			if (windowsOutputError.errorType === 'unix-command') {
				output.push('   → 当前系统为 Windows，请使用对应的 Windows/PowerShell 命令替代。');
			}
		}
	}

	return output.join('\n');
}

/**
 * 按字节数做头尾截断
 */
function truncateByBytes(content: string, limit: number, headBytes: number, tailBytes: number): string {
	const totalBytes = Buffer.byteLength(content, 'utf8');
	if (totalBytes <= limit) {
		return content;
	}

	const buf = Buffer.from(content, 'utf8');
	let headEnd = Math.min(headBytes, buf.length);
	while (headEnd > 0 && (buf[headEnd] & 0xC0) === 0x80) {
		headEnd--;
	}
	let tailStart = Math.max(buf.length - tailBytes, headEnd);
	while (tailStart < buf.length && (buf[tailStart] & 0xC0) === 0x80) {
		tailStart++;
	}

	const head = buf.slice(0, headEnd).toString('utf8');
	const tail = buf.slice(tailStart).toString('utf8');

	const omittedBytes = totalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
	const omittedLines = content.split('\n').length - head.split('\n').length - tail.split('\n').length;

	return `${head}\n... [${omittedLines} lines / ${omittedBytes} bytes omitted] ...\n${tail}`;
}

/**
 * 智能截断输出（保留首尾）
 */
function truncateOutput(content: string, keepLines: number): string {
	const lines = content.split('\n');

	if (lines.length <= keepLines * 2) {
		return content;
	}

	const head = lines.slice(0, keepLines);
	const tail = lines.slice(-keepLines);
	const skipped = lines.length - keepLines * 2;

	return [
		...head,
		'',
		`... (${skipped} 行已省略) ...`,
		'',
		...tail,
	].join('\n');
}

/**
 * 格式化时长
 */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.round((ms % 60000) / 1000);
	return `${minutes}m ${seconds}s`;
}
