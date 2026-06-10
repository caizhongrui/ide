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

### 2.5 鉴权实现照抄细节（已拍板：直接照抄九思）

九思后端鉴权用 **Sa-Token 框架**（`cn.dev33.satoken`），已查证的关键事实：

- token 名：`jiusi-token`（HTTP 头），CORS `exposedHeaders` 必须包含它；
- 单设备登录：Sa-Token 配置 `is-concurrent=false + is-share=false`，登录自动踢掉旧设备 token；
- 鉴权注解：受保护 controller 用 `@SaCheckLogin`（如 `jiusi-openapi` 的 `ChatCompletionController`）；
- 拦截器注册：`jiusi-bootstrap/.../config/WebMvcConfig.java` 的 `addInterceptors` 注册 `SaInterceptor`——**注意注册顺序坑**（源码注释：上下文 filter 必须比 SaInterceptor 先注册，否则 `@SaCheckLogin` 全部失效/抛错，九思踩过这个坑）；
- 登录实现：`jiusi-auth/.../service/LoginService.java` + `controller/AuthController.java`（`StpUtil` 登录、`SaTokenCurrentUserProvider` 取当前用户）。

**qdport 侧已查证的现状（降低照抄成本，但有一个必须分支的差异）**：
- qdport **本身已用 Sa-Token**（RuoYi-Vue-Plus 风格，`boyo-framework/config/SaTokenConfig.java`），且为 **JWT 简单模式**（`StpLogicJwtForSimple`）——框架依赖已在，无需新引；
- 现有全局拦截：`SaInterceptor` 匹配 `/**`、放行列表在 `boyo-admin/src/main/resources/application.yml` 的 `security.excludes`（`/ai/proxy/**` 已在其中）；
- ⚠️ **token 头名不一致（分支点）**：qdport 全局 `sa-token.token-name: token`，九思客户端发 `jiusi-token` 头。**不改全局配置**（会影响现有管理端 web），在新模块内自带轻量鉴权拦截器：从 `jiusi-token` 头取值 → `StpUtil.getLoginIdByToken()` 校验——这是「设计不一致单独加分支」的第一个实例；
- **登录主体隔离**：IDE 登录（SysUser by email/password）与现有管理端 web 登录不能混在同一会话体系（互踢/超时策略不同）。用 Sa-Token **多账号体系**（独立 `StpLogic`，`loginType='jiusi-ide'`）在新模块内隔离，零侵入现有登录。

**qdport 照抄清单**：照搬九思 `LoginService`/`AuthController` 语义（用户源换成 qdport `SysUser`，保留 status='1' 停用检查）→ 新模块内建独立 `StpLogic(loginType='jiusi-ide')` + `jiusi-token` 头拦截器 → CORS 对照九思 `WebMvcConfig.addCorsMappings`（必须含 `tauri://localhost` / `https://tauri.localhost` 桌面端 origin，缺了桌面端直接跨域失败；只对新模块路由生效，不动全局 CORS）。

### 2.6 数据库兼容结论（已拍板：要迁移——实测结论是天然兼容）

对比两边 `database.ts`（jiusi-server vs 码弦 packages/server）已查证：

- **DB 路径完全相同**：两边都是 `~/.maxian/maxian.db`（jiusi-server 同源未改）→ 码弦老用户装上新客户端，jiusi-server **直接打开原库**，会话/工作区/记忆全部继承，无需迁移工具；
- **schema 同源，jiusi 是超集**：核心表完全一致（sessions/messages/workspaces/history_entries/file_snapshots/memories/mcp_servers/batch_tasks/task_batches/codebase_index_*）；jiusi 多 notes/tags/todos/remote_config/remote_tasks/remote_user_state（`CREATE TABLE IF NOT EXISTS` 自动建）；码弦多 `workspace_files`（jiusi 不认识但留着无害）；
- **两边都有惰性 migration**（try/catch `ALTER TABLE ADD COLUMN`）：jiusi-server 打开码弦库时自动补齐自己需要的列（如 pm_base_url/pm_token）；码弦库已有而 jiusi 没有的列（如 sessions.model）留着无害；
- **双向安全**：升级后老版本码弦再打开也不会坏（SQLite 多余表/列无影响）——回滚无风险；
- ⚠️ **遗留验证项**（P4 联调时确认）：码弦 `sessions.model` 列记录的是 businessCode 体系的模型选择，切到九思协议后模型标识体系变化，老会话的 model 字段语义可能对不上——预期影响仅"老会话显示的模型名"，不影响内容，联调时确认即可。

