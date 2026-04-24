# 迁移笔记

## 迁移信息

- **日期**：2026-04-24
- **源仓库**：`/Users/caizhongrui/Documents/workspace/boyo/plugin/`
  - GitHub：`git@github.com:caizhongrui/maxian-desktop.git`（main 分支）
- **目标仓库**：`/Users/caizhongrui/Documents/workspace/production/ide/`（本仓）
- **策略**：D1-A / D2-A / D3-A / D4-A / D5-A（见 [架构总览](./architecture/overview.md)）

## 已迁移

| 旧位置 | 新位置 | 说明 |
|---|---|---|
| `plugin/maxian-core/` | `packages/core/` | 完整复制（排除 node_modules/dist/.git） |
| `plugin/maxian-server/` | `packages/server/` | 完整复制 |
| `plugin/maxian-sdk/` | `packages/sdk/` | 完整复制 |
| `plugin/maxian-desktop/` | `apps/desktop/` | 完整复制（含 src-tauri/） |
| `plugin/ide/src/tianhe-zhikai-ide/` | `third-party/tianhe-zhikai-ide/` | 本地 rsync 拷贝（保留 `.git/`，排除 `node_modules/`、`.build/`、`out/`、`.git/lfs/`、`.git/worktrees/`）。独立 git repo，主仓 `.gitignore` 排除。分支：`feature/solo-mode-editor-pane`。决策见 [ADR-005](./adr/005-third-party-as-local-copy.md) |

## 新增（占位）

- `packages/ui/` — `@maxian/ui` 跨形态 UI 组件库
- `packages/worker/` — `@maxian/worker` 云端任务执行
- `packages/shared-types/` — `@maxian/shared-types` 跨包类型
- `apps/vscode-extension/` — VS Code 官方插件（占位）
- `apps/idea-plugin/` — IntelliJ 插件（占位）
- `apps/web/` — Web 客户端（占位）
- `apps/cloud/` — 云端控制台（占位）
- `tools/build-sidecar/`、`tools/make-dmg/`、`tools/protocol-check/` — 构建工具（占位）
- `docs/` — 完整架构文档

## 旧仓封存建议

旧 `plugin/` 目录不只含 maxian 系列，还包含多个并行项目（`auto_query`、`codeHepler`、`demo*`、`qdport-ai` 等），所以**不建议在 plugin/ 根下添加全局 README**。

推荐操作（由用户自行执行）：

### 方案一：旧仓 GitHub description 标记

在 `https://github.com/caizhongrui/maxian-desktop` 的 repo 设置中：
- Description 改为：`[ARCHIVED 2026-04-24] 已迁移至 caizhongrui/maxian-monorepo，此仓库只读`
- Settings → General → Archive this repository

### 方案二：本地目录内各包添加 MIGRATED.md

手动在以下四个目录各放一个 `MIGRATED.md`：
- `plugin/maxian-core/MIGRATED.md`
- `plugin/maxian-server/MIGRATED.md`
- `plugin/maxian-sdk/MIGRATED.md`
- `plugin/maxian-desktop/MIGRATED.md`

内容建议：

```markdown
# 已迁移

本包已于 2026-04-24 迁移至：
`/Users/caizhongrui/Documents/workspace/production/ide/{packages|apps}/<name>/`

GitHub：`git@github.com:caizhongrui/maxian-monorepo.git`（新仓库 URL 待定）

此处保留为只读存档，请到新仓库提交改动。
```

### 方案三：什么都不做

本地 plugin/ 作为工作副本，用户自行管理。只要 GitHub 上的旧仓被 Archived 即可。

## 未同步项

- **Git 历史**：按 D2-A，新仓 `git init` 从 0 开始。旧仓 `caizhongrui/maxian-desktop.git` 保留全量历史作为存档。
- **node_modules**：未复制，新仓需 `pnpm install` 重建。
- **Rust target/**：未复制，`apps/desktop/src-tauri/target/` 首次构建会重建。
- **Bun sidecar 产物**：未复制，`packages/server/bin/` 和 `apps/desktop/bin/` 首次构建会重建。

## 回退方案

如果迁移出现问题：
1. 旧仓 `plugin/` 未被改动，直接 `cd plugin/maxian-desktop && pnpm install && pnpm tauri:dev` 即可恢复工作
2. 删除 `production/ide/` 整个目录即可放弃迁移
