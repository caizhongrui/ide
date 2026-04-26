/*---------------------------------------------------------------------------------------------
 *  ApprovalDialog — 工具调用审批对话框
 *
 *  跨形态共享组件：Desktop / VS Code webview / IDEA / Web 共用同一份实现。
 *  设计契约：纯 props 驱动，不持有外部状态，不调任何 API、不访问 localStorage / fetch。
 *
 *  i18n：调用方通过 `labels` / `getToolLabel` 注入文案，组件本身不绑定语言包。
 *--------------------------------------------------------------------------------------------*/

import { Show, For } from 'solid-js';
import type { JSX } from 'solid-js';

/** 一次审批请求的最小数据集合 */
export interface ApprovalRequestData {
	sessionId:  string;
	toolUseId:  string;
	toolName:   string;
	toolParams: Record<string, unknown>;
}

/** 审批结果决定 — 由 callback 返回 */
export type ApprovalDecision =
	| { approved: false }
	| { approved: true; remember?: 'session' | 'always' };

/** 文案覆盖（默认中文，consumer 可整体替换为英文等） */
export interface ApprovalLabels {
	title?:        string;  // "工具调用审批"
	deny?:         string;  // "拒绝"
	allowOnce?:    string;  // "允许一次"
	allowSession?: string;  // "本会话允许"
	allowAlways?:  string;  // "总是允许"
	riskHint?:     string;  // "⚠ 此操作可能修改文件或执行系统命令"
}

const DEFAULT_LABELS: Required<ApprovalLabels> = {
	title:        '工具调用审批',
	deny:         '拒绝',
	allowOnce:    '允许一次',
	allowSession: '本会话允许',
	allowAlways:  '总是允许',
	riskHint:     '⚠ 此操作可能修改文件或执行系统命令',
};

/** 默认视为"高风险"的工具集合（写文件 / 执行命令） */
const DEFAULT_RISKY_TOOLS = new Set(['write_to_file', 'execute_command', 'bash', 'edit', 'multiedit']);

export interface ApprovalDialogProps {
	/** 当前待审批的请求；为 null/undefined 时组件 render null（即关闭） */
	request: ApprovalRequestData | null | undefined;

	/** 用户做出决定时回调（拒绝 / 允许 / 记住）。组件内部不维护审批白名单 */
	onDecide: (decision: ApprovalDecision) => void;

	/**
	 * 工具名 → 展示文案映射器。可选；缺省时直接展示工具的 raw name。
	 * 例：getToolLabel('read_file') → '读取文件'
	 */
	getToolLabel?: (toolName: string) => string;

	/** 文案覆盖（不传则用默认中文） */
	labels?: ApprovalLabels;

	/**
	 * 自定义"高风险"判定逻辑；返回 true 时会显示风险警示。
	 * 默认：write_to_file / execute_command / bash / edit / multiedit 视为高风险。
	 */
	isRisky?: (toolName: string) => boolean;

	/** 同时只展示前 N 个参数行（默认 3）；防止过长参数撑爆对话框 */
	maxParamsShown?: number;

	/** 单个参数值字符串截断长度（默认 100） */
	maxParamValueLength?: number;
}

export function ApprovalDialog(props: ApprovalDialogProps): JSX.Element {
	const labels = (): Required<ApprovalLabels> => ({ ...DEFAULT_LABELS, ...(props.labels ?? {}) });
	const maxParams      = () => props.maxParamsShown ?? 3;
	const maxParamLen    = () => props.maxParamValueLength ?? 100;
	const getLabel       = (n: string) => (props.getToolLabel ? props.getToolLabel(n) : n);
	const isRiskyTool    = (n: string) => (props.isRisky ? props.isRisky(n) : DEFAULT_RISKY_TOOLS.has(n));

	const formatValue = (v: unknown): string => {
		if (typeof v === 'string') {
			return v.length > maxParamLen() ? v.slice(0, maxParamLen()) + '…' : v;
		}
		const json = JSON.stringify(v);
		return json && json.length > maxParamLen() ? json.slice(0, maxParamLen()) + '…' : json ?? '';
	};

	return (
		<Show when={props.request}>
			{(req) => {
				const r        = req();
				const risky    = isRiskyTool(r.toolName);
				const strokeC  = risky ? '#f59e0b' : '#6366f1';
				const entries  = Object.entries(r.toolParams).slice(0, maxParams());

				return (
					<div class="approval-overlay">
						<div class="approval-dialog">
							<div class="approval-header">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={strokeC} stroke-width="2">
									<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
									<line x1="12" y1="9" x2="12" y2="13" />
									<line x1="12" y1="17" x2="12.01" y2="17" />
								</svg>
								<span class="approval-title">{labels().title}</span>
							</div>
							<div class="approval-body">
								<div class="approval-tool-name">{getLabel(r.toolName)}</div>
								<div class="approval-params">
									<For each={entries}>
										{([k, v]) => (
											<div class="approval-param-row">
												<span class="approval-param-key">{k}</span>
												<span class="approval-param-val">{formatValue(v)}</span>
											</div>
										)}
									</For>
								</div>
								<Show when={risky}>
									<div class="approval-risk-hint">{labels().riskHint}</div>
								</Show>
							</div>
							<div class="approval-footer approval-footer-3col">
								<button
									class="approval-btn deny"
									onClick={() => props.onDecide({ approved: false })}
								>{labels().deny}</button>
								<button
									class="approval-btn allow"
									onClick={() => props.onDecide({ approved: true })}
								>{labels().allowOnce}</button>
								<button
									class="approval-btn allow-session"
									onClick={() => props.onDecide({ approved: true, remember: 'session' })}
									title="本会话内后续此工具不再询问"
								>{labels().allowSession}</button>
								<button
									class="approval-btn allow-always"
									onClick={() => props.onDecide({ approved: true, remember: 'always' })}
									title="所有会话永久允许此工具"
								>{labels().allowAlways}</button>
							</div>
						</div>
					</div>
				);
			}}
		</Show>
	);
}
