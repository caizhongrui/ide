# ADR-007: v0.2.17 → v0.5.0 完整功能路线图（2026 中长期规划）

- 状态：Accepted
- 日期：2026-05-06
- 作者：基于 Maxian 团队 2026-05 调研讨论

## 背景

经过两份并行调研：
- 主流 AI 编码工具 2026 最新动向调查（Claude Code / Cursor / Windsurf / Cline / Copilot / Devin / Replit 等 11 个工具）
- 码弦 Maxian 当前能力盘点（v0.2.16 截止）

得出两个结论：
1. **底子比想象的厚**：MCP / LSP / Skills / Plugin / Hooks / Auto-Approve / 多模态 / DeepSeek thinking / Batch / 上下文压缩等都已实现，与行业一线持平；本土 LLM 体验是差异化护城河。
2. **架构整改 + 主战场新功能尚有明显差距**：ADR-003 N 期遗留的 K9/K10/K11 没收尾；行业主战场（Sub-agents 真并行、MCP Tool Search 懒加载、Auto-Memory、Codebase Index、云端 Background Agent、自动 Code Review pipeline）需要补齐。

本 ADR 把这两份产出合并成一份完整的、不允许简化的、按依赖排序的执行计划，覆盖 v0.2.17 → v0.5.0。

## 决策原则

1. **不出 MVP**：每个功能按完整版交付；不为图快出阉割版本，否则后期补全的成本远高于一次做对。
2. **依赖严格遵守**：架构整改（Phase A）是其他 Phase 的硬前置，不抢跑。
3. **每个 Phase 收尾必须有 release**：v0.3.0 / v0.4.0 / v0.5.0；主分支始终可发车，不堆大 PR。
4. **可并行的并行**：A 完成后 B/C/D/E 各 Track 可分人启动；C/D 可与 E 并行。
5. **本土差异化优先**：DeepSeek/Qwen 一等公民、中文工程语境、轻量 Tauri 原生壳、中文社区 Marketplace 是不可放弃的差异点。

## 总览

```
Phase A (架构整改, blocking everything)
├─ K8d  ITerminal 抽象（去 child_process 直调）
├─ K8e  core 全异步化（去 *Sync API）            ← 主要瓶颈
├─ K8f  core 去 import 'node:*' 直调
├─ K9   IDE 切 @maxian/core，启用 VSCodePlatform
├─ K10  @maxian/ui 剩余 6 个组件抽出
└─ K11  hooks/stores + App.tsx 收尾（< 2000 行）

Phase B (Agent 能力升级, A 完成后启动)
├─ B1  Sub-agents 完整版（独立 context / worktree / background）
├─ B2  MCP Tool Search 懒加载 + 完整生命周期
├─ B3  Auto-Memory（vector store + 自动捕获）
├─ B4  Codebase Index / Repo Wiki（embedding + 增量）
└─ B5  Chrome DevTools MCP + 内嵌浏览器预览

Phase C (云端化, B1 完成后启动)
├─ C1  云端 Worker 完整实现（多租户 + 沙箱 + 队列）
├─ C2  云端控制台（提交 + 审核 + 计费）
└─ C3  Automations（cron + webhook + Slack/飞书）

Phase D (自动化 pipeline, B1+C1 完成后启动)
├─ D1  自动 Code Review pipeline（含修复闭环）
└─ D2  Spec-Driven Development 完整闭环

Phase E (形态扩展, A 完成后并行启动)
├─ E1  VS Code 官方插件
├─ E2  Web 形态正式版
└─ E3  IDEA 插件

Phase F (差异化, 长期)
├─ F1  中文社区 Marketplace（Skills + MCP + Plugin）
└─ F2  Voice 输入中文优化

总周期：9-12 月（单人全职估算；多人并行可压缩到 6-8 月）
```

---

## Phase A — 架构整改（v0.2.17 → v0.3.0）

**目标**：清空 ADR-003 N 期遗留，让所有形态共享同一套 core；让 App.tsx 瘦身到 < 2000 行。

**预估**：50-65 天单人（10-13 周）

### A.K8d — ITerminal 抽象，去 child_process 直调

