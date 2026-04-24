# maxian-web

浏览器 Web 客户端形态（占位）。

## 状态

🚧 **占位阶段**。依赖 `apps/cloud/` 上线后才能部署。

## 设计

- Vite + Solid 项目，复用 `@maxian/ui`
- 通过 `@maxian/sdk` 对接云端 `apps/cloud/`（HTTP + SSE）
- 浏览器无直接文件系统访问 — 所有文件 IO 经云端 `BrowserPlatform` 远程代理
- 详见 `docs/architecture/overview.md` § 5.4