**双品牌数据目录策略（用户拍板：暂不分离）**：
- 码弦版、九思版**暂时都用 `~/.maxian/`**（码弦老数据天然继承，这就是迁移本身）；
- ⚠️ 已知风险（记录在案、接受）：同机双装两个品牌会共写同一个 SQLite（写竞争 + 数据混淆）——正式用户场景两个品牌不会装同一台机器，开发自测时注意别同时跑两个；
- 后续若要分离：`database.ts` 已支持 `DATA_DIR` 环境变量覆盖（机制现成），打包时按 brand 注入即可，随时可做。

### 2.7 qdport 独立模块设计（已拍板：单独建模块，现有模块/接口零改动）

qdport 是 RuoYi 风格多模块 Maven 工程：根 pom 聚合 modules，`boyo-admin` 是启动模块（`BoyoApplication`，`scanBasePackages={"org.jeecg","com.boyo"}`），各业务模块作为 boyo-admin 的依赖被自动扫描。

**新模块：`boyo-jiusi-adapter`**（九思接口适配层，包路径 `com.boyo.jiusiadapter`——在 `com.boyo` 下自动被扫描，无需改启动类）：

```
boyo-jiusi-adapter/
  └─ com.boyo.jiusiadapter/
      ├─ config/        # 独立 StpLogic(loginType='jiusi-ide')、jiusi-token 头拦截器、
      │                 #   新模块路由专属 CORS（tauri:// origins）
      ├─ controller/    # /api/auth/*、/api/openapi/*、/api/tenant/*、/api/admin/balance/*、/api/health
      ├─ service/       # 协议翻译：九思格式 ⇄ 复用 boyo-knowledge 的转发核心
      └─ dto/           # 九思接口的请求/响应结构（照九思定义）
```

- **依赖方向**：boyo-jiusi-adapter → 依赖 boyo-knowledge（Spring 跨模块注入复用 `AiProxyServiceImpl` / `IModelProviderService` 等现有 bean），**只调用、不修改**；
- **现有功能全部保留**：`/ai/proxy/**` 等所有既有接口原样不动——过渡期双协议并存：老码弦 0.2.x 客户端继续走 `/ai/proxy`，新 0.3.0 走九思接口，同一个 qdport 同时服务两者；
- **不可避免的装配性改动只有三处**（均为声明/配置增量，不触碰任何现有代码逻辑）：
  1. 根 `pom.xml`：`<module>boyo-jiusi-adapter</module>` 一行；
  2. `boyo-admin/pom.xml`：新模块依赖声明一个 block；
  3. `application.yml` 的 `security.excludes`：放行九思路由（`/api/auth/login`、`/api/openapi/**` 等几行——全局 SaInterceptor 放行后由新模块自己的拦截器接管鉴权）。
- 若 `AiProxyServiceImpl` 的复用点是 private 方法（如 `buildRequestBody`），**不改它**——在新模块内通过组合调用其 public 入口，或把九思格式先翻译成 `AiProxyRequest` DTO 再调用现有 public 方法（首选，零侵入）。

### 2.8 一个未解之谜（不阻塞，但要留诊断）

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
- qdport 的「九思兼容层」为**独立 Maven 模块 `boyo-jiusi-adapter`**（设计见 §2.7）：现有模块/接口零改动全保留，过渡期双协议并存（老码弦 0.2.x 走 `/ai/proxy`，新版走九思接口）；九思接口演进时只动这一个模块；
- 码弦 ide 仓库冻结，归档。

---

## 4. 必须移植的 5 个稳定性修复（九思 client 全部没有，已逐项核实）

源码参照：码弦 ide 仓库分支 `claude/heuristic-moore-0c97e9`（worktree `/Users/caizhongrui/Documents/workspace/production/ide/.claude/worktrees/heuristic-moore-0c97e9`）。同源项目文件位置一一对应，移植成本低。