| 项 | 详情 |
|---|---|
| 目的 | core 工具不再直接 `import 'node:child_process'`，全走 `ctx.platform.terminal` |
| 涉及文件 | `packages/core/src/tools/bashTool.ts` / `executeCommandTool.ts` / `tools/terminalRegistry.ts` 等 |
| 接口扩展 | `ITerminal` 加 `executeCommand(cmd, opts)` / `spawnPty(cmd, opts)` / `streamOutput()` |
| 适配器 | `NodeTerminal` (Node 原生) + `VSCodeTerminal` (VS Code Terminal API) |
| 验收 | `grep "child_process" packages/core/src/tools/` 为空 |
| 工作量 | **5-7 天** |

### A.K8e — core 全异步化，去 *Sync API（最大块）

| 项 | 详情 |
|---|---|
| 目的 | core 在 VS Code renderer / 浏览器环境（CSP 禁同步 fs）能跑 |
| 涉及文件 | core 内所有 `readFileSync / writeFileSync / statSync / mkdirSync / readdirSync / existsSync` 调用点（约 50 处） |
| 接口扩展 | `IFileSystem` 已有的 `*Async` API 必须 100% 覆盖 sync 用例；helper `platformFs.ts` 加 async 版本 |
| 工具改造 | 9 个工具 + 内部递归 helper 全部用 async path（同步遍历改异步队列） |
| 例外保留 | `truncate.ts`（写 `~/.maxian/`）/ `findRgPath`（探测系统二进制）这种系统级例外保留并显式标注 |
| 验收 | core dist `grep -E "Sync\(" dist/tools/*.js` 仅剩例外项 |
| 工作量 | **15-20 天** |

### A.K8f — core 去 import 'node:*' 直调

| 项 | 详情 |
|---|---|
| 目的 | core 加载到浏览器/renderer 时不会因 node 模块解析失败崩溃 |
| 接口扩展 | `IPlatform.path` (join/resolve/relative) + `IPlatform.os` (homedir/platform/arch) + `IPlatform.url` |
| 验收 | core dist `grep "node:" dist/**/*.js` 仅含已标注例外 |
| 工作量 | **5-7 天** |

### A.K9 — IDE 切 @maxian/core

| 项 | 详情 |
|---|---|
| 依赖 | K8d + K8e + K8f 全部完成 |
| 动作 | 启用 `createVSCodePlatform()`；删 IDE 4 个重复工具；改 `maxianService.ts` 调 core 工具 |
| 回归 | IDE 完整功能：聊天 / 工具 / 文件 / 终端 / 编辑 / 撤销 / 取消 / 上下文压缩 |
| 工作量 | **10-14 天**（含完整回归） |

### A.K10 — @maxian/ui 剩余组件全部抽出

| 子项 | 组件 | 工作量 |
|---|---|---|
| K10b | TerminalPanel（依赖 xterm，需在 ui 包加 xterm peer dep）| 2d |
| K10c | TokenUsageBar | 1d |
| K10d | SlashCommandPalette + FileMentionDropdown（先抽象 fs 直读）| 3d |
| K10e | FileChangeTree | 1d |
| K10f | DiffViewer | 1d |
| K10g | WorkspaceSwitcher | 1d |
| 验收 | App.tsx 不再 inline 定义任何 UI 组件 | |
| 工作量 | **9 天** |

### A.K11 — hooks/stores 抽出 + App.tsx 收尾

| 子项 | 详情 | 工作量 |
|---|---|---|
| K11a | hooks 完整抽出：useSseSubscription / useTokenUsage / useApprovalQueue / useFileWatcher / useTerminalSnapshot | 3d |
| K11b | stores 扩展：sessionStore / workspaceStore / approvalStore / terminalStore | 3d |
| K11c | App.tsx 按职责切片：AppShell / Login / Settings / MainLayout，App.tsx 仅做组装 | 5d |
| K11d | 视觉零回归 + 完整功能回归 | 3d |
| 验收 | `wc -l apps/desktop/src/App.tsx` < 2000；视觉 / 功能完全不变 | |
| 工作量 | **14 天** |

---

## Phase B — Agent 能力升级（v0.3.x → v0.4.0）

**目标**：补齐 Claude Code / Cursor / Cline 的 2026 主战场能力。

**前置**：Phase A 完成

