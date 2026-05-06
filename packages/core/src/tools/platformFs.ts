/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Tool 内的 fs 抽象 helper
 *
 *  统一让工具（readFileTool / writeToFileTool / globTool 等）通过 ctx.platform.fs 调用。
 *
 *  设计目标演进：
 *  - K8 N1：tools 不再 `import fs from 'node:fs'`，统一通过 platformFs(ctx) 拿同步 API
 *  - K8e (本次完成)：core 9 大工具 + 4 大 utils 全部异步化，**sync API 整体下线**
 *    - 任何 IFileSystem 实现仅需提供 async API（readFile / writeFile / exists / stat / lstat /
 *      realpath / deleteFile / createDirectory / listFiles / rename / appendFile / readBinaryFile）
 *    - 浏览器 / VS Code renderer / IDEA JCEF 等无 sync fs 的形态都能直接跑 core
 *
 *  使用约定：
 *  - 优先 ctx.platform.fs.<method>（async；走 IFileSystem）
 *  - 没有 ctx 或 platform 未实现时，降级到 node:fs/promises
 *    （K8f 后会进一步收敛：浏览器形态必须自带 platform.fs，不再降级 node:*）
 *
 *  例外保留（非本 helper 范畴）：
 *  - tools/truncate.ts：写 ~/.maxian/ 系统配置 → 系统级例外
 *  - tools/grepTool.ts findRgPath：探测系统 ripgrep 二进制 → 系统级例外
 *  - adapters/NodeSearchService.ts：明确的 Node 专用实现（IDE 用 VSCodeSearchService 替代）
 *  - tools/bashTool.ts / executeCommandTool.ts：child_process → K8d ITerminal 抽象
 *--------------------------------------------------------------------------------------------*/

import * as nodeFsPromises from 'node:fs/promises';   // async 降级使用；K8f 后由 platform.fs 全部覆盖
import type { IToolContext } from './IToolContext.js';
import type { FileStat, BufferEncoding, FileEntry, ListFilesOptions, DeleteOptions } from '../interfaces/IFileSystem.js';

/** 工具用文件系统接口（platformFs 返回的对象，全 async）*/
export interface ToolFs {
	/** 读文本文件（UTF-8，对应 IFileSystem.readFile） */
	readFile(path: string, encoding?: BufferEncoding): Promise<string>;
	/** 读二进制文件（图片、PDF 等） */
	readBinaryFile(path: string): Promise<Uint8Array>;
	/** 写文本文件（自动创建父目录） */
	writeFile(path: string, content: string, encoding?: BufferEncoding): Promise<void>;
	/** 追加文本到文件末尾 */
	appendFile(path: string, content: string, encoding?: BufferEncoding): Promise<void>;
	/** 路径是否存在 */
	exists(path: string): Promise<boolean>;
	/** 文件元信息（跟随符号链接） */
	stat(path: string): Promise<FileStat>;
	/** 文件元信息（不跟随符号链接） */
	lstat(path: string): Promise<FileStat>;
	/** 解析符号链接到真实路径 */
	realpath(path: string): Promise<string>;
	/** 删除文件 / 目录（recursive: 递归删；useTrash: 走回收站） */
	deleteFile(path: string, options?: DeleteOptions): Promise<void>;
	/** 创建目录（recursive 默认 true） */
	createDirectory(path: string): Promise<void>;
	/** 列目录（与 IFileSystem.listFiles 一致；可递归 + maxDepth + excludePatterns） */
	listFiles(path: string, options?: ListFilesOptions): Promise<FileEntry[]>;
	/** 重命名 / 移动 */
	rename(oldPath: string, newPath: string): Promise<void>;
}

/** 静态返回 node:fs/promises（K8f 后整体移除） */
function getNodeFsPromises(): typeof import('node:fs/promises') {
	return nodeFsPromises;
}

/** 把 node:fs.Stats 转为 IFileSystem.FileStat */
function nodeStatsToFileStat(s: import('node:fs').Stats): FileStat {
	return {
		mtime: s.mtimeMs,
		ctime: s.ctimeMs,
		size: s.size,
		isDirectory: s.isDirectory(),
		isFile: s.isFile(),
		isSymbolicLink: s.isSymbolicLink(),
	};
}

