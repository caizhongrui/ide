/*---------------------------------------------------------------------------------------------
 *  MessageList — 消息列表容器
 *
 *  绑定到 messagesStore 的 messages accessor，自动响应式渲染。
 *  自动滚到底（除非用户手动上滑）。
 *
 *  最小 props：messages（reactive accessor），以及可选的渲染回调。
 *--------------------------------------------------------------------------------------------*/

import { For, createEffect, onMount } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import type { ChatMessage } from '../stores/messagesStore.js';
import { MessageBubble } from './MessageBubble.js';
import type { ToolRenderRegistry } from './ToolCallCard.js';
// @ts-expect-error vite ?inline → string
import css from './MessageList.css?inline';
import { injectStyleOnce } from './_injectStyle.js';

export interface MessageListProps {
	messages:        Accessor<ChatMessage[]>;
	renderContent?:  (text: string) => JSX.Element | string;
	toolRenderers?:  ToolRenderRegistry;
	getToolLabel?:   (name: string) => string;
	/** 容器额外 class（consumer 主题接入用） */
	class?:          string;
	/** 自动滚到底（默认 true，用户上滑后暂停） */
	autoScroll?:     boolean;
}

export function MessageList(props: MessageListProps): JSX.Element {
	injectStyleOnce('maxian-ui-message-list', css as string);

	let scrollHost: HTMLDivElement | undefined;
	let userScrolledUp = false;

	const handleScroll = (): void => {
		if (!scrollHost) return;
		const distFromBottom = scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight;
		userScrolledUp = distFromBottom > 80;
	};

	onMount(() => {
		scrollHost?.addEventListener('scroll', handleScroll, { passive: true });
	});

	createEffect(() => {
		// 任何 messages 变化都触发滚动判断
		void props.messages();
		if (props.autoScroll === false) return;
		if (!scrollHost) return;
		if (userScrolledUp) return;
		queueMicrotask(() => {
			scrollHost!.scrollTop = scrollHost!.scrollHeight;
		});
	});

	return (
		<div class={`mu-list ${props.class ?? ''}`} ref={el => (scrollHost = el)}>
			<For each={props.messages()}>
				{(msg) => (
					<MessageBubble
						message={msg}
						renderContent={props.renderContent}
						toolRenderers={props.toolRenderers}
						getToolLabel={props.getToolLabel}
					/>
				)}
			</For>
		</div>
	);
}