**预估**：75-94 天单人（15-19 周；分人并行可压到 8-10 周）

### B1 — Sub-agents 完整版

> 与 Batch 的关键差异：Batch 是用户派活；Sub-agents 是 AI 自己派活给自己。

| 项 | 详情 |
|---|---|
| 工具 | 新增 `task` 工具，签名 `task(subagent_type, description, prompt, background?, isolation?)` |
| 子代理类型 | builtin 至少 4 个：general-purpose / code-reviewer / code-explorer / test-writer；可通过 Skills 自定义 |
| 隔离层 | 每个子代理：独立 sessionId、独立 context window、独立 tool 白名单（frontmatter 声明） |
| Worktree 支持 | `isolation: 'worktree'` 时自动 `git worktree add` 到独立分支；完成后清理 |
| Background 模式 | `background: true` 时主代理继续干活；可查 `task_status` |
| 主代理可见性 | 主代理只看到 final summary（节省 context） |
| UI | 桌面端"任务编排面板"：主代理 + N 个子代理并行状态 / token / 进度；可一键打开任意子代理 session 看完整日志 |
| 取消传播 | 取消主任务级联取消所有子代理 |
| 上限治理 | 主代理同时持有的 background 子代理数 ≤ 8（可配） |
| 涉及文件 | `packages/core/src/tools/taskTool.ts` / `packages/server/src/subagentManager.ts` / `apps/desktop/src/agents/SubagentDashboard.tsx` |
| 验收 | 主代理调 `task('code-reviewer', ...)` 正常派活；6 个并发子代理在不同 worktree 跑；UI 实时显示状态 |
| 工作量 | **20-25 天** |

### B2 — MCP Tool Search 懒加载 + 完整生命周期

| 项 | 详情 |
|---|---|
| 元工具 | `mcp_tool_search(query, max_results)` / `mcp_tool_load(tool_names[])` |
| 索引 | server 启动时把 MCP server 工具元数据进 in-memory 索引（含 embedding） |
| 生命周期 | N 轮未用 / token 紧张时自动卸载 |
| Marketplace 联动 | 与 F1 集成：从 marketplace 一键安装 MCP server |
| 验收 | 挂 50+ MCP server，主对话 context 占用 ≤ 不挂时 110% |
| 工作量 | **10-14 天** |

### B3 — Auto-Memory（vector store + 自动捕获）

| 项 | 详情 |
|---|---|
| 存储 | sqlite-vec（小、与现有 better-sqlite3 兼容） |
| 数据结构 | `memories` 表：id / scope / category / content / embedding / created_at / accessed_count |
| 自动捕获 | core 加 hook：每轮对话结束让小模型扫一遍提取偏好/约定/事实 |
| 检索注入 | 每轮按 query embedding 召回 top-K 注入 system prompt |
| 显式工具 | `save_memory(scope, category, content)` / `recall_memory(query)` |
| UI | "记忆面板"：列表 / 编辑 / 删除 / 标 ⭐ / scope 过滤 |
| 隐私 | global scope 必须用户确认；可一键清空 |
| 验收 | 用户上一次说"我喜欢 Tab 缩进" → 新会话能召回并遵守 |
| 工作量 | **15-18 天** |

### B4 — Codebase Index / Repo Wiki

| 项 | 详情 |
|---|---|
| 触发 | 进项目时自动后台触发；增量监听 git change（debounce 30s） |
| 内容 | (a) 文件树 + 用途；(b) 关键 API/类/函数（走 LSP）；(c) 依赖图；(d) 模块概要；(e) 项目架构总结 |
| 存储 | `~/.maxian/index/<workspace_id>/`：tree.json / apis.json / deps.json / modules.md / architecture.md + embeddings.sqlite |
| 搜索工具 | `codebase_search(query)` 走向量召回 |
| 注入策略 | 进项目第一轮自动注入 architecture.md（不到 2K token）；按需召回 modules.md 切片 |
| 大型项目 | 超 50K 文件按 directory 分批；progress event 推前端 |
| UI | "项目知识库"：架构图 / API 列表 / 模块说明；可手动刷新 / 排除目录 |
| 验收 | 50K 文件项目首次索引 < 5 分钟；增量 < 5 秒；架构问题 AI 答对率显著上升 |
| 工作量 | **18-22 天** |

