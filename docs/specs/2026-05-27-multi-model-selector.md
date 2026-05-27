# 多模型选择功能 — 设计稿

**版本**：v0.2.25（草稿，待 review）
**日期**：2026-05-27
**作者**：码弦客户端团队
**状态**：design draft（未实施）

## 1. 背景与动机

### 1.1 现状

Maxian 桌面客户端当前对用户**不暴露模型选择**：

- 启动时 sidecar 用硬编码的 `businessCode`：Code 模式走 `IDE_CHAT_CODE`，Chat 模式走 `IDE_CHAT_ASK`。
- 云端 `ai_business_model_config` 表按 `business_code` 决定真实路由的 provider + model（`com.boyo.web.controller.system.AiBusinessModelConfigController`）。
- 用户**完全感知不到**当前用的是 Claude Sonnet 还是 DeepSeek 还是 Qwen。

### 1.2 痛点

- 不同任务（写代码 / 解释概念 / 看图）适合不同模型，用户没法选。
- 模型上限 / 视觉能力差异不向上层透出，用户传图给非 vision 模型 → 上游 400 报错（参见 [v0.2.24 changelog 错误中文化提示]）。
- 后端调整 business_code 的真实路由（A/B 测试 / 替换底层模型）时，用户没有任何感知和反馈通道。

### 1.3 目标

让用户：
1. 在 composer 上方下拉选模型；
2. **每个会话单独绑定**模型，切会话自动恢复；
3. UI 跟模型元数据联动——非 vision 模型自动隐藏图片上传、token 进度条上限按 contextWindow 走；
4. 切到小窗口模型时给出预警 + 一键压缩；
5. 切到非 vision 模型时历史图片自动跳过，不再 400 报错。

参照标杆：jiusi 客户端 v0.6.1 - v0.7.3 的完整方案。

## 2. 整体架构

### 2.1 关键：两层路由设计

| 层 | 字段 | 语义 | 唯一性 |
|---|---|---|---|
| **业务场景层** | `business_code` | "这是给 IDE Code 模式用的"——路由 / 计费 / 限流分组，可挂多模型供 priority fallback | 同 code 可多行 |
| **模型选择层** | `alias_code`（新增） | "用户面看到的某个具体模型"，1:1 映射到 ai_business_model_config 表的某一行 | 全表唯一 |

**用户选 alias_code → 后端直接定位到那一行，绕过 priority fallback**（用户既然指定了，就不再自动切换）。
**用户没选（首次启动会话）→ sidecar 用默认 `IDE_CHAT_CODE` business_code → 后端按 priority 自动选**（兼容现有行为）。

举例 admin 配置：

| business_code | alias_code | provider | model | is_public | priority |
|---|---|---|---|---|---|
| IDE_CHAT_CODE | sonnet45 | claude | claude-sonnet-4-5 | 1 | 10 |
| IDE_CHAT_CODE | deepseek-v4 | deepseek | deepseek-chat | 1 | 20 |
| IDE_CHAT_CODE | qwen-coder | qwen | qwen-3-coder | 1 | 30 |
| IDE_CHAT_CODE | sonnet35-bkp | claude | claude-sonnet-3-5 | **0** | 99 |
| IDE_CHAT_ASK | sonnet45-ask | claude | claude-sonnet-4-5 | 1 | 10 |

前端只暴露 4 个公开 alias（`sonnet45 / deepseek-v4 / qwen-coder / sonnet45-ask`）。
`sonnet35-bkp` 是管理员留的 fallback，is_public=0 用户不可见，但用户不指定 alias 时 priority pool 仍会兜底用到。

### 2.2 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│  desktop (apps/desktop)                                             │
│                                                                     │
│  ┌────────────────────┐                  ┌──────────────────────┐  │
│  │ ModelSelector      │ ←─ per-session ─→│ session.alias_code   │  │
│  │ (composer 上方)     │                  │ (sidecar SQLite 字段) │  │
│  └─────────┬──────────┘                  └──────────────────────┘  │
│            │                                                        │
│            │ availableModels (2 min TTL cache)                      │
│            ↓                                                        │
│  ┌────────────────────┐                                             │
│  │ Solid signal       │                                             │
│  └─────────┬──────────┘                                             │
└────────────┼────────────────────────────────────────────────────────┘
             │ HTTP GET /available-models
             │ HTTP PATCH /sessions/:id/model { aliasCode }
             ↓
