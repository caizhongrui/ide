/*---------------------------------------------------------------------------------------------
 *  @maxian/ui — 跨形态 UI 组件库入口
 *
 *  该包作为占位建立。组件将从 apps/desktop/src/App.tsx 逐步抽取迁入。
 *  设计详见：docs/architecture/ui-package.md
 *--------------------------------------------------------------------------------------------*/

export const PACKAGE_NAME = '@maxian/ui';
export const PACKAGE_VERSION = '0.3.0';

// 组件（Solid）
export * from './components/index.js';

// Solid 挂载入口（封装 solid-js/web.render，consumer 无需直接依赖 solid-js）
export * from './mount.js';

// Solid reactive 原语 re-export
// 让无法 bare specifier 解析 solid-js 的宿主（vscode renderer 等）
// 也能从本包统一入口拿到 createSignal/createMemo/createEffect 等。
// solid-js 已在 vite library bundle 里 inline，这些 export 在 dist/index.js 内绑定。
export {
	createSignal,
	createMemo,
	createEffect,
	createRoot,
	onCleanup,
	batch,
	untrack,
	Show,
	For,
} from 'solid-js';
export type { Accessor, Setter, Signal, JSX } from 'solid-js';

// TODO: 后续按抽取顺序加入
// export * from './components/MessageList.js';
// export * from './components/ToolCallCard.js';
// export * from './components/TokenUsageBar.js';
// export * from './components/FileChangeTree.js';
// export * from './components/SlashCommandPalette.js';
// export * from './components/DiffViewer.js';
// export * from './components/TerminalPanel.js';
// export * from './components/WorkspaceSwitcher.js';

// TODO: 迁移 hooks/
// export * from './hooks/useSseSubscription.js';
// export * from './hooks/useTokenUsage.js';
// export * from './hooks/useApprovalQueue.js';

// TODO: 迁移 stores/
// export * from './stores/messagesStore.js';
// export * from './stores/sessionStore.js';
