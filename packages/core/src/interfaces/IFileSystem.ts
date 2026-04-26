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

	// ── 可选的同步方法（K8 N1）────────────────────────────────────
	// 用途：让 core/tools 在 Node 形态下不必把整条调用链 async 化。
	// Web / IDEA 等无原生同步 fs 的形态可以**不实现**这些方法，
	// 工具内 platformFs helper 会自动降级到内置 fs（理想状态是工具
	// 后续异步化后即便 fallback 也不再需要，作为下一阶段独立任务）。

	/** 同步读文本文件（可选） */
	readFileSync?(path: string, encoding?: BufferEncoding): string;
	/** 同步写文本文件（可选） */
	writeFileSync?(path: string, content: string, encoding?: BufferEncoding): void;
	/** 同步判断路径是否存在（可选） */
	existsSync?(path: string): boolean;
	/** 同步获取文件元信息（可选） */
	statSync?(path: string): FileStat;
	/** 同步创建目录（可选；recursive 默认 true） */
	mkdirSync?(path: string, opts?: { recursive?: boolean }): void;
	/** 同步列目录条目（可选） */
	readdirSync?(path: string, opts?: { withFileTypes?: boolean }): string[] | FileEntry[];
	/** 同步删除文件（可选） */
	unlinkSync?(path: string): void;

	// ── K8c: 收尾用的额外可选 sync 方法 ─────────────────────────
	/** 同步获取文件元信息（不解符号链接）（可选） */
	lstatSync?(path: string): FileStat;
	/** 同步解析符号链接（可选） */
	realpathSync?(path: string): string;
	/** 同步读取文件为二进制（可选；用于图片等） */
	readBinaryFileSync?(path: string): Uint8Array;
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
