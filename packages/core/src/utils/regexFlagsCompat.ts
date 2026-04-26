/*---------------------------------------------------------------------------------------------
 *  regexFlagsCompat
 *
 *  把 Perl / PCRE 风格的内联标志（如 (?i) / (?m) / (?s) / (?ix)）转成 JS RegExp 的 flags。
 *  AI 经常生成 Perl 风格 regex（特别是 Python/Java 训练语料污染），直接传 new RegExp() 会
 *  抛 "Invalid regular expression: unrecognized character after (?"。本函数把它们翻译成 JS 等价。
 *
 *  支持：
 *    (?i)        → flag 'i'                      （case-insensitive）
 *    (?m)        → flag 'm'                      （multi-line ^/$）
 *    (?s)        → flag 's'                      （dot matches newline）
 *    (?x)        → 不支持（JS 无 free-spacing），剥掉 x，但保留模式原样
 *    (?-i)       → 取消 i flag
 *    (?ims)      → 任意组合
 *
 *  仅支持出现在**最开头**的内联标志（PCRE 也支持中段，但 AI 生成几乎都在开头）。
 *--------------------------------------------------------------------------------------------*/

/**
 * 把 pattern 开头的 Perl 风格 (?flags) 提取并转为 JS flags。
 * 返回 { pattern: 去掉前缀后的纯模式, flags: 合并的最终 flags 字符串 }。
 *
 * @param pattern  原始模式串（可能以 (?flags) 开头）
 * @param baseFlags  调用方默认想要的 flags（如 'g' / 'gi'）；提取出的 flags 会与之合并去重
 */
export function normalizePerlInlineFlags(pattern: string, baseFlags: string = ''): { pattern: string; flags: string } {
	if (!pattern || typeof pattern !== 'string') {
		return { pattern: pattern ?? '', flags: baseFlags };
	}

	// 匹配开头的 (?<add>[ims]*-?[ims]*) 形式，例如 (?i) (?ims) (?i-s) (?-i)
	const m = pattern.match(/^\(\?([ims]*)(?:-([ims]*))?\)/);
	if (!m) {
		return { pattern, flags: baseFlags };
	}

	const adds  = (m[1] || '').toLowerCase();
	const drops = (m[2] || '').toLowerCase();
	const stripped = pattern.slice(m[0].length);

	// 合并 flags（去重 + 后续去除 drops 中的）
	const set = new Set<string>(baseFlags);
	for (const ch of adds)  set.add(ch);
	for (const ch of drops) set.delete(ch);

	return { pattern: stripped, flags: Array.from(set).join('') };
}
