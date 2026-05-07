/*---------------------------------------------------------------------------------------------
 *  Maxian Core — NodeFileSystem（IFileSystem 的 Node 实现）
 *
 *  使用 node:fs/promises 直接实现 IFileSystem 接口，给 Server 侧装配 MaxianPlatform 用。
 *  浏览器形态请使用 RpcFileSystem，VS Code 用 VSCodeFileSystem。
 *
 *  注意：本实现是无沙箱的薄包装，路径校验由 ITenantContext / sandbox 上层负责。
 *--------------------------------------------------------------------------------------------*/

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type {
	IFileSystem,
	FileStat,
	FileEntry,
	DeleteOptions,
	ListFilesOptions,
} from '../interfaces/IFileSystem.js';
import { FileSystemError } from '../interfaces/IFileSystem.js';

function statsToFileStat(s: import('node:fs').Stats): FileStat {
	return {
		mtime:          s.mtimeMs,
		ctime:          s.ctimeMs,
		size:           s.size,
		isDirectory:    s.isDirectory(),
		isFile:         s.isFile(),
		isSymbolicLink: s.isSymbolicLink(),
	};
}

function isExcluded(relPath: string, patterns: string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	for (const pattern of patterns) {
		const segs = pattern.split('/').filter((s) => s !== '**' && s !== '*' && s.length > 0);
		if (segs.some((seg) => relPath.includes(seg))) return true;
	}
	return false;
}

/**
 * Node.js 平台 IFileSystem 实现。
 *
 * 行为：
 * - writeFile：自动创建父目录（与 IFileSystem 语义对齐）
 * - listFiles 递归模式：按 maxDepth 限制深度，按 excludePatterns 过滤路径子串
 * - resolvePath：使用 path.resolve（不感知工作区，可由上层 IWorkspace 包装）
 */
export class NodeFileSystem implements IFileSystem {
	constructor(private readonly workspaceRoot?: string) {}

	async readFile(p: string): Promise<string> {
		try {
			return await fsPromises.readFile(p, 'utf8');
		} catch (e: any) {
			throw this.wrap(e, p);
		}
	}

	async readBinaryFile(p: string): Promise<Uint8Array> {
		try {
			const buf = await fsPromises.readFile(p);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		} catch (e: any) {
			throw this.wrap(e, p);
		}
	}

	async writeFile(p: string, content: string): Promise<void> {
		try {
			const parent = path.dirname(p);
			await fsPromises.mkdir(parent, { recursive: true });
			await fsPromises.writeFile(p, content, 'utf8');
		} catch (e: any) {
			throw this.wrap(e, p);
		}
	}

	async appendFile(p: string, content: string): Promise<void> {
		try {
			await fsPromises.appendFile(p, content, 'utf8');
		} catch (e: any) {
			throw this.wrap(e, p);
		}
	}

	async exists(p: string): Promise<boolean> {
		try {
			await fsPromises.access(p);
			return true;
		} catch {
			return false;
		}
	}

	async stat(p: string): Promise<FileStat> {
		try {
			return statsToFileStat(await fsPromises.stat(p));
		} catch (e: any) {
			throw this.wrap(e, p);
		}
	}

	async deleteFile(p: string, options?: DeleteOptions): Promise<void> {
		try {
			if (options?.recursive) {
				await fsPromises.rm(p, { recursive: true, force: true });
			} else {
				await fsPromises.unlink(p);
			}
		} catch (e: any) {
			throw this.wrap(e, p);
		}
	}

	async createDirectory(p: string): Promise<void> {
		try {
			await fsPromises.mkdir(p, { recursive: true });
		} catch (e: any) {
			throw this.wrap(e, p);
		}
	}

	async listFiles(p: string, options: ListFilesOptions = {}): Promise<FileEntry[]> {
		try {
			if (!options.recursive) {
				const entries = await fsPromises.readdir(p, { withFileTypes: true });
				return entries.map((e) => ({
					name:           e.name,
					path:           path.join(p, e.name),
					isDirectory:    e.isDirectory(),
					isSymbolicLink: e.isSymbolicLink(),
				}));
			}
			const result: FileEntry[] = [];
			const maxDepth = options.maxDepth ?? Infinity;
			const walk = async (dir: string, depth: number): Promise<void> => {
				if (depth > maxDepth) return;
				let entries: import('node:fs').Dirent[];
				try {
					entries = await fsPromises.readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const e of entries) {
					const full = path.join(dir, e.name);
					const rel  = path.relative(p, full);
					if (isExcluded(rel, options.excludePatterns)) continue;
					result.push({
						name:           e.name,
						path:           full,
						isDirectory:    e.isDirectory(),
						isSymbolicLink: e.isSymbolicLink(),
					});
					if (e.isDirectory() && options.recursive) {
						await walk(full, depth + 1);
					}
				}
			};
			await walk(p, 0);
			return result;
		} catch (e: any) {
			throw this.wrap(e, p);
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		try {
			await fsPromises.rename(oldPath, newPath);
		} catch (e: any) {
			throw this.wrap(e, oldPath);
		}
	}

	resolvePath(p: string): string {
		if (path.isAbsolute(p)) return p;
		if (this.workspaceRoot) return path.resolve(this.workspaceRoot, p);
		return path.resolve(p);
	}

	private wrap(e: any, p: string): Error {
		const code: string = e?.code ?? '';
		if (code === 'ENOENT') {
			return new FileSystemError(`File not found: ${p}`, 'FileNotFound', p);
		}
		if (code === 'EACCES' || code === 'EPERM') {
			return new FileSystemError(`Permission denied: ${p}`, 'PermissionDenied', p);
		}
		// 其他错误透传
		return e;
	}
}
