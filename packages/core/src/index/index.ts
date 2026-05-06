/*---------------------------------------------------------------------------------------------
 *  @maxian/core/index — Codebase Index barrel export
 *--------------------------------------------------------------------------------------------*/

export {
	type SymbolKind,
	type CodebaseFileNode,
	type CodebaseApiEntry,
	type CodebaseModuleSummary,
	type CodebaseDepsEntry,
	type CodebaseIndexSnapshot,
	type CodebaseSearchHit,
	type ICodebaseIndex,
	type CodebaseAwareToolContext,
	CODEBASE_INDEX_STATUS_TOOL,
	CODEBASE_INDEX_REFRESH_TOOL,
	CODEBASE_INDEX_TOOLS,
	formatCodebaseSnapshotForPrompt,
	searchEntriesByEmbedding,
} from './CodebaseIndex.js';
