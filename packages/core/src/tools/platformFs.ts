/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Tool 内的 fs 抽象 helper
 *
 *  统一让工具（readFileTool / writeToFileTool / globTool 等）通过 ctx.platform.fs 调用。
 *  当 ctx.platform 未传入或某个 sync 方法未实现时，自动降级到内置 node:fs（向后兼容）。
 *
 *  设计目标（K8 N1）：
 *  1. tools 不再 `import fs from 'node:fs'`，统一通过 platformFs(ctx) 拿同步 API
 *  2. server 形态：直接用 fallback（行为不变）
 *  3. 未来 Web / IDEA 形态：传入实现了 sync 方法的 platform.fs（或者后续完成异步化）
 *
 *  注意：本 helper 只暴露常用的 7 个 sync 方法。复杂场景（如 fs.promises、fs.constants）
 *  仍可在工具里直接 import 'node:fs'，但应尽量收敛到此处。
 *--------------------------------------------------------------------------------------------*/

import type { IToolContext } from './IToolContext.js';
import type { FileStat, BufferEncoding } from '../interfaces/IFileSystem.js';

/** 工具用同步文件系统接口（platformFs 返回的对象） */
export interface ToolFs {
	readFileSync(path: string, encoding?: BufferEncoding): string;
	writeFileSync(path: string, content: string, encoding?: BufferEncoding): void;
	existsSync(path: string): boolean;
	statSync(path: string): FileStat;
	mkdirSync(path: string, opts?: { recursive?: boolean }): void;
	readdirSync(path: string, opts?: { withFileTypes?: boolean }): string[] | unknown[];
	unlinkSync(path: string): void;
}

let _nodeFsCache: typeof import('node:fs') | null = null;

/** 懒加载 node:fs（避免顶部 import 让本文件污染纯浏览器 bundle 分析） */
function getNodeFs(): typeof import('node:fs') {
	if (!_nodeFsCache) {
		// 用动态 require 防止 Web bundler 静态打包 node:fs
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		_nodeFsCache = (new Function('m', 'return require(m)'))('node:fs');
	}
	return _nodeFsCache!;
}

/**
 * 获取工具用 fs（优先 ctx.platform.fs.*Sync，否则降级 node:fs）。
 *
 * @example
 * ```ts
 * const fs = platformFs(ctx);
 * const content = fs.readFileSync(absolutePath, 'utf8');
 * ```
 */
export function platformFs(ctx?: IToolContext): ToolFs {
	const pfs = ctx?.platform?.fs;

	return {
		readFileSync(path, encoding = 'utf8') {
			if (pfs?.readFileSync) return pfs.readFileSync(path, encoding);
			return getNodeFs().readFileSync(path, encoding);
		},
		writeFileSync(path, content, encoding = 'utf8') {
			if (pfs?.writeFileSync) return pfs.writeFileSync(path, content, encoding);
			getNodeFs().writeFileSync(path, content, encoding);
		},
		existsSync(path) {
			if (pfs?.existsSync) return pfs.existsSync(path);
			return getNodeFs().existsSync(path);
		},
		statSync(path) {
			if (pfs?.statSync) return pfs.statSync(path);
			const s = getNodeFs().statSync(path);
			return {
				mtime: s.mtimeMs,
				ctime: s.ctimeMs,
				size: s.size,
				isDirectory: s.isDirectory(),
				isFile: s.isFile(),
				isSymbolicLink: s.isSymbolicLink(),
			};
		},
		mkdirSync(path, opts) {
			if (pfs?.mkdirSync) return pfs.mkdirSync(path, opts);
			getNodeFs().mkdirSync(path, { recursive: true, ...opts });
		},
		readdirSync(path, opts) {
			if (pfs?.readdirSync) return pfs.readdirSync(path, opts);
			return getNodeFs().readdirSync(path, opts as any);
		},
		unlinkSync(path) {
			if (pfs?.unlinkSync) return pfs.unlinkSync(path);
			getNodeFs().unlinkSync(path);
		},
	};
}
