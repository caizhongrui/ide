/*---------------------------------------------------------------------------------------------
 *  Maxian Core — LSP Service Abstraction (optional)
 *
 *  IDE 形态可提供完整 LSP 能力（基于 vscode.languages）。
 *  Desktop / Web / Cloud 等形态可不实现（lsp 字段留空）。
 *  详见 docs/architecture/platform-contract.md
 *--------------------------------------------------------------------------------------------*/

export interface ILspService {
	/**
	 * 获取文件的诊断信息（错误 / 警告 / 提示）。
	 */
	getDiagnostics(filePath: string): Promise<LspDiagnostic[]>;

	/**
	 * 获取符号定义位置（go-to-definition）。
	 */
	getDefinition(filePath: string, line: number, column: number): Promise<LspLocation[]>;

	/**
	 * 获取符号引用列表（find references）。
	 */
	getReferences(filePath: string, line: number, column: number): Promise<LspLocation[]>;

	/**
	 * 获取 hover 信息（鼠标悬浮显示的类型/文档）。
	 */
	getHover(filePath: string, line: number, column: number): Promise<string | null>;
}

export interface LspDiagnostic {
	filePath: string;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	severity: 'error' | 'warning' | 'info' | 'hint';
	message: string;
	source?: string;
	code?: string | number;
}

export interface LspLocation {
	filePath: string;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
}