┌─────────────────────────────────────────────────────────────────────┐
│  sidecar (maxian-server, Bun --compile)                             │
│  - 透传 /available-models 给云端（2 min 内存缓存）                     │
│  - 维护 sessions.alias_code                                          │
│  - runAgentLoop 按 alias → row → provider+model 直接路由               │
│    （alias 为空时退回 business_code + priority fallback）             │
│  - AiProxyHandler buildMessages 按 supports_vision 降级图片            │
└────────────┬────────────────────────────────────────────────────────┘
             │ HTTP GET /ai/proxy/available-models
             │ HTTP POST /ai/proxy/chat/completions
             │   body 加 aliasCode 字段（云端按 alias 锁定行,绕过 priority）
             ↓
┌─────────────────────────────────────────────────────────────────────┐
│  qdport-ai-api (Spring Boot, com.boyo.*)                            │
│  - ai_business_model_config 表加 6 字段（alias_code + 5 个 meta）     │
│  - AiProxyController 加 GET /available-models endpoint               │
│  - 现有 chat/completions 改造：若 body 带 aliasCode 则按 alias 锁定行   │
│    否则保持现有 business_code + priority 行为                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 关键决策（brainstorming 已确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 模型清单来源 | 云端 API | 后端可控、admin 维护、不需要客户端发版加新模型 |
| 绑定粒度 | per-session | 不同任务用不同模型的常见诉求 |
| UI 位置 | composer 上方，与 ModeSelector 并排 | 决策区紧凑，jiusi 验证过的位置 |
| MVP 范围 | 全套（含超额检测 + vision 降级） | 一次到位，避免后续踩 vision 兼容坑 |
| **路由分层** | **business_code + alias_code 两层** | **保留 fallback 能力的同时支持用户精确选择** |

## 3. 后端改动（qdport-ai-api）

### 3.1 Schema 迁移

```sql
-- V<next>__alter_ai_business_model_config_add_alias_and_meta.sql
ALTER TABLE ai_business_model_config
  ADD COLUMN alias_code       VARCHAR(64)  DEFAULT NULL,
  ADD COLUMN display_name     VARCHAR(128) NOT NULL DEFAULT '',
  ADD COLUMN context_window   INT          DEFAULT NULL,
  ADD COLUMN supports_vision  TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN is_public        TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN sort_no          INT          NOT NULL DEFAULT 0;

-- alias_code 全表唯一索引（用户面 ID）。允许 NULL（老数据迁移前不强制）。
CREATE UNIQUE INDEX uniq_aibmc_alias ON ai_business_model_config (alias_code);
CREATE INDEX idx_aibmc_public_sort ON ai_business_model_config (is_public, sort_no);

-- 给现有公开模型补 alias_code + 元数据（按客户实际业务调整）：
UPDATE ai_business_model_config
SET alias_code = 'sonnet45-code', display_name = 'Claude Sonnet 4.5',
    context_window = 200000, supports_vision = 1, is_public = 1, sort_no = 10
WHERE business_code = 'IDE_CHAT_CODE' AND provider = 'claude';

UPDATE ai_business_model_config
SET alias_code = 'sonnet45-ask', display_name = 'Claude Sonnet 4.5 (Ask)',
    context_window = 200000, supports_vision = 1, is_public = 1, sort_no = 20
WHERE business_code = 'IDE_CHAT_ASK' AND provider = 'claude';

-- 其他 business_code 行如有需要按上面模板加；不公开的保持 is_public = 0。
-- 老 fallback 行可以不补 alias_code，is_public = 0 即可（用户面看不到，priority pool 仍能兜底）。
```

字段语义：

| 字段 | 类型 | 说明 |
|---|---|---|
| **alias_code** | varchar(64) | **用户面唯一 ID**，前端按这个标识具体模型。用户选了某 alias 就锁定到这一行 |
| display_name | varchar(128) | 用户面显示文案，如 "Claude Sonnet 4.5" |
| context_window | int | 上下文窗口 token 数；前端 token 进度条上限同步用 |
| supports_vision | tinyint(1) | 是否支持图片输入；前端图片上传按钮 / 后端 buildMessages 降级用 |
| is_public | tinyint(1) | 是否对用户面可见；admin 可单独维护内部 business_code |
| sort_no | int | 升序排序 |

