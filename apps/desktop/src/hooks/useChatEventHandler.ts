/*---------------------------------------------------------------------------------------------
 *  useChatEventHandler — SSE 事件分发器（K11b 抽离自 App.tsx）
 *
 *  原本是 App.tsx 内 465 行 inline 的 `handleEvent`，触碰 30+ signal/setter。
 *  现在用 factory pattern：host 把所有需要的 setter / getter / helper 通过 deps 传入，
 *  返回闭包封装 `_abortedAt` 等流式状态的 `handleEvent` 函数。
 *
 *  支持的事件类型（与 server SSE 协议对齐）：
 *    task_aborted / file_changed / token_usage / todos_updated / followup_suggestions /
 *    rate_limit / rate_limit_cleared / question_request / plan_exit_request /
 *    context_compacting / context_compacted / tool_input_delta / tool_output_chunk /
 *    tool_approval_request / reasoning_delta / assistant_message /
 *    convert_reasoning_to_assistant / completion / task_status /
 *    tool_call_start / tool_call_result / error
 *
 *  逻辑零变更——纯搬迁。每个分支语义完全保持，只是 setX(...) → deps.setX(...)，
 *  ++msgId → deps.nextMsgId()。
 *--------------------------------------------------------------------------------------------*/

import type { MaxianEvent } from '@maxian/sdk'
import type { ChatMessage } from '../lib/types'
import type {
	CompactingState,
	FileChangeEntry,
	PlanExitRequest,
	QuestionRequest,
	RateLimitState,
	TodoItem,
} from '../lib/chatEventTypes'

export interface ChatEventDeps {
	// ── messages 主存储 ────────────────────────────────────────────────────
	setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void

	// ── 流式 / 进度 ───────────────────────────────────────────────────────
	setSending:  (v: boolean) => void
	bumpRecv:    (n: number) => void

	// ── K-Pet：让宠物窗口知道 review/failed 这种瞬时状态 ─────────────────
	onPetCompletion?: () => void
	onPetError?:      () => void

	// ── 文件变更 ──────────────────────────────────────────────────────────
	setChangedFiles: (updater: (prev: Map<string, FileChangeEntry>) => Map<string, FileChangeEntry>) => void

	// ── Token 用量 ────────────────────────────────────────────────────────
	setTokenUsed:   (n: number) => void
	tokenLimit:     () => number
	setTokenLimit:  (n: number) => void

	// ── Todos ─────────────────────────────────────────────────────────────
	todos:             () => TodoItem[]
	setTodos:          (list: TodoItem[]) => void
	setTodosLeftover:  (v: boolean) => void

	// ── Followup ──────────────────────────────────────────────────────────
	setFollowupSuggestions: (list: string[]) => void

	// ── Rate-limit ────────────────────────────────────────────────────────
	setRateLimit:    (state: RateLimitState) => void

	// ── Question / Plan Exit ──────────────────────────────────────────────
	setQuestionRequest:  (req: QuestionRequest | null) => void
	setQuestionAnswer:   (s: string) => void
	setQuestionSelected: (list: string[]) => void
	setPlanExitRequest:  (req: PlanExitRequest | null) => void
	setPlanExitFeedback: (s: string) => void

	// ── Context Compacting ────────────────────────────────────────────────
	compactingState:    () => CompactingState | null
	setCompactingState: (s: CompactingState | null) => void

	// ── Approval ──────────────────────────────────────────────────────────
	setApprovalRequest: (req: { sessionId: string; toolUseId: string; toolName: string; toolParams: Record<string, unknown> } | null) => void
	isAutoApproved:     (sessionId: string, toolName: string) => boolean
	/** K-Bypass：当前 composer 模式（bypass 时所有审批请求都自动通过）*/
	getComposerMode?:   () => string
	getClient:          () => Promise<{ approveToolCall: (sid: string, useId: string, ok: boolean) => Promise<unknown> }>

