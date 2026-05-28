/*---------------------------------------------------------------------------------------------
 *  Repo Map Digest — 从 SqliteCodebaseIndex snapshot 导出 1-3k token markdown 概览，
 *  注入 system prompt 让模型首轮就知道项目结构，减少 grep/glob 摸瞎。
 *
 *  设计要点（来自 jiusi 0.6.3 实践）：
 *    - 总输出 ≤ 3000 token (~12000 chars)，超长自动截断
 *    - snapshot 不存在 / 异常 → 返回空串（runAgentLoop 不阻塞）
 *    - **绝不嵌入时间戳 / 任何每次 rebuild 都变的字段**！
 *      lastIndexedAt 写进 digest 会让上游 prefix cache 从该行起全 miss
 *      （jiusi 实测命中率 99% → 0%，首字延迟 +3x）
 *    - 调用方在 system prompt 拼接时放在 cache breakpoint 之后，避免 digest 变化
 *      让静态层缓存失效。
 *--------------------------------------------------------------------------------------------*/

import type { ICodebaseIndex, CodebaseIndexSnapshot } from '@maxian/core/codebase-index';

const MAX_CHARS = 12000;  // ~3000 token

export interface RepoMapDigestOpts {
	maxModules?:  number;  // top 模块数，默认 15
	maxKeyFiles?: number;  // top 被 import 文件数，默认 25
}

export async function buildRepoMapDigest(
	codebaseIndex: ICodebaseIndex | undefined,
	workspaceId:   string,
	opts: RepoMapDigestOpts = {},
): Promise<string> {
	if (!codebaseIndex) return '';
	let snap: CodebaseIndexSnapshot | null = null;
	try {
		snap = await codebaseIndex.getSnapshot(workspaceId);
	} catch {
		return '';
	}
	if (!snap) return '';

	const maxModules  = opts.maxModules  ?? 15;
	const maxKeyFiles = opts.maxKeyFiles ?? 25;

	const lines: string[] = ['# PROJECT MAP', ''];

	// 1. 架构总结（已有则用，限制 ≤ 1500 chars 给后面字段留余地）
	if (snap.architecture) {
		const arch = snap.architecture.trim();
		lines.push('## Architecture');
		lines.push(arch.length > 1500 ? arch.slice(0, 1500).trim() + '…' : arch);
		lines.push('');
	}

	// 2. Top 模块（按 dirPath 顺序，有 summary 的优先；keyFiles 取前 3 个做 hint）
	const modules = (snap.modules ?? [])
		.filter(m => m.summary && m.summary.length > 0)
		.slice(0, maxModules);
	if (modules.length > 0) {
		lines.push('## Modules');
		for (const m of modules) {
			const keyHint = m.keyFiles.length > 0 ? `(key: ${m.keyFiles.slice(0, 3).join(', ')})` : '';
			lines.push(`- **${m.dirPath}** ${keyHint} — ${m.summary.slice(0, 200)}`);
		}
		lines.push('');
	}

	// 3. Top 被 import 的文件（从 deps 反向算入度，代表项目"骨架"）
	const inDegree: Map<string, number> = new Map();
	for (const d of (snap.deps ?? [])) {
		// 只算相对路径的 import（过滤 node_modules / 第三方包）
		if (!d.to.startsWith('.') && !d.to.startsWith('/') && !d.to.startsWith('@/') && !d.to.startsWith('~/')) continue;
		inDegree.set(d.to, (inDegree.get(d.to) ?? 0) + d.count);
	}
	const topImported = [...inDegree.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, maxKeyFiles);
	if (topImported.length > 0) {
		lines.push('## Top imported files (project skeleton)');
		for (const [p, c] of topImported) {
			lines.push(`- ${p} (imported × ${c})`);
		}
		lines.push('');
	}

	// 4. Stats 末行（仅文件/API/模块数量，**绝不含 lastIndexedAt**！）
	lines.push(`---`);
	lines.push(`Index stats: ${snap.fileCount} files, ${snap.apiCount} APIs, ${snap.moduleCount} modules.`);

	let out = lines.join('\n');
	// 兜底裁切
	if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS - 50) + '\n… (truncated)';
	return '\n\n====\n\n' + out;
}