### B5 — Chrome DevTools MCP + 内嵌浏览器预览

| 项 | 详情 |
|---|---|
| MCP 接入 | 项目 config 加 chrome-devtools-mcp server |
| 内嵌 webview | Tauri 第二窗口（或主窗口拆分面板）跑 `pnpm dev` 预览 |
| 工具 | take_screenshot / read_browser_console / read_network_requests / browser_click / browser_fill / browser_navigate |
| 安全 | 仅允许操作开发服务器（127.0.0.1 / localhost）；其他 URL 必须用户授权 |
| 涉及文件 | `apps/desktop/src/preview/PreviewWindow.tsx` / `apps/desktop/src-tauri/src/preview.rs` |
| 验收 | 改 React 组件 → AI 自动截图看效果 → 发现错位 → 自己修 → 再看 |
| 工作量 | **12-15 天** |

---

## Phase C — 云端化（v0.4.x）

**前置**：B1（Sub-agents）+ Phase A

**预估**：60-75 天（12-15 周）

### C1 — 云端 Worker 完整实现

| 项 | 详情 |
|---|---|
| 多租户 DB | Postgres schema 完整迁移（参照 ADR-003 Phase L 设计） |
| RLS | 所有 query 强制带 tenant_id；启用 PostgreSQL Row Level Security |
| SSO | 飞书 / 企业微信 / GitHub OAuth |
| 任务队列 | BullMQ (Redis)；自动重试 max 2；心跳 + 死亡检测 + reschedule |
| 沙箱方案 | 双轨：(a) E2B / Daytona thin layer 快速上线；(b) 自建 firejail + Docker 容器（L0-L4 隔离）作为后备 |
| 配额 | 每租户每日 token 配额硬限；超限自动暂停；预警阈值 80% |
| 验收 | 2 个租户 A/B 数据完全隔离；10 个并发任务无串号；恶意命令被沙箱拦下 |
| 工作量 | **25-30 天** |

### C2 — 云端控制台

| 项 | 详情 |
|---|---|
| 提交需求 | Web 表单：标题 + 描述 + 仓库 URL + 分支 + 优先级 + 定时；模板支持 |
| 任务列表 | 实时进度；暂停 / 恢复 / 取消；按状态过滤 |
| 审核工作台 | 任务完成后产出 PR + diff + AI 摘要 + token 消耗；approve（自动 merge）/ request changes / reject |
| 任务回放 | SSE 事件流逐帧回放 |
| 计费 | Token 用量看板：模型 / 租户 / 用户 / 时间维度；导出 CSV |
| 通知 | 邮件 + 飞书 / Slack |
| 涉及文件 | `apps/web/`（新建 Web 应用） |
| 工作量 | **20-25 天** |

### C3 — Automations（触发器系统）

| 项 | 详情 |
|---|---|
| Cron | 标准 cron；按租户隔离；超时杀死 |
| GitHub webhook | PR opened / Issue labeled / push to branch；绑定到 agent + prompt 模板 |
| Slack / 飞书 | bot 命令：`/maxian fix this issue: <link>` |
| Linear / Jira | webhook 双向同步 |
| Outbound webhook | 任务结束自动回调用户 URL（含 result + diff + tokens） |
| UI | 控制台 "Automations" 模块 |
| 验收 | GitHub PR 加 label → 自动派 agent → 出 review |
| 工作量 | **15-20 天** |

---

## Phase D — 自动化 Code Review Pipeline（v0.4.x）

**前置**：B1 + C1 + C3

**预估**：30-40 天（6-8 周）

### D1 — 自动 Code Review 完整版

| 项 | 详情 |
|---|---|
| 内置子代理 | code-reviewer / security-reviewer / style-reviewer 三个，每个走 Skill frontmatter |
| 触发 | GitHub PR opened/synchronize → C3 → 派子代理 review |
| 评审产出 | 行内 comment + 总结；标 must-fix / suggested |
| 修复闭环 | 用户在 PR 评论 `@maxian fix all suggestions` → coding agent 出修复 commit |
| 二次评审 | 修复后自动再 review |
| 灰度 | 仓库级开关；文件路径白名单 |
| 验收 | 真实开源项目接入；连续 5 个 PR 全自动 review，must-fix 准确率 ≥ 80% |
| 工作量 | **15-20 天** |

