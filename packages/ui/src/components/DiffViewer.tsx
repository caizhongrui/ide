/*---------------------------------------------------------------------------------------------
 *  DiffViewer — 文件级 Unified / Split diff 渲染（K10f）
 *
 *  对应 desktop App.tsx 里 FilePreviewPanel 内的 diff 视图渲染逻辑。
 *  纯组件：传入 original / current 文本字符串 + viewMode，自己跑 LCS diff 后渲染。
 *
 *  跨形态可复用：IDE / Web / Desktop 都用同一组件展示 diff（底色、行号、+/− 标记一致）。
 *--------------------------------------------------------------------------------------------*/

import { For, Show } from 'solid-js'
import type { Component } from 'solid-js'
// @ts-expect-error vite ?inline → string
import css from './DiffViewer.css?inline'
import { injectStyleOnce } from './_injectStyle.js'

/** 单条 diff 行 */
export interface DiffLine {
	type: 'del' | 'add' | 'ctx'
	text: string
}

export interface DiffViewerProps {
	/** 原始文本（null 表示新建文件） */
	original:  string | null
	/** 当前文本 */
	current:   string
	/** 视图模式：unified（单栏统一视图）/ split（左右对照） */
	viewMode?: 'unified' | 'split'
	/** 上下文行数（默认 3） */
	contextLines?: number
	/** 单边最大行数（默认 800，超出截断） */
	maxLines?: number
}

/**
 * LCS 行级 diff（迭代回溯，避免 stack overflow）
 *
 * 输出按原文档顺序（旧 → 新）；每条带 type 标记。
 */
export function computeUnifiedDiff(
	orig: string,
	curr: string,
	maxLines: number = 800,
): DiffLine[] {
	const origLines = orig.split('\n')
	const currLines = curr.split('\n')
	const result: DiffLine[] = []
	const ao = origLines.slice(0, maxLines)
	const bo = currLines.slice(0, maxLines)

	const m = ao.length
	const n = bo.length
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = ao[i - 1] === bo[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
		}
	}

	let i = m
	let j = n
	const stack: DiffLine[] = []
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && ao[i - 1] === bo[j - 1]) {
			stack.push({ type: 'ctx', text: ao[i - 1] }); i--; j--
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			stack.push({ type: 'add', text: bo[j - 1] }); j--
		} else {
			stack.push({ type: 'del', text: ao[i - 1] }); i--
		}
	}
	for (let k = stack.length - 1; k >= 0; k--) result.push(stack[k])

	if (origLines.length > maxLines || currLines.length > maxLines) {
		result.push({ type: 'ctx', text: `… (仅显示前 ${maxLines} 行)` })
	}
	return result
}