**alias_code 与 business_code 的关系**：
- 一个 business_code 可以挂多个 alias_code（用户可选的多种模型）+ 若干无 alias 行（仅作 priority fallback）
- 用户选 alias → 路由直接锁定到该行的 provider+model，**不再 fallback**
- 用户未选（首次会话 / 老客户端不带 alias）→ 走原 business_code + priority 池

### 3.2 DTO

新建 `boyo-knowledge/src/main/java/com/boyo/knowledge/dto/AvailableModelVO.java`：

```java
package com.boyo.knowledge.dto;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class AvailableModelVO {
    /** 用户面唯一 ID（前端按这个标识 + 传回后端定位行） */
    private String  aliasCode;
    /** 业务场景代码（仅作分组 / 调试展示用，路由不依赖它） */
    private String  businessCode;
    /** 用户面展示文案 */
    private String  displayName;
    /** AI 提供商标识：openai / qwen / deepseek / claude 等 */
    private String  provider;
    /** 上下文窗口 token 数（可能为 null，前端按默认 128k fallback） */
    private Integer contextWindow;
    /** 是否支持视觉输入 */
    private Boolean supportsVision;
    /** 排序，升序 */
    private Integer sortNo;
}
```

### 3.3 Controller endpoint

`AiProxyController.java` 添加：

```java
@GetMapping("/available-models")
@Operation(summary = "用户面可见的模型清单", description = "用于客户端模型选择器")
public R<List<AvailableModelVO>> listAvailableModels() {
    // 仅返回有 alias_code 且 is_public=1 且 is_enabled=1 的行（无 alias 的是内部 fallback）
    List<AiBusinessModelConfig> rows = aiBusinessModelConfigService.list(
        new LambdaQueryWrapper<AiBusinessModelConfig>()
            .eq(AiBusinessModelConfig::getIsEnabled, 1)
            .eq(AiBusinessModelConfig::getIsPublic, 1)
            .isNotNull(AiBusinessModelConfig::getAliasCode)
            .ne(AiBusinessModelConfig::getAliasCode, "")
            .orderByAsc(AiBusinessModelConfig::getSortNo));

    List<AvailableModelVO> list = rows.stream().map(r -> AvailableModelVO.builder()
        .aliasCode(r.getAliasCode())
        .businessCode(r.getBusinessCode())
        .displayName(StringUtils.hasText(r.getDisplayName()) ? r.getDisplayName() : r.getBusinessName())
        .provider(r.getProvider())
        .contextWindow(r.getContextWindow())
        .supportsVision(Boolean.TRUE.equals(r.getSupportsVision()))
        .sortNo(r.getSortNo())
        .build()).toList();

    return R.ok(list);
}
```

端点路径完整：`GET /ai/proxy/available-models`。

### 3.3b 现有 chat/completions 改造

`AiProxyController` 的 `/chat/completions` / `/stream/chat/completions` / `/sdk/stream/chat/completions` 等 endpoint 的请求 body 加可选字段 `aliasCode`：

```java
public class ChatCompletionRequest {
    private String businessCode;
    private String aliasCode;        // NEW: 若非空,服务端按 alias 锁定到具体行,忽略 priority
    private List<Message> messages;
    // ...
}
```

服务端 `AiProxyServiceImpl.routeModel(request)`：

```java
if (StringUtils.hasText(request.getAliasCode())) {
    // alias 路由：直接锁定一行,绕过 priority fallback
    return aiBusinessModelConfigService.getOne(
        new LambdaQueryWrapper<AiBusinessModelConfig>()
            .eq(AiBusinessModelConfig::getAliasCode, request.getAliasCode())
            .eq(AiBusinessModelConfig::getIsEnabled, 1));
} else {
    // 老逻辑：按 business_code + priority 选 active 行
    return existingPriorityRoute(request.getBusinessCode());
}
```

向后兼容：老客户端 / sidecar 不传 aliasCode 时行为完全不变。

### 3.4 admin 前端表单

`qdport/ai/ui/src/views/system/aiBusinessModel/index.vue` 加 6 个字段输入：

- `alias_code` —— 文本输入，**全局唯一**校验，hint "用户面 ID，如 sonnet45 / deepseek-v4；留空则此行仅作 priority fallback"
- `display_name` —— 文本输入
- `context_window` —— 数字输入，placeholder "如 200000 表示 200k"
- `supports_vision` —— switch
- `is_public` —— switch，hint "勾选后用户端模型选择器会看到此条（且必须填了 alias_code）"
- `sort_no` —— 数字输入