| # | 修复 | 码弦 commit | 源文件 → 九思目标文件 | 要点 |
|---|---|---|---|---|
| 1 | **端口 0 + stdout 握手 + Windows Job Object**（根治 EADDRINUSE「启动失败」+ 孤儿进程占端口） | `5bfcf45`(v0.2.44) | `apps/desktop/src-tauri/src/lib.rs` → `jiusi-desktop/src-tauri/src/lib.rs` | **详细移植步骤见附录 A**（含与九思已有「崩溃自动拉起」逻辑的协调） |
| 2 | **端口主动推送给前端**（修「动态端口后客户端死连默认端口」） | `c92a8e5`(v0.2.45) | 同上 lib.rs + `jiusi-desktop/src/api.ts` | **详细移植步骤见附录 A**（A.4/A.5） |
| 3 | **NodeTerminal 后台命令卡死**（`nohup x & echo $!` 等后台孙进程持有管道 → 'close' 永不触发 → 挂到超时） | NodeTerminal 修复 commit（v0.2.44 内） | `packages/core/src/adapters/NodeTerminal.ts` → `jiusi-core/src/adapters/NodeTerminal.ts` | **详细移植步骤见附录 B** |
| 4 | **tool_calls 配对 400 自愈**（消毒重试，防会话卡死在同一错误） | `7c3e669` | `packages/core/src/api/aiProxyHandler.ts` → `jiusi-core/src/api/jiusiHandler.ts`（主用 handler，**它没有 repair**；同源 aiProxyHandler 有 repair 无消毒） | **详细移植步骤见附录 C** |
| 5 | **流截断检测 + 自动重试**（修「思考中直接断了、无提示」） | `9175267`（检测）；重试九思已有现成机制 | `jiusi-core/src/api/jiusiHandler.ts`（检测）+ `jiusi-server/src/cli.ts`（一行正则） | **详细移植步骤见附录 D**——九思已有 stall 重发 + transient 重试 + attempt 级回滚（比码弦先进），缺口只有「干净掐断」的检测，移植量大幅收窄 |

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
| **数据目录** | `~/.maxian/`（保持不动=天然继承老用户全部会话/工作区，见 §2.6） | `~/.maxian/`（**暂不分离**，用户拍板；后续要分随时用现成的 `DATA_DIR` env 注入） | ⚠️ 同机双装共写一个 SQLite 的风险已知并接受（正式场景不共机；自测勿同时跑两个） |
| 更新通道 | 码弦现有 release repo（沿用，存量用户自动升级） | 九思自己的 | updater endpoint 按 brand |
| 版本线 | **0.3.0 起**（标记大版本切换） | 0.9.x 继续 | tag 前缀分流：`maxian-v*` / `jiusi-v*` |

CI：把码弦的 `release-desktop.yml` 模式搬到 jiusi client 仓库，matrix = brand(2) × platform(macOS arm64 / Windows x64)(2)，或两个 workflow 按 tag 前缀分流（推荐，省构建资源）。
（注：码弦 CI 已知问题——matrix 两个 job 并发往同一个 draft Release 传产物会竞态失败，新 workflow 改成「构建 job 出 artifacts → 单独 release job 统一上传」。）

---

## 7. 实施顺序

```
P0  qdport 九思接口适配层（独立 Maven 模块 boyo-jiusi-adapter，设计见 §2.7，
    现有模块零改动，仅三处装配性增量）：
    #1/#2 token 认证（照抄 Sa-Token + 多账号体系隔离，见 §2.5）
    → #3 chat/completions（最难，先打通；九思格式翻译成 AiProxyRequest 复用现有转发）
    → #4/#5 models
P1  qdport 形状兼容：#6 balance / #7 notifications / #10 health；#8 embeddings 调查定案
P2  客户端：feature flag + 5 个稳定性修复移植 + 品牌字符串收敛
P3  双品牌打包：tauri 双 config、数据目录隔离、CI workflow、updater 通道
P4  联调与发布：
    - 全链路：登录→模型清单→对话→工具调用→停止→重连→自动重试
    - 协议对比测试：同一请求分别打九思后端/qdport 适配层，diff SSE 输出序列
    - 跑码弦 docs/regression-checklist.md 全量回归
    - 老数据继承验证：找一台装过码弦 0.2.x 的机器直接升级 0.3.0，确认历史会话/
      工作区/记忆完整可用（§2.6 预期天然兼容），并核对老会话的 model 字段显示
    - 重点实测两台问题机器：8071 端口被占那台（验端口0）+ lenovo（验截断重试/400自愈）
    - 码弦 0.3.0-beta 经现有更新通道灰度 → 正式发布 → 码弦 ide 仓库归档
```

