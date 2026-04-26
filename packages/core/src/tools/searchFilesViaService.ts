/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Search Files Tool（T-1 新版，走 ISearchService 单路径）
 *
 *  对齐码弦 IDE `searchTools.searchFiles + codebaseSearch` 完整规格：
 *  - output_mode 三种：files_with_matches（默认）/ content / count
 *  - head_limit + offset 分页
 *  - 30s 超时（通过 AbortSignal）
 *  - noise filter（自动排除 node_modules / dist / 等噪音目录；用户显式指向时禁用）
 *  - 富错误提示（含 path 不存在、目录为空、噪音过滤命中等场景）
 *  - content 模式自动降级：跨文件过多时退回 files_with_matches，避免主线程卡顿
 *
 *  执行后端：
 *  - ctx.platform.search 已注入 → 用之（IDE 形态：vscode 内置 ripgrep）
 *  - 未注入 → 自动 fallback 到 NodeSearchService（系统 rg / JS walk）
 *
 *  与 IDE 现状的差异：
 *  - sortFilesByMtime 简化：本工具内部按 stat.mtime 同步排序（少量 statSync 调用，IDE 实测可接受）
 *  - cleanSearchQuery 暂未实现（codebase_search 用同入口时建议调用方自己清洗 query）
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

import type { IToolContext } from './IToolContext.js';
import type { ToolResponse } from '../types/toolTypes.js';
import { platformFs } from './platformFs.js';
import {
	TOOL_SEARCH_EXCLUDE_GLOBS,
	isLikelyNoisePath,
	shouldApplyNoiseFiltering,
} from '../utils/noiseFilter.js';
import { NodeSearchService } from '../adapters/NodeSearchService.js';
import type { ISearchService, SearchTextMatch } from '../interfaces/ISearchService.js';

// ─────────────────────────────────────────────────────────────────
// 配置（与 IDE 对齐）
// ─────────────────────────────────────────────────────────────────
const SEARCH_TIMEOUT_MS         = 30_000;
const MAX_CONTENT_OUTPUT_FILES  = 50;
const MAX_CONTENT_OUTPUT_MATCHES = 200;
const MAX_PREVIEWS_PER_FILE     = 5;

export interface ISearchFilesParams {
	/** 搜索路径（绝对或相对工作区，默认 = 工作区根） */
	path?:         string;
	/** 正则模式（regex 优先；只有 file_pattern 时退化为文件名搜索 — 由调用方先用 globTool 做） */
	regex?:        string;
	/** 文件名 glob 过滤（如 *.ts） */
	file_pattern?: string;
	/** 输出模式（默认 files_with_matches，节省 token） */
	output_mode?:  'files_with_matches' | 'content' | 'count';
	/** 分页：每页大小（默认 100） */
	head_limit?:   number | string;
	/** 分页：偏移量（默认 0） */
	offset?:       number | string;
}

/**
 * 主入口：通过 ctx.platform.search 注入 ripgrep / fallback NodeSearchService
 */