**前端校验**：
- 若 `is_public = 1` 则 `alias_code` 必填
- `alias_code` 全表唯一（提交时调后端 `/check-alias-unique?code=xxx`）

列表页表头加这 6 列（compact 显示），筛选条件加 `is_public` + `alias_code` 模糊搜索。

## 4. Sidecar 改动（maxian-server）

### 4.1 Schema 迁移

在 `packages/server/src/database.ts` 的 schema 初始化 SQL 里加：

```sql
ALTER TABLE sessions ADD COLUMN alias_code TEXT;
```

字段名跟后端 `ai_business_model_config.alias_code` **完全对齐**——三层（后端 Java / sidecar TS / desktop TS）统一用 `alias_code`（SQLite snake_case）/ `aliasCode`（TS camelCase），grep 一搜全在，不增加心智负担。

迁移用 `IF NOT EXISTS` 兼容老数据。`rowToSummary` 也要回填字段。

### 4.2 HTTP 路由

`packages/server/src/routes/session.ts` 加：

```ts
// 设置会话绑定的模型 alias
app.patch('/sessions/:id/model',
  zValidator('json', z.object({ aliasCode: z.string().nullable() })),
  async (c) => {
    const id = c.req.param('id');
    const { aliasCode } = c.req.valid('json');
    await sessionManager.setSessionModel(id, aliasCode);
    return c.json({ ok: true });
  });
```

新文件 `packages/server/src/routes/availableModels.ts`：

```ts
// GET /available-models —— 透传 qdport-ai-api 的 /ai/proxy/available-models
// 2 min 内存缓存，复用 sidecar 启动时的 AI 凭据
let _cached: { ts: number; data: AvailableModelVO[] } | null = null;
const TTL_MS = 2 * 60 * 1000;

app.get('/available-models', async (c) => {
  if (_cached && Date.now() - _cached.ts < TTL_MS) {
    return c.json({ models: _cached.data, cached: true });
  }
  const cfg = server.getAiConfig() ?? aiConfig;
  if (!cfg) return c.json({ models: [], cached: false });
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  const res = await fetch(`${cfg.apiUrl}/ai/proxy/available-models`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    return c.json({ models: [], error: `upstream ${res.status}` }, 200);
  }
  const data = await res.json() as { data: AvailableModelVO[] };
  _cached = { ts: Date.now(), data: data.data ?? [] };
  return c.json({ models: _cached.data, cached: false });
});
```

错误处理：上游失败时返回空数组 + error 字段，**不抛 500**。前端拿到空清单后 fallback 到"默认模型"（即不显示选择器）。

### 4.3 SessionManager 新方法

```ts
// packages/server/src/sessionManager.ts
async setSessionModel(id: string, aliasCode: string | null): Promise<void> {
  const db = getDb();
  db.prepare('UPDATE sessions SET alias_code = ? WHERE id = ?').run(aliasCode, id);
}
```

`SessionSummary` 类型加可选字段 `aliasCode?: string | null`，`rowToSummary` 回填。

### 4.4 getAiHandler 改造

两层路由的核心：sidecar 始终传 business_code（按 uiMode 决定），同时若 session 选了 alias 就一并透传给云端，云端按 §3.3b 锁定行。

```ts
// packages/server/src/cli.ts
function getAiHandler(uiMode?: string, sessionAliasCode?: string | null): AiProxyHandler | null {
  // business_code 永远按 uiMode 决定（路由 / 计费分组）
  const defaultBizCode = uiMode === 'chat' ? 'IDE_CHAT_ASK' : 'IDE_CHAT_CODE';
  // 若 session 选了 alias，从 modelMetaCache（§4.5）查 supports_vision 等 meta
  const meta = sessionAliasCode ? modelMetaCache.get(sessionAliasCode) : null;
  // cache key 加 alias 维度（不同 alias 走不同 handler 实例，supportsVision 不会串）
  const cacheKey = `rt|${apiUrl}|${username}|${defaultBizCode}|${sessionAliasCode ?? ''}`;
  const cached = __aiHandlerCache.get(cacheKey);
  if (cached) return cached;

  const h = new AiProxyHandler({
    apiUrl, username, password,
    businessCode:   defaultBizCode,
    aliasCode:      sessionAliasCode ?? undefined,     // 透传给云端
    supportsVision: meta?.supportsVision ?? true,      // 默认乐观,见 §4.5
  });
  __aiHandlerCache.set(cacheKey, h);
  return h;
}
```

