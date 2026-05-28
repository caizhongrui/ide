/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP Hub：管理多个 MCP 服务器连接
 * 提供统一的工具调用和资源访问接口
 */

import { McpServerConfig, McpServerInfo, McpTool, McpToolCallResponse, McpResourceReadResponse } from './McpTypes.js';
import { McpClient } from './McpClient.js';
import { McpToolIndex } from './McpToolIndex.js';
import type { EmbeddingService } from './embeddingService.js';

export type McpHubChangeListener = (servers: McpServerInfo[]) => void;

interface McpRetryState {
	failureCount: number;
	nextRetryAt: number;
	lastError: string;
}

export class McpHub {
	private servers: Map<string, McpServerInfo> = new Map();
	private clients: Map<string, McpClient> = new Map();
	private retryStates: Map<string, McpRetryState> = new Map();
	/** 自动重连定时器（per server）。断线后调度，连上/禁用/删除时清理。 */
	private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private changeListeners: McpHubChangeListener[] = [];
	private static readonly RETRY_BASE_DELAY_MS = 3000;
	private static readonly RETRY_MAX_DELAY_MS = 60000;

	/** B2: 工具索引 —— 所有已连接 server 的工具元数据 + 向量索引，供 mcp_tool_search 使用 */
	private readonly _toolIndex: McpToolIndex;

	constructor(opts?: { embeddingService?: EmbeddingService }) {
		this._toolIndex = new McpToolIndex({ primary: opts?.embeddingService });
	}

	/** 获取工具索引（搜索 / 列出 / 上层调度） */
	get toolIndex(): McpToolIndex {
		return this._toolIndex;
	}

	/**
	 * 获取所有服务器状态
	 */
	getAllServers(): McpServerInfo[] {
		return Array.from(this.servers.values());
	}

	/**
	 * 获取指定服务器状态
	 */
	getServer(name: string): McpServerInfo | undefined {
		return this.servers.get(name);
	}

	/**
	 * 注册变化监听器
	 */
	onDidChange(listener: McpHubChangeListener): () => void {
		this.changeListeners.push(listener);
		return () => {
			const idx = this.changeListeners.indexOf(listener);
			if (idx >= 0) this.changeListeners.splice(idx, 1);
		};
	}

	private notifyChange(): void {
		const servers = this.getAllServers();
		this.changeListeners.forEach(l => l(servers));
	}

	/**
	 * 连接（或重连）指定服务器
	 */
	async connectServer(config: McpServerConfig, options?: { force?: boolean }): Promise<McpServerInfo> {
		// 本次连接接管该 server —— 取消任何待执行的自动重连，避免重复连接
		this.clearReconnectTimer(config.name);
		const forceRetry = options?.force === true;
		const retryState = this.retryStates.get(config.name);
		const now = Date.now();
		if (!forceRetry && retryState && retryState.nextRetryAt > now) {
			const existing = this.servers.get(config.name);
			const waitSeconds = Math.ceil((retryState.nextRetryAt - now) / 1000);
			const cooledDown: McpServerInfo = {
				config,
				tools: existing?.tools || [],
				resources: existing?.resources || [],
				resourceTemplates: existing?.resourceTemplates || [],
				isConnected: false,
				isConnecting: false,
				error: `连接冷却中，请 ${waitSeconds}s 后重试。上次错误: ${retryState.lastError}`,
				sessionId: undefined,
			};
			this.servers.set(config.name, cooledDown);
			this.notifyChange();
			return cooledDown;
		}

		const existing = this.servers.get(config.name);
		const info: McpServerInfo = {
			config,
			tools: existing?.tools || [],
			resources: existing?.resources || [],
			resourceTemplates: existing?.resourceTemplates || [],
			isConnected: false,
			isConnecting: true,
			error: undefined,
			sessionId: undefined,
		};
		this.servers.set(config.name, info);
		this.notifyChange();

		try {
			// 清理上一个 client 的残留连接（旧 SSE GET 流 + 后台读循环），避免泄漏/串扰
			const oldClient = this.clients.get(config.name);
			if (oldClient) { try { oldClient.reset(); } catch { /* ignore */ } }

			const client = new McpClient(config);
			this.clients.set(config.name, client);

			// 初始化连接
			await client.initialize();

			// 获取工具列表
			const tools = await client.listTools();

			// 尝试获取资源列表
			const { resources, resourceTemplates } = await client.listResources();

			const connected: McpServerInfo = {
				config,
				tools,
				resources,
				resourceTemplates,
				isConnected: true,
				isConnecting: false,
				error: undefined,
				sessionId: (client as any).sessionId,
			};
			// 注册"意外断开 → 自动重连"回调（闭包捕获本 client；旧 client 的迟到回调会被 handleDisconnect 忽略）
			client.setOnClose(() => this.handleDisconnect(config.name, client));
			this.servers.set(config.name, connected);
			this.clearRetryState(config.name);
			// B2: 把工具元数据塞入索引（fire-and-forget；embedding 异步算，期间索引可继续接受查询）
			void this._toolIndex.upsertServerTools(config.name, tools).catch(err => {
				console.warn(`[McpHub] toolIndex.upsertServerTools(${config.name}) 失败:`, err);
			});
			this.notifyChange();
			return connected;
		} catch (error: any) {
			const errorMessage = error?.message || String(error);
			const retryState = this.markRetryFailure(config.name, errorMessage);
			const retryInSec = Math.ceil((retryState.nextRetryAt - Date.now()) / 1000);
			const failed: McpServerInfo = {
				config,
				tools: [],
				resources: [],
				resourceTemplates: [],
				isConnected: false,
				isConnecting: false,
				error: `${errorMessage}（${retryInSec}s 后自动允许重试）`,
			};
			const failedClient = this.clients.get(config.name);
			if (failedClient) { try { failedClient.reset(); } catch { /* ignore */ } }
			this.servers.set(config.name, failed);
			this.clients.delete(config.name);
			this.notifyChange();
			return failed;
		}
	}

