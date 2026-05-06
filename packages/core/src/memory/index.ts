/*---------------------------------------------------------------------------------------------
 *  @maxian/core/memory — Auto-Memory barrel export
 *--------------------------------------------------------------------------------------------*/

export {
	type MemoryScope,
	type MemoryCategory,
	type MemorySource,
	type MemoryRecord,
	type MemorySearchHit,
	type MemoryQuery,
	type IMemoryStore,
	InMemoryMemoryStore,
} from './MemoryStore.js';

export {
	SAVE_MEMORY_TOOL,
	RECALL_MEMORY_TOOL,
	MEMORY_TOOLS,
	AUTO_MEMORY_EXTRACTION_PROMPT,
	parseAutoMemoryResult,
	type MemoryAwareToolContext,
} from './memoryTools.js';
