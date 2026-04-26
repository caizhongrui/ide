/*---------------------------------------------------------------------------------------------
 *  Maxian Core — ISearchService
 *
 *  统一的"内容搜索"接口（对齐 ripgrep / vscode searchService 能力）。
 *
 *  各形态的实现：
 *  - **NodePlatform / sidecar**：`NodeSearchService` 包装系统 ripgrep（子进程） — 默认方案
 *  - **VSCodePlatform**：`VSCodeSearchService` 包装 `vscode.workspace.findInFiles` /
 *    `searchService.textSearch`（IDE 内置 ripgrep，含 i18n、CancellationToken、ignoreFiles 等）
 *  - **CloudWorkerPlatform**：复用 NodeSearchService（worker 容器内自带 ripgrep）
 *
 *  设计原则：
 *  1. 输入输出与具体后端无关（不暴露 vscode QueryType / Cancellation 等）
 *  2. 用 `AbortSignal` 标准 API 表达取消（不绑死 vscode CancellationToken）
 *  3. include / exclude 用 glob 字符串数组（picomatch 兼容语法）
 *--------------------------------------------------------------------------------------------*/

/**
 * 内容搜索参数
 */
export interface SearchTextOptions {
	/** 搜索的根目录（绝对路径） */
	folder:           string;

	/** 搜索模式 */
	pattern:          string;

	/** 是否将 pattern 当作正则（默认 true） */
	isRegExp?:         boolean;

	/** 大小写敏感（默认 false） */
	isCaseSensitive?:  boolean;

	/** 仅匹配整词（默认 false） */
	isWordMatch?:      boolean;

	/** 包含 glob 列表（如 ['**\/*.ts']），undefined = 全部包含 */
	includeGlobs?:     string[];

	/** 排除 glob 列表（如 ['**\/node_modules/**']），undefined = 默认噪音过滤 */
	excludeGlobs?:     string[];

	/** 最多返回结果数（默认 5000，对齐 IDE 当前 maxResults） */
	maxResults?:       number;

	/** 取消信号（标准 Web AbortSignal API） */
	signal?:           AbortSignal;
}

/**
 * 单条匹配结果
 */
export interface SearchTextMatch {
	/** 匹配文件的绝对路径 */
	filePath:    string;

	/** 行号（1-based） */
	lineNumber:  number;

	/** 该行内容预览（已截断到合理长度） */
	line:        string;
}

/**
 * 内容搜索服务
 */
export interface ISearchService {
	/**
	 * 在 folder 下递归搜索匹配 pattern 的内容。
	 * - regex 模式：pattern 当作 ECMAScript 正则
	 * - literal 模式：pattern 当作字面量字符串
	 *
	 * 实现需保证：
	 * - 命中 maxResults 后停止（不返回 over-limit）
	 * - signal.aborted = true 时尽快取消（throw AbortError 或返回部分结果由实现选择）
	 * - 返回结果按 filePath + lineNumber 升序（便于稳定输出）
	 */
	searchText(opts: SearchTextOptions): Promise<SearchTextMatch[]>;
}
