/*---------------------------------------------------------------------------------------------
 *  @maxian/core/mcp — MCP barrel export
 *--------------------------------------------------------------------------------------------*/

export { McpHub, type McpHubChangeListener } from './McpHub.js';
export { McpClient } from './McpClient.js';
export * from './McpTypes.js';
export { McpToolIndex, type McpToolIndexEntry, type McpToolSearchHit } from './McpToolIndex.js';
export {
	type EmbeddingService,
	KeywordEmbeddingService,
	OpenAIStyleEmbeddingService,
	cosineSimilarity,
} from './embeddingService.js';
