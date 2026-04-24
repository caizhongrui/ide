# maxian-vscode

VS Code 官方插件形态（占位）。

## 状态

🚧 **占位阶段**。N 期完成（core 清理 / @maxian/ui 可用 / 协议版本化）后开工。

## 设计

- Webview 复用 `@maxian/ui`（Solid）
- 启动 `@maxian/server` sidecar（复用 Desktop 同一二进制）或 in-proc 使用 `VSCodePlatform`
- 详见 `docs/architecture/overview.md` § 5.3
