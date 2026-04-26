/*---------------------------------------------------------------------------------------------
 *  MessageBubble — 单条对话消息气泡
 *
 *  根据 role 派发到不同样式：user / assistant / reasoning / error / system / tool
 *  tool 类型转交给 ToolCallCard 渲染（避免在本组件膨胀）
 *
 *  渲染纯字符串内容；调用方如果需要 markdown / 代码高亮，传 `renderContent` prop
 *  自定义渲染（@maxian/ui 不内置 markdown 库以保持轻量）。
 *--------------------------------------------------------------------------------------------*/

import { Show, createSignal, createEffect } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ChatMessage } from '../stores/messagesStore.js';
import { ToolCallCard, type ToolRenderRegistry } from './ToolCallCard.js';
import { renderLightMarkdown } from './lightMarkdown.js';
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
	/** 优先用 consumer 提供的渲染（如 marked + DOMPurify），否则用内置 lightMarkdown */
	const renderRichContent = (text: string): JSX.Element => {
		if (props.renderContent) {
			return props.renderContent(text) as unknown as JSX.Element;
		}
		// 内置极简 markdown（已 escape XSS 安全）
		return (<div innerHTML={renderLightMarkdown(text)} />) as unknown as JSX.Element;
	};

	return (
		<Show when={m()}>
			{(msg) => {
				const role = () => msg().role;
				// 思考气泡折叠态：流式中始终展开；完成 → 自动折叠一次；之后用户可手动展开/折叠
				const [reasoningOpen, setReasoningOpen] = createSignal(true);
				const [autoCollapsed, setAutoCollapsed] = createSignal(false);
				createEffect(() => {
					// isPartial → false 的瞬间执行一次自动折叠
					if (!m().isPartial && m().role === 'reasoning' && !autoCollapsed()) {
						setReasoningOpen(false);
						setAutoCollapsed(true);
					}
				});
				return (
					<div class={`mu-msg mu-msg-${role()}`} data-msg-id={msg().id}>
						<Show when={role() === 'user'}>
							<div class="mu-msg-content">{msg().content}</div>
						</Show>

						<Show when={role() === 'assistant'}>
							<div class="mu-msg-content">{renderRichContent(msg().content)}</div>
							<Show when={msg().isPartial}>
								<span class="mu-typing">▍</span>
							</Show>
						</Show>

						<Show when={role() === 'reasoning'}>
							{(() => {
								// 一旦完成 → 默认折叠；首次完成才折叠（用户手动展开后保持）
								const isDone   = !msg().isPartial;
								const expanded = (): boolean => msg().isPartial ? true : reasoningOpen();
								return (
									<div class="mu-reasoning" classList={{ 'mu-reasoning-done': isDone }}>
										<div
											class="mu-reasoning-head"
											onClick={() => isDone && setReasoningOpen(o => !o)}
											style={{ cursor: isDone ? 'pointer' : 'default' }}
										>
											<span class="mu-reasoning-icon">💭</span>
											<span class="mu-reasoning-title">
												{msg().isPartial ? '思考中' : '思考完成'}
												{msg().charCount ? ` (${msg().charCount} 字)` : ''}
											</span>
											<Show when={isDone}>
												<span class="mu-reasoning-toggle">{expanded() ? '▲' : '▼'}</span>
											</Show>
										</div>
										<Show when={expanded()}>
											<div
												class="mu-reasoning-body"
												classList={{ 'mu-reasoning-body-streaming': !!msg().isPartial }}
											>
												{renderRichContent(msg().content)}
											</div>
										</Show>
									</div>
								);
							})()}
						</Show>

						<Show when={role() === 'error'}>
							<div class="mu-error">
								<span class="mu-error-icon">⚠</span>
								<span>{msg().content}</span>
							</div>
						</Show>

						<Show when={role() === 'system'}>
							{(() => {
								const isTaskDone = msg().content.startsWith('✅ 任务完成');
								if (isTaskDone) {
									return (
										<div class="mu-task-done">
											<span class="mu-task-done-icon">✓</span>
											<span class="mu-task-done-text">任务完成</span>
										</div>
									);
								}
								return <div class="mu-system">{msg().content}</div>;
							})()}
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
