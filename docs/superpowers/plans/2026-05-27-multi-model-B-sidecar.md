# Plan B: 多模型选择 — maxian-server sidecar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** maxian-server sidecar 加 sessions.alias_code SQLite 列 + 新 HTTP 路由（PATCH /sessions/:id/model + GET /available-models 透传）+ modelMetaCache + getAiHandler 按 session alias 路由 + AiProxyHandler vision 降级。SDK 同步新方法。

**Architecture:** sidecar 持续保持现有 IDE_CHAT_CODE/IDE_CHAT_ASK 默认 business_code 行为；session 选了 alias 时把 alias 透传给云端 chat/completions（云端按 alias 锁定行）；用 alias 查本地 modelMetaCache 拿 supports_vision 给 AiProxyHandler 做 buildMessages 降级。

**Tech Stack:** TypeScript + Hono + Zod + Bun runtime（sidecar bundle）

**Spec 来源:** `docs/specs/2026-05-27-multi-model-selector.md` §4

**Repo cwd:** `/Users/caizhongrui/Documents/workspace/production/ide/.claude/worktrees/heuristic-moore-0c97e9`（当前 worktree）

**Plan 依赖:** Plan A1 已部署到测试环境（endpoint `/ai/proxy/available-models` 可调；chat/completions 接 aliasCode 已就绪）

---

## File Structure

| 文件 | 操作 | 责任 |
|---|---|---|
| `packages/server/src/database.ts` | Modify | schema 初始化 SQL 加 `ALTER TABLE sessions ADD COLUMN alias_code TEXT` |
| `packages/server/src/sessionManager.ts` | Modify | `setSessionModel(sid, aliasCode)` + `SessionSummary.aliasCode` + rowToSummary 回填 |
| `packages/server/src/routes/session.ts` | Modify | 加 `PATCH /sessions/:id/model` 路由 |
| `packages/server/src/routes/availableModels.ts` | Create | 新文件，透传 `GET /available-models` 给云端 + 2min 内存缓存 + 同步 modelMetaCache |
| `packages/server/src/modelMetaCache.ts` | Create | 新文件，模块级 `Map<aliasCode, AvailableModel>` |
| `packages/server/src/cli.ts` | Modify | 挂载 availableModels 路由；`getAiHandler(uiMode, sessionAliasCode)` 改造 |
| `packages/core/src/api/aiProxyHandler.ts` | Modify | `AiProxyConfiguration` 加 `aliasCode` + `supportsVision` 字段；POST body 加 aliasCode 透传；buildMessages 跳过 image blocks（当 supportsVision=false） |
| `packages/sdk/src/index.ts` | Modify | 加 `AvailableModel` 类型 + `listAvailableModels()` + `setSessionModel(sid, alias)` |
| `packages/shared-types/src/index.ts`（如有） | Modify | 共享 AvailableModel 类型 |

---

## Task 1: SQLite schema 加 alias_code 列

**Files:** `packages/server/src/database.ts`

- [ ] **Step 1: 找 sessions 表 schema 初始化代码**

```bash
grep -n "CREATE TABLE.*sessions\|sessions.*CREATE\|ADD COLUMN" packages/server/src/database.ts
```

- [ ] **Step 2: 加 ALTER 兼容老库**

找 `initDb` / `initSchema` / `runMigrations` 类似函数。在现有 ALTER 段后追加：

```ts
// K-MultiModel (v0.2.25)：sessions 表加 alias_code 列
// 用户在前端选模型时按 aliasCode 锁定行；为空则 sidecar 走默认 IDE_CHAT_CODE
db.exec(`
  ALTER TABLE sessions ADD COLUMN alias_code TEXT;
`);
```

包在 try/catch 里跳过 "duplicate column" 错（老库已加过）：

```ts
try {
  db.exec('ALTER TABLE sessions ADD COLUMN alias_code TEXT');
} catch (e: any) {
  if (!String(e?.message ?? '').includes('duplicate')) throw e;
}
```

- [ ] **Step 3: 验证 build + 启动 sidecar 不报错**

