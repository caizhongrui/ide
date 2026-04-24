# tools/protocol-check

协议版本一致性检查器（占位）。

## 状态

🚧 **未实现**。

## 设计

- 扫描 `@maxian/server` 代码中所有 SSE `emit` 调用，提取 event type
- 对照 `docs/architecture/sse-events.md` 验证无漏、无多
- 扫描 HTTP 路由，对照 `docs/architecture/http-api.md`
- 在 CI 中强制运行：协议与文档漂移 = CI 失败
