/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Config Routes
 *
 *  通用 KV 配置：GET/PUT /config/:key
 *  B2 新增：GET/PUT /config/mcp（特殊路径，写入 sqlite mcp_servers 表 + 触发重连）
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { IConfiguration } from '@maxian/core';
import type { SessionManager } from '../sessionManager.js';

export function ConfigRoutes(config: IConfiguration, sessionManager?: SessionManager) {
	const app = new Hono();

	// ── B2: MCP 服务器配置（必须在 /config/:key 之前注册，否则被通配捕获）─────────
	if (sessionManager) {
		app.get('/config/mcp', (c) => {
			const configs = sessionManager.listMcpConfigs();
			const servers = sessionManager.mcpHub.getAllServers();
			return c.json({
				configs,
				// 运行时连接状态（不包含 client 实例细节）
				runtime: servers.map(s => ({
					name:        s.config.name,
					isConnected: s.isConnected,
					isConnecting: s.isConnecting,
					error:       s.error,
					toolCount:   s.tools.length,
					resourceCount: s.resources.length,
				})),
				toolIndexSize: sessionManager.mcpHub.toolIndex.size(),
			});
		});

		app.put(
			'/config/mcp',
			zValidator('json', z.object({
				configs: z.array(z.object({
					name:        z.string().min(1),
					url:         z.string().url(),
					headers:     z.record(z.string(), z.string()).optional(),
					enabled:     z.boolean(),
					description: z.string().optional(),
				})),
			})),
			async (c) => {
				const { configs } = c.req.valid('json');
				const result = await sessionManager.replaceMcpConfigs(configs);
				return c.json({
					ok:       true,
					added:    result.added,
					updated:  result.updated,
					removed:  result.removed,
					runtime:  result.servers.map(s => ({
						name:         s.config.name,
						isConnected:  s.isConnected,
						isConnecting: s.isConnecting,
						error:        s.error,
						toolCount:    s.tools.length,
					})),
				});
			}
		);

		// MCP 工具索引：列出 / 搜索（让桌面端显示已加载工具列表用）
		app.get('/config/mcp/tools', (c) => {
			const all = sessionManager.mcpHub.toolIndex.listAll();
			return c.json({
				total: all.length,
				tools: all.map(t => ({
					toolId:      t.toolId,
					serverName:  t.serverName,
					rawToolName: t.rawToolName,
					description: t.description,
					inputSchema: t.inputSchema,
				})),
			});
		});

		app.get('/config/mcp/tools/search', async (c) => {
			const query  = c.req.query('q') ?? '';
			const max    = Math.min(Math.max(1, Number(c.req.query('max') ?? 10)), 50);
			const filter = c.req.query('servers')?.split(',').filter(Boolean);
			if (!query.trim()) return c.json({ hits: [] });
			const hits = await sessionManager.mcpHub.toolIndex.search(query, max, 0.05, filter);
			return c.json({
				hits: hits.map(h => ({
					toolId:      h.entry.toolId,
					serverName:  h.entry.serverName,
					rawToolName: h.entry.rawToolName,
					description: h.entry.description,
					score:       h.score,
				})),
			});
		});
	}

	// ── 通用 KV 配置 ────────────────────────────────────────────
	app.get('/config/:key', (c) => {
		const key = c.req.param('key');
		const value = config.getValue(key);
		return c.json({ key, value });
	});

	app.put(
		'/config/:key',
		zValidator('json', z.object({
			value: z.unknown(),
		})),
		async (c) => {
			const key = c.req.param('key');
			const { value } = c.req.valid('json');
			if (config.updateValue) {
				await config.updateValue(key, value);
			}
			return c.json({ ok: true });
		}
	);

	return app;
}
