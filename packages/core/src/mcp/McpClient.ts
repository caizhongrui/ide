/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP (Model Context Protocol) HTTP 客户端
 * 实现 Streamable HTTP 传输协议 + 传统 SSE 传输协议
 * 参考: https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/
 *
 * 传输协议自动检测：
 * - URL 以 /sse 结尾 → 使用传统 SSE 传输（GET 建立流，POST 发消息）
 * - 其他 URL → 使用 Streamable HTTP 传输（POST 直接接收 JSON 或 SSE 流）
 */

import {
	McpServerConfig, McpTool, McpResource, McpResourceTemplate,
	McpToolCallResponse, McpResourceReadResponse,
	JsonRpcRequest, JsonRpcResponse,
	McpInitializeParams, McpInitializeResult
} from './McpTypes.js';

// core 不依赖 @types/node（lib 仅 ES2022+DOM），但 SSE 走 raw socket 需要 Buffer（运行时由 Node/Bun 提供）
declare const Buffer: any;

const MCP_PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60000;  // SSE 连接超时更长

export class McpClient {
	private requestId = 0;
	private sessionId?: string;
	private initialized = false;

	// SSE 传输状态（仅 URL 以 /sse 结尾时使用）
	// 用 node:net 原始 socket 而非 fetch / node:http —— Bun(≤1.3.x) 这两者对
	// Transfer-Encoding: chunked 长连接都有 bug：fetch.getReader() 等整个响应才返回
	// （SSE 永不结束 → 卡死）；node:http 收到首个 chunk 后过早 aborted。JetBrains MCP
	// 正是 chunked SSE，curl 能用说明是 bun HTTP 高层的问题，故降到 raw socket 自己解析。
	private sseMessageEndpoint?: string;
	private sseSocket?: any;            // node:net / node:tls Socket（原始 SSE 连接）
	private sseRawBuffer: any;          // Buffer：累积原始字节（HTTP 头 + chunked body）
	private sseHeadersParsed = false;   // HTTP 响应头是否已吃完
	private sseChunkText = '';          // 已从 chunked 解码出的 SSE 文本（待按事件切分）
	private sseClosed = false;          // 断开收尾幂等标志（end/close/error 只处理一次）
	private ssePendingRequests = new Map<number | string, {
		resolve: (v: any) => void;
		reject: (e: Error) => void;
	}>();

	/** 连接意外断开（SSE 流结束/出错）时回调，供 McpHub 触发自动重连。
	 *  主动 reset() 关闭时不会触发（closing=true）。 */
	private onCloseCallback?: () => void;
	/** 是否处于主动关闭（reset）流程：避免 reset 取消 reader 导致 reading loop 误触发 onClose 重连 */
	private closing = false;

	constructor(private readonly config: McpServerConfig) { }

	/** 注册"连接意外断开"回调（McpHub 在 connect 成功后设置） */
	setOnClose(cb: () => void): void {
		this.onCloseCallback = cb;
	}