export const DiffViewer: Component<DiffViewerProps> = (props) => {
	injectStyleOnce('maxian-ui-diff-viewer', css as string)

	const viewMode     = () => props.viewMode ?? 'unified'
	const CONTEXT      = () => props.contextLines ?? 3
	const maxLines     = () => props.maxLines ?? 800

	// 新建文件：直接全部显示为 +
	const isCreate = () => props.original === null

	const diffLines = (): DiffLine[] => {
		if (isCreate()) return []
		return computeUnifiedDiff(props.original ?? '', props.current, maxLines())
	}

	const hasChanges = () => diffLines().some(l => l.type !== 'ctx')

	const showFlags = (): boolean[] => {
		const lines = diffLines()
		return lines.map((_l, idx) => {
			const start = Math.max(0, idx - CONTEXT())
			const end   = Math.min(lines.length - 1, idx + CONTEXT())
			return lines.slice(start, end + 1).some(x => x.type !== 'ctx')
		})
	}

	const splitColumns = () => {
		const lines = diffLines()
		const leftCol:  Array<{ no: number; text: string; type: 'ctx' | 'del' } | null> = []
		const rightCol: Array<{ no: number; text: string; type: 'ctx' | 'add' } | null> = []
		let leftNo = 0
		let rightNo = 0
		let i = 0
		while (i < lines.length) {
			if (lines[i].type === 'ctx') {
				leftNo++; rightNo++
				leftCol.push({  no: leftNo,  text: lines[i].text, type: 'ctx' })
				rightCol.push({ no: rightNo, text: lines[i].text, type: 'ctx' })
				i++
			} else {
				const dels: Array<{ no: number; text: string }> = []
				const adds: Array<{ no: number; text: string }> = []
				while (i < lines.length && lines[i].type === 'del') {
					leftNo++
					dels.push({ no: leftNo, text: lines[i].text }); i++
				}
				while (i < lines.length && lines[i].type === 'add') {
					rightNo++
					adds.push({ no: rightNo, text: lines[i].text }); i++
				}
				const pairLen = Math.max(dels.length, adds.length)
				for (let k = 0; k < pairLen; k++) {
					leftCol.push(dels[k]  ? { no: dels[k].no,  text: dels[k].text,  type: 'del' } : null)
					rightCol.push(adds[k] ? { no: adds[k].no, text: adds[k].text, type: 'add' } : null)
				}
			}
		}
		return { leftCol, rightCol }
	}

	return (
		<>
			{/* 新建文件视图 */}
			<Show when={isCreate()}>
				<div class="diff-table">
					<div class="diff-legend">
						<span class="diff-legend-add">+ 新建文件 ({(props.current ?? '').split('\n').length} 行)</span>
					</div>
					<div class="diff-lines">
						<For each={(props.current ?? '').split('\n').slice(0, 500)}>
							{(line, i) => (
								<div class="diff-line diff-line-add">
									<span class="diff-ln">{i() + 1}</span>
									<span class="diff-sign">+</span>
									<code class="diff-text">{line}</code>
								</div>
							)}
						</For>
						<Show when={(props.current ?? '').split('\n').length > 500}>
							<div class="diff-line diff-line-ctx">
								<span class="diff-ln">…</span>
								<span class="diff-sign"> </span>
								<code class="diff-text">… 还有 {(props.current ?? '').split('\n').length - 500} 行</code>
							</div>
						</Show>
					</div>
				</div>
			</Show>

			{/* 修改文件视图 */}
			<Show when={!isCreate()}>
				<Show when={!hasChanges()}>
					<div class="diff-no-change">文件内容未发生变化</div>
				</Show>

				<Show when={hasChanges() && viewMode() === 'split'}>
					{(() => {
						const { leftCol, rightCol } = splitColumns()
						return (
							<div class="diff-table">
								<div class="diff-legend">
									<span class="diff-legend-del">− 原始</span>
									<span class="diff-legend-add">+ 当前</span>
								</div>
								<div class="diff-split">
									<div class="diff-split-col">
										<For each={leftCol}>
											{(row) => row ? (
												<div class={`diff-line diff-line-${row.type}`}>
													<span class="diff-ln">{row.no}</span>
													<span class="diff-sign">{row.type === 'del' ? '−' : ' '}</span>
													<code class="diff-text">{row.text}</code>
												</div>
											) : (
												<div class="diff-line diff-line-empty">&nbsp;</div>
											)}
										</For>
									</div>
									<div class="diff-split-col">
										<For each={rightCol}>
											{(row) => row ? (
												<div class={`diff-line diff-line-${row.type}`}>
													<span class="diff-ln">{row.no}</span>
													<span class="diff-sign">{row.type === 'add' ? '+' : ' '}</span>
													<code class="diff-text">{row.text}</code>
												</div>
											) : (
												<div class="diff-line diff-line-empty">&nbsp;</div>
											)}
										</For>
									</div>
								</div>
							</div>
						)
					})()}
				</Show>

				<Show when={hasChanges() && viewMode() === 'unified'}>
					<div class="diff-table">
						<div class="diff-legend">
							<span class="diff-legend-del">− 删除</span>
							<span class="diff-legend-add">+ 新增</span>
						</div>
						<div class="diff-lines">
							<For each={diffLines()}>
								{(line, idx) => (
									<Show when={showFlags()[idx()]}>
										<div class={`diff-line diff-line-${line.type}`}>
											<span class="diff-sign">{line.type === 'del' ? '−' : line.type === 'add' ? '+' : ' '}</span>
											<code class="diff-text">{line.text}</code>
										</div>
									</Show>
								)}
							</For>
						</div>
					</div>
				</Show>
			</Show>
		</>
	)
}
