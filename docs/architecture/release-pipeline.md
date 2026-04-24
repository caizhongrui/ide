# 发布与打包流水线

## 1. 产物矩阵

| 形态 | 产物 | 签名 | 渠道 | CI 触发 |
|---|---|---|---|---|
| Desktop | `.dmg` / `.msi` / `.AppImage` | macOS Developer ID / Windows EV | GitHub Releases + `releases.maxian.ai/update/` | tag `desktop-v*` |
| 码弦IDE | VS Code 全量产物 | 同上 | 官网 + 自建 update server | tag `ide-v*` |
| VSCode 插件 | `.vsix` | VS Marketplace | VS Marketplace + Open VSX | tag `vsce-v*` |
| IDEA 插件 | `.zip` | JetBrains Marketplace | Marketplace | tag `idea-v*` |
| maxian-server sidecar | Bun 单文件 × 4 平台 | 同 Desktop | GitHub Releases (sidecar-v*) | tag `sidecar-v*` |
| Cloud | Docker 镜像 `maxian/cloud:x.y.z` | Docker Content Trust | 私有 registry + K8s | main push |
| Worker | Docker 镜像 `maxian/worker:x.y.z` | 同上 | 同上 | main push |

## 2. Sidecar 二进制共享策略

**一次构建、多处打包**：

- `tools/build-sidecar/compile.mjs` 产出 4 平台 binary
- 独立 CI workflow `release-sidecar.yml` 在 `sidecar-v*` tag 时构建并上传 GitHub Release
- Desktop / IDEA / (可选) VSCode 插件的 CI **下载**而非**构建** sidecar

避免 4 平台 × N 形态的构建组合爆炸。

## 3. 版本号策略

### D5-A 统一联动（当前采用）

- 所有包 `package.json` 版本号同步 bump
- 协议版本 `X-Maxian-Protocol` 独立，仅在 breaking 改动时 bump major

### 未来切换到 D5-B 独立 semver（条件）

当某个包稳定、外部使用者开始出现时，才切换。切换前必须：
- 每个包有独立 `CHANGELOG.md`
- CI 自动化检测 workspace 包间版本兼容（如 `@maxian/sdk@2` 要求 `@maxian/server@2+`）

## 4. 版本兼容矩阵

| Client \ Server | server@1.x | server@2.x |
|---|---|---|
| sdk@1.x | ✅ | ❌（426）|
| sdk@2.x | ⚠️ minor 字段缺失可降级 | ✅ |

服务器侧保留最近 **2 个 major** 版本兼容；破坏性改动必须先发 deprecation warning ≥ 90 天。

## 5. 回滚策略

- GitHub Releases 保留所有历史版本
- 自建 update server 可回滚到任意历史版本（运维面板）
- Docker 镜像保留最近 20 个 tag

## 6. 核心 CI 工作流

| Workflow | 触发 | 作用 |
|---|---|---|
| `ci.yml` | 每个 PR | `pnpm typecheck` + `pnpm lint` |
| `release-sidecar.yml` | tag `sidecar-v*` | 4 平台 Bun 单文件构建上传 |
| `release-desktop.yml` | tag `desktop-v*` | macOS(arm64/x64) / Win / Linux 打包 |
| `release-ide.yml` | tag `ide-v*` | 码弦IDE 全量打包 |
| `release-vsce.yml` | tag `vsce-v*` | VSIX 发布 |
| `release-idea.yml` | tag `idea-v*` | JetBrains plugin 发布 |
| `release-cloud.yml` | main push（或 tag `cloud-v*`）| Docker 镜像推送 |
