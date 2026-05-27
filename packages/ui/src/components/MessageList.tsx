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
	/** K-Perf：稳定 host 模式的内容渲染器，详见 MessageBubbleProps.renderRichContentMutable */
	renderRichContentMutable?: (host: HTMLElement, text: string) => void;
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
	let lastMessageCount = 0;
	let scrollPending = false;
	// pointerOnList 已废弃（K-Perf v0.2.24 / 来自 jiusi）：之前把"鼠标在列表里"
	// 作为暂停自动滚动的条件，实际效果是用户一边读一边鼠标停在窗口里时，
	// 新消息根本不会自动滚下去。改为只在"用户主动上滑离开底部 80px"时才停。

	/** 实际监听 scroll 的元素：外部 host > 内部 mu-list */
	const getScrollEl = (): HTMLElement | undefined =>
		props.externalScrollHost?.() ?? innerHost;

	/** 实时检查"是否仍接近底部" —— 比 userScrolledUp 快照变量更可靠 */
	const isNearBottom = (el: HTMLElement, slackPx = 80): boolean => {
		const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
		return dist <= slackPx;
	};

	// K-Perf v0.2.24 (from jiusi 0.4.3)：rAF 节流 scroll handler。
	// 原实现每个 scroll 事件都读 scrollHeight，触发同步 layout；WKWebView 在 800 条
	// 消息列表里单次 layout 1-5ms，120Hz 滚动事件叠加 → 主线程长期 100%，合成器
	// 拿不到帧。rAF 节流后同一帧最多读一次，layout 工作降一个数量级。
	let scrollReadPending = false;
	let scrollIdleTimer: number | undefined;
	const handleScroll = (): void => {
		// 滚动期间给 body 加 is-scrolling 类：暂停昂贵动画 / 隐藏 hover 状态。
		// 停止滚动 150ms 后移除 class，恢复完整体验。
		if (typeof document !== 'undefined') {
			const b = document.body;
			if (b && !b.classList.contains('is-scrolling')) {
				b.classList.add('is-scrolling');
			}
			if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer);
			scrollIdleTimer = window.setTimeout(() => {
				document.body?.classList.remove('is-scrolling');
				scrollIdleTimer = undefined;
			}, 150);
		}
		if (scrollReadPending) return;
		scrollReadPending = true;
		requestAnimationFrame(() => {
			scrollReadPending = false;
			const el = getScrollEl();
			if (!el) return;
			const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			userScrolledUp = distFromBottom > 80;
		});
	};

	onMount(() => {
		const el = getScrollEl();
		el?.addEventListener('scroll', handleScroll, { passive: true });
	});

	// 自动滚到底（K-Perf v0.2.24 升级）：
	//  - 只在「消息条数增加」时滚动；流式内容更新不滚。
	//  - 用户上滑离开底部 80px 以上则不滚；回到底部附近自动恢复。
	//  - 在 effect 入口同步再 check 一次（规避 userScrolledUp 快照过时）。
	//  - **双 rAF + 多轮兜底校准**：流式中 markdown 段落异步落地会让 scrollHeight
	//    估算偏小，单次 scrollTop=scrollHeight 可能滚不到真正底部；再 rAF 一次，
	//    然后用 setTimeout 重试最多 3 轮（每轮 60ms），覆盖测量异步落地的尺寸抖动。
	createEffect(() => {
		const list  = props.messages();
		const count = list.length;
		if (props.autoScroll === false) {
			lastMessageCount = count;
			return;
		}
		const el = getScrollEl();
		if (!el) {
			lastMessageCount = count;
			return;
		}
		const grew = count > lastMessageCount;
		lastMessageCount = count;
		if (!grew) return;
		if (!isNearBottom(el) && userScrolledUp) return;
		if (scrollPending) return;
		scrollPending = true;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				scrollPending = false;
				if (!el.isConnected) return;
				el.scrollTop = el.scrollHeight;
				// 兜底校准：测量异步落地后再次贴底，最多 3 轮。
				let retries = 0;
				const recheck = (): void => {
					if (retries++ >= 3) return;
					if (!el.isConnected) return;
					const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
					if (dist > 4) {
						el.scrollTop = el.scrollHeight;
						setTimeout(recheck, 60);
					}
				};
				setTimeout(recheck, 60);
			});
		});
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

	/** 把连续的 role='tool' 合并成 batch 行
	 *
	 * ⚠️ 重要：row 对象引用必须稳定 —— Solid <For> 按引用判等。
	 * 若每次 memo 重新生成新的 { kind:'msg', m } 包装对象，<For> 会全量重建所有
	 * MessageBubble 组件，导致组件内本地 signals（reasoningOpen / autoCollapsed
	 * 等）被重置，reasoning 气泡 createEffect 再次自动折叠 —— 用户感知就是"展
	 * 开后立刻闪关"。
	 *
	 * 解决：用消息 id 缓存上一轮的 row 对象，未变化的消息复用同一个 row 引用。
	 */
	let rowCache = new Map<string, Row>();
	const rows = createMemo<Row[]>(() => {
		const list    = visibleMessages();
		const grp     = props.groupTools !== false;
		const newCache = new Map<string, Row>();
		const out: Row[] = [];

		const pushMsg = (m: ChatMessage): void => {
			const cached = rowCache.get(m.id);
			// 缓存命中且消息引用未变 → 复用 row（保持组件不重挂）
			if (cached && cached.kind === 'msg' && cached.m === m) {
				out.push(cached);
				newCache.set(m.id, cached);
			} else {
				const fresh: Row = { kind: 'msg', m };
				out.push(fresh);
				newCache.set(m.id, fresh);
			}
		};

		if (!grp) {
			for (const m of list) pushMsg(m);
		} else {
			let i = 0;
			while (i < list.length) {
				const m = list[i];
				if (m.role === 'tool') {
					const tools: ChatMessage[] = [];
					while (i < list.length && list[i].role === 'tool') { tools.push(list[i]); i++; }
					// 单个工具不必走 batch（就是普通 ToolCallCard）
					if (tools.length === 1) {
						pushMsg(tools[0]);
					} else {
						const key = tools.map(t => t.id).join('|');
						const cached = rowCache.get(key);
						// batch row 缓存：tool 数组每个引用都未变才复用
						const sameRefs = cached && cached.kind === 'batch'
							&& cached.tools.length === tools.length
							&& cached.tools.every((t, idx) => t === tools[idx]);
						if (sameRefs) {
							out.push(cached!);
							newCache.set(key, cached!);
						} else {
							const fresh: Row = { kind: 'batch', tools, key };
							out.push(fresh);
							newCache.set(key, fresh);
						}
					}
				} else {
					pushMsg(m);
					i++;
				}
			}
		}

		rowCache = newCache;
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
							renderRichContentMutable={props.renderRichContentMutable}
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
