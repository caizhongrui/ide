/*---------------------------------------------------------------------------------------------
 *  Stores 索引（K11b-cont）—— 桌面端本地状态容器
 *  与 @maxian/ui/createMessagesStore 协作：UI 内的纯组件用，桌面端的本地行为用这里的
 *--------------------------------------------------------------------------------------------*/

export { createSessionStore }   from './sessionStore'
export { createWorkspaceStore } from './workspaceStore'
export type { SessionStore, WorkspaceGroupItem } from './sessionStore'
export type { WorkspaceStore }                   from './workspaceStore'
