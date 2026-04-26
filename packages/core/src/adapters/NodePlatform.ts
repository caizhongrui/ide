/*---------------------------------------------------------------------------------------------
 *  Maxian Core — NodePlatform 适配器
 *
 *  把 Node.js 标准库（fs/promises、child_process、os）封装为 MaxianPlatform 接口实现。
 *
 *  使用场景：
 *  - @maxian/server 的 sidecar 运行时（Desktop / VSCode 插件 sidecar / IDEA 插件 sidecar）
 *  - @maxian/worker 云端形态（基础层，叠加 CloudWorkerPlatform 多租户拦截）
 *
 *  注意：本文件**只声明工厂签名 + 装配 stub**。真实 IFileSystem / ITerminal 实现仍可
 *  分散在 @maxian/server 内部（K8 阶段把 cli.ts 里的 fs.*Sync 全切到接口后，
 *  实现也将搬到 packages/core/src/adapters/node/ 下）。
 *
 *  详见 docs/architecture/platform-contract.md § 5.1
 *--------------------------------------------------------------------------------------------*/

import type { MaxianPlatform, IFileSystem, ITerminal, IWorkspace, IMessageBus, IConfiguration, IStorage, IAuthProvider, IClock, IFileWatcher, ISkillService, IBehaviorReporter, ITenantContext, ILspService } from '../interfaces/index.js';
import { LocalTenantContext, SystemClock, NoopBehaviorReporter } from '../interfaces/index.js';

/**
 * 创建 Node.js 平台 MaxianPlatform 装配选项。
 *
 * 必填部分（fs / terminal / workspace / messageBus / config / storage / auth）由调用方提供 ——
 * 这些通常是 server 侧已有的实现（NodeFileSystem / NodeTerminal / SqliteStorage 等）。
 *
 * 可选字段提供合理默认（LocalTenantContext / SystemClock / NoopBehaviorReporter）。
 */
export interface NodePlatformOptions {
	// ── 必填能力 ─────────────────────────────────────────────
	fs: IFileSystem;
	terminal: ITerminal;
	workspace: IWorkspace;
	messageBus: IMessageBus;
	config: IConfiguration;
	storage: IStorage;
	auth: IAuthProvider;

	// ── 可选 ─────────────────────────────────────────────────
	/** 工作区根（用于 LocalTenantContext sandboxRoot；不传则取 workspace.getRootPath() ?? cwd） */
	workspaceRoot?: string;
	fileWatcher?: IFileWatcher;
	skills?: ISkillService;
	reporter?: IBehaviorReporter;
	tenant?: ITenantContext;
	clock?: IClock;
	lsp?: ILspService;
}

/**
 * 装配 Node 平台 MaxianPlatform。
 *
 * 默认行为：
 * - tenant：未传 → LocalTenantContext('local', 'local', sandboxRoot=workspaceRoot)
 * - clock：未传 → SystemClock
 * - reporter：未传 → NoopBehaviorReporter
 * - 其他可选字段：未传则保持 undefined（core 内部按 truthy 检查使用）
 *
 * @example
 * ```ts
 * const platform = createNodePlatform({
 *   fs: new NodeFileSystem(),
 *   terminal: new NodeTerminal(),
 *   workspace: new SingleRootWorkspace(workspaceRoot),
 *   messageBus: new EventEmitterMessageBus(),
 *   config: new FileConfiguration('~/.maxian/config.json'),
 *   storage: new SqliteStorage('~/.maxian/sessions.sqlite'),
 *   auth: new FileAuthProvider('~/.maxian/auth.json'),
 *   workspaceRoot: '/Users/me/projects/foo',
 * });
 * ```
 */
export function createNodePlatform(opts: NodePlatformOptions): MaxianPlatform {
	const sandboxRoot = opts.workspaceRoot
		?? opts.workspace.getRootPath()
		?? (typeof process !== 'undefined' ? process.cwd() : '/');

	return {
		fs: opts.fs,
		terminal: opts.terminal,
		workspace: opts.workspace,
		messageBus: opts.messageBus,
		config: opts.config,
		storage: opts.storage,
		auth: opts.auth,
		fileWatcher: opts.fileWatcher,
		skills: opts.skills,
		reporter: opts.reporter ?? new NoopBehaviorReporter(),
		tenant: opts.tenant ?? new LocalTenantContext(sandboxRoot),
		clock: opts.clock ?? new SystemClock(),
		lsp: opts.lsp,
	};
}

/**
 * 占位：未来 K8 阶段把 cli.ts 里散落的 NodeFileSystem / NodeTerminal 等实现搬到这里。
 * 当前阶段（K7）只确立工厂签名，让调用方知道未来的标准装配方式。
 */