	get name(): string {
		return this.config.name;
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * 检测是否使用传统 SSE 传输协议（URL 以 /sse 结尾）
	 */
	private get useSseTransport(): boolean {
		return this.config.url.endsWith('/sse');
	}

	/**
	 * 初始化连接：发送 initialize 请求，获取服务器能力
	 */
	async initialize(): Promise<McpInitializeResult> {
		// SSE 传输需要先建立持久连接
		if (this.useSseTransport) {
			await this.connectSse();
		}

		const params: McpInitializeParams = {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {
				roots: { listChanged: false },
			},
			clientInfo: {
				name: 'tianhe-zhikai-ide',
				version: '1.0.0',
			},
		};

		const result = await this.sendRequest<McpInitializeResult>('initialize', params);

		// 发送 initialized 通知
		await this.sendNotification('notifications/initialized', {});

		this.initialized = true;
		return result;
	}

	/**
	 * 建立传统 SSE 连接（raw TCP socket 手写 HTTP/1.1）
	 *
	 * 为什么降到 node:net 而不用 fetch / node:http：
	 * Bun(≤1.3.x) 的 fetch 与 node:http 客户端对 Transfer-Encoding: chunked 长连接都有 bug
	 * —— fetch.getReader() 会等整个响应才返回（SSE 永不结束 → 卡死）；node:http 收到首个
	 * chunk 后会过早 aborted。JetBrains MCP 正是 chunked SSE，curl 能用说明是 bun HTTP 高层
	 * 解析的问题，故这里用原始 socket，自己解析 HTTP 响应头 + chunked 编码 + SSE 事件。
	 */
	private async connectSse(): Promise<void> {
		this.sseClosed = false;
		this.sseHeadersParsed = false;
		this.sseChunkText = '';
		this.sseRawBuffer = Buffer.alloc(0);
		const url = new URL(this.config.url);
		const isHttps = url.protocol === 'https:';
		const port = Number(url.port) || (isHttps ? 443 : 80);
		// 字面量分支 import：bun --compile 能静态识别内置模块
		const mod: any = isHttps ? await import('node:tls') : await import('node:net');

		await new Promise<void>((resolveEndpoint, rejectEndpoint) => {
			let endpointDone = false;
			let timeout: ReturnType<typeof setTimeout>;

			const finishEndpoint = (err?: Error): void => {
				if (endpointDone) return;
				endpointDone = true;
				clearTimeout(timeout);
				if (err) rejectEndpoint(err); else resolveEndpoint();
			};

			const onData = (chunk: any): void => {
				this.sseRawBuffer = Buffer.concat([this.sseRawBuffer, chunk]);
				// 1) 先吃掉 HTTP 响应头
				if (!this.sseHeadersParsed) {
					const sep = this.sseRawBuffer.indexOf('\r\n\r\n');
					if (sep < 0) return;  // 头未完整，等更多数据
					const headerText = this.sseRawBuffer.slice(0, sep).toString('utf8');
					const statusLine = headerText.split('\r\n')[0] || '';
					const m = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
					const status = m ? parseInt(m[1], 10) : 0;
					if (status !== 200) {
						finishEndpoint(new Error(`SSE 连接失败 ${status || statusLine}`));
						try { this.sseSocket?.destroy(); } catch { /* ignore */ }
						return;
					}
					this.sseHeadersParsed = true;
					this.sseRawBuffer = this.sseRawBuffer.slice(sep + 4);  // 余下是 chunked body
				}
				// 2) 解析 chunked body → SSE 事件
				this.consumeChunkedSse(finishEndpoint);
			};

			const onClose = (err?: Error): void => {
				finishEndpoint(err ?? new Error('SSE 连接在收到 endpoint 事件前关闭'));
				this.handleSseClose();
			};

			const socket: any = mod.connect(
				isHttps
					? { host: url.hostname, port, servername: url.hostname }
					: { host: url.hostname, port },
				() => {
					// 连接建立后发原始 HTTP/1.1 GET（手动拼请求行 + 头）
					const lines = [
						`GET ${url.pathname}${url.search} HTTP/1.1`,
						`Host: ${url.host}`,
						`Accept: text/event-stream`,
						`Connection: keep-alive`,
					];
					for (const [k, v] of Object.entries(this.config.headers || {})) lines.push(`${k}: ${v}`);
					socket.write(lines.join('\r\n') + '\r\n\r\n');
				}
			);
			this.sseSocket = socket;
			socket.on('data', onData);
			socket.on('end', () => onClose());
			socket.on('close', () => onClose());
			socket.on('error', (e: Error) => onClose(e));

			timeout = setTimeout(() => {
				finishEndpoint(new Error('SSE endpoint 事件超时'));
				try { socket.destroy(); } catch { /* ignore */ }
			}, 10000);
		});
	}

	/**
	 * 解析 HTTP chunked body：逐个 chunk 取出 data 累积成 SSE 文本，按空行切分事件分发。
	 * @param finishEndpoint 收到 endpoint 事件时调用以 resolve 连接 Promise
	 */
	private consumeChunkedSse(finishEndpoint: (err?: Error) => void): void {
		while (true) {
			const crlf = this.sseRawBuffer.indexOf('\r\n');
			if (crlf < 0) break;                        // chunk-size 行未完整
			const sizeStr = this.sseRawBuffer.slice(0, crlf).toString('ascii').split(';')[0].trim();
			const size = parseInt(sizeStr, 16);
			if (Number.isNaN(size)) break;              // 容错：等更多数据
			if (size === 0) return;                     // 末尾 0-chunk，流结束（close 事件收尾）
			const dataStart = crlf + 2;
			if (this.sseRawBuffer.length < dataStart + size + 2) break;  // 本 chunk data 未完整
			const data = this.sseRawBuffer.slice(dataStart, dataStart + size);
			this.sseRawBuffer = this.sseRawBuffer.slice(dataStart + size + 2);  // 跳过 data + 尾随 \r\n
			this.sseChunkText += data.toString('utf8');

			// 按 SSE 事件（空行分隔，兼容 \r\n\r\n / \n\n）切分
			const events = this.sseChunkText.split(/\r?\n\r?\n/);
			this.sseChunkText = events.pop() || '';
			for (const ev of events) {
				if (!ev.trim()) continue;
				const { eventType, data: evData } = this.parseSseEvent(ev);
				if (eventType === 'endpoint' && evData) {
					const baseUrl = new URL(this.config.url);
					this.sseMessageEndpoint = new URL(evData, baseUrl.origin).toString();
					finishEndpoint();  // resolve：endpoint 已就绪，可以发 initialize 了
				} else if ((eventType === 'message' || eventType === 'response') && evData) {
					this.handleSseResponseData(evData);
				}
			}
		}
	}

	/** 解析并分发一条 JSON-RPC 响应到对应的 pending 请求 */
	private handleSseResponseData(data: string): void {
		try {
			const jsonResponse: JsonRpcResponse = JSON.parse(data);
			if (jsonResponse.id !== null && jsonResponse.id !== undefined) {
				// id 可能是 number 或 string，按两种 key 各查一次，兼容服务端类型差异
				const pending = this.ssePendingRequests.get(jsonResponse.id)
					?? this.ssePendingRequests.get(String(jsonResponse.id))
					?? this.ssePendingRequests.get(Number(jsonResponse.id));
				if (pending) {
					this.ssePendingRequests.delete(jsonResponse.id);
					this.ssePendingRequests.delete(String(jsonResponse.id));
					this.ssePendingRequests.delete(Number(jsonResponse.id));
					if (jsonResponse.error) {
						pending.reject(new Error(`MCP 错误: [${jsonResponse.error.code}] ${jsonResponse.error.message}`));
					} else {
						pending.resolve(jsonResponse.result);
					}
				}
			}
		} catch {
			// 忽略解析失败
		}
	}

	/** SSE 流结束/出错统一收尾（幂等）：拒绝未决请求 + 非主动关闭时回调 onClose 触发重连 */
	private handleSseClose(): void {
		if (this.sseClosed) return;
		this.sseClosed = true;
		this.initialized = false;
		for (const [, pending] of this.ssePendingRequests) {
			pending.reject(new Error('SSE 连接断开'));
		}
		this.ssePendingRequests.clear();
		if (!this.closing) {
			const cb = this.onCloseCallback;
			if (cb) { try { cb(); } catch { /* ignore */ } }
		}
	}

	/**
	 * 解析单个 SSE 事件文本
	 */
	private parseSseEvent(eventText: string): { eventType: string; data: string } {
		const lines = eventText.split('\n');
		let eventType = 'message';
		let data = '';

		for (const line of lines) {
			if (line.startsWith('event:')) {
				eventType = line.slice(6).trim();
			} else if (line.startsWith('data:')) {
				data = line.slice(5).trim();
			}
		}

		return { eventType, data };
	}

	/**
	 * 列出所有工具
	 */
	async listTools(): Promise<McpTool[]> {
		const result = await this.sendRequest<{ tools: McpTool[] }>('tools/list', {});
		return result.tools || [];
	}

	/**
	 * 调用工具
	 */
	async callTool(toolName: string, args?: Record<string, unknown>): Promise<McpToolCallResponse> {
		const result = await this.sendRequest<McpToolCallResponse>('tools/call', {
			name: toolName,
			arguments: args || {},
		});
		return result;
	}

	/**
	 * 列出所有资源
	 */
	async listResources(): Promise<{ resources: McpResource[]; resourceTemplates: McpResourceTemplate[] }> {
		try {
			const result = await this.sendRequest<{ resources: McpResource[]; resourceTemplates?: McpResourceTemplate[] }>('resources/list', {});
			return {
				resources: result.resources || [],
				resourceTemplates: result.resourceTemplates || [],
			};
		} catch {
			return { resources: [], resourceTemplates: [] };
		}
	}

	/**
	 * 读取资源
	 */
	async readResource(uri: string): Promise<McpResourceReadResponse> {
		const result = await this.sendRequest<McpResourceReadResponse>('resources/read', { uri });
		return result;
	}

	/**
	 * 发送 JSON-RPC 请求（带响应）
	 * 根据传输类型选择不同的发送方式
	 */
	private async sendRequest<T>(method: string, params: any): Promise<T> {
		const id = ++this.requestId;

		if (this.useSseTransport) {
			return this.sendRequestViaSse<T>(id, method, params);
		} else {
			return this.sendRequestViaStreamableHttp<T>(id, method, params);
		}
	}

	/**
	 * 通过传统 SSE 传输发送请求
	 * POST 到 sseMessageEndpoint，通过 SSE 流接收响应
	 */
	private sendRequestViaSse<T>(id: number, method: string, params: any): Promise<T> {
		if (!this.sseMessageEndpoint) {
			return Promise.reject(new Error('SSE 消息端点未建立，请先调用 initialize()'));
		}

		const request: JsonRpcRequest = {
			jsonrpc: '2.0',
			method,
			params,
			id,
		};

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...this.config.headers,
		};

		return new Promise<T>((resolve, reject) => {
			// 注册待处理请求
			this.ssePendingRequests.set(id, { resolve, reject });

			// 设置超时
			const timeoutId = setTimeout(() => {
				this.ssePendingRequests.delete(id);
				reject(new Error(`请求超时: ${method}`));
			}, REQUEST_TIMEOUT_MS);

			// 发送 POST 请求（不等待响应，响应通过 SSE 流推送）
			fetch(this.sseMessageEndpoint!, {
				method: 'POST',
				headers,
				body: JSON.stringify(request),
			}).then(response => {
				if (!response.ok) {
					clearTimeout(timeoutId);
					this.ssePendingRequests.delete(id);
					response.text().then(text => {
						reject(new Error(`MCP HTTP error ${response.status}: ${text}`));
					});
				}
				// 注意：响应体通过 SSE 流接收，这里不读取响应体
			}).catch(e => {
				clearTimeout(timeoutId);
				this.ssePendingRequests.delete(id);
				reject(e);
			});

			// 在原始 Promise 上包装 clearTimeout
			const originalResolve = resolve;
			const originalReject = reject;
			this.ssePendingRequests.set(id, {
				resolve: (v) => { clearTimeout(timeoutId); originalResolve(v); },
				reject: (e) => { clearTimeout(timeoutId); originalReject(e); },
			});
		});
	}

