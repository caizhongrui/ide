/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Sub-agent Worktree Isolation (B1)
 *
 *  当 task() 调用指定 isolation='worktree' 时，自动：
 *  1. 在父代理 workspace 下检测是否是 git 仓库（不是 → 直接降级 inherit）
 *  2. 检测当前分支是否 dirty（有未提交改动 → 降级 inherit + 警告，避免误把脏改动 fork 进去）
 *  3. git worktree add 一个新 worktree 到 ~/.maxian/worktrees/<sessionId>/
 *     新分支名：subagent/<task_id>，基于父分支 HEAD
 *  4. 子代理在该 worktree 工作（独立 working tree，不污染主分支）
 *  5. 子代理完成后 git worktree remove --force（不论成败都清掉，分支保留供事后查看）
 *
 *  失败处理：
 *  - 任何 git 命令报错 → resolve 成 inherit + 详细错误日志
 *  - 子代理任务结束后 cleanup 失败 → 不抛错，只 console.warn
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const MAXIAN_WORKTREE_ROOT = path.join(os.homedir(), '.maxian', 'worktrees');

export interface WorktreeResolution {
	/** 实际给子代理用的 workspace 路径 */
	effectiveWorkspacePath: string;
	/** 是否真的进入 worktree 模式（false = 降级到 inherit） */
	isWorktree:    boolean;
	/** worktree 路径（仅 isWorktree=true 时） */
	worktreePath?: string;
	/** 分支名（仅 isWorktree=true 时） */
	branchName?:   string;
	/** 降级原因（isWorktree=false 时；用于日志） */
	downgradeReason?: string;
}

/**
 * 异步 spawn 的 helper：返回 stdout，非零退出码时抛错。
 */
async function gitExec(cwd: string, args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const to = setTimeout(() => {
			try { child.kill('SIGTERM'); } catch { /* ignore */ }
			resolve({ stdout, stderr: stderr + '\n[timeout]', code: 124 });
		}, timeoutMs);
		child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
		child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
		child.on('exit', (code) => {
			clearTimeout(to);
			resolve({ stdout, stderr, code: code ?? 0 });
		});
		child.on('error', (err) => {
			clearTimeout(to);
			resolve({ stdout, stderr: stderr + '\n' + err.message, code: 127 });
		});
	});
}

/** 父 workspace 是否 git 仓库 */
async function isGitRepo(parentWorkspacePath: string): Promise<boolean> {
	const r = await gitExec(parentWorkspacePath, ['rev-parse', '--is-inside-work-tree']);
	return r.code === 0 && r.stdout.trim() === 'true';
}

/** 父 workspace 是否 dirty（有未提交变更） */
async function isWorkingTreeDirty(parentWorkspacePath: string): Promise<boolean> {
	const r = await gitExec(parentWorkspacePath, ['status', '--porcelain']);
	if (r.code !== 0) return true; // 当 git 命令出错时按 dirty 处理（保守）
	return r.stdout.trim().length > 0;
}

/** 当前 HEAD 短哈希 */
async function getHeadCommit(parentWorkspacePath: string): Promise<string> {
	const r = await gitExec(parentWorkspacePath, ['rev-parse', 'HEAD']);
	return r.stdout.trim() || 'HEAD';
}

/**
 * 主入口：根据用户传入的 isolation 决定真正给子代理用的工作目录。
 *
 * @param parentWorkspacePath 父代理工作区
 * @param desired             用户指定的 isolation
 * @param taskId              用于命名分支 + worktree 子目录
 */
export async function resolveSubagentWorkspace(
	parentWorkspacePath: string,
	desired: 'inherit' | 'worktree',
	taskId: string,
): Promise<WorktreeResolution> {
	if (desired === 'inherit') {
		return { effectiveWorkspacePath: parentWorkspacePath, isWorktree: false };
	}

	// desired === 'worktree'
	if (!await isGitRepo(parentWorkspacePath)) {
		return {
			effectiveWorkspacePath: parentWorkspacePath,
			isWorktree:             false,
			downgradeReason:        '父工作区不是 git 仓库，无法 worktree 隔离，降级为 inherit',
		};
	}
	if (await isWorkingTreeDirty(parentWorkspacePath)) {
		return {
			effectiveWorkspacePath: parentWorkspacePath,
			isWorktree:             false,
			downgradeReason:        '父工作区有未提交变更，worktree 隔离会复制脏改动；降级为 inherit',
		};
	}

	const branchName = `subagent/${taskId}`;
	const worktreePath = path.join(MAXIAN_WORKTREE_ROOT, taskId);
	try {
		fs.mkdirSync(MAXIAN_WORKTREE_ROOT, { recursive: true });
	} catch { /* mkdir 失败不致命 */ }

	const head = await getHeadCommit(parentWorkspacePath);
	const r = await gitExec(parentWorkspacePath, ['worktree', 'add', '-b', branchName, worktreePath, head], 30_000);
	if (r.code !== 0) {
		return {
			effectiveWorkspacePath: parentWorkspacePath,
			isWorktree:             false,
			downgradeReason:        `git worktree add 失败：${r.stderr.trim() || `exit=${r.code}`}；降级为 inherit`,
		};
	}

	console.log(`[SubagentWorktree] worktree 已创建：${worktreePath} (branch=${branchName})`);
	return {
		effectiveWorkspacePath: worktreePath,
		isWorktree:             true,
		worktreePath,
		branchName,
	};
}

/**
 * 子代理任务结束后清理 worktree。
 * 失败不抛错（用户/磁盘问题不该挂主 sidecar）。
 */
export async function cleanupSubagentWorktree(
	parentWorkspacePath: string,
	worktreePath: string,
): Promise<void> {
	try {
		// remove --force：即使有未保存改动也清掉；分支保留（用户事后能 git log 找到）
		const r = await gitExec(parentWorkspacePath, ['worktree', 'remove', '--force', worktreePath], 15_000);
		if (r.code === 0) {
			console.log(`[SubagentWorktree] worktree 已清理：${worktreePath}`);
		} else {
			console.warn(`[SubagentWorktree] worktree 清理失败 (exit=${r.code}): ${r.stderr.trim()}`);
			// 兜底：直接 rm -rf 目录（worktree metadata 残留下次 git worktree prune 会清）
			try {
				fs.rmSync(worktreePath, { recursive: true, force: true });
				console.log(`[SubagentWorktree] 强制 rm worktree 目录：${worktreePath}`);
			} catch (e) {
				console.warn(`[SubagentWorktree] 强制 rm 也失败：${(e as Error).message}`);
			}
		}
	} catch (e) {
		console.warn(`[SubagentWorktree] cleanup exception: ${(e as Error).message}`);
	}
}
