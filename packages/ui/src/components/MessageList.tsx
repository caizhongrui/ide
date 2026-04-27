/*---------------------------------------------------------------------------------------------
 *  MessageList — 消息列表容器
 *
 *  绑定到 messagesStore 的 messages accessor，自动响应式渲染。
 *  自动滚到底（除非用户手动上滑）。
 *
 *  最小 props：messages（reactive accessor），以及可选的渲染回调。
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import type { ChatMessage } from '../stores/messagesStore.js';
import { MessageBubble, type MessageActions } from './MessageBubble.js';
import { ToolBatchCard } from './ToolBatchCard.js';
import type { ToolRenderRegistry } from './ToolCallCard.js';

/** 渲染单元：消息或工具批次 */
type Row =
	| { kind: 'msg';   m: ChatMessage }
	| { kind: 'batch'; tools: ChatMessage[]; key: string };
// @ts-expect-error vite ?inline → string
import css from './MessageList.css?inline';
import { injectStyleOnce } from './_injectStyle.js';

export interface MessageListProps {
	messages:        Accessor<ChatMessage[]>;
	renderContent?:  (text: string) => JSX.Element | string;
	toolRenderers?:  ToolRenderRegistry;
	getToolLabel?:   (name: string) => string;
	/** 单条消息操作按钮（hover 时显示） */
	actions?:        MessageActions;
	/** 容器额外 class（consumer 主题接入用） */
	class?:          string;
	/** 自动滚到底（默认 true，用户上滑后暂停） */
	autoScroll?:     boolean;
	/** 是否把连续的 tool 消息合并成 ToolBatchCard（默认 true） */
	groupTools?:     boolean;
	/**
	 * 外部接管 scroll 容器：若提供，本组件内部不再滚动（mu-list overflow visible）；
	 * autoScroll 滚到底动作改为对该外部容器执行；适用于 desktop / IDE 已有自家 scroll 包装层的场景。
	 */
	externalScrollHost?: () => HTMLElement | undefined | null;
	/**
	 * 虚拟化兜底：超过此条数时仅渲染最近 maxRender 条，顶部显示"展开全部"按钮。
	 * 默认 800（避免几千条消息直接卡死浏览器渲染）。
	 */
	maxRender?: number;
	/** 按角色过滤（true = 隐藏对应消息） */
	filter?: {
		hideReasoning?:     boolean;
		hideTodos?:         boolean;   // 隐藏 todo_write / update_todo_list 工具
		hideInternalTools?: boolean;   // 隐藏一组内部工具（具体名单由 internalToolNames 提供）
	};
	/** 配合 hideInternalTools 使用的内部工具名集合（小写） */
	internalToolNames?: Set<string>;
	/** 强制全部 reasoning 展开（覆盖单条折叠态）；默认 false */
	expandAllReasoning?: boolean;
	/** 头像渲染：返回 JSX/字符串/null。默认按 role 显示首字母圆形徽标 */
	renderAvatar?: (role: ChatMessage['role']) => JSX.Element | string | null;
}

export function MessageList(props: MessageListProps): JSX.Element {
	injectStyleOnce('maxian-ui-message-list', css as string);

	let innerHost: HTMLDivElement | undefined;
	let userScrolledUp = false;

	/** 实际监听 scroll 的元素：外部 host > 内部 mu-list */
	const getScrollEl = (): HTMLElement | undefined =>
		props.externalScrollHost?.() ?? innerHost;

	const handleScroll = (): void => {
		const el = getScrollEl();
		if (!el) return;
		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		userScrolledUp = distFromBottom > 80;
	};

	onMount(() => {
		const el = getScrollEl();
		el?.addEventListener('scroll', handleScroll, { passive: true });
	});

	createEffect(() => {
		void props.messages();
		if (props.autoScroll === false) return;
		const el = getScrollEl();
		if (!el) return;
		if (userScrolledUp) return;
		queueMicrotask(() => { el.scrollTop = el.scrollHeight; });
	});

	const [expandAll, setExpandAll] = createSignal(false);
	const RENDER_LIMIT = (): number => props.maxRender ?? 800;

	/** 先按 filter 过滤，再做虚拟化截断 */
	const filteredMessages = createMemo<ChatMessage[]>(() => {
		const list = props.messages();
		const f = props.filter;
		if (!f) return list;
		const internal = props.internalToolNames;
		return list.filter(m => {
			if (f.hideReasoning && m.role === 'reasoning') return false;
			if (m.role === 'tool') {
				const name = (m.toolName ?? '').toLowerCase();
				if (f.hideTodos && (name === 'todo_write' || name === 'update_todo_list')) return false;
				if (f.hideInternalTools && internal && internal.has(name)) return false;
			}
			return true;
		});
	});
	const visibleMessages = createMemo<ChatMessage[]>(() => {
		const list = filteredMessages();
		const lim = RENDER_LIMIT();
		if (expandAll() || list.length <= lim) return list;
		return list.slice(list.length - lim);
	});
	const truncatedCount = createMemo<number>(() => {
		if (expandAll()) return 0;
		const total = filteredMessages().length;
		return total > RENDER_LIMIT() ? total - RENDER_LIMIT() : 0;
	});

	/** 把连续的 role='tool' 合并成 batch 行 */
	const rows = createMemo<Row[]>(() => {
		const list = visibleMessages();
		const grp = props.groupTools !== false;
		if (!grp) return list.map(m => ({ kind: 'msg', m } as Row));
		const out: Row[] = [];
		let i = 0;
		while (i < list.length) {
			const m = list[i];
			if (m.role === 'tool') {
				const tools: ChatMessage[] = [];
				while (i < list.length && list[i].role === 'tool') { tools.push(list[i]); i++; }
				// 单个工具不必走 batch（就是普通 ToolCallCard）
				if (tools.length === 1) {
					out.push({ kind: 'msg', m: tools[0] });
				} else {
					out.push({ kind: 'batch', tools, key: tools.map(t => t.id).join('|') });
				}
			} else {
				out.push({ kind: 'msg', m });
				i++;
			}
		}
		return out;
	});

	return (
		<div
			class={`mu-list ${props.externalScrollHost ? 'mu-list-no-scroll' : ''} ${props.class ?? ''}`}
			ref={el => (innerHost = el)}
		>
			<Show when={truncatedCount() > 0}>
				<button class="mu-list-show-more" onClick={() => setExpandAll(true)}>
					为保持流畅，已折叠 {truncatedCount()} 条较早消息 · 点击展开全部
				</button>
			</Show>
			<For each={rows()}>
				{(row) => row.kind === 'msg'
					? (
						<MessageBubble
							message={row.m}
							renderContent={props.renderContent}
							toolRenderers={props.toolRenderers}
							getToolLabel={props.getToolLabel}
							actions={props.actions}
							expandReasoning={props.expandAllReasoning}
							renderAvatar={props.renderAvatar}
						/>
					)
					: (
						<ToolBatchCard
							tools={row.tools}
							getToolLabel={props.getToolLabel}
							renderers={props.toolRenderers}
						/>
					)
				}
			</For>
		</div>
	);
}
