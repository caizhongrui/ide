/*---------------------------------------------------------------------------------------------
 *  工具调用参数修复（Tool-Call Argument Repair）
 *
 *  目的：治理模型输出**截断 / 残缺**的工具参数 JSON —— 例如少了结尾的 `}` / `]`、
 *  断在字符串中间、悬空的 key（"foo":）、尾随逗号等。这是「同模型下码弦比 Claude Code
 *  生成质量差、有时少生成 { 导致解析失败」的直接成因之一：一旦 JSON.parse 失败，
 *  整个工具调用会被丢弃，模型只能重来 → 浪费轮次 + 任务卡顿。
 *
 *  设计：纯字符串处理，**无任何外部依赖**（不 import fs / vscode / child_process），
 *  遵守 @maxian/core 架构纪律，可被 server / IDE / 任意形态复用。
 *
 *  对标：gitee.com/reasonix/DeepSeek-Reasonix `src/repair/truncation.ts`。
 *--------------------------------------------------------------------------------------------*/

export interface TruncationRepairResult {
	/** 修复后的 JSON 字符串（fallback 时为 "{}"） */
	repaired: string;
	/** 是否相对原始输入发生了改动 */
	changed: boolean;
	/** 修复动作说明（用于日志诊断） */
	notes: string[];
	/** true = 所有修复尝试都失败、回退到 "{}"，原始参数不可恢复（调用方应丢弃而非误用 {}） */
	fallback: boolean;
}

/**
 * 尝试修复一段可能被截断的 JSON 文本。
 *
 * 策略（仅做**本地补全**，不臆造内容）：
 *  1. 已经可解析 → 原样返回（changed=false）
 *  2. 扫描括号 / 字符串栈，记录最后一个有意义字符位置
 *  3. 去尾随逗号、悬空 key 补 null、闭合未结束的字符串、按栈逆序补齐 } ] "
 *  4. 仍不可解析 → fallback=true（调用方据此决定丢弃）
 */
export function repairTruncatedJson(input: string): TruncationRepairResult {
	const notes: string[] = [];

	if (!input || !input.trim()) {
		return { repaired: '{}', changed: input !== '{}', notes: ['空输入 → {}'], fallback: false };
	}

	// 快路径：本身就是合法 JSON
	try {
		JSON.parse(input);
		return { repaired: input, changed: false, notes: [], fallback: false };
	} catch {
		/* 落入修复流程 */
	}

	const stack: Array<'{' | '[' | '"'> = [];
	let escaped = false;
	let inString = false;
	let lastSignificant = -1;

	for (let i = 0; i < input.length; i++) {
		const c = input[i]!;
		if (!/\s/.test(c)) lastSignificant = i;

		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (c === '\\') {
				escaped = true;
				continue;
			}
			if (c === '"') {
				inString = false;
				stack.pop();
			}
			continue;
		}
		if (c === '"') {
			inString = true;
			stack.push('"');
			continue;
		}
		if (c === '{' || c === '[') {
			stack.push(c);
		} else if (c === '}' || c === ']') {
			stack.pop();
		}
	}

	// 截掉尾部空白（截断往往断在空白或半个 token 处）
	let s = input.slice(0, lastSignificant + 1);

	// 尾随逗号会阻断重新解析
	if (/,$/.test(s)) {
		s = s.replace(/,$/, '');
		notes.push('去除尾随逗号');
	}

	// 断在 "key": 之后没有值 → 补 null
	if (/"\s*:\s*$/.test(s)) {
		s += ' null';
		notes.push('悬空 key 补 null');
	}

	// 断在字符串中间 → 闭合字符串
	if (inString) {
		s += '"';
		stack.pop();
		notes.push('闭合未结束的字符串');
	}

	// 按栈逆序补齐未闭合的结构
	while (stack.length > 0) {
		const top = stack.pop();
		if (top === '{') s += '}';
		else if (top === '[') s += ']';
		else if (top === '"') s += '"';
	}

	try {
		JSON.parse(s);
		return { repaired: s, changed: s !== input, notes, fallback: false };
	} catch (err) {
		const preview =
			input.length <= 500 ? input : `${input.slice(0, 500)} …[+${input.length - 500} 字符]`;
		notes.push(`回退到 {}：${(err as Error).message}`);
		notes.push(`不可恢复的截断 —— 原始参数预览：${preview}`);
		return { repaired: '{}', changed: true, notes, fallback: true };
	}
}
