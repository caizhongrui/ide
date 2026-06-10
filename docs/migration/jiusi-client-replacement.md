# 码弦客户端全面替换方案：统一到九思客户端（双品牌打包）

> 状态：方案已评审，待执行。本文档自包含，可在全新会话中直接据此开工。
> 制定日期：2026-06-10
> 核心原则（用户拍板）：**接口及实现以九思为准，qdport 管理端向九思对齐（可改/可增接口）；实在设计不一致的地方，单独加逻辑分支。后续修改在同一套代码上进行，码弦、九思两个品牌同步受益。**

---

## 1. 背景与目标

码弦（maxian）与九思（jiusi）客户端是**同源项目**（jiusi-desktop 的 package.json description 仍是"码弦 Maxian 桌面客户端"），已分叉数月：

| | 码弦 | 九思 client |
|---|---|---|
| 仓库 | `/Users/caizhongrui/Documents/workspace/production/ide`（主仓） | `/Users/caizhongrui/Documents/workspace/production/jiusi/client`（独立 git repo） |
| 版本 | 0.2.45 | 0.9.7（2026-06-08 仍活跃，commit `1f60473`） |
| 规模 | desktop 79 文件 / core 167 文件 | desktop **189** 文件 / core **184** 文件 |
| 独有功能 | — | design（原型设计）/ project（功能清单+字段表）/ tasks / notes / toolbox / 一键开发 / 实时日志 |
| 后端 | qdport 管理端（`/Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api`，Java，Basic 认证 + businessCode） | 九思后端（`/Users/caizhongrui/Documents/workspace/production/jiusi/api`，Java，token + 租户 + 计费/key 池） |

**目标**：
1. 客户端统一为九思 client 一套代码，码弦客户端仓库退役；
2. qdport 管理端实现九思风格接口（适配层），客户端统一走 `mode='jiusi'` 协议，不分叉；
3. 双品牌打包：同一代码构建出「码弦Desktop」（连 qdport、屏蔽多余功能）和「九思」（连九思后端、全功能）两个包；
4. 码弦近期实战修掉的 5 个稳定性 bug **必须移植**（九思 client 全都没有，见 §4）。

---

## 2. 已查证的关键事实（不需要重新调研）

### 2.1 九思客户端已内置双模式（分支洞已预留）

`jiusi-server/src/routes/auth.ts`（POST /auth/configure）支持：
- `mode='jiusi'`：九思后端协议——`POST {apiUrl}/api/openapi/v1/chat/completions`，HTTP 头 `jiusi-token` 鉴权，OpenAI 兼容 body（见 `jiusi-core/src/api/jiusiHandler.ts`）；
- `mode='proxy'`：旧码弦协议——body 带 base64 user/pass + businessCode，打 `/ai/proxy/stream/chat/completions`（`jiusi-core/src/api/aiProxyHandler.ts` 仍保留）。

**本方案选择：统一走 `mode='jiusi'`，qdport 实现九思接口**（而不是用 proxy 模式迁就 qdport）。

### 2.2 九思客户端依赖的后端接口面（屏蔽 5 个功能后）

实测提取（grep jiusi-desktop/src/api.ts + jiusi-server + jiusi-core）：

| # | 接口 | 用途 | qdport 现状 → 对齐动作 |
|---|---|---|---|
| 1 | `POST /api/auth/login` | email/password → **token** + 用户信息 | 无 → **新增**（token 映射 SysUser） |
| 2 | `GET /api/auth/me` | token 校验 + 用户信息 | 无 → **新增** |
| 3 | `POST /api/openapi/v1/chat/completions` | AI 对话（SSE、tools、`jiusi-token` 头、`X-Jiusi-Turn-Id` 头） | 有语义等价的 `/ai/proxy/stream/chat/completions` → **新增 controller 复用其转发核心** `AiProxyServiceImpl.forwardStreamRequest`/`buildRequestBody` |
| 4 | `GET /api/openapi/models` | 模型清单 | 有 `/scene-models/{businessCode}` → **新增**翻译层（业务场景配置 → 九思模型列表格式） |
| 5 | `GET /api/tenant/available-models`、`GET /api/admin/platform-models/public` | 租户/平台模型 | 无租户 → **形状兼容**（返回平台级，同 #4 数据源） |
| 6 | `GET /api/admin/balance/me`、`GET /api/tenant/balance` | 余额 | **无计费体系（设计不一致点）** → 分支：返回"不限额"形状 + 客户端 flag 隐藏余额 UI（双保险） |
| 7 | `GET /api/openapi/notifications/pending` | 通知 | 无 → 返回空数组 |
| 8 | `/v1/embeddings` | codebase 语义索引 | **待查**：先查码弦客户端 codebase 索引现在 embeddings 走哪，再决定 qdport 补接口还是客户端降级纯文本检索 |
| 9 | 停止生成 | jiusi 模式靠客户端 AbortController 本地中止 | 需核实九思后端有无服务端 stop；qdport 已有 `/ai/proxy/stop/{id}` 可包装 |
| 10 | `GET /api/health` | 健康检查 | 无 → 新增（几行） |