	/**
	 * 通过 Streamable HTTP 发送请求（原有实现）
	 */
	private async sendRequestViaStreamableHttp<T>(id: number, method: string, params: any): Promise<T> {
		const request: JsonRpcRequest = {
			jsonrpc: '2.0',
			method,
			params,
			id,
		};

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			...this.config.headers,
		};

		if (this.sessionId) {
			headers['mcp-session-id'] = this.sessionId;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		try {
			const response = await fetch(this.config.url, {
				method: 'POST',
				headers,
				body: JSON.stringify(request),
				signal: controller.signal,
			});

			// 从响应头中提取 session ID
			const newSessionId = response.headers.get('mcp-session-id');
			if (newSessionId) {
				this.sessionId = newSessionId;
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`MCP HTTP error ${response.status}: ${errorText}`);
			}

			const contentType = response.headers.get('content-type') || '';

			if (contentType.includes('text/event-stream')) {
				// SSE 流式响应
				return await this.parseSSEResponse<T>(response, id);
			} else {
				// 普通 JSON 响应
				const jsonResponse: JsonRpcResponse = await response.json();
				return this.extractResult<T>(jsonResponse, method);
			}
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * 发送 JSON-RPC 通知（无响应）
	 */
	private async sendNotification(method: string, params: any): Promise<void> {
		const notification = {
			jsonrpc: '2.0',
			method,
			params,
		};

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			...this.config.headers,
		};

		if (this.useSseTransport) {
			// SSE 传输：POST 到消息端点
			if (this.sseMessageEndpoint) {
				try {
					await fetch(this.sseMessageEndpoint, {
						method: 'POST',
						headers,
						body: JSON.stringify(notification),
					});
				} catch {
					// 通知失败不影响主流程
				}
			}
		} else {
			// Streamable HTTP 传输
			if (this.sessionId) {
				headers['mcp-session-id'] = this.sessionId;
			}
			try {
				await fetch(this.config.url, {
					method: 'POST',
					headers,
					body: JSON.stringify(notification),
				});
			} catch {
				// 通知失败不影响主流程
			}
		}
	}

