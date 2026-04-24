# 架构总览

> 多形态客户端架构的全景图。读完这一篇，你应该知道哪些代码放在哪个包、向哪个方向演进。

## 1. 形态矩阵

| # | 形态 | 位置 | 状态 | 消费方式 |
|---|---|---|---|---|
| 1 | Desktop (Tauri) | `apps/desktop/` | ✅ v0.2.10 | sidecar HTTP |
| 2 | 码弦IDE (VSCode fork) | `third-party/tianhe-zhikai-ide/` (本地独立 git repo) | ✅ 已上线 | in-process |
| 3 | VSCode 官方插件 | `apps/vscode-extension/` | 🚧 占位 | sidecar HTTP 或 in-process（待决） |
| 4 | IDEA 插件 | `apps/idea-plugin/` | 🚧 占位 | sidecar HTTP（强制，跨语言） |
| 5 | Web | `apps/web/` | 🚧 占位 | 远程 HTTP（云端） |
| 6 | 云端自主模式 | `apps/cloud/` + `packages/worker/` | 🚧 占位 | 队列驱动 |

## 2. 共享层（包）

```
apps/*
  └─→ @maxian/ui（跨形态 UI 组件）
       └─→ @maxian/sdk（HTTP + SSE 客户端）
            └─→ @maxian/server（HTTP + SSE 服务，sidecar 或 in-proc）
                 └─→ @maxian/core（agent + 工具，依赖 interfaces/）
                      └─→ Platform Adapter（每形态一个）
```

- `@maxian/shared-types` 提供跨包类型，被上面每一层按需引用
- `@maxian/worker` 消费 `@maxian/core` + 任务队列，云端专用

## 3. Platform Adapter

`@maxian/core` 通过 `MaxianPlatform` 接口与宿主交互。每种形态提供一个实现：

| Adapter | 位置 | 实现方式 |
|---|---|---|
| `NodePlatform` | `packages/core/src/adapters/` | Desktop sidecar / 云端 worker 共用 |
| `TauriPlatform` | `apps/desktop/` | 实际走 HTTP → sidecar NodePlatform |
| `VSCodePlatform` | `third-party/tianhe-zhikai-ide/` + `apps/vscode-extension/` | in-proc，桥到 vscode API |
| `BrowserPlatform` | `apps/web/` + `apps/cloud/` | 浏览器 UI 壳 + 云端 Node 执行 |
| `IDEAPlatform` | `apps/idea-plugin/` | sidecar HTTP，Kotlin 启动进程 |
| `CloudWorkerPlatform` | `packages/worker/` | NodePlatform + 多租户沙箱 |

## 4. 关键纪律

1. **`@maxian/core` 严禁**直接 import `vscode` / `fs` / `child_process` — 全走 `interfaces/`
2. **apps/** 是最终产品，**packages/** 是库 — 双向不能反
3. **打包版本**与**协议版本**分离
   - `package.json` 的 version 跟各包 feature 迭代
   - `X-Maxian-Protocol` header 只在破坏性协议改动时 bump
4. **第三方 fork** 放 `third-party/` 作为本地独立 git repo，主仓 `.gitignore` 排除（见 [ADR-005](../adr/005-third-party-as-local-copy.md)）
5. 所有跨包 API 变更必须同步文档（`docs/architecture/` + `docs/protocol/CHANGELOG.md`）

## 5. 当前耦合热点（N 期待清理）

| 热点 | 位置 | 影响 |
|---|---|---|
| Core 工具直接调 `fs.*Sync` 约 50 处 | `packages/core/src/tools/*.ts` | Web / IDEA 形态接入会炸 |
| Desktop UI 单文件巨石 8534 行 | `apps/desktop/src/App.tsx` | VS Code / IDEA / Web 无法复用 |
| 码弦IDE 工具双份实现 | `third-party/.../contrib/maxian/common/tools/` | core 升级无法同步到 IDE |
| HTTP 协议无版本号 | `packages/server/` | 客户端/服务端漂移必炸 |

详细治理方案见 [整改路线图 (ADR-003)](../adr/003-refactor-roadmap.md)。
