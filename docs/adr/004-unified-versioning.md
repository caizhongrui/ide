# ADR-004: 采用统一联动版本（D5-A）

- 状态：Accepted
- 日期：2026-04-24

## 背景

6 种客户端形态 + 5 个库包共存的 monorepo 需要确定版本号策略：
- (A) 统一联动：所有包版本号同步
- (B) 独立 semver：各包按自身 semver 演进

## 决策

采用 **(A) 统一联动**。

## 理由

1. **架构未稳定**：N/M 期将持续有跨包破坏性改动，独立 semver 会产生大量版本协调工作
2. **内部使用为主**：目前所有包的消费者都在本仓内，不存在外部 consumer 解耦需求
3. **协议版本分离**：`X-Maxian-Protocol` header 独立于包版本，真正的兼容契约由它承载，包版本只是发布批次编号
4. **发布简单**：一次 bump、一次 tag、一次发布

## 切换条件（未来从 A → B）

当以下所有条件满足时，考虑切换到独立 semver：

- `@maxian/sdk` 有外部发布需求（比如给 IDEA 插件开发者复用）
- `@maxian/core` 稳定度高，半年内无 breaking
- 引入 changesets 工具链管理独立版本

## 影响

- 根 `package.json` version 是"正式版本号"
- 各子包 `package.json` version 保持同步（通过脚本/CI 校验，避免手动漂移）
- CHANGELOG 在根仓一份即可（`/CHANGELOG.md`）
- Tag 按形态分前缀（`desktop-v*`、`ide-v*`、`sidecar-v*` 等），见 [release-pipeline.md](../architecture/release-pipeline.md)
