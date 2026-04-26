# Changelog

本仓库聚合变更日志。各形态具体发布见 GitHub Releases（按 tag 前缀区分）。

协议变更见 [docs/protocol/CHANGELOG.md](./docs/protocol/CHANGELOG.md)。

---

## Unreleased

### desktop v0.2.11 (2026-04-26)
- 修复任务清单卡 X/Y 永不完成（AI 提前结束未收尾 todos） — `2c22d25`
  - 后端 HARD RULES 加第 8 条：attempt_completion 前必须收尾 todos
  - 前端兜底显示橙色警告徽章 "⚠ AI 提前结束，N 项未收尾"
  - TodoItem 支持 `cancelled` 状态
- 修复切换会话时右侧"文件变更"面板始终为空 — `f092946`
  - 切会话时异步从 `/sessions/:id/changed-files` 拉历史
  - 防竞态：用 `activeSessionId()` 校验
- 修复设置面板会话 token 用量都显示 0 — `990d9a3`
  - `runAgentLoop` 末尾把本轮 input/output tokens 累加到 `sessions` 表
  - 仅对新会话和未来对话生效，历史会话仍为 0（独立任务可回填）

### CI / 工具
- CI typecheck 前先 build:libs，修复 GitHub Actions 上 "Cannot find module @maxian/core" — `8e3a85f`

### 架构重组
- 从 `plugin/` monorepo 整仓迁移到 `production/ide/` 新结构
- 按 `packages/` (库) / `apps/` (产品) / `tools/` (构建) / `docs/` (文档) / `third-party/` (外部 fork submodule) 分层
- 新增占位包：`@maxian/ui`、`@maxian/worker`、`@maxian/shared-types`
- 新增占位形态：`vscode-extension`、`idea-plugin`、`web`、`cloud`
- 码弦IDE 改为 git submodule 引入，仅保留 `feature/solo-mode-editor-pane` 分支

### 文档体系
- 新建 `docs/architecture/` 共 6 篇架构文档
- 新建 `docs/protocol/` 协议版本化规范
- 新建 `docs/adr/` 4 条架构决策记录
- 新建 `docs/regression-checklist.md` 回归测试清单

### 已迁移（无行为变化）
- `@maxian/core` v0.1.0
- `@maxian/server` v0.1.0
- `@maxian/sdk` v0.1.0
- `@maxian/desktop` v0.2.10

---

## 历史

v0.2.x 及之前的发布记录保留在原仓库：
https://github.com/caizhongrui/maxian-desktop/releases