```bash
pnpm --filter @maxian/server run build 2>&1 | tail -5
rm -f packages/server/bin/maxian-server-aarch64-apple-darwin
node apps/desktop/scripts/sync-sidecar.mjs 2>&1 | tail -5
```

(可选) 临时启 sidecar 看 schema 加列成功：

```bash
ls ~/.maxian/maxian.db && sqlite3 ~/.maxian/maxian.db ".schema sessions" 2>&1 | grep alias_code
```

Expected: 看到 `alias_code TEXT` 列。

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/database.ts
git commit -m "feat(sidecar): sessions 表加 alias_code 列（K-MultiModel）"
```

---

## Task 2: SessionManager setSessionModel + SessionSummary.aliasCode

**Files:**
- `packages/server/src/sessionManager.ts`
- `packages/server/src/types.ts`（若 SessionSummary 在这里）

- [ ] **Step 1: 找 SessionSummary type**

```bash
grep -rn "interface SessionSummary\|type SessionSummary" packages/server/src
```

- [ ] **Step 2: 加 aliasCode 字段**

在 SessionSummary 字段列表末尾追加：

```ts
  /** K-MultiModel：用户选的模型 alias_code；null 表示走默认 IDE_CHAT_CODE */
  aliasCode?: string | null;
```

- [ ] **Step 3: 找 rowToSummary 函数加回填**

```bash
grep -n "function rowToSummary\|rowToSummary\b" packages/server/src/sessionManager.ts
```

在 rowToSummary 返回对象里加：

```ts
    aliasCode: (row as any).alias_code ?? null,
```

- [ ] **Step 4: 加 setSessionModel 方法**

在 SessionManager class 内 `deleteSession` 附近追加：

```ts
  /**
   * K-MultiModel (v0.2.25)：设置会话绑定的模型 alias_code。
   * 传 null 即清空（恢复默认行为）。
   */
  async setSessionModel(id: string, aliasCode: string | null): Promise<void> {
    const db = getDb();
    db.prepare('UPDATE sessions SET alias_code = ? WHERE id = ?').run(aliasCode, id);
  }
```

- [ ] **Step 5: build 验证**

```bash
pnpm --filter @maxian/server run build 2>&1 | tail -5
```

Expected: 编译通过。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/sessionManager.ts packages/server/src/types.ts
git commit -m "feat(sidecar): SessionManager 加 setSessionModel + SessionSummary.aliasCode (K-MultiModel)"
```

---

## Task 3: modelMetaCache 模块

**Files:** Create `packages/server/src/modelMetaCache.ts`

- [ ] **Step 1: 创建文件**

```ts
/*---------------------------------------------------------------------------------------------
 *  K-MultiModel (v0.2.25) — Model Meta Cache
 *
 *  按 aliasCode 索引的模型元数据缓存，由 /available-models 透传路由同步更新。
 *  getAiHandler 创建 handler 前查这个 Map 拿到 supports_vision 等 meta，
 *  避免每次 AI 调用都查云端 / 数据库。
 *--------------------------------------------------------------------------------------------*/

export interface AvailableModelMeta {
	aliasCode:      string;
	businessCode:   string;
	displayName:    string;
	provider:       string;
	contextWindow?: number;
	supportsVision: boolean;
	sortNo?:        number;
}

const cache = new Map<string, AvailableModelMeta>();

export function getModelMeta(aliasCode: string | null | undefined): AvailableModelMeta | null {
	if (!aliasCode) return null;
	return cache.get(aliasCode) ?? null;
}

export function setModelMetaList(models: AvailableModelMeta[]): void {
	cache.clear();
	for (const m of models) {
		if (m.aliasCode) cache.set(m.aliasCode, m);
	}
}

export function getModelMetaCacheSize(): number {
	return cache.size;
}
```

- [ ] **Step 2: build 验证**

```bash
pnpm --filter @maxian/server run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/modelMetaCache.ts
git commit -m "feat(sidecar): 新增 modelMetaCache 模块（按 aliasCode 索引）(K-MultiModel)"
```