/** 单层 readdir（async，node fallback） */
async function nodeListSingle(path: string): Promise<FileEntry[]> {
	const fp = getNodeFsPromises();
	const entries = await fp.readdir(path, { withFileTypes: true });
	const sep = (await import('node:path')).sep;
	return entries.map((e) => ({
		name: e.name,
		path: path + (path.endsWith(sep) ? '' : sep) + e.name,
		isDirectory: e.isDirectory(),
		isSymbolicLink: e.isSymbolicLink(),
	}));
}

/** 递归 readdir + glob 排除（async，node fallback） */
async function nodeListRecursive(
	rootPath: string,
	options: ListFilesOptions
): Promise<FileEntry[]> {
	const fp = getNodeFsPromises();
	const path = await import('node:path');
	const result: FileEntry[] = [];
	const maxDepth = options.maxDepth ?? Infinity;

	const excludePatterns = options.excludePatterns ?? [];
	const isExcluded = (relPath: string): boolean => {
		for (const pattern of excludePatterns) {
			const segs = pattern.split('/').filter((s) => s !== '**' && s !== '*');
			if (segs.some((seg) => relPath.includes(seg))) return true;
		}
		return false;
	};

	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > maxDepth) return;
		let entries: import('node:fs').Dirent[];
		try {
			entries = await fp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			const rel = path.relative(rootPath, full);
			if (isExcluded(rel)) continue;
			result.push({
				name: e.name,
				path: full,
				isDirectory: e.isDirectory(),
				isSymbolicLink: e.isSymbolicLink(),
			});
			if (e.isDirectory() && options.recursive) {
				await walk(full, depth + 1);
			}
		}
	};

	await walk(rootPath, 0);
	return result;
}

/**
 * 获取工具用 fs（优先 ctx.platform.fs.*，否则降级 node:fs/promises）。
 *
 * @example
 * ```ts
 * const fs = platformFs(ctx);
 * const content = await fs.readFile(absolutePath);
 * ```
 */
export function platformFs(ctx?: IToolContext): ToolFs {
	const pfs = ctx?.platform?.fs;

	return {
		async readFile(path, encoding = 'utf8') {
			if (pfs?.readFile) return pfs.readFile(path);
			return getNodeFsPromises().readFile(path, encoding);
		},
		async readBinaryFile(path) {
			if (pfs?.readBinaryFile) return pfs.readBinaryFile(path);
			const buf = await getNodeFsPromises().readFile(path);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		},
		async writeFile(path, content, encoding = 'utf8') {
			if (pfs?.writeFile) return pfs.writeFile(path, content);
			// node:fs/promises.writeFile 不会自动创建父目录，与 IFileSystem 语义对齐：自动创建
			const np = await import('node:path');
			const parent = np.dirname(path);
			await getNodeFsPromises().mkdir(parent, { recursive: true });
			await getNodeFsPromises().writeFile(path, content, encoding);
		},
		async appendFile(path, content, encoding = 'utf8') {
			if (pfs?.appendFile) return pfs.appendFile(path, content);
			await getNodeFsPromises().appendFile(path, content, encoding);
		},
		async exists(path) {
			if (pfs?.exists) return pfs.exists(path);
			try {
				await getNodeFsPromises().access(path);
				return true;
			} catch {
				return false;
			}
		},
		async stat(path) {
			if (pfs?.stat) return pfs.stat(path);
			return nodeStatsToFileStat(await getNodeFsPromises().stat(path));
		},
		async lstat(path) {
			if ((pfs as any)?.lstat) return (pfs as any).lstat(path);
			return nodeStatsToFileStat(await getNodeFsPromises().lstat(path));
		},
		async realpath(path) {
			if ((pfs as any)?.realpath) return (pfs as any).realpath(path);
			return getNodeFsPromises().realpath(path);
		},
		async deleteFile(path, options) {
			if (pfs?.deleteFile) return pfs.deleteFile(path, options);
			if (options?.recursive) {
				await getNodeFsPromises().rm(path, { recursive: true, force: true });
			} else {
				await getNodeFsPromises().unlink(path);
			}
		},
		async createDirectory(path) {
			if (pfs?.createDirectory) return pfs.createDirectory(path);
			await getNodeFsPromises().mkdir(path, { recursive: true });
		},
		async listFiles(path, options = {}) {
			if (pfs?.listFiles) return pfs.listFiles(path, options);
			if (options.recursive) {
				return nodeListRecursive(path, options);
			}
			return nodeListSingle(path);
		},
		async rename(oldPath, newPath) {
			if (pfs?.rename) return pfs.rename(oldPath, newPath);
			await getNodeFsPromises().rename(oldPath, newPath);
		},
	};
}