### D2 — Spec-Driven Development 完整闭环

| 项 | 详情 |
|---|---|
| Spec 模板 | `<workspace>/.maxian/specs/`：需求 + 验收 + 技术约束 + 测试用例 |
| Workflow | spec → plan → 测试（红） → 实现（绿） → 自动跑测试 → 不过自动迭代 |
| 工具 | read_spec / update_spec / run_tests / verify_acceptance |
| Plan/Act 强制 | plan_exit 工具升级：plan 阶段产出可勾选清单；act 阶段每步先验证 |
| Verify | 完成时自动跑用户 verification 命令（npm test && npm run build） |
| UI | "Spec 面板"：spec 列表 / 状态 / 关联 PR / 历史迭代 |
| 验收 | 给一个 spec → AI 全自动跑通 plan → test → impl → verify 闭环；多次迭代直到测试通过 |
| 工作量 | **15-20 天** |

---

## Phase E — 形态扩展（v0.4.x → v0.5.0）

**前置**：Phase A 完成

**说明**：可与 Phase B/C/D 并行。

### E1 — VS Code 官方插件

| 项 | 详情 |
|---|---|
| 模式 | sidecar 模式（与桌面端共用 maxian-server bun 二进制） |
| 形态 | webview UI（基于 @maxian/ui）+ Activity Bar icon + 命令面板集成 |
| 平台 | `createVSCodePlatform()` 已有，复用 |
| 发布 | VS Marketplace + Open VSX |
| 工作量 | **15-20 天** |

### E2 — Web 形态正式版

| 项 | 详情 |
|---|---|
| 架构 | Browser UI ⇄ HTTPS+SSE ⇄ maxian-cloud（多租户 NodePlatform） |
| 仓库挂载 | git clone 用户仓库到 `/tmp/maxian/{userId}/{workspaceId}/` |
| 限制 | 文件大小限制；命令白名单；预览走云端 sandbox |
| 工作量 | **20-25 天** |

### E3 — IDEA 插件

| 项 | 详情 |
|---|---|
| 模式 | sidecar + JCEF webview（@maxian/ui 静态打包） |
| 平台 | Kotlin 仅做 sidecar 生命周期 + JCEF 通信桥 |
| 发布 | JetBrains Marketplace |
| 工作量 | **25-35 天** |

---

## Phase F — 差异化 / 长期（v0.5+）

### F1 — 中文社区 Marketplace

| 项 | 详情 |
|---|---|
| Manifest 格式 | 复用 Cline / Continue Hub（兼容生态） |
| 后端 | 静态 JSON 索引（GitHub repo 即仓库）+ CDN；中文站 marketplace.maxian.ai |
| 客户端 | 桌面端"市场"面板：搜索 / 分类 / 评分 / 一键安装 / 自动更新 |
| 内容初始化 | 自建 50+ 高质量 Skills（前端/后端/DevOps/测试/中文文档） |
| 提交流程 | PR-based；自动 lint + 安全扫描 |
| 工作量 | **20-30 天** |

### F2 — Voice 输入中文优化

| 项 | 详情 |
|---|---|
| ASR | OpenAI Whisper API（large-v3）/ 阿里通义听悟（备份） |
| 编码词典 | 自建中文编码术语映射：驼峰→camelCase / 蛇形→snake_case / 大驼峰→PascalCase 等 |
| Push-to-talk | 长按快捷键说话；松开自动转写 |
| 实时显示 | 流式 ASR；说话过程实时显示部分结果 |
| 工作量 | **15-20 天** |

---

## 总排期表