	// ── 副作用 / helpers ──────────────────────────────────────────────────
	showToast:           (opts: { message: string; kind?: 'info' | 'success' | 'warn' | 'error'; duration?: number; action?: { label: string; onClick: () => void } }) => string
	pushError:           (source: string, message: string, sessionId?: string) => void
	refreshSessions:     () => Promise<void>
	maybeScrollToBottom: () => void
	nextMsgId:           () => string
}

export interface ChatEventHandler {
	/** 主分发函数：把 SSE 事件喂给它即可 */
	handle:          (e: MaxianEvent) => void
	/** 新一轮 send 开始时调用，清掉上次 cancel 的"丢弃窗口" */
	resetAbortedAt:  () => void
}

export function createChatEventHandler(deps: ChatEventDeps): ChatEventHandler {
	// 任务取消时间戳：cancel 触发后，后续残留的流式事件全部忽略
	let _abortedAt = 0

	const handle = function handleEvent(e: MaxianEvent) {
		const type = e.type as string

		// task_aborted = 后端强制中止信号，立刻进入"忽略后续流"模式
		if (type === "task_aborted") {
			_abortedAt = Date.now()
			console.log('[handleEvent] 收到 task_aborted，后续 200ms 内的流式事件全部忽略')
			// 收尾所有 isPartial 消息
			deps.setMessages((prev) => prev.map(m => {
				if (!m.isPartial) return m
				if (m.role === 'tool') {
					return { ...m, isPartial: false, toolSuccess: false, toolResult: m.toolResult || '[任务已中止]' }
				}
				if (m.role === 'reasoning') return { ...m, isPartial: false, charCount: m.content.length }
				return { ...m, isPartial: false }
			}))
			deps.setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
			deps.setSending(false)
			return
		}

		// 流式事件白名单：abort 后 1.5 秒内丢弃这些（兜底防 SSE buffer 残留）
		const STREAM_EVENTS = new Set([
			'reasoning_delta', 'assistant_message', 'tool_input_delta', 'tool_call_start',
			'tool_call_result', 'tool_output_chunk', 'todos_updated',
		])
		if (_abortedAt > 0 && STREAM_EVENTS.has(type) && (Date.now() - _abortedAt) < 1500) {
			return  // 静默丢弃
		}

		// 文件变更事件
		if (type === "file_changed") {
			const filePath = (e as any).path as string
			const action   = (e as any).action as FileChangeEntry['action']
			deps.setChangedFiles(prev => {
				const next = new Map(prev)
				next.set(filePath, { path: filePath, action })
				return next
			})
			return
		}
		// Token 用量事件
		if (type === "token_usage") {
			const used  = (e as any).used  as number
			const limit = (e as any).limit as number | undefined
			deps.setTokenUsed(used)
			// 后端上报的 limit 作为真实上下文窗口大小（覆盖前端默认 128K）
			if (typeof limit === 'number' && limit > 0 && limit !== deps.tokenLimit()) {
				deps.setTokenLimit(limit)
			}
			return
		}
		// Todos 更新事件（AI 调用 todo_write 工具时触发）
		if (type === "todos_updated") {
			const list = (e as any).todos as TodoItem[]
			deps.setTodos(Array.isArray(list) ? list : [])
			deps.setTodosLeftover(false)   // AI 又更新了 todos，清掉上一轮的"未完成"提示
			return
		}
		// Followup 建议
		if (type === "followup_suggestions") {
			const list = (e as any).suggestions as string[]
			deps.setFollowupSuggestions(Array.isArray(list) ? list : [])
			return
		}
		// Rate-limit 事件
		if (type === "rate_limit") {
			const resetAt = Number((e as any).resetAt) || (Date.now() + 30000)
			const attempt = Number((e as any).attempt) || 1
			const message = String((e as any).message ?? '触发限流，正在等待重试…')
			deps.setRateLimit({ active: true, resetAt, attempt, message })
			return
		}
		if (type === "rate_limit_cleared") {
			deps.setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
			return
		}
		// Agent 提问
		if (type === "question_request") {
			deps.setQuestionAnswer('')
			deps.setQuestionSelected([])
			deps.setQuestionRequest({
				sessionId: (e as any).sessionId as string,
				question:  (e as any).question as string,
				options:   ((e as any).options as string[]) ?? [],
				multi:     ((e as any).multi as boolean) ?? false,
			})
			return
		}
		// Plan Exit 请求
		if (type === "plan_exit_request") {
			deps.setPlanExitFeedback('')
			deps.setPlanExitRequest({
				sessionId: (e as any).sessionId as string,
				summary:   (e as any).summary as string,
				steps:     ((e as any).steps as string) ?? '',
			})
			return
		}
		// 上下文压缩开始
		if (type === "context_compacting") {
			deps.setCompactingState({
				tokensCurrent: (e as any).tokensCurrent as number,
				willLevel2:    !!(e as any).willLevel2,
				manual:        !!(e as any).manual,
				startedAt:     Date.now(),
			})
			return
		}
		// 上下文压缩完成
		if (type === "context_compacted") {
			const level  = (e as any).level  as number
			const before = (e as any).tokensBefore as number
			const after  = (e as any).tokensAfter  as number
			const pruned = (e as any).prunedTools as number
			const summd  = (e as any).summarizedMsgs as number
			const manual = (e as any).manual as boolean
			const error  = (e as any).error  as string | undefined
			const compactStart = deps.compactingState()?.startedAt
			const elapsed = compactStart ? ((Date.now() - compactStart) / 1000).toFixed(1) : null
			deps.setCompactingState(null)

			if (error) {
				deps.setMessages(prev => [...prev, {
					id: deps.nextMsgId(),
					role: 'error',
					createdAt: Date.now(),
					content: `🗜 上下文压缩失败：${error}`,
				}])
				deps.showToast({ message: `压缩失败：${error}`, kind: 'error', duration: 5000 })
				return
			}

			if (level === 0) {
				// 压缩实际未运行（比如 token 未达阈值、剪枝没够效果）
				deps.setMessages(prev => [...prev, {
					id: deps.nextMsgId(),
					role: 'system',
					createdAt: Date.now(),
					content: `🗜 上下文压缩：未触发（当前 ${before.toLocaleString()} tokens 未达阈值）${elapsed ? ` · ${elapsed}s` : ''}`,
				}])
				return
			}

			const levelLabel = level === 2 ? 'LLM 总结' : '按类型剪枝'
			const saved = before - after
			const savedPct = before > 0 ? Math.round(saved / before * 100) : 0
			const detail = [
				`${before.toLocaleString()} → ${after.toLocaleString()} tokens`,
				saved > 0 ? `节省 ${saved.toLocaleString()} (${savedPct}%)` : null,
				pruned > 0 ? `剪 ${pruned} 工具结果` : null,
				summd > 0 ? `总结 ${summd} 条` : null,
				elapsed ? `${elapsed}s` : null,
			].filter(Boolean).join(' · ')
			deps.setMessages(prev => [...prev, {
				id: deps.nextMsgId(),
				role: 'system',
				createdAt: Date.now(),
				content: `🗜 ${manual ? '手动' : '自动'}上下文压缩完成（${levelLabel}）：${detail}`,
			}])
			deps.showToast({
				message: `压缩完成：${before.toLocaleString()} → ${after.toLocaleString()} tokens${elapsed ? ` · ${elapsed}s` : ''}`,
				kind: 'success',
				duration: 4000,
			})
			return
		}
		// 流式 tool input 增量（实时显示工具参数生成进度）
		if (type === "tool_input_delta") {
			const inputDelta = (e as any).inputDelta as string
			// 只更新接收计数器让 UI "已接收 X 字" 动起来。
			// ⚠️ 重要：之前每个 chunk 都 setMessages 把 inputDelta 累积到 tool message 的
			// content 字段——但 ToolCallCard 在 streaming 期间根本不显示 content，纯无用写。
			// 副作用：multiedit 转 2000 行 SP 时单次工具参数 100KB，每 50ms 复制整个 messages
			// 数组 + Solid <For> 全表 memo 重算 + hljs 反复跑 → webview OOM 真凶。
			// 完整 toolParams 在 tool_call_start streaming=false 时一次性写入即可，无需流式累积。
			if (inputDelta) deps.bumpRecv(inputDelta.length)
			return
		}
		// 工具流式输出（bash 的 stdout/stderr 实时增量）
		if (type === "tool_output_chunk") {
			const toolUseId = (e as any).toolUseId as string
			const chunk     = (e as any).chunk     as string
			const kind      = ((e as any).kind     as 'stdout' | 'stderr') ?? 'stdout'
			if (!toolUseId || !chunk) return
			// 追加到对应工具消息的 liveOutput 字段（供工具卡片实时显示）。
			// 上限 64KB：长期跑的 bash（npm install / build）输出能到几 MB，
			// 多任务累积容易让 webview OOM。超限保留尾部 64KB 即可（UI 也只看 tail）。
			const LIVE_OUTPUT_CAP = 64 * 1024
			deps.setMessages((prev) => {
				const idx = [...prev].reverse().findIndex(m => m.role === 'tool' && m.toolUseId === toolUseId)
				if (idx === -1) return prev
				const realIdx = prev.length - 1 - idx
				const t = prev[realIdx] as any
				const prevLive = t.liveOutput ?? ''
				const marker = kind === 'stderr' ? '⚠ ' : ''
				let next = prevLive + marker + chunk
				if (next.length > LIVE_OUTPUT_CAP) {
					next = '... [输出超 64KB，已截断头部]\n' + next.slice(-LIVE_OUTPUT_CAP)
				}
				return [
					...prev.slice(0, realIdx),
					{ ...t, liveOutput: next },
					...prev.slice(realIdx + 1),
				]
			})
			return
		}
		// 工具审批请求事件
		if (type === "tool_approval_request") {
			const sid = (e as any).sessionId as string
			const toolUseId = (e as any).toolUseId as string
			const toolName  = (e as any).toolName  as string
			const toolParams = (e as any).toolParams as Record<string, unknown>
			const composerMode = deps.getComposerMode?.()
			// FILE_EDIT_TOOLS 必须与 packages/server/src/cli.ts 同步
			const FILE_EDIT_TOOLS = new Set(['write_to_file', 'edit', 'multiedit', 'apply_patch'])
			// ★ bypass 模式 → 一切自动批准
			//   code 模式 + 文件编辑类 → 自动批准（"自动接受文件修改"语义）
			//   （服务端理论上已经短路了，这里是双保险防老 sidecar / 时序竞态）
			if (composerMode === 'bypass' || (composerMode === 'code' && FILE_EDIT_TOOLS.has(toolName))) {
				void (async () => {
					try {
						const c = await deps.getClient()
						await c.approveToolCall(sid, toolUseId, true)
					} catch (err) {
						console.error('[mode-auto-approve] failed:', err)
					}
				})()
				return
			}
			// 自动审批：已记忆的工具跳过弹窗
			if (deps.isAutoApproved(sid, toolName)) {
				void (async () => {
					try {
						const c = await deps.getClient()
						await c.approveToolCall(sid, toolUseId, true)
					} catch (err) {
						console.error('[auto-approve] failed:', err)
					}
				})()
				return
			}
			deps.setApprovalRequest({ sessionId: sid, toolUseId, toolName, toolParams })
			return
		}
		if (type === "reasoning_delta") {
			// 思考过程流式 delta
			const content = (e as any).content as string
			if (!content) return
			deps.bumpRecv(content.length)
			// 单条 reasoning 上限 30KB：DeepSeek thinking 一轮可累 50KB+ 思维链，
			// 600 条 messages × 50KB = 30MB 仅 reasoning 文本；给单条加 cap 把 worst case 砍半。
			const REASONING_PER_MSG_CAP = 30 * 1024
			deps.setMessages((prev) => {
				if (prev.length > 0 && prev[prev.length - 1].role === "reasoning" && prev[prev.length - 1].isPartial) {
					const last = prev[prev.length - 1]
					let nextContent = last.content + content
					if (nextContent.length > REASONING_PER_MSG_CAP) {
						// 保留头部 + 尾部，省略中间（思考有用的信息常在结论附近）
						const head = nextContent.slice(0, REASONING_PER_MSG_CAP / 2)
						const tail = nextContent.slice(-REASONING_PER_MSG_CAP / 2)
						nextContent = head + `\n\n... [思维链中段 ${nextContent.length - REASONING_PER_MSG_CAP} 字省略，仅 UI 显示]\n\n` + tail
					}
					return [...prev.slice(0, -1), { ...last, content: nextContent }]
				}
				return [...prev, { id: deps.nextMsgId(), role: "reasoning", content, isPartial: true, createdAt: Date.now() }]
			})
		} else if (type === "assistant_message") {
			const content = (e as any).content as string
			const isPartial = (e as any).isPartial as boolean
			if (content) deps.bumpRecv(content.length)
			// 单条 assistant 上限 80KB：超长回复（如代码生成）单条文本能到几十 KB，
			// 给 cap 防长会话×长输出双重累积。代码段已经写到工具结果，自然语言部分够用。
			const ASSISTANT_PER_MSG_CAP = 80 * 1024
			deps.setMessages((prev) => {
				let base = prev
				const lastMsg = base.length > 0 ? base[base.length - 1] : null
				if (lastMsg?.role === 'reasoning' && lastMsg.isPartial) {
					base = [...base.slice(0, -1), { ...lastMsg, isPartial: false, charCount: lastMsg.content.length }]
				}
				if (isPartial && base.length > 0 && base[base.length - 1].role === "assistant") {
					const last = base[base.length - 1]
					let nextContent = last.content + content
					if (nextContent.length > ASSISTANT_PER_MSG_CAP) {
						const head = nextContent.slice(0, ASSISTANT_PER_MSG_CAP / 2)
						const tail = nextContent.slice(-ASSISTANT_PER_MSG_CAP / 2)
						nextContent = head + `\n\n... [回复中段 ${nextContent.length - ASSISTANT_PER_MSG_CAP} 字省略]\n\n` + tail
					}
					return [...base.slice(0, -1), { ...last, content: nextContent, isPartial }]
				}
				return [...base, { id: deps.nextMsgId(), role: "assistant", content, isPartial, createdAt: Date.now() }]
			})
		} else if (type === "convert_reasoning_to_assistant") {
			// Agent 模式：最终迭代的文本以 reasoning_delta 流出，完成后转为普通助手消息
			deps.setMessages((prev) => {
				if (prev.length === 0) return prev
				const last = prev[prev.length - 1]
				if (last.role === "reasoning") {
					// 将最后一条 reasoning 转为 assistant（保留内容，渲染切为 markdown）
					return [...prev.slice(0, -1), {
						...last, role: "assistant" as const, isPartial: false,
					}]
				}
				return prev
			})
		} else if (type === "completion") {
			deps.setMessages((prev) => prev.map(m => {
				// 完成所有残余 partial assistant
				if (m.role === "assistant" && m.isPartial) return { ...m, isPartial: false }
				// 完成所有残余 partial reasoning（中间迭代留下的）
				if (m.role === "reasoning" && m.isPartial) return { ...m, isPartial: false, charCount: m.content.length }
				return m
			}))
			deps.setSending(false)
			deps.onPetCompletion?.()
			void deps.refreshSessions()
			// 系统通知：当文档不在前台时发送 OS 通知
			if (document.visibilityState !== 'visible') {
				void (async () => {
					try {
						if ((window as any).__TAURI_INTERNALS__) {
							const { sendNotification } = await import('@tauri-apps/plugin-notification' as any)
							await sendNotification({ title: '码弦 AI', body: 'AI 已完成任务' })
						} else if ('Notification' in window && (Notification as any).permission === 'granted') {
							new Notification('码弦 AI', { body: 'AI 已完成任务', icon: '/favicon.ico' })
						}
					} catch { /* 忽略通知失败 */ }
				})()
			}
			// 提示音（Web Audio API）
			try {
				const ctx = new AudioContext()
				const osc = ctx.createOscillator()
				const gain = ctx.createGain()
				osc.connect(gain); gain.connect(ctx.destination)
				osc.frequency.setValueAtTime(880, ctx.currentTime)
				osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15)
				gain.gain.setValueAtTime(0.1, ctx.currentTime)
				gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
				osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3)
				osc.onended = () => ctx.close()
			} catch { /* 忽略音频失败 */ }
		} else if (type === "task_status") {
			const s = (e as any).status as string
			if (s === "processing") {
				deps.bumpRecv(1)   // 后端开始处理，让蓝点亮起
				deps.setTodosLeftover(false)   // 新一轮处理开始，清掉上一轮的"未完成"提示
				// 新任务一律清空上一轮 todos（不论状态）：AI 调 todo_write 时会重写完整列表，
				// 清空避免新任务 sending 期间把旧清单搬回来显示。
				deps.setTodos([])
			}
			if (s === "completed" || s === "aborted" || s === "error") {
				deps.setSending(false)
				// 检查 todos 是否有未收尾的项目（AI 提前结束的兜底提示）
				const list = deps.todos()
				if (list.length > 0 && list.some(t => t.status === 'in_progress' || t.status === 'pending')) {
					deps.setTodosLeftover(true)
				}
			}
		} else if (type === "tool_call_start") {
			deps.bumpRecv(1)
			const toolName   = (e as any).toolName   as string
			const toolUseId  = (e as any).toolUseId  as string
			let   toolParams = (e as any).toolParams as Record<string, unknown> | undefined
			const streaming  = (e as any).streaming  as boolean | undefined
			// toolParams 大字段截断（multiedit 转 2000 行文件时 edits[].oldString/newString 各 100KB+
			// 直接进 messages signal 会把 webview 内存撑爆）。
			// UI 只用 path / command 等"主参数"展示，长字符串字段用占位符替换。
			if (toolParams) {
				const TRIM_FIELD_BYTES = 4096
				const trimmed: Record<string, unknown> = {}
				for (const [k, v] of Object.entries(toolParams)) {
					if (typeof v === 'string' && v.length > TRIM_FIELD_BYTES) {
						trimmed[k] = v.slice(0, TRIM_FIELD_BYTES) + `\n... [${v.length - TRIM_FIELD_BYTES} 字节已截断]`
					} else if (Array.isArray(v)) {
						// multiedit 的 edits 数组逐项截断
						trimmed[k] = v.map((item: any) => {
							if (item && typeof item === 'object') {
								const out: Record<string, unknown> = {}
								for (const [ik, iv] of Object.entries(item)) {
									out[ik] = (typeof iv === 'string' && iv.length > TRIM_FIELD_BYTES)
										? iv.slice(0, TRIM_FIELD_BYTES) + `\n... [${iv.length - TRIM_FIELD_BYTES} 字节已截断]`
										: iv
								}
								return out
							}
							return item
						})
					} else {
						trimmed[k] = v
					}
				}
				toolParams = trimmed
			}
			deps.setMessages((prev) => {
				// 如果是 streaming=false（工具参数完整到达），查找已有占位消息更新其 toolParams
				if (streaming === false) {
					const idx = [...prev].reverse().findIndex(m => m.role === "tool" && m.toolUseId === toolUseId)
					if (idx !== -1) {
						const realIdx = prev.length - 1 - idx
						return [
							...prev.slice(0, realIdx),
							{ ...prev[realIdx], toolParams, content: '' /* 清空 streaming 文本，正式结果在 toolResult 里 */ },
							...prev.slice(realIdx + 1),
						]
					}
				}
				// streaming=true（首次）或没找到占位：新建工具消息
				let base = prev
				if (prev.length > 0) {
					const last = prev[prev.length - 1]
					if (last.isPartial && (last.role === 'assistant' || last.role === 'reasoning')) {
						base = [...prev.slice(0, -1), {
							...last,
							isPartial: false,
							...(last.role === 'reasoning' ? { charCount: last.content.length } : {}),
						}]
					}
				}
				return [...base, {
					id: deps.nextMsgId(), role: "tool" as const, content: "",
					toolName, toolUseId, toolSuccess: undefined, isPartial: true, toolParams,
					createdAt: Date.now(),
				}]
			})
		} else if (type === "tool_call_result") {
			const toolUseId  = (e as any).toolUseId as string
			const success    = (e as any).success   as boolean
			let   toolResult = (e as any).result    as string | undefined
			// 工具结果也算接收到的数据
			if (toolResult) deps.bumpRecv(toolResult.length)
			// 超大 toolResult（log 转储 / 大文件 grep）截 200KB，避免单条消息吃几 MB 内存
			const TOOL_RESULT_CAP = 200 * 1024
			if (toolResult && toolResult.length > TOOL_RESULT_CAP) {
				const head = toolResult.slice(0, TOOL_RESULT_CAP / 2)
				const tail = toolResult.slice(-TOOL_RESULT_CAP / 2)
				toolResult = head + `\n\n... [中段省略 ${toolResult.length - TOOL_RESULT_CAP} 字]\n\n` + tail
			}
			deps.setMessages((prev) => {
				const idx = [...prev].reverse().findIndex(m => m.role === "tool" && m.toolUseId === toolUseId)
				if (idx === -1) return prev
				const realIdx = prev.length - 1 - idx
				return [
					...prev.slice(0, realIdx),
					// ✨ 关键：清空 liveOutput（已被 toolResult 替代），释放 streaming 期间累积的内存
					{ ...prev[realIdx], isPartial: false, toolSuccess: success, toolResult, liveOutput: undefined },
					...prev.slice(realIdx + 1),
				]
			})
		} else if (type === "error") {
			const errMsg = (e as any).message ?? "未知错误"
			// 把所有 isPartial 的消息收尾（reasoning/tool/assistant），避免留下"执行中..."转圈
			deps.setMessages((prev) => {
				const cleaned = prev.map(m => {
					if (!m.isPartial) return m
					if (m.role === 'tool') {
						return {
							...m,
							isPartial: false,
							toolSuccess: false,
							toolResult: m.toolResult || '[任务已中断]',
						}
					}
					if (m.role === 'reasoning') {
						return { ...m, isPartial: false, charCount: m.content.length }
					}
					// assistant / 其他
					return { ...m, isPartial: false }
				})
				return [...cleaned, {
					id: deps.nextMsgId(),
					role: "error" as const,
					content: errMsg,
					createdAt: Date.now(),
				}]
			})
			deps.pushError('agent', errMsg, (e as any).sessionId as string | undefined)
			deps.onPetError?.()
			// 清除限流提示、sending、followup 等残留状态
			deps.setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
			deps.setSending(false)
		}
		// 仅当用户在底部时才 auto-scroll（避免打断向上翻阅读）
		deps.maybeScrollToBottom()
	}

	return {
		handle,
		resetAbortedAt: () => { _abortedAt = 0 },
	}
}