`/v1/messages`（Anthropic 直连 fallback）大概率不需要 qdport 实现，确认后排除。

### 2.3 #3 必须逐字节对齐的协议细节（从九思 `jiusi-api` 的 `LlmProxyService` 已确认）

- SSE 错误：`data: {"error":{"message":...,"type":...}}` 后紧跟 `data: [DONE]`，然后 `emitter.complete()`——**绝不能** `completeWithError()`（Spring 会把 JSON 错误体往 text/event-stream 写，抛 HttpMessageNotWritableException 雪崩，九思源码注释原话）；
- **过滤上游的 `[DONE]`**，由服务端统一发（避免双 [DONE] 客户端漏读末尾 chunk）；
- 九思有 `jiusi_cost` 计费 chunk → qdport 无计费，**不发**（客户端当可选处理，需验证）；
- usage chunk（prompt/completion_tokens）必须发——客户端 token 统计靠它；上游没回 usage 时九思按文本长度估算（qdport 现有代码已有同款估算逻辑可复用）；
- `X-Jiusi-Turn-Id` 请求头：接收不报错即可，可先忽略；
- 九思的重试原则：**第一帧 chunk 之前的失败自动重试（换 key），已推送过 chunk 不再重试**。qdport 无 key 池，可不实现服务端重试（客户端已有轮级自动重试兜底，见 §4-#5）。

### 2.4 qdport 管理端现状

- 路径：`/Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api`，模块 `boyo-knowledge`；
- master `5857919`（2026-06-02），部署镜像 `2026-06-03-01`（不滞后）；
- 本地未推送 commit `358ca6c`：流式 400 时 dump tool_calls 配对诊断日志（保留，随下次部署带上）；
- 关键文件：`controller/AiProxyController.java`、`service/impl/AiProxyServiceImpl.java`（`forwardStreamRequest` / `buildRequestBody` / `resolveBusinessModel`）、`domain/dto/AiProxyRequest.java`；
- 现有转发已忠实透传 tool_calls / tool_call_id / reasoning_content / cache_control（2026-01-21 commit `cff5e45` 加入）。

### 2.5 一个未解之谜（不阻塞，但要留诊断）

lenovo 机器上出现过「上游 400：tool_call_ids did not have response messages」反复复现：sidecar 出站消息已验证合规、qdport 源码转发忠实、部署不滞后 → 剩余嫌疑是 qdport 的 `EffectiveAiConfig.apiEndpoint` 指向的**上游网关**（所配模型名 `deepseek-v4-pro` 非 DeepSeek 官方命名，疑似内部网关渠道）在协议转换时丢 tool 配对。`358ca6c` 的诊断日志 + 客户端 400 自愈（§4-#4）已covering。**迁移时检查 IDE_CHAT_CODE 场景的 apiEndpoint 指向并确认那层网关的行为。**

---

## 3. 总体架构

```
              ┌── 品牌: 码弦Desktop (brand=maxian) ──▶ qdport 管理端（九思接口适配层 → 复用 AiProxyServiceImpl）
一套 jiusi 客户端代码
（mode='jiusi' 不分叉）
              └── 品牌: 九思 (brand=jiusi) ──▶ 九思后端（原生）
```

- 后续所有功能/修复在 jiusi client 一套代码上做，**两个品牌同步获得**；
- qdport 的「九思兼容层」收敛到独立包（建议 `com.boyo.knowledge.jiusiapi`），九思接口演进时只动这一处；
- 码弦 ide 仓库冻结，归档。

---

## 4. 必须移植的 5 个稳定性修复（九思 client 全部没有，已逐项核实）

源码参照：码弦 ide 仓库分支 `claude/heuristic-moore-0c97e9`（worktree `/Users/caizhongrui/Documents/workspace/production/ide/.claude/worktrees/heuristic-moore-0c97e9`）。同源项目文件位置一一对应，移植成本低。