`AiProxyHandler.createMessage` 构造 POST body 时加 `aliasCode` 字段（若非空），云端按 §3.3b 锁定行。

`runAgentLoop` 入口读取 session.aliasCode：

```ts
const sess = server.sessionManager.getSession(sessionId);
const handler = getAiHandler(uiMode, sess?.aliasCode);
```

### 4.5 AiProxyHandler vision 降级

**数据获取**：sidecar 的 `/available-models` 透传 endpoint 已经缓存了模型清单（含 supports_vision）。把那个缓存抽出成模块级 `modelMetaCache: Map<aliasCode, AvailableModel>`，`getAiHandler(uiMode, sessionAliasCode)` 创建 handler 时按 alias 查这个 Map 拿到 supports_vision，**不**直接打云端、**不**新增 SQL 查询。

```ts
// packages/server/src/cli.ts
const modelMetaCache = new Map<string, AvailableModel>();   // key = aliasCode

// 透传 endpoint 拉清单时同步更新 cache
async function refreshModelCache(): Promise<void> {
  const { models } = await fetchAvailableModelsFromCloud();
  modelMetaCache.clear();
  for (const m of models) modelMetaCache.set(m.aliasCode, m);
}
```

（getAiHandler 完整代码见 §4.4。）

`packages/core/src/api/aiProxyHandler.ts` 的 `AiProxyConfiguration` 加 `supportsVision?: boolean` 字段（默认 true，向后兼容）。

`buildMessages` 里增加（参照 jiusi `jiusiHandler.ts:582-609`）：

```ts
if (this.config.supportsVision === false) {
  let droppedImages = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      const filtered: ContentPart[] = [];
      let textBuf = '';
      for (const part of msg.content) {
        if (part.type === 'image_url') {
          droppedImages++;
        } else if (part.type === 'text') {
          textBuf += part.text;
        }
      }
      if (droppedImages > 0) {
        textBuf += `\n[此处原有 ${droppedImages} 张图片，因当前模型不支持视觉已省略]`;
      }
      msg.content = textBuf;  // 整段塌成纯文本
    }
  }
}
```

**乐观默认的取舍**：拉清单失败 / 清单里没找到对应 alias_code（包括用户未选 alias 的旧会话）时，`supportsVision` 默认 true，**不主动降级**。这样：
- 真支持 vision 的模型不会被误伤
- 真不支持 vision 的模型若没在清单里 → 用户传图后上游 400 → friendlyHttpError 翻译为中文（v0.2.24 已加），用户可读 → 用户主动切模型解决

**缓存刷新时机**：sidecar 启动后异步 fire-and-forget 拉一次；`/available-models` 端点每次响应时刷新；可选加 onCancel-style refresh hook 让用户 force refresh。

### 4.6 SDK 方法

`packages/sdk/src/index.ts`：

```ts
async listAvailableModels(): Promise<{ models: AvailableModel[]; cached: boolean; error?: string }> {
  return this.request('GET', '/available-models');
}

async setSessionModel(sid: string, aliasCode: string | null): Promise<void> {
  await this.request('PATCH', `/sessions/${sid}/model`, { aliasCode });
}

export interface AvailableModel {
  aliasCode:      string;       // 用户面唯一 ID
  businessCode:   string;       // 业务场景代码（仅展示用，前端不传回）
  displayName:    string;
  provider:       string;
  contextWindow?: number;
  supportsVision: boolean;
  sortNo?:        number;
}
```

## 5. Desktop UI 改动

### 5.1 新组件 ModelSelector

`apps/desktop/src/components/ModelSelector.tsx`：

- props：`models` (accessor) / `currentAliasCode` / `loading` / `onSelect(aliasCode)` / `onRefresh()`
- 形态：button + dropdown，button 显示当前模型 displayName + 小三角
- dropdown 内容：每行一个 model（按 sortNo 升序），显示 `displayName · provider tag · ctx 200K · 🖼` 等
- 空清单 / 未选时：button 显示 "默认模型"（依赖 sidecar 走 IDE_CHAT_CODE + priority pool）

CSS 风格：跟 `ModeSelector` 一致，并排时视觉对齐。

### 5.2 App.tsx 集成

