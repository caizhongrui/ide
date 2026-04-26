/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Tenant Context (Multi-tenancy abstraction)
 *--------------------------------------------------------------------------------------------*/

/**
 * 租户上下文抽象。
 *
 * 实现方：
 * - 本地形态（Desktop / IDE / Self-hosted server）：`LocalTenantContext`，userId='local', tenantId='local'，无配额限制
 * - 云端 Worker：`CloudTenantContext`，从任务派发携带的 tenant_id / user_id 构造，写 usage_ledger
 *
 * 详见 docs/architecture/cloud-design.md
 */
export interface ITenantContext {
	/** 当前用户 ID（本地形态固定 'local'） */
	readonly userId: string;
	/** 当前租户 ID（本地形态固定 'local'） */
	readonly tenantId: string;
	/**
	 * 沙箱根路径 —— 所有 fs / terminal 操作必须严格在此目录下。
	 * 本地形态 = 用户工作区根目录；云端 Worker = `/var/maxian/tasks/{taskId}/workspace`
	 */
	readonly sandboxRoot: string;

	/**
	 * 查询当前可用配额。
	 * @returns dailyTokens / concurrentSessions 为 null 时表示无限制
	 */
	getQuota(): Promise<{ dailyTokens: number | null; concurrentSessions: number | null }>;

	/**
	 * 记录本次工具/LLM 调用的 token 消耗。
	 * 本地形态可空操作；云端形态写 usage_ledger 表。
	 */
	recordUsage(usage: { inputTokens: number; outputTokens: number; model?: string }): Promise<void>;
}

/** 本地形态默认实现（单租户、无配额、空账本） */
export class LocalTenantContext implements ITenantContext {
	readonly userId = 'local';
	readonly tenantId = 'local';
	constructor(public readonly sandboxRoot: string) {}
	async getQuota(): Promise<{ dailyTokens: number | null; concurrentSessions: number | null }> {
		return { dailyTokens: null, concurrentSessions: null };
	}
	async recordUsage(_usage: { inputTokens: number; outputTokens: number; model?: string }): Promise<void> {
		// no-op for local mode
	}
}
