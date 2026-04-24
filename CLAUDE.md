# Claude/AI 开发规约

## 基本原则

- 不要随意创建简化版本，没有我的要求，你就要按照完整功能进行
- 不要在乎用了多少 token
- 不要自己创意，讨价还价
- 出现问题不要随意回退或者删除文件
- 任何功能不能简化，不怕时间长
- 不要因为时间或者token问题创建简化版本，必须实现完整版本

## 参考基线

- 每个功能开发时，参照 kilocode 源代码，保持一致，尤其提示词及前端 UI 的显示逻辑
- 对标 OpenCode 做代码生成质量/效率对比

## 架构纪律

- 新增功能前先读 `docs/architecture/` 下对应的设计文档
- `@maxian/core` 严禁直接 import `vscode` / `fs` / `child_process`，必须走 `interfaces/`
- 所有 HTTP 路由变更必须同步更新 `docs/architecture/http-api.md` 和 `docs/protocol/CHANGELOG.md`
- 所有 SSE 事件变更必须同步更新 `docs/architecture/sse-events.md`
- 跨形态 UI 组件放在 `packages/ui/`，不要放 `apps/desktop/src/` 里

## 重构纪律

- 一次重构只改一件事，PR 可独立合并/回退
- 每次变更后必须跑通 `docs/regression-checklist.md`
- 协议版本号 `X-Maxian-Protocol` 任何破坏性改动都要 bump major 并留至少 90 天向后兼容期

## 本仓历史

- 2026-04-24：由 `boyo/plugin/` 迁入
- 码弦IDE 源码在 `third-party/tianhe-zhikai-ide/`（本地独立 git repo，主仓不追踪；初始化见 `third-party/README.md`）
