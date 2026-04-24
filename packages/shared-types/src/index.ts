/*---------------------------------------------------------------------------------------------
 *  @maxian/shared-types — 跨包共享类型入口
 *
 *  用途：同时被 @maxian/core、@maxian/server、@maxian/sdk、@maxian/ui 引用的类型。
 *  例如：协议版本号、SSE 事件 discriminated union、HTTP schema 等。
 *--------------------------------------------------------------------------------------------*/

/** 当前协议版本 — 客户端在 HTTP header `X-Maxian-Protocol` 中声明 */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// 后续添加：
// export type * from './sse-events.js';
// export type * from './http-schemas.js';
// export type * from './tenant.js';