| Phase | 内容 | 单人工作量 | 推荐节奏 |
|---|---|---|---|
| **A** | K8d/K8e/K8f + K9 + K10 + K11 | 50-65 天 | 11-13 周（v0.2.17 → v0.3.0） |
| **B** | Sub-agents + MCP Search + Memory + Index + Browser | 75-94 天 | 15-19 周（v0.3.x → v0.4.0） |
| **C** | Cloud Worker + 控制台 + Automations | 60-75 天 | 12-15 周（v0.4.x） |
| **D** | Auto Review + Spec-Driven | 30-40 天 | 6-8 周（v0.4.x，可与 C 并行） |
| **E** | VS Code + Web + IDEA | 60-80 天（并行 25-35 天） | A 完成后并行启动 |
| **F** | Marketplace + Voice | 35-50 天 | 长期 |
| **总计** | | **310-404 天**（单人） | **9-12 月**（含并行优化） |

---

## 关键依赖图

```
A.K8d ──┐
A.K8e ──┼─→ A.K9 ──→ E.E1 (VS Code)
A.K8f ──┘            └→ E.E2 (Web) → E.E3 (IDEA)

A.K10 ─→ A.K11 ─→ (Phase B 启动条件)

B.B1 (Sub-agents) ─→ C.C1 (Worker)  ─→ C.C2 (控制台)
                                    └→ C.C3 (Automations)
                  ─→ D.D1 (Code Review)
                  ─→ D.D2 (Spec-Driven)

B.B2 (MCP Search) ─→ F.F1 (Marketplace)
B.B3 (Memory) ────→ 独立
B.B4 (Index) ─────→ 独立
B.B5 (Browser) ───→ 独立
F.F2 (Voice) ─────→ 独立
```

**关键路径**：A.K8e → A.K9 → B.B1 → C.C1 是主线，决定整体节奏。

---

## 验收里程碑

### Phase A 验收（v0.3.0 release）
- [ ] `grep -rE "Sync\(|child_process|node:" packages/core/src/tools/` 仅剩例外项
- [ ] `wc -l apps/desktop/src/App.tsx` < 2000
- [ ] IDE 启动后能正常聊天 / 工具调用 / 文件操作 / 终端 / 撤销 / 取消，且不再依赖 IDE 端的工具实现
- [ ] 桌面端、IDE 共用同一份 core，回归清单全过

### Phase B 验收（v0.4.0 release）
- [ ] 主代理调 `task('code-reviewer', ...)` 能正常派活；可同时跑 6 个并发子代理（不同 worktree）
- [ ] 挂 50+ MCP server，主对话 context 占用 ≤ 不挂时 110%
- [ ] 用户上一次说"我喜欢 Tab 缩进" → 新会话能召回并遵守
- [ ] 50K 文件项目 5 分钟内完成索引；增量 5 秒内
- [ ] AI 改前端 → 自动截图 / console / network 反馈给自己迭代

### Phase C 验收（v0.4.x）
- [ ] 2 个租户 A/B：A 看不到 B 的任何数据；并发 10 个任务无串号
- [ ] 提交 10 个需求 → 至少 9 个产出可审 PR
- [ ] 恶意命令（rm -rf / / curl|sh）被沙箱拦下
- [ ] GitHub PR 加 label → 自动派 agent → 出 review

### Phase D 验收
- [ ] 真实开源项目接入；连续 5 个 PR 全自动 review，must-fix 准确率 ≥ 80%
- [ ] 给一个 spec → AI 自动 plan → test → impl → verify 闭环，最多 5 次迭代过

### Phase E 验收（v0.5.0 release）
- [ ] VS Code Marketplace 可安装；Web 形态可登录用 SSO；IDEA 插件 JCEF 加载 UI
- [ ] 三个新形态共用同一份 maxian-server 二进制 + 同一份 @maxian/ui

### Phase F 验收
- [ ] Marketplace 至少 50 个官方 Skills + 20 个 MCP + 10 个 Plugin
- [ ] 中文 Voice 输入识别准确率 ≥ 95%（编码场景）

---

## 影响

- 当前 v0.2.16 桌面端 / 码弦IDE 两个形态在 Phase A 完成前**功能不变**，仅底层 core 慢慢异步化（每个 commit 保证回归 PASS）
- 协议版本 `X-Maxian-Protocol: 1` 持续兼容；任何破坏性改动须 bump major + 90 天弃用窗口
- 本路线图上的所有功能任务**禁止 MVP**；如确实需要分阶段交付，必须在本 ADR 加 amendment 说明

## 变更记录

- 2026-05-06：初版（合并 ADR-003 N 期遗留 + 2026 行业调研产出）
