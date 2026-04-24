# HTTP API 规格

`@maxian/server` 提供的所有 HTTP 路由清单。**这是客户端与服务端之间唯一的真相源**。

## 0. 协议版本化

每个请求必须带 header：

```
X-Maxian-Protocol: 1
```

- 当前版本：`1`（基线）
- Server 端 middleware 校验：缺失或不匹配返回 `426 Upgrade Required` + `{ error: 'protocol_mismatch', serverVersion: 1, yours: <version|null> }`
- 变更记录：见 [`docs/protocol/CHANGELOG.md`](../protocol/CHANGELOG.md)

## 1. 路由分组

### 1.1 健康 / 鉴权 / 配置

| Method | Path | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回 `{ status, serverProtocol, version }` |
| POST | `/auth/configure` | 配置 AI 凭据 |
| DELETE | `/auth/configure` | 清除凭据 |
| GET | `/auth/status` | 凭据状态 |
| GET | `/config/:key` | 读配置 |
| PUT | `/config/:key` | 写配置 |

### 1.2 会话

| Method | Path | 说明 |
|---|---|---|
| GET | `/sessions` | 列出会话 |
| POST | `/sessions` | 创建会话 |
| GET | `/sessions/:id` | 会话详情 |
| DELETE | `/sessions/:id` | 删除会话（清 FileTime）|
| GET | `/sessions/:id/messages` | 历史消息 |
| POST | `/sessions/:id/messages` | 发送消息 |
| GET | `/sessions/:id/events` | **SSE 订阅**（详见 [sse-events.md](./sse-events.md)）|
| POST | `/sessions/:id/cancel` | 取消当前任务 |
| POST | `/sessions/:id/compact` | 手动压缩上下文 |
| POST | `/sessions/:id/fork` | 分叉会话 |
| POST | `/sessions/:id/approve` | 工具审批回应 |
| POST | `/sessions/:id/revert` | 文件撤销（快照回滚）|
| GET | `/sessions/:id/changed-files` | 变更文件列表 |
| GET | `/sessions/:id/file-diff` | 查看某文件 diff |
| DELETE | `/sessions/:id/messages/:messageId` | 删除单条消息 |
| POST | `/sessions/:id/messages/:messageId/regenerate` | 重新生成 |
| POST | `/sessions/:id/messages/:messageId/fork` | 从消息点分叉 |

### 1.3 工作区

| Method | Path | 说明 |
|---|---|---|
| GET | `/workspaces` | 列出工作区 |
| POST | `/workspaces` | 新建工作区 |
| DELETE | `/workspaces/:id` | 删除工作区 |
| GET | `/workspaces/:id/files` | 文件树 |
| GET | `/workspaces/:id/file-content` | 文件内容 |
| POST | `/workspaces/:id/file-write` | 写入文件 |
| GET | `/workspaces/:id/file-stat` | 文件元信息 |
| GET | `/workspaces/:id/project-config` | 项目配置 |
| GET | `/workspaces/:id/symbols` | LSP 符号 |
| GET | `/workspaces/:id/skills` | Skills 列表 |
| GET | `/workspaces/:id/worktrees` | Git worktrees |

### 1.4 工具

| Method | Path | 说明 |
|---|---|---|
| GET | `/tools` | 列出可用工具 |
| POST | `/tools/invoke` | 直接调用工具（非会话上下文）|

## 2. 认证

- 本地 sidecar 模式：无认证（仅 localhost 绑定）
- 云端模式：`Authorization: Bearer <token>` + 多租户 header

## 3. 错误响应统一格式

```json
{
  "error": "code_string",
  "message": "人类可读描述",
  "details": { /* 可选 */ }
}
```

常见 code：
- `protocol_mismatch` - 协议版本不匹配（426）
- `unauthorized` - 未授权（401）
- `forbidden` - 禁止访问（403）
- `not_found` - 资源不存在（404）
- `quota_exceeded` - 配额超限（429，云端）
- `internal_error` - 服务端错误（500）

## 4. 完整 Schema（TODO）

每个路由的 request / response 详细 schema 待用 Zod 定义，放在 `packages/shared-types/src/http-schemas/`，由 server 和 sdk 共用。