预估：P0 约 2-3 天（大头 #3 协议细节）、P1 一天、P2 一天、P3-P4 共 1-2 天，总计约一周。

---

## 8. 已拍板与待拍板

**已拍板**（用户确认）：
- 全面替换，以九思为准，qdport 对齐九思接口，不一致处单独分支；
- design/project/tasks/notes/toolbox 暂不开放（feature flag 屏蔽，代码保留）；
- 双品牌打包，后续修改两个品牌同步；
- token 体系：**直接照抄九思的 Sa-Token 鉴权实现**（照抄清单见 §2.5；qdport 已自带 Sa-Token，差异点 jiusi-token 头名/登录主体用新模块内拦截器 + 多账号体系隔离解决）；
- 老用户历史会话：**要迁移**——已查证天然兼容（同一 DB 路径 + schema 同源超集 + 惰性 migration，见 §2.6），码弦版保持 `~/.maxian/` 即自动继承，无需迁移工具；
- qdport 后端接口：**单独创建模块 `boyo-jiusi-adapter`，不改动现有模块**（设计见 §2.7），既有功能/接口全部保留，过渡期双协议并存。

**待拍板/待调查**（仅剩一项）：
1. embeddings（§2.2-#8）调查结论出来后定：qdport 补接口 or 客户端降级。

---

## 9. 给执行会话的操作提示

- 四个代码位置：
  - 九思 client（主战场）：`/Users/caizhongrui/Documents/workspace/production/jiusi/client`（git 根在 client/，不在 jiusi/）
  - 九思后端（接口标准参照，只读）：`/Users/caizhongrui/Documents/workspace/production/jiusi/api`（`jiusi-openapi`/`jiusi-proxy` 模块）
  - qdport 管理端（要加适配层）：`/Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api`（注意有本地未推送 commit `358ca6c` 和一些未提交的 yml/Dockerfile 改动，动手前先看 `git status`）
  - 码弦 ide（修复移植的源，参照只读）：分支 `claude/heuristic-moore-0c97e9`，未出货 commits：`7c3e669`（400自愈）、`9175267`（截断检测）、`41f7651`（截断重试）
- qdport 编译验证：`mvn compile -pl boyo-knowledge -am -DskipTests`（新模块建好后：`mvn compile -pl boyo-jiusi-adapter -am -DskipTests`）
- 九思 client 校验：`pnpm -r --if-present typecheck`；桌面 dev：`pnpm --filter @jiusi/desktop run tauri:dev`
- 码弦的回归清单：ide 仓库 `docs/regression-checklist.md`
- 遵守 ide 仓库 CLAUDE.md 纪律（一次重构只改一件事、HTTP 路由变更同步文档等）；qdport/jiusi 仓库如有各自 CLAUDE.md 同样遵守。

---

## 附录 A：端口修复移植详细说明（九思侧，对应 §4-#1/#2）

### A.0 原理：为什么旧方案有竞态、新方案没有

**九思现状（旧方案，`jiusi-desktop/src-tauri/src/lib.rs` 的 `spawn_server`）**：
```
probe_existing_server(51823)   # /health 探活，是自己的残留就复用（__REUSE_EXISTING__）
→ find_free_port(51823)        # Rust 进程里 TcpListener::bind 试绑，+1 递增找空闲
→ spawn sidecar --port <探测到的端口>   # sidecar 自己再 bind 一次
```
缺陷：① **试绑→sidecar 真正 bind 之间有时间窗**（sidecar 启动还要先同步读 DB，几百 ms~1s+），任何进程在窗口内抢占该端口，sidecar 就 EADDRINUSE 崩；② 端口被「杀不掉的占用者」握住时（实战案例：安全软件 MITM 回环 TCP 留下 ESTABLISHED 连接、taskkill 拒绝访问），固定起点的探测可能反复踩坑；③ 残留 sidecar 复用有自杀隐患（它的 parent-death watcher 认的是旧 app 的 stdin）。

