/*---------------------------------------------------------------------------------------------
 *  ChatEvent 相关 state 类型（K11b 抽离自 App.tsx）
 *
 *  这些都是 SSE 事件流驱动的 UI 状态：file_changed / token_usage / todos_updated /
 *  rate_limit / question / plan_exit / context_compacting 等。
 *  类型集中在这里方便 createChatEventHandler 引用，App.tsx 也直接从这里 import。
 *--------------------------------------------------------------------------------------------*/

export interface FileChangeEntry {
	path:   string
	action: 'modified' | 'created' | 'deleted'
}

export interface TodoItem {
	id:      string
	content: string
	status:  'pending' | 'in_progress' | 'completed' | 'cancelled'
}

export interface RateLimitState {
	active:  boolean
	resetAt: number
	attempt: number
	message: string
}

export interface QuestionRequest {
	sessionId: string
	question:  string
	options:   string[]
	multi:     boolean
}

export interface CompactingState {
	tokensCurrent: number
	willLevel2:    boolean
	manual:        boolean
	startedAt:     number
}

export interface PlanExitRequest {
	sessionId: string
	summary:   string
	steps:     string
}
