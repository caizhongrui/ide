# @maxian/ui

跨形态 UI 组件库。Desktop / VS Code 插件 / IDEA 插件（JCEF） / Web 共享使用。

## 状态

🚧 **占位阶段** — 尚未包含任何组件。组件将从 `apps/desktop/src/App.tsx`（~8500 行）逐步拆出迁入。

## 设计约束

- 仅依赖 `solid-js`（peer dependency）
- 不依赖 `@tauri-apps/*`、`vscode`、任何宿主特定 API
- 所有数据通过 props 传入、所有操作通过 callback 外抛
- 主题通过 CSS variables，consumer 可覆写

## 迁移计划

见 `docs/architecture/ui-package.md`。

按 PR 粒度渐进迁移（约 5 次 PR）：

1. `MessageList` + `MessageBubble` + `ToolCallCard`
2. `ApprovalDialog` + `SlashCommandPalette` + `FileChangeTree`
3. `TokenUsageBar` + `DiffViewer` + `TerminalPanel`
4. hooks + stores
5. App.tsx 瘦身收尾
