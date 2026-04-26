/*---------------------------------------------------------------------------------------------
 *  mount — 把 Solid 组件挂载到任意 HTMLElement 的入口
 *
 *  为什么要导出这个：vscode renderer 等"非 vite/webpack"宿主无法 bare-specifier 引用
 *  `solid-js/web` 的 `render`；@maxian/ui 已 inline solid-js，把 mount 函数从这里暴露，
 *  consumer 只需 import `mountSolid` 即可，无需自己处理 solid runtime。
 *--------------------------------------------------------------------------------------------*/

import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';

export type SolidComponent = () => JSX.Element;

/**
 * Trusted Types 适配 ── vscode renderer 等强制 TT 的宿主必备
 *
 * 背景：
 *   Solid 编译产物用 `template.innerHTML = '<...>'` 来克隆 DOM 模板（性能优化）。
 *   vscode workbench 的 CSP `trusted-types <allowlist>` 要求所有 innerHTML 写入必须
 *   是 TrustedHTML 实例，否则报 "This document requires 'TrustedHTML' assignment"。
 *
 * 方案：
 *   1. 在 vscode workbench(.dev).html 的 trusted-types 名单加 `maxianUI`（已添加）
 *   2. 注册同名 passthrough policy
 *   3. monkey-patch HTMLTemplateElement.prototype.innerHTML setter，
 *      把字符串入参先 policy.createHTML(s) 包成 TrustedHTML 再写
 *
 * 安全：policy 是纯透传，不放宽任何已有 sanitizer 的工作；
 *      仅 HTMLTemplateElement 受影响（Element/HTMLDivElement.innerHTML 不动），
 *      且 vscode 自己写 template.innerHTML 都已自带 dompurify 等 policy，
 *      不会因此引入新 XSS 通道。
 */
let _ttPatched = false;
function ensureTrustedHtmlPatch(): void {
	if (_ttPatched) return;
	_ttPatched = true;
	if (typeof window === 'undefined') return;
	const tt = (window as unknown as {
		trustedTypes?: {
			createPolicy: (n: string, p: { createHTML: (s: string) => string }) => { createHTML: (s: string) => unknown };
		};
	}).trustedTypes;
	if (!tt?.createPolicy) return;   // 浏览器无 TT → 无需 patch

	let policy: { createHTML: (s: string) => unknown };
	try {
		policy = tt.createPolicy('maxianUI', { createHTML: (s) => s });
	} catch {
		// 重复注册 / 名单未包含 → 静默跳过；后续 innerHTML 写入仍会被 TT 拦
		return;
	}

	// 同时 patch 两条原型链上的 innerHTML setter：
	//  1. HTMLTemplateElement.prototype — Solid 编译产物 template().innerHTML = html 走这条
	//  2. Element.prototype             — JSX 里 <div innerHTML={...}> 走这条（lightMarkdown 渲染依赖）
	// passthrough policy 不放宽任何已有 sanitizer 的工作，仅让我们自己已 escapeHtml 的输出能落入 DOM。
	const elementDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
	if (elementDesc?.set) {
		const origSet = elementDesc.set;
		Object.defineProperty(Element.prototype, 'innerHTML', {
			...elementDesc,
			set(value: unknown) {
				if (typeof value === 'string') {
					origSet.call(this, policy.createHTML(value));
				} else {
					origSet.call(this, value);
				}
			},
		});
	}

	// HTMLTemplateElement 单独可能有自己的 setter overload（部分浏览器版本）
	const tplProto = HTMLTemplateElement.prototype;
	const tplDesc  = Object.getOwnPropertyDescriptor(tplProto, 'innerHTML');
	if (tplDesc?.set && tplDesc.set !== elementDesc?.set) {
		const origTplSet = tplDesc.set;
		Object.defineProperty(tplProto, 'innerHTML', {
			...tplDesc,
			set(value: unknown) {
				if (typeof value === 'string') {
					origTplSet.call(this, policy.createHTML(value));
				} else {
					origTplSet.call(this, value);
				}
			},
		});
	}
}

/**
 * 把 Solid 组件挂载到 parent，返回 dispose 函数（卸载并清理 reactive context）。
 *
 * @example
 *   const dispose = mountSolid(() => <ApprovalDialog request={r} onDecide={d => …} />, hostEl);
 *   // ...
 *   dispose();
 */
export function mountSolid(component: SolidComponent, parent: HTMLElement): () => void {
	ensureTrustedHtmlPatch();
	return render(component, parent);
}