---

## Task 4: 新路由 GET /available-models 透传

**Files:** Create `packages/server/src/routes/availableModels.ts`

- [ ] **Step 1: 找现有路由 register 模式**

```bash
grep -n "registerRoutes\|registerSessionRoutes\|app.get\|app.route" packages/server/src/routes/session.ts | head -5
```

- [ ] **Step 2: 创建透传路由文件**

```ts
/*---------------------------------------------------------------------------------------------
 *  K-MultiModel (v0.2.25) — /available-models route
 *
 *  透传云端 GET /ai/proxy/available-models 给客户端用，同时同步 modelMetaCache。
 *  2 min 内存缓存避免每次切会话都打云端。
 *--------------------------------------------------------------------------------------------*/

import type { Hono } from 'hono';
import { setModelMetaList, type AvailableModelMeta } from '../modelMetaCache.js';

let _cache: { ts: number; data: AvailableModelMeta[] } | null = null;
const TTL_MS = 2 * 60 * 1000;

export interface AvailableModelsRouteDeps {
	getAiConfig: () => { apiUrl: string; username: string; password: string } | null;
}

export function registerAvailableModelsRoute(app: Hono, deps: AvailableModelsRouteDeps): void {
	app.get('/available-models', async (c) => {
		// cache hit
		if (_cache && Date.now() - _cache.ts < TTL_MS) {
			return c.json({ models: _cache.data, cached: true });
		}
		const cfg = deps.getAiConfig();
		if (!cfg) {
			return c.json({ models: [], cached: false, error: 'AI 服务未配置' });
		}
		try {
			const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
			const res = await fetch(`${cfg.apiUrl.replace(/\/$/, '')}/ai/proxy/available-models`, {
				headers: { Authorization: `Basic ${auth}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				console.warn(`[available-models] upstream ${res.status}`);
				return c.json({ models: [], cached: false, error: `upstream ${res.status}` });
			}
			const body = await res.json() as { code?: number; data?: AvailableModelMeta[] };
			const data = body.data ?? [];
			_cache = { ts: Date.now(), data };
			setModelMetaList(data);
			console.log(`[available-models] 拉到 ${data.length} 个模型，已同步到 modelMetaCache`);
			return c.json({ models: data, cached: false });
		} catch (e) {
			console.error('[available-models] 拉取失败', e);
			return c.json({ models: _cache?.data ?? [], cached: !!_cache, error: (e as Error).message });
		}
	});
}
```

- [ ] **Step 3: 在 cli.ts 注册路由**

找 cli.ts 里 `registerSessionRoutes(app, ...)` 或类似的 route 注册区，追加：

```ts
import { registerAvailableModelsRoute } from './routes/availableModels.js';

// ...在 routes 注册区：
registerAvailableModelsRoute(app, {
  getAiConfig: () => server.getAiConfig() ?? (aiConfig?.type === 'proxy' ? {
    apiUrl: aiConfig.apiUrl, username: aiConfig.username, password: aiConfig.password,
  } : null),
});

// 启动后异步预热一次 modelMetaCache
fetch(`http://${opts.hostname}:${opts.port}/available-models`).catch(() => {});
```

- [ ] **Step 4: build + 启动验证**

```bash
pnpm --filter @maxian/server run build 2>&1 | tail -5
rm -f packages/server/bin/maxian-server-aarch64-apple-darwin
node apps/desktop/scripts/sync-sidecar.mjs 2>&1 | tail -3
```

(可选) curl 测：

```bash
# 启 dev / 拿端口 / 拿 auth basic
curl -s http://127.0.0.1:4096/available-models -u maxian:test123 | head -20
```

Expected: JSON `{"models":[...], "cached":false}`。如果 cloud endpoint 还没就绪返回 `{"models":[], "error":"..."}`，不崩。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/availableModels.ts packages/server/src/cli.ts
git commit -m "feat(sidecar): 新增 GET /available-models 透传路由 + modelMetaCache 同步 (K-MultiModel)"
```

