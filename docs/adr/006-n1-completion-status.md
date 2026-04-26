# ADR-006: N 期完成度记录与剩余 backlog

- 状态：Accepted
- 日期：2026-04-26

## 背景

N 期（近期任务，对标 [ADR-003](./003-refactor-roadmap.md)）目的是为新形态铺路。
经过 K1-K8（部分）的推进，确立**契约层完整 + 1 个工具样板**为 N 期"已就绪"边界。
本 ADR 记录已完成项与剩余项的精确状态、剩余项的清单与可独立推进的方式。

## 已完成（commit 链 → main 分支）

| ID | 内容 | Commit |
|---|---|---|
| K1 (N1c) | `MaxianPlatform` 加 6 个可选字段（fileWatcher / skills / reporter / tenant / clock / lsp）；新建 `ITenantContext`、`IClock`、`ILspService` 接口 | `7902633` |
| K2 (N1d) | `IMessageBus.MaxianEvent` union 补 9 种事件类型（与 server 实际 emit 全对齐）| `7902633` |
| K3 (N4) | `X-Maxian-Protocol: 1` header（SDK 自动带）+ `ProtocolMiddleware`（server 端 logging-only）+ `/health` 返回 `serverProtocol` | `7902633` |
| K4 (Backlog) | `file_snapshots` 表加 `action` 列 + 自动迁移 + emit/route/SDK/前端全链路适配 | `7902633` |
| K5 (Backlog) | 历史会话 token 从 `history_entries` 内容估算回填（误差 ±20%，启动时跑一次） | `7902633` |
| K6 (Backlog) | 码弦IDE TagExtractor 失败降级 + 不刷屏日志 | IDE 仓 `080b3b02b` |
| K7 (N1b) | `packages/core/src/adapters/NodePlatform.ts` 显式化 + `createNodePlatform()` 工厂 + 子路径导出 | (待 commit) |
| K8 (N1) 契约 | `IFileSystem` 加 7 个可选 sync 方法；`IToolContext` 加 `platform?` 字段；`tools/platformFs.ts` helper（优先 platform / 降级 node:fs）；样板工具 `lsTool.ts` 完成改造 | (待 commit) |

## 剩余（未在本对话内完成的 K8 工具改造 + K9 / K10 / K11）

### K8b：剩余 8 个工具按 lsTool 样板模式改造 ✅ 完成

每个工具改造步骤（参照 `lsTool.ts` 改动）：
1. `import { platformFs, type ToolFs } from './platformFs.js'`
2. 函数首行 `const pf = platformFs(ctx);`
3. 把所有 `fs.readFileSync(p, ...)` → `pf.readFileSync(p, ...)`，其他 7 个方法同理
4. 沿用 `node:fs` 仅作 `fs.Stats` / `fs.Dirent` 类型用途
5. typecheck + 该工具的回归测试

完成清单：

| 文件 | 工具入口走 platformFs | 状态 |
|---|---|---|
| `grepTool.ts` | path 越界检查 (existsSync) | ✅ |
| `globTool.ts` | walkFiles + 入口 (3) | ✅ |
| `searchFilesTool.ts` | 入口 + 递归 + 单文件读 (5) | ✅ |
| `listFilesTool.ts` | getIgnoreRules + 入口 (4) | ✅（listDirAsync 递归 helper 保留 fs，作为 K8c 后续） |
| `readFileTool.ts` | 入口 + 模糊匹配 + stat (4) | ✅（图片 binary buffer / openSync 等保留 fs） |
| `writeToFileTool.ts` | 入口 + mkdir + write (4) | ✅ |
| `applyPatchTool.ts` | dry-run readFileSync + 写入 (5) | ✅ |
| `bashTool.ts` / `executeCommandTool.ts` | child_process | **不在 K8 范围**：terminal 抽象由 ITerminal 处理（K8c 后续） |

实际工作量：约 1.5 小时（含 typecheck + 调试 mtimeMs → mtime 字段适配）。

### K8c：内部递归 helper 收尾 ✅ 完成

后续追加：把 K8b 阶段保留 fs 直调的内部 helper 也走 platformFs。