**新方案（码弦 v0.2.44/45 已实战验证）**：
```
spawn sidecar --port 0         # 内核在 sidecar bind 时原子分配空闲端口——不存在探测窗口
→ sidecar listen 成功后 stdout 打印 __JIUSI_READY__ {"port":NNNNN,...}
→ Rust 行缓冲解析握手 → 写入 ServerPort state + emit 事件主动推给前端
→ Windows: 把 sidecar 挂进 kill-on-close Job Object（父进程死亡 OS 自动连带杀，孤儿绝迹）
```
实测：连续 6 次重启 + 3 实例并发启动，EADDRINUSE 全 0，每次都拿到不同空闲端口。

### A.1 Rust 侧改动（`jiusi-desktop/src-tauri/src/lib.rs`）

1. **`spawn_server` 端口选择段整段删除**：
   - 删 `probe_existing_server(...)` 调用及 `__REUSE_EXISTING__` 复用分支（port=0 模式下每次新端口，不存在「复用固定端口上的残留」；残留治理交给 Job Object）；
   - 删 `find_free_port(...)` 调用；`probe_existing_server`/`find_free_port` 两个函数整体删除；
   - sidecar 启动参数改 `"--port", "0"`。
2. **签名协调（九思特有）**：九思 `spawn_server` 返回 `(CommandChild, u16)`，spawn 时已知端口；port=0 后 spawn 时**不知道**端口（异步握手到达）→ 返回值改 `Result<CommandChild, String>`，`store_server_state` 去掉 port 参数（端口由握手解析写入 `ServerPort`）；调用点（setup 初次启动 + **崩溃自动拉起处** `match spawn_server(&app2)`）同步调整。**自动拉起逻辑本身保留**——拉起的新实例同样 port=0 → 新端口 → 握手 → 推送事件 → 前端自动跟随。
3. **新增 `parse_ready_port`**（解析握手行，九思的标记是 `__JIUSI_READY__`，sidecar 已在输出、无需改服务端）：
   ```rust
   fn parse_ready_port(line: &str) -> Option<u16> {
       let brace = line.find('{')?;
       let v: serde_json::Value = serde_json::from_str(line[brace..].trim()).ok()?;
       v.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok())
   }
   ```
4. **stdout 消费循环改造**（spawn_server 内已有的 `CommandEvent::Stdout` 分支）：
   - 解码改 `String::from_utf8_lossy(&data)`——**实战坑**：`String::from_utf8` 在 chunk 边界切断多字节 UTF-8 时整块丢弃，会吞掉握手行导致端口解析失败；
   - 加行缓冲（Stdout 事件不保证按行切分）：累积到 `\n` 再逐行检查 `__JIUSI_READY__`；命中 → `parse_ready_port` → 写 `ServerPort` state → `app.emit("jiusi:server-ready", json!({"port": p, "baseUrl": format!("http://127.0.0.1:{}", p)}))` 主动推给前端 → 置 `ready_done` 不再解析；缓冲上限 16KB 防无界增长。
5. **`server_info` 命令**：握手到达前返回 `{"ready": false}`（**不要**臆测返回默认端口 51823——旧行为会让前端死连错误端口）；到达后返回 `{"ready":true, "baseUrl":..., "port":...}`。`JIUSI_PORT` 环境变量仍可作显式覆盖（standalone/dev 用）。
6. **新增 `winjob` 模块（Windows Job Object）**，spawn 成功拿到 pid 后调用：
   ```rust
   #[cfg(windows)]
   { if winjob::assign_kill_on_close(pid) { /* log ok */ } else { /* log 退回 stdin-EOF 兜底 */ } }
   ```
   模块完整代码照抄码弦 commit `5bfcf45` 的 `winjob` mod（约 60 行）：`CreateJobObjectW` 建进程级唯一 Job、`SetInformationJobObject` 设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、`OpenProcess(PROCESS_SET_QUOTA|PROCESS_TERMINATE)` + `AssignProcessToJobObject` 挂入；Job 句柄存 `OnceLock` 活到进程退出（故意不 CloseHandle——进程死亡时 OS 关句柄即触发连带终止，这正是要的语义）。mac/linux 不编译此模块，保留 sidecar 既有 stdin-EOF watcher 兜底（`PR_SET_PDEATHSIG` 需子进程 exec 前自设，无法经 tauri-plugin-shell 注入）。