	/**
	 * 解析 SSE 流式响应（Streamable HTTP 专用），找到匹配 id 的消息
	 */
	private async parseSSEResponse<T>(response: Response, targetId: number | string): Promise<T> {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// 解析 SSE 事件（以 \n\n 分隔）
				const events = buffer.split('\n\n');
				buffer = events.pop() || '';

				for (const eventText of events) {
					const { eventType, data } = this.parseSseEvent(eventText);

					if (eventType === 'message' && data) {
						try {
							const jsonResponse: JsonRpcResponse = JSON.parse(data);
							if (jsonResponse.id === targetId) {
								return this.extractResult<T>(jsonResponse, '');
							}
						} catch {
							// 忽略解析失败的事件
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		throw new Error('SSE 流结束但未收到匹配的响应');
	}

	/**
	 * 从 JSON-RPC 响应中提取结果
	 */
	private extractResult<T>(response: JsonRpcResponse, method: string): T {
		if (response.error) {
			throw new Error(`MCP 错误 (${method}): [${response.error.code}] ${response.error.message}`);
		}
		return response.result as T;
	}

	/**
	 * 重置连接状态
	 */
	reset(): void {
		// 标记主动关闭：cancel(reader) 会让 reading loop 走到 done，
		// 但 closing=true 时 finally 不会触发 onClose（避免主动断开被当成意外断线去重连）
		this.closing = true;
		this.sseClosed = true;   // 主动关闭，handleSseClose 不再触发重连
		this.initialized = false;
		this.sessionId = undefined;
		this.requestId = 0;
		this.sseMessageEndpoint = undefined;
		this.sseHeadersParsed = false;
		this.sseChunkText = '';
		if (this.sseSocket) {
			try { this.sseSocket.destroy(); } catch { /* ignore */ }
			this.sseSocket = undefined;
		}
		this.ssePendingRequests.clear();
	}
}