	/**
	 * 断开指定服务器
	 */
	disconnectServer(name: string): void {
		// 主动断开：取消自动重连定时器 + reset client（cancel 旧 SSE 连接，且 closing=true 不触发重连）
		this.clearReconnectTimer(name);
		const client = this.clients.get(name);
		if (client) { try { client.reset(); } catch { /* ignore */ } }
		this.servers.delete(name);
		this.clients.delete(name);
		this.retryStates.delete(name);
		// B2: 从工具索引中移除该 server 的所有条目（防止 mcp_tool_search 召回已断开的工具）
		this._toolIndex.removeServer(name);
		this.notifyChange();
	}

	/**
	 * 更新服务器配置（重新连接）
	 */
	async updateServer(config: McpServerConfig): Promise<McpServerInfo> {
		this.disconnectServer(config.name);
		if (config.enabled) {
			return this.connectServer(config, { force: true });
		}
		// 禁用：只存配置，不连接
		const info: McpServerInfo = {
			config,
			tools: [],
			resources: [],
			resourceTemplates: [],
			isConnected: false,
			isConnecting: false,
			error: '已禁用',
		};
		this.servers.set(config.name, info);
		this.notifyChange();
		return info;
	}

	/**
	 * 调用工具
	 */
	async callTool(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<McpToolCallResponse> {
		const client = this.getConnectedClient(serverName);
		try {
			return await client.callTool(toolName, args);
		} catch (error: any) {
			return {
				content: [{ type: 'text', text: `工具调用失败: ${error?.message || String(error)}` }],
				isError: true,
			};
		}
	}

	/**
	 * 读取资源
	 */
	async readResource(serverName: string, uri: string): Promise<McpResourceReadResponse> {
		const client = this.getConnectedClient(serverName);
		return client.readResource(uri);
	}

	/**
	 * 获取所有已连接服务器的工具（用于系统提示词）
	 */
	getConnectedTools(): Array<{ serverName: string; tool: McpTool }> {
		const result: Array<{ serverName: string; tool: McpTool }> = [];
		for (const [name, info] of this.servers) {
			if (info.isConnected) {
				for (const tool of info.tools) {
					result.push({ serverName: name, tool });
				}
			}
		}
		return result;
	}

	private getConnectedClient(serverName: string): McpClient {
		const info = this.servers.get(serverName);
		const client = this.clients.get(serverName);
		if (!client || !info?.isConnected) {
			const reconnecting = info && !info.isConnected && this.reconnectTimers.has(serverName);
			throw new Error(`MCP 服务器 "${serverName}" 未连接${reconnecting ? '（正在自动重连，请稍后重试）' : ''}`);
		}
		return client;
	}

	/**
	 * 从存储格式加载配置并批量连接
	 */
	async loadConfigs(configs: McpServerConfig[]): Promise<void> {
		const uniqueEnabledConfigs: McpServerConfig[] = [];
		const seenSignatures = new Set<string>();
		for (const config of configs) {
			if (!config.enabled) {
				continue;
			}
			const signature = JSON.stringify({
				url: config.url || '',
				headers: config.headers || {},
			});
			if (seenSignatures.has(signature)) {
				continue;
			}
			seenSignatures.add(signature);
			uniqueEnabledConfigs.push(config);
		}

		const promises = uniqueEnabledConfigs
			.map(c => this.connectServer(c).catch(err => {
				console.error(`[McpHub] 连接服务器 ${c.name} 失败:`, err);
			}));
		await Promise.all(promises);
	}

	/**
	 * 销毁所有连接
	 */
	dispose(): void {
		for (const t of this.reconnectTimers.values()) clearTimeout(t);
		this.reconnectTimers.clear();
		for (const c of this.clients.values()) { try { c.reset(); } catch { /* ignore */ } }
		this.servers.clear();
		this.clients.clear();
		this.retryStates.clear();
		this.changeListeners = [];
	}

	private markRetryFailure(name: string, errorMessage: string): McpRetryState {
		const previous = this.retryStates.get(name);
		const failureCount = (previous?.failureCount || 0) + 1;
		const delay = Math.min(
			McpHub.RETRY_BASE_DELAY_MS * Math.pow(2, failureCount - 1),
			McpHub.RETRY_MAX_DELAY_MS
		);
		const retryState: McpRetryState = {
			failureCount,
			nextRetryAt: Date.now() + delay,
			lastError: errorMessage,
		};
		this.retryStates.set(name, retryState);
		return retryState;
	}

	private clearRetryState(name: string): void {
		this.retryStates.delete(name);
	}

	/**
	 * 连接成功后被服务端/网络意外断开时由 McpClient.onClose 触发：
	 * 标记断开状态（让 UI 不再误显示"已连接"）+ 调度自动重连。
	 */
	private handleDisconnect(name: string, client: McpClient): void {
		// 只处理"当前 client"的断开；旧 client（已被替换）的迟到回调直接忽略
		if (this.clients.get(name) !== client) return;
		const info = this.servers.get(name);
		if (!info) return;                 // 已被删除
		if (!info.config.enabled) return;  // 已被禁用 → 不重连

		const disconnected: McpServerInfo = {
			...info,
			isConnected: false,
			isConnecting: false,
			error: '连接已断开，正在自动重连…',
		};
		this.servers.set(name, disconnected);
		// 从工具索引移除，避免 mcp_tool_search 召回已断开 server 的工具
		this._toolIndex.removeServer(name);
		this.notifyChange();
		console.warn(`[McpHub] 服务器 "${name}" 连接断开，调度自动重连`);
		this.scheduleReconnect(name);
	}

	/**
	 * 调度一次自动重连（带指数退避）。
	 * 连上则停止；仍失败则继续退避重连，直到成功或 server 被 disconnect / 禁用。
	 */
	private scheduleReconnect(name: string): void {
		this.clearReconnectTimer(name);
		const info = this.servers.get(name);
		if (!info || !info.config.enabled) return;

		// 退避延迟复用 retryState 的失败计数（断线本身不计 failure，连不上才累加）
		const failureCount = this.retryStates.get(name)?.failureCount ?? 0;
		const delay = Math.min(
			McpHub.RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, failureCount)),
			McpHub.RETRY_MAX_DELAY_MS
		);

		const timer = setTimeout(() => {
			this.reconnectTimers.delete(name);
			const cur = this.servers.get(name);
			if (!cur || !cur.config.enabled) return;  // 期间被删除/禁用 → 放弃
			if (cur.isConnected) return;              // 期间已被别处连上 → 放弃
			void this.connectServer(cur.config, { force: true })
				.then(result => {
					// 仍未连上 → 继续退避重连
					if (!result.isConnected) {
						const still = this.servers.get(name);
						if (still && still.config.enabled && !still.isConnected) this.scheduleReconnect(name);
					}
				})
				.catch(() => {
					const still = this.servers.get(name);
					if (still && still.config.enabled && !still.isConnected) this.scheduleReconnect(name);
				});
		}, delay);
		(timer as any).unref?.();  // 不阻塞进程退出
		this.reconnectTimers.set(name, timer);
		console.log(`[McpHub] 服务器 "${name}" 将在 ${Math.round(delay / 1000)}s 后自动重连`);
	}

	private clearReconnectTimer(name: string): void {
		const t = this.reconnectTimers.get(name);
		if (t) { clearTimeout(t); this.reconnectTimers.delete(name); }
	}
}
