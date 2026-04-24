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
