# 协议变更日志

`@maxian/server` HTTP + SSE 协议版本变更历史。

协议版本通过 `X-Maxian-Protocol` header 声明。任何破坏性改动必须 bump major 并保留至少 90 天向后兼容期。

---

## v1（基线） — 2026-04-24

初始基线，定义：

- 35 个 HTTP 路由（见 [http-api.md](../architecture/http-api.md)）
- 19 种 SSE 事件（见 [sse-events.md](../architecture/sse-events.md)）
- `X-Maxian-Protocol: 1` header 约定

此时 middleware **只记录不拒绝** 协议版本不匹配。

---

## v1.1（minor）— 2026-05-12

**新增 SSE 事件**：`workspace_files_changed`

- 由 server 端 chokidar 文件系统 watcher 100ms 时窗合并后广播
- 广播粒度：所有当前激活、`workspacePath` 匹配的 session 订阅者（不绑 sessionId）
- 字段：`{ type: 'workspace_files_changed', workspaceId, added: string[], removed: string[] }`
- 路径形态：工作区相对路径（与 `GET /workspaces/:id/files` 一致）
- 过滤：与 `listFiles()` 的 IGNORED_DIRS 一致（node_modules / dist / dotfiles 等不上报）
- 向后兼容：旧客户端按"静默丢弃未知事件"规则忽略，无影响

事件清单从 19 种变为 20 种。详见 [sse-events.md#45](../architecture/sse-events.md)。

---

## 变更规则

| 变更类型 | 行动 |
|---|---|
| 新增路由 / 新增事件类型 | minor（可选补全 schema） |
| 新增可选字段 | minor |
| 字段重命名 / 字段删除 / 字段类型改变 | major + 90 天兼容期 |
| 路由语义改变 | major |
| 心跳间隔改变 | major |

每次改动必须：
1. 在本文件追加一条记录（版本号 + 日期 + 具体改动）
2. 更新 `docs/architecture/http-api.md` 或 `sse-events.md`
3. 如果是 major：server 同时支持新旧两个版本直到 deprecation 结束
