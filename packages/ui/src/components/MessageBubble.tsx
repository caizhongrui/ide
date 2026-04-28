/*---------------------------------------------------------------------------------------------
 *  MessageBubble — 单条对话消息气泡
 *
 *  根据 role 派发到不同样式：user / assistant / reasoning / error / system / tool
 *  tool 类型转交给 ToolCallCard 渲染（避免在本组件膨胀）
 *
 *  渲染纯字符串内容；调用方如果需要 markdown / 代码高亮，传 `renderContent` prop
 *  自定义渲染（@maxian/ui 不内置 markdown 库以保持轻量）。
 *--------------------------------------------------------------------------------------------*/

import { Show, For, createSignal, createEffect } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ChatMessage } from '../stores/messagesStore.js';
import { ToolCallCard, type ToolRenderRegistry } from './ToolCallCard.js';
import { renderLightMarkdown } from './lightMarkdown.js';
// @ts-expect-error vite ?inline → string
import css from './MessageBubble.css?inline';
import { injectStyleOnce } from './_injectStyle.js';

/**
 * 每条 reasoning 气泡的展开状态按 msg.id 全局记忆。
 * MessageBubble 组件被父级 <For> 重建（任何流式更新都可能触发）时，组件内
 * 的 createSignal 都会重置；把状态外置到这里就能保持"用户手动展开/折叠"
 * 的选择不被外部刷新冲掉。
 *
 * LRU 上限 500 条避免长会话/多次启动累积无限增长（webview OOM 防御）。
 */
const REASONING_MAP_CAP = 500;
const reasoningOpenById = new Map<string, boolean>();
const reasoningSeenDoneById = new Set<string>();
function setReasoningOpenCapped(id: string, v: boolean): void {
	if (reasoningOpenById.size >= REASONING_MAP_CAP && !reasoningOpenById.has(id)) {
		const firstKey = reasoningOpenById.keys().next().value as string | undefined;
		if (firstKey) reasoningOpenById.delete(firstKey);
	}
	reasoningOpenById.set(id, v);
}
function markReasoningSeenDoneCapped(id: string): void {
	if (reasoningSeenDoneById.size >= REASONING_MAP_CAP) {
		const firstKey = reasoningSeenDoneById.values().next().value as string | undefined;
		if (firstKey) reasoningSeenDoneById.delete(firstKey);
	}
	reasoningSeenDoneById.add(id);
}

export interface MessageActions {
	/** 重新生成此消息（从此节点开始重跑） */
	onRegenerate?: (message: ChatMessage) => void;
	/** 从此消息分叉一个新会话 */
	onFork?:       (message: ChatMessage) => void;
	/** 删除此消息 */
	onDelete?:     (message: ChatMessage) => void;
}

export interface MessageBubbleProps {
	message: ChatMessage;
	/** 自定义内容渲染（markdown 等）；未提供则按 textContent 输出 */
	renderContent?: (text: string) => JSX.Element | string;
	/** 工具卡片自定义 render 注册表（per-tool 视图） */
	toolRenderers?: ToolRenderRegistry;
	/** 工具名 → 显示文案（中文化） */
	getToolLabel?: (name: string) => string;
	/** 单条消息操作按钮（hover 时显示在消息右上） */
	actions?: MessageActions;
	/** 头像渲染：返回 JSX/字符串/null。默认按 role 显示首字母圆形徽标 */
	renderAvatar?: (role: ChatMessage['role']) => JSX.Element | string | null;
	/** 强制 reasoning 全部展开（"展开全部思考"按钮联动） */
	expandReasoning?: boolean;
}

/**
 * 从消息 metadata.images 或 content 中的 data:URL 提取图片，渲染缩略图条。
 * Consumer 在 store 里把图片塞到 metadata.images: string[] 即可显示。
 */
