# `@maxian/ui` 组件库设计

跨形态 UI 组件。Desktop / 码弦IDE / VS Code 插件 / IDEA 插件（JCEF）/ Web 共享。

## 1. 包结构

```
packages/ui/
├── package.json         # 仅 peer 依赖 solid-js
├── src/
│   ├── index.ts
│   ├── components/
│   │   ├── MessageList.tsx         # 流式消息列表
│   │   ├── MessageBubble.tsx       # 单条消息气泡
│   │   ├── ToolCallCard.tsx        # 工具调用卡片分发器
│   │   ├── tool-renders/           # 每种工具一个视图
│   │   │   ├── ReadFileView.tsx
│   │   │   ├── EditView.tsx        # diff 展示
│   │   │   ├── BashView.tsx        # xterm 风格终端输出
│   │   │   ├── TodoView.tsx
│   │   │   └── ...
│   │   ├── ApprovalDialog.tsx
│   │   ├── TokenUsageBar.tsx
│   │   ├── FileChangeTree.tsx
│   │   ├── SlashCommandPalette.tsx
│   │   ├── DiffViewer.tsx
│   │   ├── TerminalPanel.tsx
│   │   └── WorkspaceSwitcher.tsx
│   ├── hooks/
│   │   ├── useSseSubscription.ts
│   │   ├── useTokenUsage.ts
│   │   └── useApprovalQueue.ts
│   ├── stores/
│   │   ├── messagesStore.ts
│   │   └── sessionStore.ts
│   └── styles/
│       └── base.css
```

## 2. 设计约束

- **零全局副作用** — 不调 fetch、不读 localStorage、不依赖 Tauri API
- **Props 驱动** — 所有数据/操作通过 props + callback
- **可主题化** — CSS variables，consumer 覆写

### 组件 API 示例

```tsx
export interface MessageListProps {
  messages: ChatMessage[];
  onRegenerate?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  renderToolCall?: (call: ToolCall) => JSX.Element;
}

export function MessageList(props: MessageListProps): JSX.Element;
```

## 3. Desktop 渐进迁移计划

`apps/desktop/src/App.tsx`（~8534 行）按 5 个 PR 切片：

| PR | 迁移内容 | 预估行数 |
|---|---|---|
| PR-1 | MessageList + MessageBubble + ToolCallCard | ~3000 |
| PR-2 | ApprovalDialog + SlashCommandPalette + FileChangeTree | ~1500 |
| PR-3 | TokenUsageBar + DiffViewer + TerminalPanel | ~1200 |
| PR-4 | hooks + stores | ~1000 |
| PR-5 | App.tsx 瘦身收尾 | 剩余 < 2000 |

每 PR 完成后 `apps/desktop` 必须**视觉零回归** + `docs/regression-checklist.md` 全过。

## 4. 不同 Webview 兼容性

| 宿主 | Webview 运行时 | 兼容性 |
|---|---|---|
| Tauri | 系统 Webview (WebKit macOS / WebView2 Windows) | ✅ 已验证 |
| VSCode Webview | Chromium (Electron 内) | ✅ 需配 CSP nonce |
| IDEA JCEF | Chromium (捆绑) | ✅ 需 POC 验证 Solid 打包产物 |
| 浏览器 | 任意 | ✅ |

所有目标都支持 ES2022，Solid 运行无障碍。