---

## Task 5: PATCH /sessions/:id/model 路由

**Files:** `packages/server/src/routes/session.ts`

- [ ] **Step 1: 在路由文件加新 patch handler**

找 `app.delete('/sessions/:id', ...)` 之后，追加：

```ts
	// K-MultiModel (v0.2.25)：设置会话绑定的模型 alias_code
	app.patch('/sessions/:id/model',
		zValidator('json', z.object({ aliasCode: z.string().nullable() })),
		async (c) => {
			const id = c.req.param('id');
			const { aliasCode } = c.req.valid('json');
			await sessionManager.setSessionModel(id, aliasCode);
			return c.json({ ok: true });
		});
```

`zValidator` 和 `z` 通常该文件已经 import；如果没，加：

```ts
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
```

- [ ] **Step 2: build 验证**

```bash
pnpm --filter @maxian/server run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/session.ts
git commit -m "feat(sidecar): 加 PATCH /sessions/:id/model 路由（K-MultiModel）"
```

---

## Task 6: AiProxyHandler 加 aliasCode + supportsVision 字段 + vision 降级

**Files:** `packages/core/src/api/aiProxyHandler.ts`

- [ ] **Step 1: 加 config 字段**

找 `interface AiProxyConfiguration` 加：

```ts
  /** K-MultiModel：用户指定的模型 alias_code，云端按 alias 锁定行。null 走默认 priority pool */
  aliasCode?: string;
  /** K-MultiModel：当前模型是否支持视觉。false 时 buildMessages 自动跳过 image 块 */
  supportsVision?: boolean;
```

- [ ] **Step 2: POST body 透传 aliasCode**

找 createMessage 内构造 POST body 的位置（应该有 `const body = { username, password, businessCode, messages, ... }` 之类）。在 body 字段列表加：

```ts
    aliasCode: this.config.aliasCode || undefined,    // 不发空串
```

- [ ] **Step 3: buildMessages 加 vision 降级**

找 messages 构造函数（可能叫 `buildMessages` / `convertMessages` / 或直接 inline）。在返回 messages 前加：

```ts
    // K-MultiModel：模型不支持视觉时，把 image 块替换为占位文本
    if (this.config.supportsVision === false) {
      let droppedImages = 0;
      for (const msg of result) {
        if (Array.isArray(msg.content)) {
          const textParts: string[] = [];
          for (const part of msg.content) {
            if ((part as any).type === 'image_url') {
              droppedImages++;
            } else if ((part as any).type === 'text') {
              textParts.push((part as any).text);
            }
          }
          if (droppedImages > 0) {
            textParts.push(`\n[此处原有 ${droppedImages} 张图片，因当前模型不支持视觉已省略]`);
          }
          // 整段塌成纯文本
          (msg as any).content = textParts.join('');
        }
      }
      if (droppedImages > 0) {
        console.log(`[AiProxy] 降级跳过 ${droppedImages} 张图片（当前 alias=${this.config.aliasCode}, supportsVision=false）`);
      }
    }
```

注意 result 是函数返回的 messages array 引用，按现有代码 mutate 即可。

- [ ] **Step 4: build + sync-sidecar**

```bash
pnpm --filter @maxian/core --filter @maxian/server run build 2>&1 | tail -5
rm -f packages/server/bin/maxian-server-aarch64-apple-darwin
node apps/desktop/scripts/sync-sidecar.mjs 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/api/aiProxyHandler.ts
git commit -m "feat(core): AiProxyHandler 加 aliasCode 透传 + vision 降级 buildMessages (K-MultiModel)"
```

---

## Task 7: getAiHandler 改造（cli.ts）

**Files:** `packages/server/src/cli.ts`

- [ ] **Step 1: 找 getAiHandler 签名**

```bash
grep -n "function getAiHandler" packages/server/src/cli.ts
```

- [ ] **Step 2: 改签名 + 实现**

把现有 `function getAiHandler(uiMode?: string): AiProxyHandler | null { ... }` 改为：

