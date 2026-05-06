/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 系统导出
 */

export * from './AgentTypes.js';
export { ExploreAgent } from './ExploreAgent.js';
export { PlanAgent } from './PlanAgent.js';
export { ExecuteAgent } from './ExecuteAgent.js';
export { AgentOrchestrator, type OrchestratorConfig, type OrchestratorEvents } from './AgentOrchestrator.js';

// B1: Sub-agents 完整版（builtin 4 类 + 别名映射）
export {
	BUILTIN_SUBAGENTS,
	SUBAGENT_GENERAL_PURPOSE,
	SUBAGENT_CODE_REVIEWER,
	SUBAGENT_CODE_EXPLORER,
	SUBAGENT_TEST_WRITER,
	LEGACY_SUBAGENT_ALIASES,
	getBuiltinSubagent,
	listBuiltinSubagentNames,
	resolveSubagentName,
	type SubagentDefinition,
	type SubagentIsolation,
} from './subagentDefinitions.js';