function renderImageBlocks(msg: ChatMessage): JSX.Element | null {
	const imgs: string[] = (msg.metadata?.images as string[] | undefined) ?? [];
	if (!imgs || imgs.length === 0) return null;
	return (
		<div class="mu-msg-images">
			<For each={imgs}>
				{(src: string) => (
					<a href={src} target="_blank" rel="noopener noreferrer" class="mu-msg-image-link">
						<img src={src} class="mu-msg-image" alt="附件图片" />
					</a>
				)}
			</For>
		</div>
	);
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
				// 思考气泡折叠态：用模块级 Map 按 msg.id 持久化状态，组件重建状态依然在。
				// 默认：流式中视为展开（true），完成 → 自动折叠 → 之后完全由用户控制。
				const initialOpen = (): boolean => {
					const stored = reasoningOpenById.get(msg().id);
					if (stored !== undefined) return stored;
					return msg().isPartial === true;   // 默认值
				};
				const [reasoningOpen, _setReasoningOpenInner] = createSignal(initialOpen());
				const setReasoningOpen = (next: boolean | ((prev: boolean) => boolean)): void => {
					_setReasoningOpenInner(prev => {
						const v = typeof next === 'function' ? next(prev) : next;
						setReasoningOpenCapped(msg().id, v);
						return v;
					});
				};
				// 进入完成态的"瞬间"折叠一次（每条 reasoning 一次性）；用户后续手动操作不再被覆盖。
				createEffect(() => {
					if (m().role !== 'reasoning') return;
					const isDoneNow = m().isPartial !== true;
					const id = m().id;
					if (isDoneNow && !reasoningSeenDoneById.has(id)) {
						markReasoningSeenDoneCapped(id);
						// 用户在流式期间未手动操作过 → 自动折叠
						if (!reasoningOpenById.has(id)) {
							setReasoningOpen(false);
						}
					}
				});
				const ts = (): string => {
					const t = msg().createdAt;
					if (!t) return '';
					const d = new Date(t);
					const Y = d.getFullYear();
					const M = String(d.getMonth() + 1).padStart(2, '0');
					const D = String(d.getDate()).padStart(2, '0');
					const hh = String(d.getHours()).padStart(2, '0');
					const mm = String(d.getMinutes()).padStart(2, '0');
					return `${Y}-${M}-${D} ${hh}:${mm}`;
				};
				const actionsAvailable = (): boolean => {
					const a = props.actions;
					if (!a) return false;
					// 只对 user / assistant 显示操作按钮
					return (role() === 'user' || role() === 'assistant')
						&& Boolean(a.onRegenerate || a.onFork || a.onDelete);
				};
				const showAvatar = (): boolean => role() === 'user' || role() === 'assistant';
				const avatarText = (): string => {
					if (props.renderAvatar) {
						const v = props.renderAvatar(role());
						if (typeof v === 'string') return v.slice(0, 2);
						if (v && typeof v !== 'string') {
							// JSX element：完整使用，由 consumer 自负样式
							return '';
						}
					}
					return role() === 'user' ? '我' : 'AI';
				};
				const avatarNode = (): JSX.Element | null => {
					if (!showAvatar()) return null;
					// consumer 提供 JSX 时直接用其内容；否则用文字 + 默认 mu-avatar 样式
					if (props.renderAvatar) {
						const v = props.renderAvatar(role());
						if (v && typeof v !== 'string') {
							return <div class={`mu-avatar mu-avatar-${role()}`}>{v}</div>;
						}
					}
					return <div class={`mu-avatar mu-avatar-${role()}`}>{avatarText()}</div>;
				};
				return (
					<div class={`mu-msg mu-msg-${role()}`} data-msg-id={msg().id}>
						<Show when={actionsAvailable()}>
							<div class="mu-msg-actions">
								<Show when={props.actions?.onRegenerate}>
									<button class="mu-msg-action" title="重新生成" onClick={() => props.actions!.onRegenerate!(msg())}>
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<polyline points="1 4 1 10 7 10"/>
											<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
										</svg>
									</button>
								</Show>
								<Show when={props.actions?.onFork}>
									<button class="mu-msg-action" title="从此分叉新会话" onClick={() => props.actions!.onFork!(msg())}>
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<circle cx="6" cy="3" r="2"/>
											<circle cx="6" cy="21" r="2"/>
											<circle cx="18" cy="12" r="2"/>
											<path d="M8 3h6a4 4 0 0 1 4 4v3M6 5v14M8 21h6a4 4 0 0 0 4-4v-3"/>
										</svg>
									</button>
								</Show>
								<Show when={props.actions?.onDelete}>
									<button class="mu-msg-action mu-msg-action-danger" title="删除消息" onClick={() => props.actions!.onDelete!(msg())}>
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<polyline points="3 6 5 6 21 6"/>
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
										</svg>
									</button>
								</Show>
							</div>
						</Show>
						<Show when={role() === 'user'}>
							<div class="mu-msg-content">
								{renderImageBlocks(msg())}
								<Show when={msg().content}>
									<div>{msg().content}</div>
								</Show>
								<Show when={ts()}>
									<span class="mu-msg-time">{ts()}</span>
								</Show>
							</div>
							{avatarNode()}
						</Show>

						<Show when={role() === 'assistant'}>
							{avatarNode()}
							<div class="mu-msg-content mu-msg-content-rich">
								{renderRichContent(msg().content)}
								<Show when={ts() && !msg().isPartial}>
									<span class="mu-msg-time">{ts()}</span>
								</Show>
							</div>
							<Show when={msg().isPartial}>
								<span class="mu-typing">▍</span>
							</Show>
						</Show>

						<Show when={role() === 'reasoning'}>
							{(() => {
								// 关键：isDone / expanded 必须是函数（响应式）而不是 const 快照。
								// 否则流式中初次渲染时 isPartial=true 把 isDone 冻结成 false，
								// 流结束后用户点 header 时 onClick 里的 isDone && ... 永远是 false，
								// 导致"展不开"——这是用户实际遇到的 bug。
								const isDone   = (): boolean => !msg().isPartial;
								const expanded = (): boolean => msg().isPartial || props.expandReasoning === true || reasoningOpen();
								return (
									<div class="mu-reasoning" classList={{ 'mu-reasoning-done': isDone(), 'mu-reasoning-collapsed': isDone() && !expanded() }}>
										<div
											class="mu-reasoning-head"
											onClick={() => isDone() && setReasoningOpen(o => !o)}
											style={{ cursor: isDone() ? 'pointer' : 'default' }}
										>
											<span class="mu-reasoning-icon">💭</span>
											<span class="mu-reasoning-title">
												{msg().isPartial ? '思考中' : '思考'}
												{msg().charCount ? ` · ${msg().charCount} 字` : ''}
											</span>
											<Show when={isDone()}>
												<button class="mu-reasoning-toggle" type="button" aria-label={expanded() ? '折叠' : '展开'}>
													<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
														stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
														style={{ transform: expanded() ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 180ms ease' }}>
														<polyline points="6 9 12 15 18 9" />
													</svg>
												</button>
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
