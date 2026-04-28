/*---------------------------------------------------------------------------------------------
 *  ToolBatchCard — 把同一时间段连续触发的多个工具调用合并成一张卡片
 *
 *  视觉：
 *  - 折叠态：单行摘要 — 一排状态点 (✓/✗/⋯) + "已执行 N 个工具" + 展开 ▼
 *  - 展开态：纵向罗列每个 ToolCallCard
 *  - 任一工具仍 isPartial=true 时强制展开（用户能看到进度）
 *--------------------------------------------------------------------------------------------*/

import { Show, For, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ChatMessage } from '../stores/messagesStore.js';
import { ToolCallCard, type ToolRenderRegistry } from './ToolCallCard.js';
// @ts-expect-error vite ?inline → string
import css from './ToolBatchCard.css?inline';
import { injectStyleOnce } from './_injectStyle.js';

/** 按 batch key（tool id 拼接）持久化 userOpen。LRU 上限 200 防长会话累积 OOM */
const BATCH_MAP_CAP = 200;
const batchOpenByKey = new Map<string, boolean>();
function setBatchOpenCapped(key: string, v: boolean): void {
	if (batchOpenByKey.size >= BATCH_MAP_CAP && !batchOpenByKey.has(key)) {
		const firstKey = batchOpenByKey.keys().next().value as string | undefined;
		if (firstKey) batchOpenByKey.delete(firstKey);
	}
	batchOpenByKey.set(key, v);
}

export interface ToolBatchCardProps {
	tools: ChatMessage[];   // 必为 role='tool' 且按出现顺序
	getToolLabel?: (n: string) => string;
	renderers?:    ToolRenderRegistry;
}

export function ToolBatchCard(props: ToolBatchCardProps): JSX.Element {
	injectStyleOnce('maxian-ui-tool-batch', css as string);

	const batchKey = (): string => props.tools.map(t => t.id).join('|');
	const anyRunning = (): boolean => props.tools.some(t => t.isPartial);
	const [userOpen, _setUserOpenInner] = createSignal(batchOpenByKey.get(batchKey()) ?? false);
	const setUserOpen = (v: boolean): void => {
		setBatchOpenCapped(batchKey(), v);
		_setUserOpenInner(v);
	};
	const expanded = (): boolean => anyRunning() || userOpen();

	const dot = (t: ChatMessage): string => {
		if (t.isPartial) return 'mu-batch-dot-pending';
		if (t.toolSuccess === false) return 'mu-batch-dot-err';
		return 'mu-batch-dot-ok';
	};

	return (
		<div class="mu-batch">
			<Show when={!expanded()}>
				<button class="mu-batch-row" onClick={() => setUserOpen(true)}>
					<div class="mu-batch-dots">
						<For each={props.tools.slice(0, 7)}>
							{(t) => <span class={`mu-batch-dot ${dot(t)}`} />}
						</For>
						<Show when={props.tools.length > 7}>
							<span class="mu-batch-more">+{props.tools.length - 7}</span>
						</Show>
					</div>
					<span class="mu-batch-label">已执行 {props.tools.length} 个工具</span>
					<svg class="mu-batch-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</button>
			</Show>

			<Show when={expanded()}>
				<div class="mu-batch-expanded">
					<Show when={!anyRunning()}>
						<div class="mu-batch-head" onClick={() => setUserOpen(false)}>
							<span class="mu-batch-label">{props.tools.length} 个工具</span>
							<svg class="mu-batch-icon mu-batch-icon-up" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<polyline points="6 9 12 15 18 9" />
							</svg>
						</div>
					</Show>
					<For each={props.tools}>
						{(t) => (
							<ToolCallCard
								toolName={t.toolName ?? 'unknown'}
								toolId={t.toolId ?? t.id}
								toolParams={t.toolParams ?? {}}
								toolResult={t.toolResult}
								toolSuccess={t.toolSuccess}
								liveOutput={t.liveOutput}
								isPartial={t.isPartial}
								getToolLabel={props.getToolLabel}
								renderers={props.renderers}
							/>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}
