/*---------------------------------------------------------------------------------------------
 *  vite.config.ts — @maxian/ui library build
 *
 *  策略：用 vite library mode + vite-plugin-solid，产出 ESM bundle：
 *    dist/index.js          — 主入口（solid-js 作为 peer external，由宿主提供 singleton）
 *
 *  关键决策：solid-js / solid-js/web / solid-js/store 必须 external。
 *
 *  为什么 NOT inline solid-js：
 *    Solid 的响应式系统依赖**模块级单例状态**（Owner / Listener / Updates 等）。
 *    如果 inline，dist 里会带一份 Solid runtime；宿主（desktop/IDE）也有自己的 Solid runtime。
 *    两套 runtime 互不感知 → 宿主创建的 signal 在组件内 `<For>` 读不到更新，
 *    导致 setSignal 后 UI 完全不响应（已在 desktop 端复现：终端 tab 永远渲染 0 个）。
 *
 *  对各形态的影响：
 *    - Desktop（Vite）：node_modules/.pnpm/solid-js 单例 → 直接外部解析，OK。
 *    - VS Code renderer / 码弦IDE：不解析 bare specifier 的环境，需要在该宿主侧打包时
 *      用 importmap 或 alias 把 'solid-js' 指向打好的 vendor chunk，由宿主负责提供 runtime；
 *      不能在本包 inline。
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'vite';
import solid           from 'vite-plugin-solid';
import { resolve }     from 'node:path';

export default defineConfig({
	plugins: [solid()],
	build: {
		lib: {
			entry:    resolve(__dirname, 'src/index.ts'),
			formats:  ['es'],
			fileName: () => 'index.js',
		},
		outDir:      'dist',
		emptyOutDir: false,    // tsc 会先在 dist/ 写 .d.ts，别清掉
		minify:      false,    // 调试期保留可读输出；上线再 minify
		sourcemap:   true,
		rollupOptions: {
			// 关键：solid-js 全家桶必须 external，由宿主提供 runtime singleton。
			// 否则 dist 里 inline 的 Solid 与宿主的 Solid 是两套独立响应式系统，
			// 跨边界传 signal / props 会彻底失去响应性（setSignal 后 UI 不更新）。
			external: [
				'solid-js',
				'solid-js/web',
				'solid-js/store',
				'solid-js/h',
			],
			output: {
				preserveModules: false,
			},
		},
	},
});