```ts
function getAiHandler(uiMode?: string, sessionAliasCode?: string | null): AiProxyHandler | null {
  const defaultBizCode = uiMode === 'chat' ? 'IDE_CHAT_ASK' : 'IDE_CHAT_CODE';
  const meta = sessionAliasCode ? getModelMeta(sessionAliasCode) : null;

  // 1. 运行时动态配置
  const runtimeCfg = server.getAiConfig();
  if (runtimeCfg) {
    const bizCode = (runtimeCfg as any).businessCode ?? defaultBizCode;
    const cacheKey = `rt|${runtimeCfg.apiUrl}|${runtimeCfg.username}|${bizCode}|${sessionAliasCode ?? ''}`;
    const cached = __aiHandlerCache.get(cacheKey);
    if (cached) return cached;
    const h = new AiProxyHandler({
      apiUrl:            runtimeCfg.apiUrl,
      username:          runtimeCfg.username,
      password:          runtimeCfg.password,
      businessCode:      bizCode,
      flashBusinessCode: (runtimeCfg as any).flashBusinessCode ?? undefined,
      aliasCode:         sessionAliasCode ?? undefined,
      supportsVision:    meta?.supportsVision ?? true,
    });
    __aiHandlerCache.set(cacheKey, h);
    return h;
  }
  // 2. 启动时静态配置
  if (aiConfig && aiConfig.type === 'proxy') {
    const bizCode = uiMode === 'chat' ? 'IDE_CHAT_ASK' : (aiConfig.businessCode ?? 'IDE_CHAT_CODE');
    const cacheKey = `st|${aiConfig.apiUrl}|${aiConfig.username}|${bizCode}|${sessionAliasCode ?? ''}`;
    const cached = __aiHandlerCache.get(cacheKey);
    if (cached) return cached;
    const h = new AiProxyHandler({
      apiUrl:            aiConfig.apiUrl,
      username:          aiConfig.username,
      password:          aiConfig.password,
      businessCode:      bizCode,
      flashBusinessCode: aiConfig.flashBusinessCode ?? undefined,
      aliasCode:         sessionAliasCode ?? undefined,
      supportsVision:    meta?.supportsVision ?? true,
    });
    __aiHandlerCache.set(cacheKey, h);
    return h;
  }
  return null;
}
```

注意 import：

```ts
import { getModelMeta } from './modelMetaCache.js';
```

- [ ] **Step 3: runAgentLoop 传 sessionAliasCode**

找 `runAgentLoop` 内 `getAiHandler(uiMode)` 调用点，改成：

```ts
const sess = server.sessionManager.getSession(sessionId);
const handler = getAiHandler(uiMode, sess?.aliasCode);
```

- [ ] **Step 4: build + sync sidecar**

```bash
pnpm --filter @maxian/server run build 2>&1 | tail -5
rm -f packages/server/bin/maxian-server-aarch64-apple-darwin
node apps/desktop/scripts/sync-sidecar.mjs 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cli.ts
git commit -m "feat(sidecar): getAiHandler 按 session.aliasCode 路由 + 注入 meta supportsVision (K-MultiModel)"
```

---

## Task 8: SDK 加方法

**Files:** `packages/sdk/src/index.ts`

- [ ] **Step 1: 加 AvailableModel 类型 export**

在文件适当位置（其他 export interface 旁）追加：

```ts
export interface AvailableModel {
  aliasCode:      string;
  businessCode:   string;
  displayName:    string;
  provider:       string;
  contextWindow?: number;
  supportsVision: boolean;
  sortNo?:        number;
}
```

- [ ] **Step 2: 在 Client class 加 2 个方法**

找 `deleteSession` 方法附近（同区），追加：

```ts
  async listAvailableModels(): Promise<{
    models:  AvailableModel[];
    cached:  boolean;
    error?:  string;
  }> {
    return this.request('GET', '/available-models');
  }

  async setSessionModel(sid: string, aliasCode: string | null): Promise<void> {
    await this.request('PATCH', `/sessions/${sid}/model`, { aliasCode });
  }
```

