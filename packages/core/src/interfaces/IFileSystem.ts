/*---------------------------------------------------------------------------------------------
 *  Maxian Core — File System Abstraction
 *--------------------------------------------------------------------------------------------*/

/**
 * 文件系统抽象接口。
 *
 * 实现方：
 * - IDE：基于 VSCode IFileService 实现（处理 URI、工作区感知）
 * - Desktop：基于 node:fs/promises 实现
 */
export interface IFileSystem {
	/**
	 * 读取文本文件内容。
	 * @param path 绝对路径或相对于工作区根的路径
	 * @returns 文件内容（UTF-8 解码）
	 * @throws FileNotFoundError 当文件不存在
	 * @throws PermissionDeniedError 当无读权限
	 */
	readFile(path: string): Promise<string>;

	/**
	 * 读取二进制文件内容（如图片、PDF）。
	 * @returns Uint8Array 二进制数据
	 */
	readBinaryFile(path: string): Promise<Uint8Array>;

	/**
	 * 写入文件（自动创建父目录）。
	 * @param path 目标路径
	 * @param content 文本内容
	 */
	writeFile(path: string, content: string): Promise<void>;

	/**
	 * 追加文本到文件末尾。
	 */
	appendFile(path: string, content: string): Promise<void>;

	/**
	 * 判断路径是否存在（文件或目录）。
	 */
	exists(path: string): Promise<boolean>;

	/**
	 * 获取文件元信息。
	 * @throws FileNotFoundError 当路径不存在
	 */
	stat(path: string): Promise<FileStat>;

	/**
	 * 删除文件。
	 * @param path 目标文件
	 * @param options.recursive 是否递归删除（针对目录）
	 * @param options.useTrash 是否移动到回收站而不是永久删除
	 */
	deleteFile(path: string, options?: DeleteOptions): Promise<void>;

	/**
	 * 创建目录（recursive 默认 true）。
	 */
	createDirectory(path: string): Promise<void>;

	/**
	 * 列出目录下的条目。
	 * @param path 目录路径
	 * @param options.recursive 是否递归列出所有子目录
	 * @param options.maxDepth 最大递归深度（默认无限制，传 0 表示仅当前层）
	 * @param options.excludePatterns 要排除的 glob 模式（如 ['**\/node_modules/**']）
	 */
	listFiles(path: string, options?: ListFilesOptions): Promise<FileEntry[]>;

	/**
	 * 重命名 / 移动文件或目录。
	 */
	rename(oldPath: string, newPath: string): Promise<void>;

	/**
	 * 解析为绝对路径（相对于工作区根或当前目录）。
	 * 实现方可以在此加入工作区感知逻辑。
	 */
	resolvePath(path: string): string;

	// ── K8e（已完成）：sync API 全数下线 ─────────────────────────
	// 历史背景：N1 阶段曾增设可选的 *Sync 镜像方法（readFileSync? 等），让 core 工具不必整条调用链 async 化。
	// K8e 完成后 core 9 大工具 + 4 大 utils 全部异步化，sync API 不再被 core 引用，已从契约里整体移除。
	//
	// 浏览器 / VS Code renderer / IDEA JCEF 等无 sync fs 的形态现在可以直接实现 IFileSystem，无需提供 sync 镜像。
	//
	// 例外（非 IFileSystem 范畴，仍保留少量 fs 直调）：
	//   - tools/truncate.ts：写 ~/.maxian/ 系统配置
	//   - tools/grepTool.ts findRgPath：探测系统 rg 二进制
	//   - adapters/NodeSearchService.ts：Node 专用 ISearchService 实现
	//   - tools/bashTool.ts / executeCommandTool.ts：child_process（K8d ITerminal 抽象覆盖）
}

/** Node.js BufferEncoding 类型镜像（core 不依赖 @types/node） */
export type BufferEncoding =
	| 'ascii' | 'utf8' | 'utf-8' | 'utf16le' | 'ucs2' | 'ucs-2'
	| 'base64' | 'base64url' | 'latin1' | 'binary' | 'hex';

export interface FileStat {
	/** 最后修改时间（毫秒时间戳） */
	mtime: number;
	/** 最后访问时间（毫秒时间戳） */
	ctime: number;
	/** 文件大小（字节） */
	size: number;
	/** 是否为目录 */
	isDirectory: boolean;
	/** 是否为普通文件 */
	isFile: boolean;
	/** 是否为符号链接 */
	isSymbolicLink: boolean;
}

export interface FileEntry {
	/** 文件名（不含路径） */
	name: string;
	/** 绝对路径 */
	path: string;
	/** 是否为目录 */
	isDirectory: boolean;
	/** 是否为符号链接 */
	isSymbolicLink: boolean;
}

export interface DeleteOptions {
	recursive?: boolean;
	useTrash?: boolean;
}

export interface ListFilesOptions {
	recursive?: boolean;
	maxDepth?: number;
	excludePatterns?: string[];
}

/** 文件系统错误基类 */
export class FileSystemError extends Error {
	constructor(
		message: string,
		public readonly code: FileSystemErrorCode,
		public readonly path?: string
	) {
		super(message);
		this.name = 'FileSystemError';
	}
}

export type FileSystemErrorCode =
	| 'FileNotFound'
	| 'FileExists'
	| 'PermissionDenied'
	| 'IsADirectory'
	| 'NotADirectory'
	| 'Unknown';
