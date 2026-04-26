/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Path Suggestions
 *
 *  对齐码弦 IDE 当前 `fileOperations.ts` 的 `getPathSuggestions / getSimilarFiles
 *  / getSimilarPathVariants` 完整规格（v1.108.x）。
 *
 *  当用户给出的 path 不存在时，提供"你是否要找…"的模糊匹配建议。
 *  完全平台无关 —— 通过 `ToolFs` 接口（platformFs(ctx)）访问文件系统。
 *
 *  使用：
 *  ```ts
 *  const fs = platformFs(ctx);
 *  const suggestions = getPathSuggestions(fs, absolutePath);
 *  if (suggestions.length > 0) {
 *      return `错误: 文件不存在\n路径: ${absolutePath}\n\n你是否要找:\n${suggestions.map(s => `  - ${s}`).join('\n')}`;
 *  }
 *  ```
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { distance as levenshteinDistance } from './levenshtein.js';
import type { ToolFs } from '../tools/platformFs.js';

/**
 * 综合路径建议（最多 maxSuggestions 条）：
 *  - getSimilarFiles 在同目录下做模糊匹配
 *  - getSimilarPathVariants 沿父级路径回溯做分段模糊匹配
 */
export function getPathSuggestions(
	fs:              ToolFs,
	targetPath:      string,
	maxSuggestions   = 3,
): string[] {
	const suggestions = new Set<string>();

	for (const s of getSimilarFiles(fs, targetPath, maxSuggestions)) {
		suggestions.add(s);
	}
	for (const s of getSimilarPathVariants(fs, targetPath, maxSuggestions)) {
		suggestions.add(s);
	}

	return Array.from(suggestions).slice(0, maxSuggestions);
}

/**
 * 同目录模糊匹配：父目录下找文件名相似的兄弟文件
 *  - 文件名包含/被包含 OR
 *  - Levenshtein 距离 ≤ max(2, 30% 长度)
 */
export function getSimilarFiles(
	fs:              ToolFs,
	targetPath:      string,
	maxSuggestions   = 3,
): string[] {
	try {
		const dirPath  = path.dirname(targetPath);
		const baseName = path.basename(targetPath).toLowerCase();

		if (!fs.existsSync(dirPath)) return [];

		let stat;
		try { stat = fs.statSync(dirPath); } catch { return []; }
		if (!stat.isDirectory) return [];

		const entries = fs.readdirSync(dirPath, { withFileTypes: true }) as Array<{
			name:        string;
			isDirectory: () => boolean;
			isFile:      () => boolean;
		}>;

		// 仅文件
		const siblings = entries
			.filter(e => typeof e.isDirectory === 'function' ? !e.isDirectory() : true)
			.map(e => e.name);

		const matches = siblings
			.filter(name => {
				const nameLower = name.toLowerCase();
				return nameLower.includes(baseName)
					|| baseName.includes(nameLower)
					|| levenshteinDistance(nameLower, baseName) <= Math.max(2, Math.floor(baseName.length * 0.3));
			})
			.slice(0, maxSuggestions)
			.map(name => path.join(dirPath, name));

		return matches;
	} catch {
		return [];
	}
}

/**
 * 父级回溯模糊匹配：当 path 中间某段也不存在时，沿路径段逐级模糊匹配。
 *
 * 例：/repo/srcss/fooo.ts 不存在
 *   - probePath /repo/srcss → 不存在 → 弹出 srcss 入 missingSegments，回 /repo
 *   - probePath /repo → 存在
 *   - 在 /repo 下匹配 srcss → 找到 src
 *   - 在 /repo/src 下匹配 fooo.ts → 找到 foo.ts
 *   - 返回 ['/repo/src/foo.ts']
 */
export function getSimilarPathVariants(
	fs:              ToolFs,
	targetPath:      string,
	maxSuggestions   = 3,
): string[] {
	try {
		let probePath              = targetPath;
		const missingSegments: string[] = [];

		while (!fs.existsSync(probePath)) {
			const currentSegment = path.basename(probePath);
			const parentPath     = path.dirname(probePath);
			if (!currentSegment || !parentPath || parentPath === probePath) {
				return [];
			}
			missingSegments.unshift(currentSegment);
			probePath = parentPath;
		}

		if (missingSegments.length === 0) return [];

		let candidates = [probePath];

		for (let index = 0; index < missingSegments.length; index++) {
			const expectedSegment = missingSegments[index].toLowerCase();
			const isLastSegment    = index === missingSegments.length - 1;
			const nextCandidates: string[] = [];

			for (const candidateBase of candidates) {
				let entries;
				try {
					entries = fs.readdirSync(candidateBase, { withFileTypes: true }) as Array<{
						name:        string;
						isDirectory: () => boolean;
					}>;
				} catch { continue; }

				const matches = entries
					.filter(child => isLastSegment || (typeof child.isDirectory === 'function' ? child.isDirectory() : false))
					.filter(child => {
						const childName = child.name.toLowerCase();
						return childName.includes(expectedSegment)
							|| expectedSegment.includes(childName)
							|| levenshteinDistance(childName, expectedSegment) <= Math.max(2, Math.floor(expectedSegment.length * 0.3));
					})
					.slice(0, maxSuggestions)
					.map(child => path.join(candidateBase, child.name));

				nextCandidates.push(...matches);
			}

			if (nextCandidates.length === 0) return [];

			candidates = Array.from(new Set(nextCandidates)).slice(0, maxSuggestions);
		}

		const resolved: string[] = [];
		for (const c of candidates) {
			if (fs.existsSync(c)) resolved.push(c);
		}
		return resolved.slice(0, maxSuggestions);
	} catch {
		return [];
	}
}
