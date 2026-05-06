/*---------------------------------------------------------------------------------------------
 *  SettingsUsage — Token 用量 dashboard（K11c-5：从 App.tsx 切出）
 *--------------------------------------------------------------------------------------------*/

import { For, createMemo } from 'solid-js'
import type { Component } from 'solid-js'

export interface SessionLike {
	id:           string
	title?:       string
	updatedAt:    number
	messageCount: number
	uiMode?:      string
	inputTokens?: number
	outputTokens?: number
}

export interface SettingsUsageProps {
	sessions: () => SessionLike[]
}

export const SettingsUsage: Component<SettingsUsageProps> = (props) => {
	const totalInput  = createMemo(() => props.sessions().reduce((sum, s) => sum + (s.inputTokens  ?? 0), 0))
	const totalOutput = createMemo(() => props.sessions().reduce((sum, s) => sum + (s.outputTokens ?? 0), 0))

	const byMode = createMemo(() => {
		const stats: Record<string, { in: number; out: number; count: number }> = {}
		for (const s of props.sessions()) {
			const k = s.uiMode ?? 'code'
			if (!stats[k]) stats[k] = { in: 0, out: 0, count: 0 }
			stats[k].in  += s.inputTokens  ?? 0
			stats[k].out += s.outputTokens ?? 0
			stats[k].count++
		}
		return stats
	})

	const topSessions = createMemo(() =>
		[...props.sessions()]
			.sort((a, b) => ((b.inputTokens ?? 0) + (b.outputTokens ?? 0)) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)))
			.slice(0, 10)
	)

	return (
		<>
			<div class="settings-title">Token 用量</div>
			<div class="settings-group">
				<div class="settings-group-title">累计用量</div>
				<div class="settings-card">
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">输入 tokens</div>
							<div class="settings-row-desc">所有会话累计（流入 LLM 的 token）</div>
						</div>
						<div style="font-size:24px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">
							{totalInput().toLocaleString()}
						</div>
					</div>
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">输出 tokens</div>
							<div class="settings-row-desc">所有会话累计（LLM 生成的 token）</div>
						</div>
						<div style="font-size:24px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">
							{totalOutput().toLocaleString()}
						</div>
					</div>
					<div class="settings-row">
						<div class="settings-row-label">
							<div class="settings-row-name">合计</div>
							<div class="settings-row-desc">input + output</div>
						</div>
						<div style="font-size:28px;font-weight:700;color:var(--text-base);font-variant-numeric:tabular-nums">
							{(totalInput() + totalOutput()).toLocaleString()}
						</div>
					</div>
				</div>
			</div>
			<div class="settings-group">
				<div class="settings-group-title">按模式分布</div>
				<div class="settings-card">
					<For each={Object.entries(byMode())}>
						{([mode, stats]) => (
							<div class="settings-row">
								<div class="settings-row-label">
									<div class="settings-row-name">{mode === 'chat' ? 'Chat' : 'Code'} 模式</div>
									<div class="settings-row-desc">{stats.count} 个会话</div>
								</div>
								<div style="font-family:monospace;font-size:13px;color:var(--text-base)">
									{stats.in.toLocaleString()} in · {stats.out.toLocaleString()} out
								</div>
							</div>
						)}
					</For>
				</div>
			</div>
			<div class="settings-group">
				<div class="settings-group-title">Top 10 会话（按 token 消耗）</div>
				<div class="settings-card">
					<For each={topSessions()}>
						{(s) => (
							<div class="settings-row">
								<div class="settings-row-label">
									<div class="settings-row-name">{s.title || s.id.slice(0, 8)}</div>
									<div class="settings-row-desc">{new Date(s.updatedAt).toLocaleString('zh-CN')} · {s.messageCount} 条</div>
								</div>
								<div style="font-family:monospace;font-size:12px;color:var(--text-muted)">
									{((s.inputTokens ?? 0) + (s.outputTokens ?? 0)).toLocaleString()} tokens
								</div>
							</div>
						)}
					</For>
				</div>
			</div>
		</>
	)
}
