/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Plan Exit Tool
 *
 *  对标 OpenCode `packages/opencode/src/tool/plan.ts`
 *  Plan 模式下 AI 规划完毕后调用此工具请求切换到 Build 模式。
 *  服务端拦截此工具调用，挂起 Agent 循环并向用户展示"开始执行"确认对话框。
 *--------------------------------------------------------------------------------------------*/

export interface IPlanExitParams {
	/** 计划摘要（用于给用户确认） */
	summary:   string;
	/** 详细步骤 Markdown（可选） */
	steps?:    string;
}

export interface IPlanExitResult {
	/** 用户是否同意切换到 build 模式 */
	approved:  boolean;
	/** 用户是否拒绝并给出反馈 */
	feedback?: string;
	/**
	 * K-Plan-Cancel：用户主动按下了"取消"按钮（区别于"拒绝并反馈"）。
	 * 取消语义 = 立即停止所有动作；拒绝语义 = 根据反馈重新规划。
	 * 之前 sessionManager.cancelTask 用 feedback='任务被取消' 表达这个意图，
	 * 但 AI 看到"feedback"字段就会理解成"用户想让我改进计划"并继续行动，
	 * 触发"用户拒绝了计划但没提供反馈"这种荒诞自我对话。
	 */
	cancelled?: boolean;
}

export function formatPlanExitResult(r: IPlanExitResult): string {
	if (r.cancelled) {
		// 给 AI 一个明确的"立即停止"指令，避免它读完结果还要继续输出长串思考。
		return '[任务已被用户取消。立即停止所有动作，不再调用任何工具，本轮结束。]';
	}
	if (r.approved) return '[用户已同意，现在切换到 Build（Code）模式执行计划]';
	return `[用户拒绝当前计划${r.feedback ? `: ${r.feedback}` : ''}，请根据反馈重新规划]`;
}
