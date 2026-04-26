/*---------------------------------------------------------------------------------------------
 *  MessageBubble — 单条对话消息气泡
 *
 *  根据 role 派发到不同样式：user / assistant / reasoning / error / system / tool
 *  tool 类型转交给 ToolCallCard 渲染（避免在本组件膨胀）
 *
 *  渲染纯字符串内容；调用方如果需要 markdown / 代码高亮，传 `renderContent` prop
 *  自定义渲染（@maxian/ui 不内置 markdown 库以保持轻量）。
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ChatMessage } from '../stores/messagesStore.js';
import { ToolCallCard, type ToolRenderRegistry } from './ToolCallCard.js';
// @ts-expect-error vite ?inline → string
import css from './MessageBubble.css?inline';
import { injectStyleOnce } from './_injectStyle.js';

export interface MessageBubbleProps {
	message: ChatMessage;
	/** 自定义内容渲染（markdown 等）；未提供则按 textContent 输出 */
	renderContent?: (text: string) => JSX.Element | string;
	/** 工具卡片自定义 render 注册表（per-tool 视图） */
	toolRenderers?: ToolRenderRegistry;
	/** 工具名 → 显示文案（中文化） */
	getToolLabel?: (name: string) => string;
}

export function MessageBubble(props: MessageBubbleProps): JSX.Element {
	injectStyleOnce('maxian-ui-message-bubble', css as string);

	const m = () => props.message;
	const renderContent = (text: string): JSX.Element | string =>
		props.renderContent ? props.renderContent(text) : text;

	return (
		<Show when={m()}>
			{(msg) => {
				const role = () => msg().role;
				return (
					<div class={`mu-msg mu-msg-${role()}`} data-msg-id={msg().id}>
						<Show when={role() === 'user'}>
							<div class="mu-msg-content">{renderContent(msg().content)}</div>
						</Show>

						<Show when={role() === 'assistant'}>
							<div class="mu-msg-content">{renderContent(msg().content)}</div>
							<Show when={msg().isPartial}>
								<span class="mu-typing">▍</span>
							</Show>
						</Show>

						<Show when={role() === 'reasoning'}>
							<div class="mu-reasoning">
								<div class="mu-reasoning-head">
									<span class="mu-reasoning-icon">💭</span>
									<span>思考中{msg().charCount ? ` (${msg().charCount} 字)` : ''}</span>
								</div>
								<div class="mu-reasoning-body">{msg().content}</div>
							</div>
						</Show>

						<Show when={role() === 'error'}>
							<div class="mu-error">
								<span class="mu-error-icon">⚠</span>
								<span>{msg().content}</span>
							</div>
						</Show>

						<Show when={role() === 'system'}>
							<div class="mu-system">{msg().content}</div>
						</Show>

						<Show when={role() === 'tool'}>
							<ToolCallCard
								toolName={msg().toolName ?? 'unknown'}
								toolId={msg().toolId ?? msg().id}
								toolParams={msg().toolParams ?? {}}
								toolResult={msg().toolResult}
								toolSuccess={msg().toolSuccess}
								liveOutput={msg().liveOutput}
								isPartial={msg().isPartial}
								getToolLabel={props.getToolLabel}
								renderers={props.toolRenderers}
							/>
						</Show>
					</div>
				);
			}}
		</Show>
	);
}