export async function searchFilesViaService(
	ctx:    IToolContext,
	params: ISearchFilesParams,
): Promise<ToolResponse> {
	const pf            = platformFs(ctx);
	const startTime     = Date.now();
	const workspaceRoot = ctx.workspacePath;

	const outputMode = (params.output_mode as 'content' | 'files_with_matches' | 'count') ?? 'files_with_matches';
	const headLimit  = params.head_limit !== undefined ? parseInt(String(params.head_limit), 10) : 100;
	const offsetVal  = params.offset     !== undefined ? parseInt(String(params.offset),     10) : 0;

	const regex        = params.regex;
	const filePatternIn = params.file_pattern;

	if (!regex && !filePatternIn) {
		return '错误: 必须提供搜索模式(regex)或文件模式(file_pattern)';
	}

	// 解析 searchPath（兼容 IDE 的 path = file 场景：把 path 拆为父目录 + 文件名 include）
	const rawPath = params.path || workspaceRoot;
	const searchPath = path.isAbsolute(rawPath)
		? rawPath
		: path.resolve(workspaceRoot, rawPath);

	const lastSegment   = path.basename(searchPath);
	const isFilePath    = lastSegment.includes('.') && !rawPath.endsWith('/') && !pf.existsSync(searchPath)
		? false   // 不存在 → 不强制视为文件
		: lastSegment.includes('.') && !rawPath.endsWith('/') && (() => {
			try { return pf.statSync(searchPath).isFile; } catch { return false; }
		})();
	const folderPath    = isFilePath ? path.dirname(searchPath) : searchPath;
	const fileNameFilter = isFilePath ? lastSegment : undefined;

	// 检查目录存在性
	if (!pf.existsSync(folderPath)) {
		return `未找到匹配的文件。\n\n📁 目录 "${folderPath}" 不存在。\n\n💡 建议：如果你需要创建文件，请逐步使用 write_to_file 创建，并在关键步骤后验证结果。`;
	}

	// 选择 service：优先 platform 注入，否则 NodeSearchService 兜底
	const service: ISearchService = ctx.platform?.search ?? new NodeSearchService(workspaceRoot);

	// 噪音过滤（与 IDE 完全一致：用户显式指向噪音目录时禁用）
	const applyNoise   = shouldApplyNoiseFiltering(searchPath, workspaceRoot);
	const excludeGlobs = applyNoise ? Object.keys(TOOL_SEARCH_EXCLUDE_GLOBS) : undefined;

	// 文件名过滤（合并 fileNameFilter + file_pattern 参数）
	const effectiveFilePattern = normalizeFilePattern(fileNameFilter ?? filePatternIn);
	const includeGlobs         = effectiveFilePattern ? [effectiveFilePattern] : undefined;

	// AbortSignal 超时
	const ac = new AbortController();
	const timeoutId = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS);

	try {
		// 仅 regex 路径（content 搜索）
		if (regex) {
			const rawMatches = await service.searchText({
				folder:          folderPath,
				pattern:         regex,
				isRegExp:        true,
				isCaseSensitive: false,
				includeGlobs,
				excludeGlobs,
				maxResults:      5000,
				signal:          ac.signal,
			});

			const matches = applyNoise
				? rawMatches.filter(m => !isLikelyNoisePath(m.filePath))
				: rawMatches;

			const elapsed = Date.now() - startTime;

			if (matches.length === 0) {
				if (rawMatches.length > 0) {
					return `未找到匹配正则表达式 "${regex}" 的可用结果（原始命中 ${rawMatches.length} 条均位于噪音目录，已自动过滤）。\n\n📁 搜索路径: "${searchPath}"${filePatternIn ? '\n📄 文件模式: ' + filePatternIn : ''}\n\n💡 提示：如需搜索构建产物目录，请把 path 明确指向该目录后重试。`;
				}
				return `未找到匹配正则表达式 "${regex}" 的内容。\n\n📁 搜索路径: "${searchPath}"${filePatternIn ? '\n📄 文件模式: ' + filePatternIn : ''}\n\n💡 建议：\n1. 检查正则表达式语法是否正确\n2. 或使用 codebase_search 进行关键词搜索\n3. 或使用 glob 工具按文件名搜索`;
			}

			// 按文件分组
			const resultsByFile = new Map<string, { lineNumber: number; line: string }[]>();
			for (const { filePath, lineNumber, line } of matches) {
				if (!resultsByFile.has(filePath)) resultsByFile.set(filePath, []);
				resultsByFile.get(filePath)!.push({ lineNumber, line });
			}
			const sortedFiles = sortFilesByMtimeSync(pf, [...resultsByFile.keys()]);

			// count 模式
			if (outputMode === 'count') {
				return `${matches.length} matches across ${resultsByFile.size} files`;
			}

			// files_with_matches 模式（默认）
			if (outputMode === 'files_with_matches') {
				const filePaths = sortedFiles.slice(offsetVal, offsetVal + headLimit);
				return filePaths.join('\n');
			}

			// content 模式：自动降级保护
			if (!isFilePath && !effectiveFilePattern && resultsByFile.size > MAX_CONTENT_OUTPUT_FILES) {
				const filePaths = sortedFiles.slice(0, headLimit);
				return `检测到 content 模式会跨 ${resultsByFile.size} 个文件返回大量内容，已自动降级为文件路径列表以避免主线程卡住。\n\n请先从这些候选文件中选择目标文件再 read_file：\n\n${filePaths.join('\n')}`;
			}

			// content 模式：完整内容输出
			const allResults: string[] = [];
			for (const filePath of sortedFiles) {
				const fileResults = resultsByFile.get(filePath)!;
				const perFile     = fileResults.slice(0, MAX_PREVIEWS_PER_FILE);
				for (const { lineNumber, line } of perFile) {
					allResults.push(`${filePath}:${lineNumber}: ${line}`);
				}
				if (fileResults.length > MAX_PREVIEWS_PER_FILE) {
					allResults.push(`${filePath}: ... (+${fileResults.length - MAX_PREVIEWS_PER_FILE} more matches)`);
				}
			}
			const contentLimit = Math.min(headLimit, MAX_CONTENT_OUTPUT_MATCHES);
			const paged        = allResults.slice(offsetVal, offsetVal + contentLimit);

			void elapsed; // 暂不输出耗时（与 IDE 当前一致 — 只有 debug 时打印）
			return `找到 ${matches.length} 个匹配 (显示 ${offsetVal + 1}-${offsetVal + paged.length} / ${allResults.length}):\n\n${paged.join('\n')}`;
		}

		// 仅 file_pattern：建议走 globTool；这里给一条退化提示
		return `提示: 仅 file_pattern 的纯文件名搜索请使用 glob 工具（更高效）。\n如需在 search_files 中按文件名 glob 搜索内容，请同时提供 regex（即使是 ".*"）。`;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * 归一化 file_pattern:
 * - 裸文件名/扩展名模式（如 *.java / package.json）自动补全为递归匹配前缀
 * - 已包含路径层级（含 / 或双星前缀）的模式保持不变
 */
function normalizeFilePattern(pattern: string | undefined): string | undefined {
	if (!pattern) return undefined;
	const normalized = pattern.trim().replace(/\\/g, '/');
	if (!normalized) return undefined;
	if (normalized.startsWith('**/') || normalized.includes('/')) return normalized;
	return `**/${normalized}`;
}

/**
 * 同步按 mtime 降序排序文件（少量 statSync 调用，对中小型项目可接受）
 */
function sortFilesByMtimeSync(
	pf: ReturnType<typeof platformFs>,
	files: string[],
): string[] {
	const withMtime = files.map(f => {
		let mtime = 0;
		try { mtime = pf.statSync(f).mtime; } catch { /* ignore */ }
		return { f, mtime };
	});
	withMtime.sort((a, b) => b.mtime - a.mtime);
	return withMtime.map(x => x.f);
}