- [ ] **Step 3: build**

```bash
pnpm --filter @maxian/sdk run build 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/index.ts
git commit -m "feat(sdk): 加 listAvailableModels + setSessionModel + AvailableModel 类型 (K-MultiModel)"
```

---

## Task 9: 集成验证

- [ ] **Step 1: typecheck 全过**

```bash
pnpm --filter @maxian/core --filter @maxian/sdk --filter @maxian/server run build 2>&1 | tail -10
cd apps/desktop && pnpm run typecheck 2>&1 | tail -5 && cd -
```

Expected: 全过。

- [ ] **Step 2: 启动 dev 联调**

```bash
lsof -i :1420 -t && echo PORT_BUSY || cd apps/desktop && pnpm run tauri:dev &
```

后台启动后等 60s 让 cargo 增量编译 + sidecar 拉起。

- [ ] **Step 3: 测 /available-models**

```bash
sleep 60
curl -s http://127.0.0.1:4096/available-models -u maxian:test123 | head -10
```

Expected: JSON 含 models 数组（数量 = Plan A1 配的公开模型数）。

- [ ] **Step 4: 测 PATCH /sessions/:id/model**

先创建一个 session（或用一个现有的 id）：

```bash
SID=$(curl -s http://127.0.0.1:4096/sessions -u maxian:test123 | head -c 500 | grep -oE '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "sid=$SID"
curl -s -X PATCH http://127.0.0.1:4096/sessions/$SID/model \
  -u maxian:test123 \
  -H "Content-Type: application/json" \
  -d '{"aliasCode":"sonnet45-code"}'
```

Expected: `{"ok":true}`。检查 SQLite 验证：

```bash
sqlite3 ~/.maxian/maxian.db "SELECT id, alias_code FROM sessions WHERE id='$SID'"
```

Expected: alias_code 列等于 `sonnet45-code`。

- [ ] **Step 5: 在 dev 客户端发一条消息验证 alias 透传**

打开桌面端窗口，对刚才那个 session 发任意消息。看 sidecar log：

```bash
tail -20 /tmp/maxian-dev.log 2>/dev/null || echo "看 tauri dev 窗口输出"
```

Expected: AI 调用日志看到 chat/completions POST body 包含 `"aliasCode":"sonnet45-code"`。后端服务日志（Plan A1 Task 9 加的）出现 `路由按 alias 锁定: alias=sonnet45-code`。

- [ ] **Step 6: 测 vision 降级（如果 admin 后台配了 supportsVision=false 的模型）**

把 session alias 切到 supportsVision=false 的某个 alias，传一张图片 + 文字。看 sidecar log：

```
[AiProxy] 降级跳过 N 张图片
```

后端 chat/completions 不再 400。

---

## 自验收清单

- [ ] sessions.alias_code 列在 SQLite 已加
- [ ] GET /available-models 返回 cloud endpoint 的清单（含 cache 标记）
- [ ] PATCH /sessions/:id/model 写入 SQLite
- [ ] runAgentLoop 走 session.aliasCode → getAiHandler → AiProxyHandler 携带 aliasCode
- [ ] 后端日志确认按 alias 路由
- [ ] vision 降级 buildMessages 跳过图片（supportsVision=false 时）
- [ ] modelMetaCache 在 /available-models 拉取后更新
- [ ] 8 个 commit 都 tag K-MultiModel

---

## Notes

- 当前 dev 测试需要 Plan A1 已部署到测试环境（否则 cloud endpoint 不可调，sidecar 拿到空清单但不崩）
- Cache TTL 2 min，调试时若想强制刷新，可改 cli.ts 加个 force refresh 路由（YAGNI 先不做）
- vision 降级**不破坏**消息持久化：sidecar 只在发给 LLM 前 mutate；存到 history_entries 时仍是完整 ContentBlock 数组（包含 image_url）。下次切回 vision 模型，image 自动回来
- 模型清单为空时 desktop UI 应该隐藏 ModelSelector（Plan C 处理）
