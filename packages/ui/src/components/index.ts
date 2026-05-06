/*---------------------------------------------------------------------------------------------
 *  @maxian/ui/components — Solid 组件统一导出
 *--------------------------------------------------------------------------------------------*/

export {
	ApprovalDialog,
	type ApprovalDialogProps,
	type ApprovalRequestData,
	type ApprovalDecision,
	type ApprovalLabels,
} from './ApprovalDialog.js';

export { MessageList,   type MessageListProps   } from './MessageList.js';
export { MessageBubble, type MessageBubbleProps, type MessageActions } from './MessageBubble.js';
export { ToolCallCard,  type ToolCallCardProps, type ToolRenderRegistry } from './ToolCallCard.js';
export { ToolBatchCard, type ToolBatchCardProps } from './ToolBatchCard.js';
export { EditDiffView } from './EditDiffView.js';

// K10b
export { TerminalPanel, type TerminalPanelProps, type TerminalTab } from './TerminalPanel.js';

// K10c
export { TokenUsageBar, type TokenUsageBarProps } from './TokenUsageBar.js';

// K10d
export {
	CommandPalette,
	MentionDropdown,
	type CommandPaletteProps,
	type MentionDropdownProps,
	type SlashCommandItem,
	type PaletteRect,
} from './CommandPalette.js';

// K10e
export {
	FileChangesPanel,
	type FileChangesPanelProps,
	type FileChangeEntry,
} from './FileChangesPanel.js';

// K10f
export {
	DiffViewer,
	computeUnifiedDiff,
	type DiffViewerProps,
	type DiffLine,
} from './DiffViewer.js';
