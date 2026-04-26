/*---------------------------------------------------------------------------------------------
 *  ToolCallCard — 单个工具调用卡片
 *
 *  渲染：
 *    - 头：工具中文名 + 状态徽标（执行中 / 成功 / 失败）
 *    - 身：关键参数（path / command / query 优先展示）
 *    - 尾：toolResult 折叠 / liveOutput（bash 实时） 折叠
 *
 *  consumer 可通过 `renderers` 覆盖某些工具的展示（如 edit 的 diff 预览、
 *  read_file 的语法高亮等），未注册的回退默认 KV 视图。
 *--------------------------------------------------------------------------------------------*/

import { Show, For, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
// @ts-expect-error vite ?inline → string
import css from './ToolCallCard.css?inline';
import { injectStyleOnce } from './_injectStyle.js';

export interface ToolCallCardProps {
	toolName:     string;
	toolId:       string;
	toolParams:   Record<string, unknown>;
	toolResult?:  string;
	toolSuccess?: boolean;
	liveOutput?:  string;
	isPartial?:   boolean;
	getToolLabel?: (name: string) => string;
	renderers?:   ToolRenderRegistry;
}

/** 自定义工具渲染器：每个工具名 → 一个组件返回 JSX */
export type ToolRenderRegistry = Record<string, (p: ToolCallCardProps) => JSX.Element>;

const DEFAULT_LABELS: Record<string, string> = {
	read_file:       '读取文件',
	write_to_file:   '写入文件',
	edit:            '编辑文件',
	multiedit:       '多处编辑',
	apply_diff:      '应用补丁',
	search_files:    '搜索文件',
	list_files:      '列出目录',
	execute_command: '执行命令',
	bash:            '终端命令',
	grep:            '内容搜索',
	glob:            '通配符匹配',
	ls:              '列出目录',
	todo_write:      '更新任务',
	web_fetch:       '获取网页',
	load_skill:      '加载技能',
	lsp:             'LSP 查询',
	task:            '子 Agent',
};

/** 优先展示的参数字段（按这个顺序找第一个有值的） */
const PRIMARY_PARAM_KEYS = ['path', 'command', 'query', 'pattern', 'url', 'name', 'file_pattern'];

export function ToolCallCard(props: ToolCallCardProps): JSX.Element {
	injectStyleOnce('maxian-ui-tool-card', css as string);

	const label = () => {
		if (props.getToolLabel) return props.getToolLabel(props.toolName);
		return DEFAULT_LABELS[props.toolName] ?? props.toolName;
	};

	// custom renderer 走自定义路径
	const customRenderer = () => props.renderers?.[props.toolName];

	const status = (): 'pending' | 'success' | 'error' => {
		if (props.isPartial) return 'pending';
		if (props.toolSuccess === false) return 'error';
		return 'success';
	};

	const primaryParam = (): { key: string; val: string } | null => {
		const params = props.toolParams ?? {};
		for (const k of PRIMARY_PARAM_KEYS) {
			const v = params[k];
			if (v !== undefined && v !== null && v !== '') {
				return { key: k, val: typeof v === 'string' ? v : JSON.stringify(v) };
			}
		}
		return null;
	};

	return (
		<Show when={!customRenderer()} fallback={<>{customRenderer()!(props)}</>}>
			<div class={`mu-tool mu-tool-${status()}`}>
				<div class="mu-tool-head">
					<span class="mu-tool-icon">{statusIcon(status())}</span>
					<span class="mu-tool-name">{label()}</span>
					<Show when={primaryParam()}>
						{(p) => (
							<span class="mu-tool-primary" title={p().val}>
								{truncateMid(p().val, 60)}
							</span>
						)}
					</Show>
					<span class="mu-tool-status">{statusText(status())}</span>
				</div>

				<Show when={!props.isPartial && (props.toolResult || props.liveOutput)}>
					<ToolDetails result={props.toolResult} liveOutput={props.liveOutput} />
				</Show>

				<Show when={Object.keys(props.toolParams ?? {}).length > 1}>
					<ToolParamsExpanded params={props.toolParams} />
				</Show>
			</div>
		</Show>
	);
}

function ToolDetails(props: { result?: string; liveOutput?: string }): JSX.Element {
	const [open, setOpen] = createSignal(false);
	const text = () => props.liveOutput ?? props.result ?? '';
	const lines = () => text().split('\n').length;

	return (
		<div class="mu-tool-details">
			<button class="mu-tool-toggle" onClick={() => setOpen(!open())}>
				{open() ? '▼' : '▶'} {lines()} 行输出
			</button>
			<Show when={open()}>
				<pre class="mu-tool-result">{text()}</pre>
			</Show>
		</div>
	);
}

function ToolParamsExpanded(props: { params: Record<string, unknown> }): JSX.Element {
	const [open, setOpen] = createSignal(false);
	const entries = () => Object.entries(props.params).filter(([k]) => !PRIMARY_PARAM_KEYS.includes(k));

	return (
		<Show when={entries().length > 0}>
			<div class="mu-tool-params">
				<button class="mu-tool-toggle" onClick={() => setOpen(!open())}>
					{open() ? '▼' : '▶'} 全部参数 ({entries().length})
				</button>
				<Show when={open()}>
					<div class="mu-tool-params-grid">
						<For each={entries()}>
							{([k, v]) => (
								<div class="mu-tool-param-row">
									<span class="mu-tool-param-key">{k}</span>
									<span class="mu-tool-param-val">
										{typeof v === 'string' ? v : JSON.stringify(v)}
									</span>
								</div>
							)}
						</For>
					</div>
				</Show>
			</div>
		</Show>
	);
}

function statusIcon(s: 'pending' | 'success' | 'error'): string {
	switch (s) {
		case 'pending': return '⋯';
		case 'success': return '✓';
		case 'error':   return '✗';
	}
}
function statusText(s: 'pending' | 'success' | 'error'): string {
	switch (s) {
		case 'pending': return '执行中';
		case 'success': return '已完成';
		case 'error':   return '失败';
	}
}
function truncateMid(s: string, max: number): string {
	if (!s || s.length <= max) return s;
	const half = Math.floor((max - 1) / 2);
	return s.slice(0, half) + '…' + s.slice(s.length - half);
}