```tsx
const [availableModels, setAvailableModels] = createSignal<AvailableModel[]>([])
const [modelsLoading, setModelsLoading] = createSignal(false)

// 启动 + 工作区切换时拉一次
createEffect(() => {
  const ws = activeWorkspace()
  if (!ws) return
  void (async () => {
    setModelsLoading(true)
    try {
      const c = await getClient()
      const { models } = await c.listAvailableModels()
      setAvailableModels(models)
    } finally {
      setModelsLoading(false)
    }
  })()
})

// 当前会话的 aliasCode：切会话时自动同步
const currentAliasCode = createMemo(() => {
  const sess = activeSession()
  return sess?.aliasCode ?? null
})

// 模型 meta 派生
const currentModelMeta = createMemo(() => {
  const alias = currentAliasCode()
  if (!alias) return null
  return availableModels().find(m => m.aliasCode === alias) ?? null
})

// 切模型
async function switchModel(targetAlias: string) {
  const sid = activeSessionId()
  if (!sid) return
  // 超额检测见 §6.1
  if (!(await guardContextOverflow(targetAlias))) return
  const c = await getClient()
  await c.setSessionModel(sid, targetAlias)
  await refreshActiveSession()
}
```

### 5.3 ModelSelector 在 composer 区的位置

在 `ModeSelector` 右侧：

```tsx
<div class="composer-controls-row">
  <ModeSelector ... />
  <ModelSelector
    models={availableModels}
    currentAliasCode={currentAliasCode}
    loading={modelsLoading}
    onSelect={switchModel}
  />
  {/* 余下控件 */}
</div>
```

### 5.4 元数据驱动 UI

```tsx
// 图片上传按钮按 vision 能力显隐
<Show when={currentModelMeta()?.supportsVision === true}>
  <ImageUploadButton ... />
</Show>

// token 进度条上限同步
createEffect(() => {
  const ctx = currentModelMeta()?.contextWindow
  setTokenLimit(ctx ?? 128_000)
})
```

## 6. 进阶能力

### 6.1 切模型超额检测

```ts
async function guardContextOverflow(targetAlias: string): Promise<boolean> {
  const target = availableModels().find(m => m.aliasCode === targetAlias)
  if (!target?.contextWindow) return true  // 无 meta 时直接放行
  const current = tokenUsed()
  if (current <= target.contextWindow * 0.85) return true

  const decision = await showDialog({
    title: '当前对话可能超出目标模型上下文',
    body: `当前已用约 ${formatTokens(current)} tokens，目标模型 "${target.displayName}" 上限 ${formatTokens(target.contextWindow)} tokens。
        切换后超出部分可能被截断。
        建议先压缩上下文：`,
    actions: [
      { label: '压缩后切换（推荐）', value: 'compact' },
      { label: '直接切换', value: 'force' },
      { label: '取消', value: 'cancel' },
    ],
  })
  if (decision === 'cancel') return false
  if (decision === 'compact') {
    const c = await getClient()
    await c.compactSession(activeSessionId()!)
  }
  return true
}
```

### 6.2 Vision 降级（sidecar 实现，见 §4.5）

后端 buildMessages 阶段实现，对前端透明。前端只需在选模型时提示用户「当前模型不支持视觉，历史图片切换后将自动跳过」（友好告知，不阻塞操作）。

### 6.3 缓存策略

- sidecar：2 min TTL（内存），失效时拉云端，云端失败时返回 stale + warning
- desktop：不另缓存，每次切工作区时拉一次
- 不监听文件变化，不订阅 SSE 推送——模型清单变化频率低，refresh 用手动按钮 + 工作区切换触发已经足够

## 7. 协议变更

- 新 HTTP 路由（sidecar）：`GET /available-models`、`PATCH /sessions/:id/model`
- 协议版本 `X-Maxian-Protocol`：从当前 v1.1 → v1.2（minor，向后兼容）
- 新事件：暂无 SSE 事件（切模型不广播，前端主动 refresh）
- 旧客户端连新 sidecar：完全兼容（旧客户端不调新端点，session.business_code 为 NULL 时退回默认 `IDE_CHAT_CODE`）

需更新文档：

- `docs/protocol/CHANGELOG.md`：加 v1.2 条目
- `docs/architecture/http-api.md`：补 2 个新路由

## 8. 分阶段交付计划