| # | 修复 | 码弦 commit | 源文件 → 九思目标文件 | 要点 |
|---|---|---|---|---|
| 1 | **端口 0 + stdout 握手 + Windows Job Object**（根治 EADDRINUSE「启动失败」+ 孤儿进程占端口） | `5bfcf45`(v0.2.44) | `apps/desktop/src-tauri/src/lib.rs` → `jiusi-desktop/src-tauri/src/lib.rs`；`packages/server/src/cli.ts`（`__MAXIAN_READY__` 握手行已存在） | 九思现在还是「探测+1 递增」找端口（有竞态）。sidecar `--port 0`；解析 stdout `__MAXIAN_READY__ {json}` 拿实际端口；`winjob` 模块挂 kill-on-close Job Object（需 Cargo.toml 加 `windows-sys` 含 `Win32_Security` feature——`CreateJobObjectW` 被它门控）；删除旧的探测/强杀逻辑 |
| 2 | **端口主动推送给前端**（修「动态端口后客户端死连默认端口」） | `c92a8e5`(v0.2.45) | 同上 lib.rs（`emit("maxian:server-ready")`）+ `apps/desktop/src/api.ts`（`listenServerReady`）→ jiusi 对应文件 | stdout 解析用 `from_utf8_lossy`（chunk 边界切断多字节字符会吞握手行）；前端事件监听 + `waitForServer` 每轮重取 client |
| 3 | **NodeTerminal 后台命令卡死**（`nohup x & echo $!` 等后台孙进程持有管道 → 'close' 永不触发 → 挂到超时） | NodeTerminal 修复 commit（v0.2.44 内） | `packages/core/src/adapters/NodeTerminal.ts` → `jiusi-core/src/adapters/NodeTerminal.ts` | 监听 `'exit'` + 200ms 排空 grace 后强制收尾（移除 stdout/stderr 监听、unref、emit exit chunk）；实测从 8000ms 超时 → 6ms |
| 4 | **tool_calls 配对 400 自愈**（消毒重试，防会话卡死在同一错误） | `7c3e669` | `packages/core/src/api/aiProxyHandler.ts` → `jiusi-core/src/api/jiusiHandler.ts`（注意：九思模式走 JiusiHandler，要移植到它；aiProxyHandler 也可同步） | `isToolPairingError` 识别 + `sanitizeToolHistory`（assistant.tool_calls 折叠为文本、role:tool 转 user）+ 任何内容输出之前命中则消毒重试一次 |
| 5 | **流截断检测 + 轮级自动重试**（修「思考中直接断了、无提示」） | `9175267` + `41f7651` | `packages/core/src/api/aiProxyHandler.ts`（截断检测）→ `jiusi-core/src/api/jiusiHandler.ts`；`packages/server/src/cli.ts`（P0-6 重试块扩展）→ `jiusi-server/src/cli.ts` | 检测：流 done 但无 `[DONE]`/finish_reason/已上抛业务错误 → yield「响应流被中途截断」error。重试：复用限流重试循环，TRUNCATION_RE 命中 → **回滚本轮累积**（iterText/allText 增量/toolCalls/reasoning 分段 offset/工具流状态）→ 等 3s 整轮重发，最多 3 次；重试中再次截断继续重试 |

> 另：码弦 v0.2.43 的「模型清单 IDE_CHAT_ASK/CODE 误映射」修复是码弦 UI 特有逻辑，迁移后模型清单走九思接口（§2.2-#4/#5），不需要移植，但联调时要验证模型清单在四种作曲模式下一致。

每项移植后用码弦侧已写过的实测脚本验证（repair 五形态 / 截断四场景 / NodeTerminal 三场景 / 端口六连发+三并发），脚本模式见码弦会话记录或按 commit message 里的描述重写。

---

## 5. 客户端改动清单（jiusi client 仓库）

1. **feature flag 体系**（建议 `jiusi-desktop/src/featureFlags.ts`）：
   - 由构建时 `VITE_BRAND=maxian|jiusi` 决定默认值；
   - `brand=maxian` 时关闭：design / project / tasks / notes / toolbox / 余额显示；
   - 隐藏入口（侧栏、路由、命令面板）之外，**排查这些模块的开机自动行为**（扫描、轮询、定时器）一并跳过；
   - 不删代码，后续开放改配置即可。
2. **移植 §4 的 5 个修复**。
3. **登录页**：brand=maxian 时默认 apiUrl 指 qdport 管理端地址、文案用码弦品牌；协议统一 jiusi token 模式（qdport 已实现 #1/#2 后）。
4. **品牌资源**：图标、产品名、关于页、UI 内品牌字符串收敛到 brand 配置（白标最常见的脏活，需一次全局排查 `九思|jiusi` 硬编码文案）。

---

## 6. 双品牌打包

```
pnpm tauri build --config tauri.maxian.conf.json   # 码弦Desktop
pnpm tauri build --config tauri.jiusi.conf.json    # 九思
```

