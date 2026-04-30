/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Auto-approve 黑名单（v0.2.16+）
 *
 *  批量任务模式启用 auto-approve 时，AI 调用任何工具默认自动放行；
 *  但下面这些命令模式无论 auto-approve 状态都硬拦——避免 AI 误操作放大。
 *--------------------------------------------------------------------------------------------*/

/** 命令级硬拦黑名单（匹配 bash / execute_command 的 command 参数） */
export const HARD_DENY_PATTERNS: RegExp[] = [
	// ── 文件系统破坏 ──
	/^\s*rm\s+-rf\s+\//,                    // rm -rf /
	/^\s*rm\s+-rf\s+\$HOME/,                // rm -rf $HOME
	/^\s*rm\s+-rf\s+~/,                     // rm -rf ~
	/^\s*chmod\s+-R\s+777/,                 // chmod -R 777
	/^\s*chown\s+-R\s+\w+\s+\//,            // chown -R xxx /
	/>\s*\/etc\//,                          // 重定向写 /etc
	/>\s*\/usr\//,                          // 重定向写 /usr
	/:\s*>\s*\/dev\/sd[a-z]/,               // : > /dev/sda

	// ── 提权 ──
	/^\s*sudo\b/,                           // 任何 sudo
	/^\s*su\s+(-|root)/,                    // su 切 root

	// ── git 破坏性 ──
	/^\s*git\s+push\s+.*--force\b/,
	/^\s*git\s+push\s+.*-f\b/,
	/^\s*git\s+reset\s+--hard\s+origin/,
	/^\s*git\s+filter-branch\b/,            // 改写历史
	/^\s*git\s+update-ref\s+-d/,            // 删 ref

	// ── 容器 / 系统 ──
	/^\s*docker\s+system\s+prune/,
	/^\s*docker\s+rm\s+-f\s+\$\(/,          // docker rm -f $(...)
	/^\s*kubectl\s+delete\s+namespace/,

	// ── 远程脚本执行（CVE 高发区） ──
	/curl\s+.*\|\s*sh\b/,
	/curl\s+.*\|\s*bash\b/,
	/wget\s+.*\|\s*sh\b/,
	/wget\s+.*\|\s*bash\b/,

	// ── 数据库破坏 ──
	/DROP\s+DATABASE\b/i,
	/TRUNCATE\s+TABLE\b/i,                  // 在 bash 里 SQL 注入也拦
];

/** 检查命令是否触黑名单。返回 null 表示 OK，返回字符串表示拒绝原因。 */
export function checkCommandDenied(command: string): string | null {
	for (const pat of HARD_DENY_PATTERNS) {
		if (pat.test(command)) {
			return `黑名单命令拦截：${pat.source}（参数：${command.slice(0, 80)}${command.length > 80 ? '...' : ''}）`;
		}
	}
	return null;
}

/** 给某个工具调用做 auto-approve 决策。
 *  - cfg.enabled=false → 'ask'（走原 approval 流程）
 *  - 命令在黑名单 → 'deny'
 *  - 否则 → 'auto'（直接通过）
 */
export function decideApproval(
	cfg: { enabled: boolean; deny: RegExp[] } | undefined,
	toolName: string,
	params: Record<string, unknown>,
): { decision: 'auto' | 'deny' | 'ask'; reason?: string } {
	if (!cfg?.enabled) return { decision: 'ask' };

	// 提取命令文本（多个工具有不同字段名）
	const cmd = String(params.command ?? params.cmd ?? params.script ?? '');
	if (cmd) {
		for (const pat of (cfg.deny.length > 0 ? cfg.deny : HARD_DENY_PATTERNS)) {
			if (pat.test(cmd)) {
				return { decision: 'deny', reason: `命令被黑名单拦截：${cmd.slice(0, 100)}` };
			}
		}
	}

	return { decision: 'auto' };
}
