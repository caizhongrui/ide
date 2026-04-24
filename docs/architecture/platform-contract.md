# Platform Contract — `MaxianPlatform` 接口集

`@maxian/core` 与宿主的契约。每种客户端形态需提供一个 `MaxianPlatform` 实现。

位置：`packages/core/src/interfaces/`

## 1. 接口清单

| 接口 | 必填 | 用途 |
|---|---|---|
| `IFileSystem` | ✅ | 文件读写 |
| `ITerminal` | ✅ | 命令执行（短命令 / 流式） |
| `IWorkspace` | ✅ | 工作区根路径、相对路径换算 |
| `IMessageBus` | ✅ | Core → UI 事件流 + UI → Core 命令 |
| `IConfiguration` | ✅ | 配置读写（兼容 VSCode IConfigurationService 子集）|
| `IStorage` | ✅ | 持久化键值（会话历史等）|
| `IAuthProvider` | ✅ | 凭据管理 |
| `IFileWatcher` | ⚠️ 可选 | 外部文件变更监听（stale-overwrite 依赖） |
| `ISkillService` | ⚠️ 可选 | Skills 加载 |
| `IBehaviorReporter` | ⚠️ 可选 | 行为埋点（默认 `NoopBehaviorReporter`） |
| `ITenantContext` | ⚠️ 可选 | 多租户上下文（云端必填） |
| `IClock` | ⚠️ 可选 | 可注入时钟（测试/回放） |
| `ILspService` | ⚠️ 可选 | LSP 诊断（IDE 形态专属） |

## 2. 聚合类型

```ts
// packages/core/src/interfaces/index.ts
export interface MaxianPlatform {
  fs: IFileSystem;
  terminal: ITerminal;
  workspace: IWorkspace;
  messageBus: IMessageBus;
  config: IConfiguration;
  storage: IStorage;
  auth: IAuthProvider;
  // 可选扩展
  fileWatcher?: IFileWatcher;
  skills?: ISkillService;
  reporter?: IBehaviorReporter;
  tenant?: ITenantContext;
  clock?: IClock;
  lsp?: ILspService;
}
```

## 3. 各形态 Adapter 实现要点

### NodePlatform（Desktop sidecar / 云端 worker）

```ts
export function createNodePlatform(opts: {
  workspaceRoot: string;
  tenantId?: string;
  userId?: string;
  sessionDb?: string;
  clock?: IClock;
}): MaxianPlatform
```

- `IFileSystem` 基于 `node:fs/promises`
- `ITerminal` 基于 `child_process.spawn`
- `IStorage` 基于 `better-sqlite3` / `bun:sqlite`

### TauriPlatform（Desktop）

Desktop **不直接构造 Platform** — 通过 SDK 走 HTTP 消费 sidecar 的 NodePlatform。Tauri 壳层只管生命周期（启动 sidecar、文件对话框、系统通知、自动更新）。

### VSCodePlatform（码弦IDE + 官方插件）

```ts
export function createVSCodePlatform(ctx: vscode.ExtensionContext): MaxianPlatform
```

- `IFileSystem` → `vscode.workspace.fs`
- `ITerminal` → `vscode.window.createTerminal`
- `IStorage` → `ctx.globalState` / `ctx.workspaceState`
- `IAuthProvider` → `ctx.secrets`
- `IConfiguration` → `vscode.workspace.getConfiguration('maxian')`（结构兼容）
- 可选：`lsp` → `vscode.languages`

### BrowserPlatform（Web）

所有方法通过 SDK RPC 到 `apps/cloud/`，浏览器端本身不执行文件 IO / 命令。

### IDEAPlatform

**不实现 MaxianPlatform** — Kotlin 侧启动 Bun sidecar，其内部使用 NodePlatform。JVM ↔ sidecar 通过 HTTP + SSE。

### CloudWorkerPlatform（云端）

在 NodePlatform 之上叠一层多租户/沙箱拦截：
- `fs.resolvePath()` 强制路径 startsWith 沙箱根
- `terminal.execute()` 强制 cwd 在沙箱内、命令走白名单
- `tenant.recordUsage()` 每次 token 消耗写 `usage_ledger`

## 4. 当前缺口（N 期治理目标）

- [ ] `MaxianPlatform` 加可选字段 `fileWatcher / skills / reporter / tenant / clock / lsp`
- [ ] `ITenantContext.ts` + `IClock.ts` + `ILspService.ts` 新建
- [ ] `packages/core/src/adapters/NodePlatform.ts` 显式化（当前散落在 server 中）
- [ ] `packages/core/src/tools/*.ts` 约 50 处 `fs.*Sync` 替换为 `ctx.platform.fs.*`
