#!/usr/bin/env node
/**
 * 同步 maxian-server/bin/ 下的二进制到 src-tauri/bin/。
 * 若目标二进制不存在则自动调用 build-bin.mjs 生成。
 *
 * 调用：
 *   node scripts/sync-sidecar.mjs             → 当前平台
 *   node scripts/sync-sidecar.mjs darwin-arm64
 *   node scripts/sync-sidecar.mjs all          → 所有平台（Bun 跨平台编译）
 *
 * 副产品：把 @lydell/node-pty + 平台特定原生模块复制到 src-tauri/bin/maxian-deps/
 * 让 sidecar 运行时能加载 PTY（Bun --compile 不带 .node 原生模块进二进制）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync, cpSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');
// 新 monorepo 结构：apps/desktop/ → packages/server/ 走 ../../packages/server
const SERVER_ROOT  = path.resolve(DESKTOP_ROOT, '..', '..', 'packages', 'server');
const SIDECAR_DIR  = path.join(DESKTOP_ROOT, 'src-tauri', 'bin');
const SRC_BIN_DIR  = path.join(SERVER_ROOT, 'bin');

function run(cmd, args, cwd) {
	console.log(`$ ${cmd} ${args.join(' ')}  (cwd=${path.relative(DESKTOP_ROOT, cwd)})`);
	const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
	if (r.status !== 0) {
		console.error(`命令失败 (exit=${r.status})`);
		process.exit(r.status ?? 1);
	}
}

const TARGETS_TABLE = {
	'darwin-arm64': 'maxian-server-aarch64-apple-darwin',
	'darwin-x64':   'maxian-server-x86_64-apple-darwin',
	'linux-x64':    'maxian-server-x86_64-unknown-linux-gnu',
	'linux-arm64':  'maxian-server-aarch64-unknown-linux-gnu',
	'win32-x64':    'maxian-server-x86_64-pc-windows-msvc.exe',
};

function currentKey() {
	return `${process.platform}-${process.arch}`;
}

const arg = (process.argv[2] ?? 'current').toLowerCase();
const key = arg === 'current' ? currentKey() : arg;

// 1. 若目标 binary 不存在，调用 build-bin.mjs 生成
const needBuild = arg === 'all'
	? true
	: !existsSync(path.join(SRC_BIN_DIR, TARGETS_TABLE[key] ?? ''));

if (needBuild) {
	console.log(`[sync-sidecar] 目标 binary 不存在，开始构建...`);
	// 先确保 TS 产物是新的。用 pnpm 跨平台触发（Windows 下是 pnpm.cmd）
	const pm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
	// 关键：必须先 build @maxian/core（server 通过 import '@maxian/core' 间接吃 core 的 dist/，
	// 不主动 rebuild 会导致 core 修改不进 sidecar binary）
	const CORE_ROOT = path.resolve(SERVER_ROOT, '..', 'core');
	if (existsSync(path.join(CORE_ROOT, 'package.json'))) {
		run(pm, ['run', 'build'], CORE_ROOT);
	}
	run(pm, ['run', 'build'], SERVER_ROOT);
	// 再跑 build-bin
	run('node', [path.join(SERVER_ROOT, 'scripts', 'build-bin.mjs'), arg === 'current' ? key : arg], SERVER_ROOT);
} else {
	console.log(`[sync-sidecar] 目标 binary 已存在，跳过构建`);
}

// 2. 把产物拷贝到 src-tauri/bin/
mkdirSync(SIDECAR_DIR, { recursive: true });
if (!existsSync(SRC_BIN_DIR)) {
	console.error(`[sync-sidecar] ${SRC_BIN_DIR} 不存在`);
	process.exit(1);
}
const entries = readdirSync(SRC_BIN_DIR).filter(f => f.startsWith('maxian-server-'));
if (entries.length === 0) {
	console.error(`未在 ${SRC_BIN_DIR} 找到任何 maxian-server-* 二进制`);
	process.exit(1);
}

for (const entry of entries) {
	const src = path.join(SRC_BIN_DIR, entry);
	const dst = path.join(SIDECAR_DIR, entry);
	copyFileSync(src, dst);
	const sizeMB = (statSync(dst).size / 1024 / 1024).toFixed(1);
	console.log(`✅ ${entry} (${sizeMB} MB) → src-tauri/bin/`);
}

// 3. 把 @lydell/node-pty + 平台特定原生模块（pty.node）复制到 src-tauri/bin/maxian-deps/
//    Sidecar 二进制启动时通过 createRequire(<bin dir>/maxian-deps/sentinel.js) 解析到这里。
//    每个平台的 pty.node 只有几百 KB，复制不会显著增加产物体积。
function copyNodePtyDeps() {
	const REPO_ROOT       = path.resolve(DESKTOP_ROOT, '..', '..');
	const REPO_NM         = path.join(REPO_ROOT, 'node_modules');
	const PNPM_DIR        = path.join(REPO_NM, '.pnpm');
	const TARGET_DEPS     = path.join(SIDECAR_DIR, 'maxian-deps');
	const TARGET_NM       = path.join(TARGET_DEPS, 'node_modules');

	// 当前 host 平台的 node-pty + 原生包
	const hostKey = currentKey();
	const platformPkg = `@lydell/node-pty-${process.platform}-${process.arch}`;

	// 找 @lydell/node-pty（主包）
	const ptyMain = path.join(PNPM_DIR, ...readdirSync(PNPM_DIR).filter(d => d.startsWith('@lydell+node-pty@')).slice(0, 1), 'node_modules', '@lydell', 'node-pty');
	if (!existsSync(ptyMain)) {
		console.warn(`[sync-sidecar] 未找到 @lydell/node-pty 主包，跳过 deps 复制（终端工具不可用）`);
		return;
	}

	// 找平台特定原生模块包
	const nativeDir = readdirSync(PNPM_DIR).find(d => d.startsWith(`@lydell+node-pty-${process.platform}-${process.arch}@`));
	const nativePkg = nativeDir
		? path.join(PNPM_DIR, nativeDir, 'node_modules', '@lydell', `node-pty-${process.platform}-${process.arch}`)
		: null;
	if (!nativePkg || !existsSync(nativePkg)) {
		console.warn(`[sync-sidecar] 未找到 ${platformPkg} 平台原生包，跳过（终端工具在 ${hostKey} 上不可用）`);
		return;
	}

	// 复制
	mkdirSync(path.join(TARGET_NM, '@lydell'), { recursive: true });
	cpSync(ptyMain, path.join(TARGET_NM, '@lydell', 'node-pty'), { recursive: true, force: true });
	cpSync(nativePkg, path.join(TARGET_NM, '@lydell', `node-pty-${process.platform}-${process.arch}`), { recursive: true, force: true });

	// 关键：把平台原生包 ALSO 嵌进 node-pty 包内的 node_modules，
	// 这样无论调用方的 require 从哪个 anchor 来，主包 index.js 内部的
	// `require('@lydell/node-pty-<platform>-<arch>')` 都能命中（沿同级 node_modules 优先解析）。
	const ptyNestedNm = path.join(TARGET_NM, '@lydell', 'node-pty', 'node_modules', '@lydell');
	mkdirSync(ptyNestedNm, { recursive: true });
	cpSync(nativePkg, path.join(ptyNestedNm, `node-pty-${process.platform}-${process.arch}`), { recursive: true, force: true });

	// **关键 PATCH**：Bun --compile 后的 createRequire 不会向上递归搜 node_modules（即使 nested 嵌入也找不到），
	// 而且 require(<directory>) 也不会通过 package.json 的 exports/main 字段解析入口文件。
	// 解决：直接重写 node-pty/index.js，把 require(PACKAGE_NAME) 改成绝对路径的 lib/index.js —— 完全绕过 Node resolve。
	// 平台包的 entry 由其 package.json 的 "exports": "./lib/index.js" 决定，固定即可。
	const ptyIndexPath = path.join(TARGET_NM, '@lydell', 'node-pty', 'index.js');
	const platformPkgEntryRelative = `./node_modules/@lydell/node-pty-${process.platform}-${process.arch}/lib/index.js`;
	const patchedIndex = `// Patched by maxian sync-sidecar: 用绝对路径 require 平台原生包的 entry 文件，绕过 Bun --compile 的 require 解析限制
const path = require('path');
const PACKAGE_NAME = '@lydell/node-pty-${process.platform}-${process.arch}';
const PLATFORM_PKG_ENTRY = path.join(__dirname, ${JSON.stringify(platformPkgEntryRelative)});

Object.defineProperty(exports, '__esModule', { value: true });
exports.native = exports.open = exports.createTerminal = exports.fork = exports.spawn = void 0;

try {
  module.exports = require(PLATFORM_PKG_ENTRY);
} catch (e) {
  throw new Error(
    'maxian-patched node-pty: 无法加载平台原生包 ' + PACKAGE_NAME + ' (entry=' + PLATFORM_PKG_ENTRY + ')。原因: ' + e.message,
    { cause: e },
  );
}
`;
	writeFileSync(ptyIndexPath, patchedIndex);

	// ⚠️ 已知问题（2026-05-06）：Bun v1.3.4 --compile 后的二进制（以及 `bun run` 直接执行模式）
	// 在跑 @lydell/node-pty 时无法正确驱动 PTY 子进程：spawn-helper 启动后挂在
	// `open(slave_pty, O_RDWR)` 上不返回，或者 zsh exec 后立刻 exit 0 无输出。
	// 同一份 node_modules 用 Node.js 22 跑则完全正常（已验证）。
	// 暂未修复 —— 终端面板在桌面端显示空白。
	// 后续可选方案：
	//   A) Tauri Rust 侧用 portable-pty crate 直接管 PTY，frontend 改用 invoke 而非 WS
	//   B) Sidecar 启动一个 Node 子进程做 PTY 桥，Bun 通过 stdin/stdout JSON IPC 与之通信
	//   C) 等 Bun 修复 posix_spawn / PTY 子进程的运行时 bug

	// 写一个 sentinel package.json 让 createRequire 能定位
	const sentinel = path.join(TARGET_DEPS, 'package.json');
	writeFileSync(sentinel, JSON.stringify({ name: 'maxian-sidecar-deps', private: true, version: '0.0.0' }, null, 2));

	// 统计大小
	const counter = (p) => {
		let total = 0;
		for (const e of readdirSync(p, { withFileTypes: true })) {
			const fp = path.join(p, e.name);
			if (e.isDirectory()) total += counter(fp);
			else total += statSync(fp).size;
		}
		return total;
	};
	let totalBytes = 0;
	try { totalBytes = counter(TARGET_DEPS); } catch { /* ignore */ }
	console.log(`✅ @lydell/node-pty + ${platformPkg} → src-tauri/bin/maxian-deps/ (${(totalBytes / 1024).toFixed(0)} KB)`);
}

try {
	copyNodePtyDeps();
} catch (e) {
	console.warn(`[sync-sidecar] node-pty deps 复制失败（终端工具会不可用）: ${e.message}`);
}

console.log('[sync-sidecar] 完成');
