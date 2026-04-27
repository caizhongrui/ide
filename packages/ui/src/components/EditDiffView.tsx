/*---------------------------------------------------------------------------------------------
 *  EditDiffView — edit / multiedit 工具的内置 diff 视图
 *
 *  从 toolParams.old_string + new_string 生成简单的红绿对比展示：
 *    - 红色背景行：被删除（来自 old_string）
 *    - 绿色背景行：被新增（来自 new_string）
 *
 *  没接入完整 LCS diff 算法（避免引入第三方依赖），所以只是"全量替换"的简易展示。
 *  consumer 想要更精细的逐字符 diff 时，通过 toolRenderers 自行替换实现。
 *--------------------------------------------------------------------------------------------*/

import { Show, For, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ToolCallCardProps } from './ToolCallCard.js';
// @ts-expect-error vite ?inline → string
import css from './EditDiffView.css?inline';
import { injectStyleOnce } from './_injectStyle.js';

interface EditOp { oldString: string; newString: string }

function getEdits(props: ToolCallCardProps): EditOp[] {
	const p = props.toolParams ?? {};
	if (props.toolName === 'edit') {
		return [{
			oldString: String(p.old_string ?? p.oldString ?? ''),
			newString: String(p.new_string ?? p.newString ?? ''),
		}];
	}
	if (props.toolName === 'multiedit') {
		const raw = p.edits;
		const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? safeParseArray(raw) : []);
		return arr.map((e: any) => ({
			oldString: String(e?.old_string ?? e?.oldString ?? ''),
			newString: String(e?.new_string ?? e?.newString ?? ''),
		}));
	}
	return [];
}
function safeParseArray(s: string): unknown[] {
	try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function EditDiffView(props: ToolCallCardProps): JSX.Element {
	injectStyleOnce('maxian-ui-edit-diff', css as string);
	const path = (): string => String(props.toolParams?.path ?? '');
	const edits = (): EditOp[] => getEdits(props);

	const status = (): 'pending' | 'success' | 'error' => {
		if (props.isPartial) return 'pending';
		if (props.toolSuccess === false) return 'error';
		return 'success';
	};
	const statusIcon = (s: string): string => s === 'pending' ? '⋯' : s === 'success' ? '✓' : '✗';
	const statusText = (s: string): string => s === 'pending' ? '执行中' : s === 'success' ? '已应用' : '失败';

	const [open, setOpen] = createSignal(true);

	return (
		<div class={`mu-diff mu-diff-${status()}`}>
			<div class="mu-diff-head" onClick={() => setOpen(o => !o)}>
				<span class="mu-diff-icon">{statusIcon(status())}</span>
				<span class="mu-diff-tool">{props.toolName === 'multiedit' ? '多处编辑' : '编辑'}</span>
				<span class="mu-diff-path" title={path()}>{shortenPath(path(), 60)}</span>
				<span class="mu-diff-meta">{edits().length} 处修改 · {statusText(status())}</span>
				<span class="mu-diff-toggle">{open() ? '▲' : '▼'}</span>
			</div>
			<Show when={open()}>
				<div class="mu-diff-body">
					<For each={edits()}>
						{(e, i) => (
							<div class="mu-diff-block">
								<div class="mu-diff-block-head">第 {i() + 1} 处</div>
								<Show when={e.oldString}>
									<DiffSide kind="del" text={e.oldString} />
								</Show>
								<Show when={e.newString}>
									<DiffSide kind="add" text={e.newString} />
								</Show>
							</div>
						)}
					</For>
				</div>
			</Show>
			{/* tool 的 toolResult 仍然显示（含 LSP 诊断等） */}
			<Show when={!props.isPartial && props.toolResult}>
				<details class="mu-diff-result">
					<summary>执行结果</summary>
					<pre>{props.toolResult}</pre>
				</details>
			</Show>
		</div>
	);
}

function DiffSide(props: { kind: 'add' | 'del'; text: string }): JSX.Element {
	const sign = props.kind === 'add' ? '+' : '-';
	return (
		<div class={`mu-diff-side mu-diff-side-${props.kind}`}>
			<For each={props.text.split('\n')}>
				{(line) => (
					<div class="mu-diff-line">
						<span class="mu-diff-sign">{sign}</span>
						<span class="mu-diff-text">{line || ' '}</span>
					</div>
				)}
			</For>
		</div>
	);
}

function shortenPath(p: string, max: number): string {
	if (!p) return '';
	if (p.length <= max) return p;
	const half = Math.floor((max - 1) / 2);
	return p.slice(0, half) + '…' + p.slice(p.length - half);
}
