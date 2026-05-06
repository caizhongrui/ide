/*
 * maxian-spawn-helper.c (TIOCSCTTY variant)
 *
 * 替代 @lydell/node-pty 的 spawn-helper。处理 Bun --compile 二进制的 posix_spawn
 * 在 SETSID + open(slave_pty) 这套传统流程上挂死的问题。
 *
 * 我们改用 ioctl(TIOCSCTTY) 直接把 slave PTY（已经是 fd 0）设为 controlling terminal。
 * 流程：
 *   1) setsid() 成为 session leader（必须的，否则 TIOCSCTTY 拒绝）
 *   2) ioctl(0, TIOCSCTTY, 0) 把 fd 0 上的 PTY 设为 ctty
 *   3) chdir(argv[1])
 *   4) execvp(argv[2], argv+2)
 *
 * macOS 上 TIOCSCTTY 在 sys/ttycom.h 里定义。
 */

#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/ttycom.h>

int main(int argc, char** argv) {
	if (argc < 3) {
		fprintf(stderr, "usage: spawn-helper <cwd> <shell> [args...]\n");
		return 1;
	}

	/* 1. 必须先成为 session leader，否则 TIOCSCTTY 拒绝 */
	if (setsid() == -1) {
		/* 已经是 session leader 了，无所谓 */
	}

	/* 2. 把 fd 0（slave PTY）设为本 session 的 controlling terminal
	 *    第三个参数 0 = 不强制（如果其他 session 已占用就失败而非抢占）。
	 *    我们用 0 就行，因为 setsid 后没人占用。
	 */
	if (ioctl(0, TIOCSCTTY, 0) == -1) {
		/* 即便失败也继续 —— shell 至少能跑（job control 可能受限）*/
		perror("ioctl(TIOCSCTTY)");
	}

	/* 3. chdir */
	if (argv[1][0] != '\0') {
		if (chdir(argv[1]) == -1) {
			perror("chdir");
			return 1;
		}
	}

	/* 4. exec */
	execvp(argv[2], argv + 2);
	perror("execvp");
	return 1;
}
