# Maxian — 码弦 AI 开发平台

多形态 AI 编程助手 monorepo。共享一套 `@maxian/core` agent + 工具链，向多种客户端形态分发。

## 仓库布局

```
production/ide/
├── packages/            库包（给其他包 import）
│   ├── core             @maxian/core          核心 agent + 工具
│   ├── server           @maxian/server        HTTP + SSE 服务（sidecar）
│   ├── sdk              @maxian/sdk           HTTP 客户端
│   ├── ui               @maxian/ui            跨形态 UI 组件（占位）
│   ├── worker           @maxian/worker        云端任务执行（占位）
│   └── shared-types     @maxian/shared-types  跨包类型（占位）
├── apps/                最终产品形态
│   ├── desktop          Tauri 桌面客户端
│   ├── vscode-extension VS Code 官方插件（占位）
│   ├── idea-plugin      IntelliJ IDEA 插件（占位，Kotlin）
│   ├── web              浏览器 Web 客户端（占位）
│   └── cloud            云端控制台 + API 网关（占位）
├── tools/               构建工具
├── docs/                架构文档
└── third-party/        外部 fork（本地副本，不被主仓追踪）
    └── tianhe-zhikai-ide  码弦IDE（VS Code fork，独立 git repo）
```

## 开发

```bash
# 安装依赖
pnpm install

# 类型检查
pnpm typecheck

# 构建所有库包
pnpm build:libs

# 启动桌面客户端
pnpm desktop:dev
```

## 形态状态

| 形态 | 状态 | 说明 |
|---|---|---|
| Desktop (Tauri) | ✅ 已上线 v0.2.10 | 主力客户端 |
| 码弦IDE (VSCode fork) | ✅ 已上线 | 独立 git repo（`third-party/`） |
| VSCode 插件 | 🚧 占位 | 架构就绪，等待开工 |
| IDEA 插件 | 🚧 占位 | sidecar 模式，架构就绪 |
| Web | 🚧 占位 | 依赖云端 |
| 云端自主模式 | 🚧 占位 | 多租户 + 任务队列 |

## 文档

- [架构总览](./docs/architecture/overview.md)
- [平台抽象契约](./docs/architecture/platform-contract.md)
- [HTTP API 规格](./docs/architecture/http-api.md)
- [SSE 事件规格](./docs/architecture/sse-events.md)
- [UI 组件库设计](./docs/architecture/ui-package.md)
- [云端模式设计](./docs/architecture/cloud-design.md)
- [发布流水线](./docs/architecture/release-pipeline.md)
- [回归测试清单](./docs/regression-checklist.md)
- [协议变更日志](./docs/protocol/CHANGELOG.md)
- [架构决策记录 (ADR)](./docs/adr/)

## 历史

本仓库由 `boyo/plugin/` monorepo 于 2026-04-24 重构迁入。旧仓库保留为只读存档。
