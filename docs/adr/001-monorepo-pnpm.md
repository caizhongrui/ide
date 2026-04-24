# ADR-001: Monorepo with pnpm workspaces

- 状态：Accepted
- 日期：2026-04-24

## 背景

本项目由 6 种客户端形态（Desktop / 码弦IDE / VSCode 插件 / IDEA 插件 / Web / 云端）共享 5 个库包（core / server / sdk / ui / worker）。需要选择仓库组织方式。

## 决策

采用 **pnpm workspaces** 作为 monorepo 方案。

仓库结构：
- `packages/` — 库
- `apps/` — 可发布形态
- `tools/` — 构建工具
- `third-party/` — 外部 fork (submodule)

## 考虑过的替代

- **Turborepo**：增量构建、远程缓存有优势，但当前 tsc 未到瓶颈；等真的慢了再上
- **Nx**：功能最强，但复杂度溢出
- **多仓库**：每包独立 repo，发布简单但跨包改动需要 PR 链路，对内部迭代效率差

## 理由

- pnpm workspace 已在上一代 monorepo 验证稳定
- `workspace:*` 协议简洁
- catalog 统一依赖版本避免漂移
- 生态工具（changesets、pnpm pack）成熟

## 影响

- 每个包必须有 `package.json`
- 根 `package.json` 通过 `scripts` 暴露聚合命令
- 新增包需同步更新 `pnpm-workspace.yaml` 的 `packages` 通配模式能覆盖到