| 维度 | 码弦版 | 九思版 | 机制 |
|---|---|---|---|
| productName / 图标 | 码弦Desktop | 九思 | Tauri `--config` 覆盖合并 |
| identifier | **`com.maxian.desktop`**（老用户无缝升级，不可变） | `com.jiusi.desktop` | 不同 identifier → 可并存安装 |
| 功能面 | 5 模块关 | 全开 | `VITE_BRAND` + feature flag |
| 默认后端 | qdport 管理端 | 九思后端 | brand 配置 |
| **数据目录** | `~/.maxian/` | `~/.jiusi/` | 构建时传给 sidecar（env/参数）；**必须隔离**，否则同机双装共写一个 SQLite |
| 更新通道 | 码弦现有 release repo（沿用，存量用户自动升级） | 九思自己的 | updater endpoint 按 brand |
| 版本线 | **0.3.0 起**（标记大版本切换） | 0.9.x 继续 | tag 前缀分流：`maxian-v*` / `jiusi-v*` |

CI：把码弦的 `release-desktop.yml` 模式搬到 jiusi client 仓库，matrix = brand(2) × platform(macOS arm64 / Windows x64)(2)，或两个 workflow 按 tag 前缀分流（推荐，省构建资源）。
（注：码弦 CI 已知问题——matrix 两个 job 并发往同一个 draft Release 传产物会竞态失败，新 workflow 改成「构建 job 出 artifacts → 单独 release job 统一上传」。）

---

## 7. 实施顺序

```
P0  qdport 九思接口适配层（独立包 com.boyo.knowledge.jiusiapi）：
    #1/#2 token 认证 → #3 chat/completions（最难，先打通）→ #4/#5 models
P1  qdport 形状兼容：#6 balance / #7 notifications / #10 health；#8 embeddings 调查定案
P2  客户端：feature flag + 5 个稳定性修复移植 + 品牌字符串收敛
P3  双品牌打包：tauri 双 config、数据目录隔离、CI workflow、updater 通道
P4  联调与发布：
    - 全链路：登录→模型清单→对话→工具调用→停止→重连→自动重试
    - 协议对比测试：同一请求分别打九思后端/qdport 适配层，diff SSE 输出序列
    - 跑码弦 docs/regression-checklist.md 全量回归
    - 重点实测两台问题机器：8071 端口被占那台（验端口0）+ lenovo（验截断重试/400自愈）
    - 码弦 0.3.0-beta 经现有更新通道灰度 → 正式发布 → 码弦 ide 仓库归档
```

预估：P0 约 2-3 天（大头 #3 协议细节）、P1 一天、P2 一天、P3-P4 共 1-2 天，总计约一周。

---

## 8. 已拍板与待拍板

**已拍板**（用户确认）：
- 全面替换，以九思为准，qdport 对齐九思接口，不一致处单独分支；
- design/project/tasks/notes/toolbox 暂不开放（feature flag 屏蔽，代码保留）；
- 双品牌打包，后续修改两个品牌同步。

**待拍板**（执行前确认，括号内为建议默认值）：
1. token 体系：简单 DB token 表映射 SysUser，还是照抄九思鉴权 filter 实现？（建议：先读九思实现，能照抄就照抄——"实现尽可能一致"原则）
2. 老用户历史会话：`~/.maxian/maxian.db` schema 与 jiusi-server 已分叉数月——做只读导入迁移，还是接受丢失？（建议：先实测 jiusi-server 能否直接打开旧库；不能则 0.3.0 发布说明里声明会话不迁移，新起）
3. embeddings（§2.2-#8）调查结论出来后定：qdport 补接口 or 客户端降级。

---

## 9. 给执行会话的操作提示

- 四个代码位置：
  - 九思 client（主战场）：`/Users/caizhongrui/Documents/workspace/production/jiusi/client`（git 根在 client/，不在 jiusi/）
  - 九思后端（接口标准参照，只读）：`/Users/caizhongrui/Documents/workspace/production/jiusi/api`（`jiusi-openapi`/`jiusi-proxy` 模块）
  - qdport 管理端（要加适配层）：`/Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api`（注意有本地未推送 commit `358ca6c` 和一些未提交的 yml/Dockerfile 改动，动手前先看 `git status`）
  - 码弦 ide（修复移植的源，参照只读）：分支 `claude/heuristic-moore-0c97e9`，未出货 commits：`7c3e669`（400自愈）、`9175267`（截断检测）、`41f7651`（截断重试）
- qdport 编译验证：`mvn compile -pl boyo-knowledge -am -DskipTests`
- 九思 client 校验：`pnpm -r --if-present typecheck`；桌面 dev：`pnpm --filter @jiusi/desktop run tauri:dev`
- 码弦的回归清单：ide 仓库 `docs/regression-checklist.md`
- 遵守 ide 仓库 CLAUDE.md 纪律（一次重构只改一件事、HTTP 路由变更同步文档等）；qdport/jiusi 仓库如有各自 CLAUDE.md 同样遵守。