### A.2 `jiusi-desktop/src-tauri/Cargo.toml` 加依赖

```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = [
    "Win32_Foundation",
    "Win32_Security",            # ← 必须：CreateJobObjectW 被此 feature 门控（实测踩过，缺它编译不过）
    "Win32_System_JobObjects",
    "Win32_System_Threading",
] }
```

### A.3 sidecar（`jiusi-server`）——基本无需改

- `__JIUSI_READY__ {json}` 握手行已存在（cli.ts `console.log` 处，含 port 字段）；
- 确认 `adapter/node.ts` 的 `listen` 在 `port:0` 下从 `server.address()` 取实际端口（码弦同源文件已支持，注释明确写了「port=0 让 OS 分配随机端口」；九思同源大概率一致，移植时花一分钟确认）。

### A.4 前端（`jiusi-desktop/src/api.ts`）——事件监听（对应码弦 v0.2.45）

1. 新增 `listenServerReady()`（幂等）：`@tauri-apps/api/event` 的 `listen('jiusi:server-ready', ...)` → 收到后 `resolvedInfo = {baseUrl, ...}`、`_client = null`（下次 getClient 用新端口重建）；
2. `getClient()` 开头调 `listenServerReady()`（确保监听尽早挂上）；
3. `waitForServer()` 轮询循环**每轮重取** `c = await getClient()`（事件一到立刻生效）；保留「每 5 次失败 `resetClient()` 重新 invoke server_info」作兜底（应对事件在监听器注册前发出被错过）。

### A.5 验证清单（移植完逐项跑）

| 验证 | 方法 | 预期 |
|---|---|---|
| Rust 编译 | `cargo check`（mac）+ 隔离 crate `cargo check --target x86_64-pc-windows-msvc`（验 winjob，mac 上整包 cross-check 会被 ring 的 C 依赖卡住，码弦侧用隔离 crate 法通过） | 零 error |
| 端口不撞 | sidecar 二进制直接 `--port 0` 起 6 次（杀掉再起）+ 3 个并发 | 每次不同端口，EADDRINUSE=0 |
| 握手链路 | tauri dev 启动，看 sidecar 日志 | 依次出现 `spawn OK（等待 __JIUSI_READY__）`→`Listening on :NNNNN`→`[ready] 实际端口=NNNNN`→ 前端请求打到 NNNNN |
| 前端跟随 | 启动后前端能正常进主界面 | 不再死连 51823 |
| Job Object（仅 Windows 实机） | 任务管理器强杀 jiusi-desktop.exe | jiusi-server.exe 同时消失（不再残留） |
| 崩溃自动拉起协调 | 手动 kill sidecar 进程 | 1s 后自动拉起、拿到**新端口**、前端经事件自动跟随恢复 |

> 码弦侧参照实现：ide 仓库分支 `claude/heuristic-moore-0c97e9`，commit `5bfcf45`（端口0+Job Object+握手解析）、`c92a8e5`（事件推送+lossy+前端监听）。两 commit 的 diff 就是完整答案，九思侧主要差异：标记名 `__JIUSI_READY__`、事件名 `jiusi:server-ready`、env 前缀 `JIUSI_*`、以及 §A.1-2 的返回值/自动拉起协调。

---

## 附录 B：NodeTerminal 后台命令卡死修复移植说明（对应 §4-#3）

### B.0 问题与原理

`executeStream` 判定命令完成只靠 `child.on('close')`。`'close'` 的语义是「进程退出**且** stdio 管道全部关闭」——当命令把后台孙进程留在身后（典型：AI 执行 `nohup node server > log 2>&1 & echo "PID=$!"` 起 dev server），孙进程**继承并持续持有** stdout/stderr 管道写端，父 shell 退出后 `'close'` 永不触发 → `executeStream` 不 yield exit chunk → 上层 `for await` 挂到超时（60–120s），UI 表现为「AI 执行命令后卡住不动」，最后还误报 timedOut。

