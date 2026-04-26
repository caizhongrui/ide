/*---------------------------------------------------------------------------------------------
 *  vite.config.ts — @maxian/ui library build
 *
 *  策略：用 vite library mode + vite-plugin-solid，产出**单一 ESM bundle**：
 *    dist/index.js          — 主入口（solid-js 已 inline，可直接被任何 ESM 宿主消费）
 *
 *  为什么 inline solid-js：
 *    vscode renderer 不解析 bare specifier（"solid-js"），必须把整个 runtime 打进 bundle。
 *
 *  Desktop 端虽然有自己的 solid-js 副本，但 inline 的副本只增加 ~7KB，且能确保版本一致，
 *  避免 desktop 与 IDE 端 solid 实例不一致引起的 reactive 上下文冲突。
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
			external: [],        // solid-js 必须 inline（IDE 端依赖）
			output: {
				preserveModules: false,
			},
		},
	},
});