| 阶段 | 工作量 | 内容 | 阻塞 |
|---|---|---|---|
| P1 后端 schema + endpoint | 0.5 天 | qdport-ai-api 改动（§3.1-3.3） | 无 |
| P2 admin 前端表单 | 0.5 天 | qdport/ai/ui Vue 表单（§3.4） | P1 |
| P3 sidecar schema + 路由 | 0.5 天 | maxian-server 改动（§4.1-4.4, 4.6） | P1（依赖 endpoint）|
| P4 desktop UI 基础 | 0.5 天 | ModelSelector 组件 + 拉清单 + 切模型（§5.1-5.3） | P3 |
| P5 元数据驱动 UI | 1 天 | vision 按钮显隐 + tokenLimit 同步（§5.4） | P4 |
| P6 切模型超额检测 | 1 天 | dialog + compact 联动（§6.1） | P4 |
| P7 Vision 降级 | 1 天 | sidecar buildMessages 跳过 image blocks（§4.5, §6.2） | P3 |

**估总**：5 天（4 仓串行依赖）。

**风险点**：
1. **P1 schema 迁移**需要 DBA / 生产部署窗口。
2. **P2 admin 前端**改完需要后端打包重发部署，迭代慢。
3. **P3-P4 sidecar 改 schema** 需要清理用户老 SQLite（兼容 `ALTER TABLE IF NOT EXISTS COLUMN` 写法）。
4. **P7 vision 降级**改 `AiProxyHandler.buildMessages` 是核心 LLM 调用路径，必须有充分单元测试 + 真实切模型回归。

## 9. 测试 / 回归

- 后端：JUnit 测 endpoint 返回字段完整、is_public 过滤、空清单兜底
- sidecar：Vitest 测 setSessionModel + getAiHandler 优先级（session > default）+ /available-models 缓存
- desktop：手动验证：
  1. 启动客户端，模型选择器出现，默认选项是 sidecar 启动配置的 IDE_CHAT_CODE
  2. 切模型 → SDK 调用 → DB 字段更新 → 切会话后恢复
  3. 切到无 vision 模型 → 图片上传按钮消失 → 已上传图片仍在历史里 → 发送时 sidecar 跳过 → AI 回复不卡
  4. 切回 vision 模型 → 图片重新可见
  5. 切到小 ctx 模型且当前 tokens 超 85% → 弹超额对话框 → "压缩并切换"路径走通

跑 `docs/regression-checklist.md` 全量。

## 10. 不在本期范围

- **模型价格展示**：jiusi 0.7.x 有价格 tooltip + 节省统计，我们当前后端没有计费/价格表，整套体现"成本"需重型设计，本期跳过。
- **模型快捷切换键**：不加键盘快捷键。
- **多 provider 凭据并存**：用户不直接持有 Anthropic/DeepSeek API key，统一走码弦云。
- **客户端硬编码模型 fallback**：sidecar 拉不到清单时不 fallback 到硬编码列表，直接隐藏选择器，依赖 sidecar 默认 IDE_CHAT_CODE。
- **A/B testing UI**：管理员 A/B 配 business_code 模型路由是后端管的事，前端只感知用户面 displayName。

## 11. 实施 Order of Operations

按 CLAUDE.md "一次重构只改一件事，PR 可独立合并/回退"：

1. **PR1**（qdport-ai-api）：schema migration + DTO + Controller endpoint + 初始化 SQL
2. **PR2**（qdport-ai-api/ui）：admin Vue 表单加字段
3. **PR3**（maxian repo）：sidecar schema + 路由 + SDK + AiProxyHandler 改造
4. **PR4**（maxian repo）：desktop ModelSelector 组件 + composer 集成
5. **PR5**（maxian repo）：元数据驱动 UI
6. **PR6**（maxian repo）：切模型超额检测
7. **PR7**（maxian repo）：Vision 降级 sidecar 端

每个 PR 独立可回退。PR3-PR7 是 maxian 客户端 monorepo 内部。

## 12. 参考

- jiusi 客户端 v0.6.1 - v0.7.3 changelog
- `jiusi-core/src/api/jiusiHandler.ts:582-609`（vision 降级原型）
- `jiusi-billing/AvailableModelsTenantController.java`（不同栈但 endpoint 形态可借鉴）
- 当前码弦云：`qdport-ai-api/boyo-system/.../AiBusinessModelConfig.java`、`boyo-knowledge/.../AiProxyController.java`
- 当前 maxian：`packages/server/src/cli.ts` getAiHandler / `packages/core/src/api/aiProxyHandler.ts`