修复：补订阅 `'exit'`（进程本身退出，先于 'close' 触发）。正常命令仍走 'close' 主路径（输出完整）；进程退出后给 **200ms 排空窗口**让最后的缓冲输出（如 `echo PID=$!` 的结果）落地，'close' 仍未到则强制收尾——孙进程继续后台运行，父侧立即返回。码弦实测：卡 8000ms 超时 → **6ms** 正常返回。

### B.1 改动（`jiusi-core/src/adapters/NodeTerminal.ts`，与码弦修复前同构，照搬即可）

替换原 `child.on('close', ...)` 单一收尾为三件套（完整代码见码弦 v0.2.44 commit `5bfcf45` 中 NodeTerminal.ts 的 diff）：

1. **幂等 `finalize()`**：`finished` 守卫；清 killTimer/idleChecker/graceTimer；`removeAllListeners('data')` + `child.unref()`（摘除监听让孙进程自由运行）；`enqueue({type:'exit', exitCode: timedOut ? null : lastExitCode, ...})`；
2. **`child.on('close')`**：记录 exitCode → `finalize()`（正常命令主路径，行为不变）；
3. **`child.on('exit')`**：记录 exitCode → `graceTimer = setTimeout(finalize, 200)`（孙进程持管道时的逃生路径）；
4. `child.on('error')` 收尾处同步清 graceTimer。

### B.2 验证（用编译产物直接实测）

| 用例 | 命令 | 预期 |
|---|---|---|
| 卡死复现型 | `nohup sleep 20 > /tmp/x.log 2>&1 & echo "PID=$!"` | **<300ms** 返回 exit=0，stdout 含 PID（修复前挂满 timeoutMs 且误报 timedOut） |
| 普通命令 | `echo hello` | 无新增延迟（~3ms） |
| 退出码传播 | `sh -c "exit 7"` | exit=7 正确传播 |

---

## 附录 C：tool_calls 配对 400 自愈移植说明（对应 §4-#4）

### C.0 问题与原理

上游返回 400「`An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`」时，破损在**会话历史**里——每次请求都复现，会话永久卡死（码弦实机案例：sidecar 出站已验证合规，仍反复 400，嫌疑在上游网关丢配对）。防线两层：

- **第一层 repair（请求前自愈）**：扫描出站消息，发现 assistant.tool_calls 后面缺对应 role:tool 回复 → 立刻插占位 tool 消息。来源：取消时未补 placeholder / 旧版 bug / 压缩边界裁错。
- **第二层消毒重试（请求后自愈）**：repair 保证了出站合规，但链路上的网关仍可能丢配对。命中此类 400 且**未输出任何内容**时，把历史中的工具对话**降级为纯文本**（assistant.tool_calls 折叠进 content、role:tool 转 user 文本——语义无损但消除所有 tool 配对结构，绕开任何层的配对校验）重发一次。

### C.1 九思现状与改动

- `jiusi-core/src/api/aiProxyHandler.ts`：**有** `repairOrphanToolCalls`（同源 v0.2.20）、**无**消毒重试；
- `jiusi-core/src/api/jiusiHandler.ts`（**九思模式主用 handler**）：repair 和消毒**都没有**——消息构建是独立实现。

改动（jiusiHandler 为主，aiProxyHandler 顺手补消毒）：

