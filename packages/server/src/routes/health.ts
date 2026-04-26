/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Health Route
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { MAXIAN_CORE_VERSION } from '@maxian/core';
import { SERVER_PROTOCOL_VERSION } from '../middleware/index.js';

export function HealthRoutes(serverStartTime: number) {
	return new Hono()
		.get('/health', (c) => {
			return c.json({
				ok: true,
				version: MAXIAN_CORE_VERSION,
				serverProtocol: SERVER_PROTOCOL_VERSION,
				uptime: Date.now() - serverStartTime,
			});
		})
		.get('/version', (c) => {
			return c.json({
				version: MAXIAN_CORE_VERSION,
				serverProtocol: SERVER_PROTOCOL_VERSION,
			});
		});
}
