/*---------------------------------------------------------------------------------------------
 *  injectStyleOnce — 把组件 CSS 一次性注入 document.head
 *
 *  用法：每个组件 import 自己的 .css?inline，调用本函数注入。
 *  以 id 去重：同一个 id 不会重复插入 <style>。
 *
 *  CSS 用 var(--maxian-X, fallback) 写法，consumer 可通过 :root 覆盖主题。
 *--------------------------------------------------------------------------------------------*/

const _injected = new Set<string>();

export function injectStyleOnce(id: string, css: string): void {
	if (typeof document === 'undefined') return;   // SSR 安全
	if (_injected.has(id)) return;
	_injected.add(id);

	// 已存在同 id 的 <style>（例如热重载场景）→ 不重复注入
	if (document.getElementById(id)) return;

	const style = document.createElement('style');
	style.id          = id;
	style.textContent = css;
	document.head.appendChild(style);
}
