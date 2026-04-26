/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Glob Tool（T-1 重写）
 *
 *  对齐码弦 IDE `fileOperations.glob` 完整规格：
 *  - picomatch 替换之前的自写正则（支持 brace expansion / extglob 等）
 *  - 工作区噪音过滤（isLikelyNoisePath） + DIRS_TO_IGNORE 单段目录跳过
 *  - 100 文件结果上限 + 15 层深度上限 + 10s 超时
 *  - mtime 降序排序
 *  - 路径不存在时给出 path suggestions
 *  - path 不能指向文件（必须目录）—— 给出明确改写示例
 *  - 兼容 `pattern` / `file_pattern` 双参数名（IDE 用 file_pattern，对 OpenCode/CC 兼容用 pattern）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';   // 仅 fs.Dirent 类型
import * as path from 'node:path';
import picomatch from 'picomatch';

import type { IToolContext } from './IToolContext.js';
import { platformFs, type ToolFs } from './platformFs.js';
import { DIRS_TO_IGNORE, isLikelyNoisePath, shouldApplyNoiseFiltering } from '../utils/noiseFilter.js';
import { getPathSuggestions } from '../utils/pathSuggestions.js';

export interface IGlobToolParams {
	/** 起始目录（默认工作区） */
	path?:           string;
	/** glob 模式 — 优先 pattern，兼容 file_pattern */
	pattern?:        string;
	file_pattern?:   string;
	/** 最多返回数（默认 100，对齐 IDE） */
	limit?:          number;
}

export interface IGlobToolResult {
	files:     string[];
	total:     number;
	truncated: boolean;
	timedOut:  boolean;
}

const DEFAULT_LIMIT      = 100;
const MAX_DEPTH          = 15;
const TIMEOUT_MS         = 10_000;
const IGNORED_DIRS_SET   = new Set<string>(DIRS_TO_IGNORE);

export async function globTool(
	ctx:    IToolContext,
	params: IGlobToolParams,
): Promise<IGlobToolResult> {
	const pf      = platformFs(ctx);
	const pattern = params.pattern ?? params.file_pattern ?? '';

	if (!pattern) {
		return { files: [], total: 0, truncated: false, timedOut: false };
	}

	const startDir = params.path
		? (path.isAbsolute(params.path) ? params.path : path.resolve(ctx.workspacePath, params.path))
		: ctx.workspacePath;

	if (!pf.existsSync(startDir)) {
		// 调用方拿不到 suggestions（接口返回 IGlobToolResult），但 caller 可以拿到 startDir 自己再 getPathSuggestions
		return { files: [], total: 0, truncated: false, timedOut: false };
	}

	let stat;
	try { stat = pf.statSync(startDir); } catch {
		return { files: [], total: 0, truncated: false, timedOut: false };
	}
	if (!stat.isDirectory) {
		// path 是文件而不是目录 — 由 caller 在 format 时处理（这里返回空集 + 用 truncated=false 表达）
		return { files: [], total: 0, truncated: false, timedOut: false };
	}

	const limit             = params.limit && params.limit > 0 ? params.limit : DEFAULT_LIMIT;
	const startTime         = Date.now();
	const matcher           = picomatch(pattern, { dot: true, nocase: false });
	const applyNoiseFilter  = shouldApplyNoiseFiltering(startDir, ctx.workspacePath);

	const matched: Array<{ rel: string; mtime: number }> = [];
	let timedOut = false;

	const checkTimeout = (): boolean => {
		if (Date.now() - startTime > TIMEOUT_MS) {
			timedOut = true;
			return true;
		}
		return false;
	};

	walk(pf, startDir, '', 0, matched, limit, matcher, applyNoiseFilter, checkTimeout);

	// mtime 降序
	matched.sort((a, b) => b.mtime - a.mtime);

	const total     = matched.length;
	const truncated = total > limit;
	const files     = matched.slice(0, limit).map(f => path.join(startDir, f.rel));

	return { files, total, truncated, timedOut };
}

function walk(
	pf:               ToolFs,
	root:             string,
	rel:              string,
	depth:            number,
	out:              Array<{ rel: string; mtime: number }>,
	limit:            number,
	matcher:          (s: string) => boolean,
	applyNoiseFilter: boolean,
	checkTimeout:     () => boolean,
): void {
	if (out.length >= limit || depth > MAX_DEPTH || checkTimeout()) return;

	let entries: fs.Dirent[];
	try {
		entries = pf.readdirSync(path.join(root, rel), { withFileTypes: true }) as fs.Dirent[];
	} catch { return; }

	for (const entry of entries) {
		if (out.length >= limit || checkTimeout()) return;

		// 单段目录名快速过滤（避开 node_modules / dist / .git 等）
		if (entry.isDirectory() && IGNORED_DIRS_SET.has(entry.name)) continue;

		const childRel  = rel ? path.join(rel, entry.name) : entry.name;
		const normChildRel = childRel.replace(/\\/g, '/');

		// 路径级噪音过滤（只在用户没显式指向噪音目录时启用）
		if (applyNoiseFilter && isLikelyNoisePath(normChildRel)) continue;

		if (entry.isDirectory()) {
			walk(pf, root, childRel, depth + 1, out, limit, matcher, applyNoiseFilter, checkTimeout);
		} else if (entry.isFile()) {
			if (!matcher(normChildRel)) continue;

			const full = path.join(root, childRel);
			let mtime = 0;
			try { mtime = pf.statSync(full).mtime; } catch { /* ignore */ }
			out.push({ rel: childRel, mtime });
		}
	}
}

/**
 * 格式化输出（对齐 IDE 风格的中文 + 友好提示）
 */
export function formatGlobResult(
	r:        IGlobToolResult,
	params:   IGlobToolParams,
	pathArg?: string,        // 可选：调用方传入实际使用的 path（用于错误提示）
	pf?:      ToolFs,        // 可选：用于路径不存在时给 suggestions
): string {
	const pattern = params.pattern ?? params.file_pattern ?? '';

	if (!pattern) {
		return '错误: 未提供文件模式（pattern 或 file_pattern）';
	}

	if (pathArg && pf && !pf.existsSync(pathArg)) {
		const suggestions = getPathSuggestions(pf, pathArg);
		if (suggestions.length > 0) {
			return `错误: 路径不存在 "${pathArg}"\n\n你是否要找:\n${suggestions.map(s => `  - ${s}`).join('\n')}`;
		}
		return `错误: 路径不存在 "${pathArg}"\n请检查 path 参数是否正确`;
	}

	if (pathArg && pf) {
		try {
			const st = pf.statSync(pathArg);
			if (!st.isDirectory) {
				const dir  = pathArg.substring(0, pathArg.lastIndexOf('/'));
				const base = pathArg.substring(pathArg.lastIndexOf('/') + 1);
				return `错误: glob 的 path 参数必须是目录，"${pathArg}" 是一个文件\n提示: 请传入目录路径，并在 file_pattern 中使用匹配模式\n示例: path="${dir}", file_pattern="**/${base}"`;
			}
		} catch { /* fallthrough */ }
	}

	const lines: string[] = [
		`# Glob: ${pattern}`,
		`共找到 ${r.total} 个文件${r.truncated ? `（仅显示前 ${r.files.length} 个，按 mtime 降序）` : ''}${r.timedOut ? '（已超时）' : ''}`,
		'',
	];
	if (r.files.length === 0) {
		lines.push('未找到匹配文件。');
	} else {
		lines.push(...r.files);
	}
	return lines.join('\n');
}