| 文件 | 改动 |
|---|---|
| `IFileSystem.ts` | 加 3 个可选 sync 方法：`lstatSync` / `realpathSync` / `readBinaryFileSync` |
| `platformFs.ts` | 对应三个方法加入 ToolFs 接口 + fallback 实现 |
| `lsTool.ts` | `pf.statSync` → `pf.lstatSync`（正确不解符号链接）|
| `listFilesTool.ts` | `listDirAsync` 接收 pf 参数；`fs.realpathSync` / `fs.readdirSync` / `getIgnoreRules` / `getFileSize` 全走 pf |
| `readFileTool.ts` | binary 检测 `openSync/readSync/closeSync` → `pf.readBinaryFileSync`；图片 base64 走 pf；`readFileWithEncoding` 接收 pf 参数 |

最终核验：9 个工具入口 fs.*Sync 仅剩 3 处（lsTool 注释 + listFilesTool getIgnoreRules 的 `pf? : fs` 三元 fallback），实质清零。

不在 K8 范围（独立子任务）：
- `bashTool.ts` / `executeCommandTool.ts`：child_process 直调，属于 ITerminal 抽象（独立任务 K8d）
- `truncate.ts` / `grepTool.ts findRgPath`：写到 `~/.maxian/` 系统级目录 / 探测系统二进制路径，与 platform.fs 无关，保留 fs 直调合理

### K9：码弦IDE 切到 `@maxian/core`（N3）

**核心动作**：删除 `third-party/tianhe-zhikai-ide/src/vs/workbench/contrib/maxian/common/tools/` 下与 core 同名的工具实现，改为：
- 新建 `VSCodePlatform.ts`（实现 `MaxianPlatform`，桥接 `vscode.workspace.fs` / `vscode.window.terminal` 等）
- IDE 自己的 `maxianService.ts` / `toolExecutorImpl.ts` 改为调用 `@maxian/core` 的工具，传入 VSCodePlatform

预估：5-7 天（含 IDE 完整回归测试）。**强烈依赖 K8b 完成**（core 工具能脱离 node:fs 在 VSCode 环境跑）。

### K10 + K11：抽 `@maxian/ui` 包（N2）

**核心动作**：把 `apps/desktop/src/App.tsx`（~8500 行）按 6 大组件拆出到 `packages/ui/`：

| 子 PR | 内容 | 预估行数 |
|---|---|---|
| K10 | MessageList + MessageBubble + ToolCallCard | ~3000 |
| K11a | ApprovalDialog + SlashCommandPalette + FileChangeTree | ~1500 |
| K11b | TokenUsageBar + DiffViewer + TerminalPanel | ~1200 |
| K11c | hooks + stores | ~1000 |
| K11d | App.tsx 瘦身收尾，目标 < 2000 行 | 剩余清理 |

预估：4-5 天（每子 PR 必须视觉零回归 + 完整回归清单 PASS）。

## 决策

- **N 期**视为"契约层已锁定 + 1 工具样板验证可行"即可结题
- K8b / K9 / K10 / K11 列为**独立 backlog 任务**，每项可在专门时段推进
- 任何新形态接入工作（M 期）均可基于当前契约层启动；新形态遇到的 core 工具问题（如 Web 没 sync fs）按 K8b 模板继续异步化即可

## 影响

- 当前 Desktop / 码弦IDE 两种形态**完全不受影响**（K8 改 lsTool 仅一行行为：从 fs 直调 → ctx.platform.fs 优先 / 降级 fs，行为等价）
- 协议版本 `X-Maxian-Protocol: 1` 已正式使用，未来破坏性改动可在中间件改 logging-only → 426 拒绝
- `MaxianPlatform` 合约已稳定，未来任何 Adapter 实现都基于此

## 未来重启 K8b 的指令

> 请按 `lsTool.ts` 模板继续改造 `grepTool.ts` → `globTool.ts` → `searchFilesTool.ts` → `listFilesTool.ts` → `readFileTool.ts` → `writeToFileTool.ts` → `applyPatchTool.ts`，每个工具一个原子 commit + typecheck + sidecar 重建 + 跑 docs/regression-checklist.md 对应分类。