1. **repair 适配进 jiusiHandler**：把 aiProxyHandler 的 `repairOrphanToolCalls` 逻辑按 jiusiHandler 自己的消息结构适配（它构建 `body.messages` 处、发请求前调用）。算法不变：遍历→发现 assistant.tool_calls→收集紧随的 role:tool 已覆盖 ids→缺的补占位 `{role:'tool', tool_call_id, content:'[历史不完整：该工具结果丢失或未执行]'}`；
2. **消毒重试**（照搬码弦 `7c3e669`，两个纯函数 + 流消费包装）：
   - `isToolPairingError(err)`：`/tool_call/i` **且** `/(must be followed|did not have response|tool messages|preceding message)/i`（码弦实测：命中真实 400 原文、不误伤"用户名或密码错误"/"tool execution failed"）；
   - `sanitizeToolHistory(messages)`：assistant.tool_calls → 折叠为 `content + "\n[历史工具调用(已折叠为文本): name(args); ...]"` 并删 tool_calls 字段；role:tool → `{role:'user', content:'[历史工具结果 id]\n...'}`；其余原样；
   - 流消费处包一层：错误出现在**任何内容 chunk 之前**且命中识别 → 不上抛，`body.messages = sanitizeToolHistory(...)` 重发一次（只一次）；再失败如实上抛。jiusiHandler 的流读取在 `createMessage` 内联（无独立 processStream），包装位置在其 SSE 读循环外层。

### C.2 验证

- repair：五形态历史输入（孤儿在末尾+新 user / 并行 tool_calls 缺一 / 文本+tool_result 混合 / 图片+tool_result 混合 / 孤儿在最末）→ 输出全部满足 OpenAI 配对约束（校验器：每个 assistant.tool_calls 的全部 id 必须被紧随的 role:tool 覆盖）；
- 消毒：含真实 400 原文的识别命中 / 两类普通错误不误伤 / 消毒输出零 tool 结构且语义保留。

---

## 附录 D：流截断检测移植说明（对应 §4-#5，九思侧移植量已收窄）

### D.0 先说九思已有的（不要重复造）

九思 `jiusi-server/src/cli.ts` 的 agent 循环已具备（且比码弦实现更系统）：
- `consumeStreamWithStallRetry`：60s 静默 stall 检测 + 重发；
- **transient 瞬时错误自动重试**：`isTransientAiError`（5xx/空流/网络断连等）→ 退避 1.5/3s 重发，最多 2 次；
- **attempt 级回滚**：每次重发前把本轮累积器（iterText/iterReasoningText/toolCalls/工具流状态）复位到 iter-start 基线——半截输出不会与重试输出叠加。**码弦 `41f7651` 的回滚逻辑不需要移植**，九思现成。

### D.1 唯一缺口：「干净掐断」检测不到

`jiusi-core/src/api/jiusiHandler.ts` 读循环 `if (done) break;` 后无收尾判断：连接被**干净地关闭**（TCP FIN 正常到达——网关空闲超时主动断、上游进程退出，**不是**静默 stall，所以 stall 检测抓不到）且没收到 `[DONE]`/finish_reason 时，半截输出被当成「模型正常说完」静默结束——无错误上抛 → transient 重试不触发 → UI 停在「思考中」半截文字（码弦实机案例）。

### D.2 改动（两小步）

1. **jiusiHandler 加截断检测**（适配码弦 `9175267`）：读循环作用域加三个标记——`sawDoneMarker`（收到 `[DONE]` 时置位，九思在 296 行处理 [DONE]）、`finishReason`（收到任一 finish_reason 时记录，105 行已有字段定义）、`yieldedErrorChunk`（333 行已有的后端 error 块 yield 处置位）。读循环结束后、finally 前：
   ```ts
   if (!sawDoneMarker && !finishReason && !yieldedErrorChunk) {
       yield { type: 'error', error: '响应流被中途截断（未收到结束标记，疑似网络中断或网关超时），内容不完整。请重试。' };
   }
   ```
2. **`jiusi-server/src/cli.ts` 的 `isTransientAiError` 正则加一项**：`|响应流被中途截断`——让现成的 transient 重试 + 回滚机制接管自动重发。

### D.3 验证（mock SSE 流四场景，码弦侧脚本可复用）

| 场景 | 输入流 | 预期 |
|---|---|---|
| 截断流 | 只有半截 content、无 [DONE] 无 finish_reason | 报「响应流被中途截断」 |
| 正常流 | content + finish_reason + [DONE] | 不误报 |
| 有 finish 无 DONE | content + finish_reason（部分厂商习惯） | 不误报 |
| 后端业务错误流 | `{"error":{...}}` + [DONE] | 只报业务错误，不重复报截断 |

端到端：截断后应看到「上游瞬时错误，Ns 后自动重试…」提示条，随后输出自动接续，历史无半截+完整重复。
