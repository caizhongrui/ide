# Plan C: 多模型选择 — maxian-desktop UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** desktop 端新增 ModelSelector 组件挂在 composer 上方；启动时拉模型清单；切模型走 per-session 绑定；元数据驱动 UI（vision 按钮显隐 + tokenLimit 同步 + 切模型超额检测对话框）。

**Architecture:** ModelSelector 跟 ModeSelector 并排；activeSession()?.aliasCode 派生 currentAliasCode → currentModelMeta；切模型前调 guardContextOverflow 校验上下文超额。模型清单空时整个 selector 隐藏（fallback 到 sidecar 默认行为）。

**Tech Stack:** SolidJS + TypeScript + Tauri WebView

**Spec 来源:** `docs/specs/2026-05-27-multi-model-selector.md` §5 + §6

**Repo cwd:** `/Users/caizhongrui/Documents/workspace/production/ide/.claude/worktrees/heuristic-moore-0c97e9`

**Plan 依赖:** Plan B 已完成（sidecar `/available-models` + PATCH /sessions/:id/model 就绪；SDK 已加新方法；SessionSummary.aliasCode 字段返回）

---

## File Structure

| 文件 | 操作 | 责任 |
|---|---|---|
| `apps/desktop/src/components/ModelSelector.tsx` | Create | 模型选择器组件（button + dropdown panel） |
| `apps/desktop/src/components/ModelSelector.css` | Create | 组件样式（跟 ModeSelector 对齐） |
| `apps/desktop/src/App.tsx` | Modify | 加 state（availableModels / currentAliasCode / currentModelMeta）+ 启动拉清单 + switchModel + guardContextOverflow + ModelSelector 挂载 |
| `apps/desktop/src/dialogs/ModelSwitchOverflowDialog.tsx` | Create | 切模型超额提示对话框（压缩/直接切/取消三选） |
| `apps/desktop/src/styles.css` | Modify | 加 `.composer-controls-row` flex 容器样式（如未有） |

---

## Task 1: ModelSelector 组件

**Files:**
- Create: `apps/desktop/src/components/ModelSelector.tsx`
- Create: `apps/desktop/src/components/ModelSelector.css`

- [ ] **Step 1: 创建 ModelSelector.css**

```css
.model-selector {
  position: relative;
  display: inline-flex;
}

.model-selector-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text-base);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background 100ms, border-color 100ms;
  max-width: 220px;
}
.model-selector-btn:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.model-selector-btn-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-selector-btn-caret {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 120ms;
}
.model-selector-btn.open .model-selector-btn-caret {
  transform: rotate(180deg);
}

.model-selector-panel {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  min-width: 280px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  z-index: 100;
  padding: 4px;
}
.model-selector-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 80ms;
  font-size: 12px;
}
.model-selector-item:hover {
  background: var(--bg-hover);
}
.model-selector-item.active {
  background: var(--accent-faint);
  color: var(--accent);
}
.model-selector-item-name { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-selector-item-provider {
  font-size: 10px;
  padding: 1px 5px;
  background: var(--bg-muted);
  border-radius: 3px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.model-selector-item-ctx {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.model-selector-item-vision {
  color: #67C23A;
  flex-shrink: 0;
}
.model-selector-loading {
  padding: 14px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
```

- [ ] **Step 2: 创建 ModelSelector.tsx**

```tsx
/*---------------------------------------------------------------------------------------------
 *  ModelSelector — 模型选择器（v0.2.25 K-MultiModel）
 *
 *  挂在 composer 上方，跟 ModeSelector 并排。
 *  点击 button 弹下拉清单；选某个 alias 触发 onSelect。
 *  models 为空时整个组件返回 null（隐藏，sidecar 走默认行为）。
 *--------------------------------------------------------------------------------------------*/

import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import type { Component } from 'solid-js'

export interface ModelMeta {
	aliasCode:      string
	businessCode:   string
	displayName:    string
	provider:       string
	contextWindow?: number
	supportsVision: boolean
}

export interface ModelSelectorProps {
	models:           () => ModelMeta[]
	currentAliasCode: () => string | null
	loading:          () => boolean
	onSelect:         (aliasCode: string) => void | Promise<void>
}

export const ModelSelector: Component<ModelSelectorProps> = (props) => {
	const [open, setOpen] = createSignal(false)
	let panelRef: HTMLDivElement | undefined
	let btnRef: HTMLButtonElement | undefined

	// 点外面关闭
	const handleDocClick = (e: MouseEvent): void => {
		if (!open()) return
		const t = e.target as Node | null
		if (t && (panelRef?.contains(t) || btnRef?.contains(t))) return
		setOpen(false)
	}
	onMount(() => document.addEventListener('click', handleDocClick))
	onCleanup(() => document.removeEventListener('click', handleDocClick))

	const currentName = (): string => {
		const code = props.currentAliasCode()
		if (!code) return '默认模型'
		const m = props.models().find(m => m.aliasCode === code)
		return m?.displayName ?? code
	}

	const fmtCtx = (n?: number): string => {
		if (!n) return ''
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
		if (n >= 1000) return `${(n / 1000).toFixed(0)}K`
		return `${n}`
	}

	return (
		<Show when={props.models().length > 0}>
			<div class="model-selector">
				<button
					ref={el => (btnRef = el)}
					class="model-selector-btn"
					classList={{ open: open() }}
					onClick={() => setOpen(v => !v)}
					title="切换模型"
				>
					<span class="model-selector-btn-name">{currentName()}</span>
					<svg class="model-selector-btn-caret" width="10" height="10" viewBox="0 0 24 24"
						fill="none" stroke="currentColor" stroke-width="2.5"
						stroke-linecap="round" stroke-linejoin="round">
						<polyline points="6 9 12 15 18 9"/>
					</svg>
				</button>
				<Show when={open()}>
					<div class="model-selector-panel" ref={el => (panelRef = el)}>
						<Show when={props.loading()} fallback={null}>
							<div class="model-selector-loading">加载模型清单...</div>
						</Show>
						<For each={props.models()}>
							{(m) => (
								<div
									class="model-selector-item"
									classList={{ active: props.currentAliasCode() === m.aliasCode }}
									onClick={() => {
										setOpen(false)
										void props.onSelect(m.aliasCode)
									}}
								>
									<span class="model-selector-item-name">{m.displayName}</span>
									<span class="model-selector-item-provider">{m.provider}</span>
									<Show when={m.contextWindow}>
										<span class="model-selector-item-ctx">{fmtCtx(m.contextWindow)}</span>
									</Show>
									<Show when={m.supportsVision}>
										<span class="model-selector-item-vision" title="支持视觉">🖼</span>
									</Show>
								</div>
							)}
						</For>
					</div>
				</Show>
			</div>
		</Show>
	)
}
```

- [ ] **Step 3: typecheck**

```bash
cd apps/desktop && pnpm run typecheck 2>&1 | tail -5 && cd -
```

Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/ModelSelector.tsx \
        apps/desktop/src/components/ModelSelector.css
git commit -m "feat(desktop): 新增 ModelSelector 组件 + 样式 (K-MultiModel)"
```

---

## Task 2: App.tsx 加 state + 启动拉清单

**Files:** `apps/desktop/src/App.tsx`

- [ ] **Step 1: import ModelSelector + CSS**

在 import 区追加：

```tsx
import { ModelSelector, type ModelMeta } from "./components/ModelSelector"
import "./components/ModelSelector.css"
import type { AvailableModel } from "@maxian/sdk"
```

- [ ] **Step 2: 加 signals**

找一个合适位置（其他 panel state 旁），追加：

```tsx
  // K-MultiModel (v0.2.25)：模型清单 + 当前 session alias
  const [availableModels, setAvailableModels] = createSignal<AvailableModel[]>([])
  const [modelsLoading, setModelsLoading] = createSignal(false)

  // 当前会话绑定的模型 alias_code（来自 server SessionSummary.aliasCode）
  const currentAliasCode = createMemo<string | null>(() => {
    const sid = activeSessionId()
    if (!sid) return null
    return sessions().find(s => s.id === sid)?.aliasCode ?? null
  })

  // 当前模型 meta（用于元数据驱动 UI）
  const currentModelMeta = createMemo<AvailableModel | null>(() => {
    const code = currentAliasCode()
    if (!code) return null
    return availableModels().find(m => m.aliasCode === code) ?? null
  })
```

注意：`sessions()` 是现有 signal（会话列表），`activeSessionId()` 也是。如果命名不同 grep 一下确认。

- [ ] **Step 3: 启动时拉清单**

找 `getClient()` 初次调用 / 启动副作用，附近加：

```tsx
  // K-MultiModel：登录后拉一次模型清单
  createEffect(() => {
    const ws = activeWorkspace()
    if (!ws) return
    void (async () => {
      setModelsLoading(true)
      try {
        const c = await getClient()
        const res = await c.listAvailableModels()
        setAvailableModels(res.models ?? [])
      } catch (e) {
        console.warn('[ModelSelector] 拉清单失败', e)
        setAvailableModels([])
      } finally {
        setModelsLoading(false)
      }
    })()
  })
```

- [ ] **Step 4: typecheck + sdk build**

```bash
pnpm --filter @maxian/sdk run build 2>&1 | tail -3
cd apps/desktop && pnpm run typecheck 2>&1 | tail -5 && cd -
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(desktop): App.tsx 加 availableModels / currentAliasCode 派生 state + 启动拉清单 (K-MultiModel)"
```

---

## Task 3: 切模型超额检测对话框

**Files:** Create `apps/desktop/src/dialogs/ModelSwitchOverflowDialog.tsx`

- [ ] **Step 1: 找现有 dialog 模板（参考其他对话框）**

```bash
ls apps/desktop/src/dialogs/ 2>/dev/null
```

参考现有 PlanExitDialog 之类的 pattern。

- [ ] **Step 2: 创建对话框**

```tsx
/*---------------------------------------------------------------------------------------------
 *  ModelSwitchOverflowDialog — 切模型上下文超额提示（v0.2.25 K-MultiModel）
 *
 *  切到 contextWindow 更小的模型时，若当前 token 用量 > 新模型上限 × 0.85 弹出。
 *  三个选项：压缩后切换 / 直接切换 / 取消。
 *--------------------------------------------------------------------------------------------*/

import { Show } from 'solid-js'
import type { Component } from 'solid-js'

export type OverflowDecision = 'compact' | 'force' | 'cancel'

export interface ModelSwitchOverflowDialogProps {
	open:               () => boolean
	currentTokens:      number
	targetDisplayName:  string
	targetContextWindow: number
	onDecision:         (d: OverflowDecision) => void
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	if (n >= 1000) return `${(n / 1000).toFixed(0)}K`
	return `${n}`
}

export const ModelSwitchOverflowDialog: Component<ModelSwitchOverflowDialogProps> = (props) => {
	return (
		<Show when={props.open()}>
			<div class="dialog-backdrop" onClick={() => props.onDecision('cancel')}>
				<div class="dialog-panel" onClick={(e) => e.stopPropagation()}>
					<div class="dialog-title">⚠ 当前对话可能超出目标模型上下文</div>
					<div class="dialog-body">
						<p>
							当前已用约 <strong>{fmtTokens(props.currentTokens)}</strong> tokens，
							目标模型 <strong>"{props.targetDisplayName}"</strong> 上限{' '}
							<strong>{fmtTokens(props.targetContextWindow)}</strong> tokens。
						</p>
						<p>切换后超出部分可能被截断或返回错误。建议先压缩上下文。</p>
					</div>
					<div class="dialog-actions">
						<button class="dialog-btn dialog-btn-primary" onClick={() => props.onDecision('compact')}>
							压缩后切换（推荐）
						</button>
						<button class="dialog-btn" onClick={() => props.onDecision('force')}>
							直接切换
						</button>
						<button class="dialog-btn dialog-btn-cancel" onClick={() => props.onDecision('cancel')}>
							取消
						</button>
					</div>
				</div>
			</div>
		</Show>
	)
}
```

- [ ] **Step 3: typecheck**

```bash
cd apps/desktop && pnpm run typecheck 2>&1 | tail -5 && cd -
```

如果 `.dialog-backdrop` / `.dialog-panel` 等样式不存在，搜其他对话框的 class：

```bash
grep -rn "dialog-backdrop\|dialog-panel\|dialog-btn" apps/desktop/src 2>/dev/null | head -5
```

如果项目已有 dialog 通用样式直接复用；否则在 styles.css 简单加几行。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/dialogs/ModelSwitchOverflowDialog.tsx
git commit -m "feat(desktop): 新增 ModelSwitchOverflowDialog 切模型超额对话框 (K-MultiModel)"
```

---

## Task 4: switchModel + guardContextOverflow 集成

**Files:** `apps/desktop/src/App.tsx`

- [ ] **Step 1: 加超额对话框 state**

```tsx
  // K-MultiModel：切模型超额对话框
  const [overflowDialog, setOverflowDialog] = createSignal<{
    open:            boolean
    target:          AvailableModel | null
    currentTokens:   number
    resolve:         (d: 'compact' | 'force' | 'cancel') => void
  }>({ open: false, target: null, currentTokens: 0, resolve: () => {} })
```

- [ ] **Step 2: 加 guardContextOverflow 函数**

```tsx
  async function guardContextOverflow(targetAlias: string): Promise<boolean> {
    const target = availableModels().find(m => m.aliasCode === targetAlias)
    if (!target?.contextWindow) return true  // 无 meta 时直接放行
    const current = tokenUsed()
    if (current <= target.contextWindow * 0.85) return true

    return new Promise<boolean>(resolve => {
      setOverflowDialog({
        open: true,
        target,
        currentTokens: current,
        resolve: async (d) => {
          setOverflowDialog(s => ({ ...s, open: false }))
          if (d === 'cancel') return resolve(false)
          if (d === 'compact') {
            const sid = activeSessionId()
            if (sid) {
              try {
                const c = await getClient()
                await c.compactSession(sid)
              } catch (e) {
                showToast({ message: '压缩失败：' + (e as Error).message, kind: 'error' })
                return resolve(false)
              }
            }
          }
          resolve(true)
        },
      })
    })
  }

  // K-MultiModel：切模型
  async function switchModel(targetAlias: string): Promise<void> {
    const sid = activeSessionId()
    if (!sid) return
    if (!(await guardContextOverflow(targetAlias))) return
    try {
      const c = await getClient()
      await c.setSessionModel(sid, targetAlias)
      // 刷新会话信息让 currentAliasCode memo 更新
      await refreshSessions()
      const m = availableModels().find(m => m.aliasCode === targetAlias)
      showToast({ message: `已切换到 ${m?.displayName ?? targetAlias}`, kind: 'success', duration: 1500 })
    } catch (e) {
      showToast({ message: '切换模型失败：' + (e as Error).message, kind: 'error' })
    }
  }
```

注意 `refreshSessions` 是已有函数（grep 确认），`compactSession` SDK 已有方法。

- [ ] **Step 3: typecheck**

```bash
cd apps/desktop && pnpm run typecheck 2>&1 | tail -5 && cd -
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(desktop): switchModel + guardContextOverflow 联动 compact (K-MultiModel)"
```

---

## Task 5: 元数据驱动 UI（vision 按钮 + tokenLimit）

**Files:** `apps/desktop/src/App.tsx`

- [ ] **Step 1: 图片上传按钮按 vision 能力显隐**

找现有图片上传按钮（grep `ImageUpload\|attachImage\|attached.*[Ii]mage` 之类）。包到 Show 里：

```tsx
<Show when={currentModelMeta() === null || currentModelMeta()?.supportsVision === true}>
  <button class="..." onClick={...}>📷</button>  {/* 现有图片上传按钮 */}
</Show>
```

注意：`currentModelMeta() === null` 时显示（默认乐观，没选 alias 时不限制图片）；选了 alias 但 supportsVision=false 时隐藏。

- [ ] **Step 2: tokenLimit 同步**

找现有 setTokenLimit 调用点。加一个 effect：

```tsx
  // K-MultiModel：当前模型 contextWindow 同步到 tokenLimit
  createEffect(() => {
    const ctx = currentModelMeta()?.contextWindow
    if (ctx && ctx > 0 && ctx !== tokenLimit()) {
      setTokenLimit(ctx)
    }
  })
```

注意：如果当前 tokenLimit 由 SSE token_usage 事件 override，要确保这个 effect 不跟事件 race。看 useChatEventHandler.ts:
- 事件里如果 `event.limit` 非空就 setTokenLimit 到 event 值——这条优先
- 否则保持 currentModelMeta 同步

可以让 effect 仅在 currentModelMeta 变化时跑（去掉 tokenLimit 依赖），避免无限 loop：

```tsx
  createEffect(() => {
    const meta = currentModelMeta()
    if (meta?.contextWindow && meta.contextWindow > 0) {
      untrack(() => {
        if (tokenLimit() !== meta.contextWindow) setTokenLimit(meta.contextWindow!)
      })
    }
  })
```

`untrack` 从 'solid-js' import。

- [ ] **Step 3: typecheck**

```bash
cd apps/desktop && pnpm run typecheck 2>&1 | tail -5 && cd -
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(desktop): 元数据驱动 UI — vision 按钮显隐 + tokenLimit 同步 (K-MultiModel)"
```

---

## Task 6: ModelSelector 挂载 + 对话框挂载

**Files:** `apps/desktop/src/App.tsx`

- [ ] **Step 1: 找 ModeSelector 渲染位置**

```bash
grep -n "<ModeSelector\|ModeSelector\b" apps/desktop/src/App.tsx | head -5
```

- [ ] **Step 2: 在 ModeSelector 旁边挂 ModelSelector**

包成 row（如果还没有 .composer-controls-row 容器，加一个）：

```tsx
<div class="composer-controls-row">
  <ModeSelector ... />
  <ModelSelector
    models={availableModels}
    currentAliasCode={currentAliasCode}
    loading={modelsLoading}
    onSelect={switchModel}
  />
  {/* 其他控件 */}
</div>
```

如果原本 ModeSelector 就在 row 容器里，直接在它后面追加 ModelSelector 即可。

- [ ] **Step 3: 在 App return 末尾挂超额对话框**

找其他 dialog 挂载点（grep `<KeybindHelp\|<PlanExit\|<QuestionRequest` 等），追加：

```tsx
<ModelSwitchOverflowDialog
  open={() => overflowDialog().open}
  currentTokens={overflowDialog().currentTokens}
  targetDisplayName={overflowDialog().target?.displayName ?? ''}
  targetContextWindow={overflowDialog().target?.contextWindow ?? 0}
  onDecision={(d) => overflowDialog().resolve(d)}
/>
```

注意 import：`import { ModelSwitchOverflowDialog } from "./dialogs/ModelSwitchOverflowDialog"`。

- [ ] **Step 4: 加 .composer-controls-row CSS（如未有）**

在 styles.css 末尾追加：

```css
.composer-controls-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
```

- [ ] **Step 5: typecheck + build**

```bash
cd apps/desktop && pnpm run typecheck 2>&1 | tail -5 && pnpm run build 2>&1 | tail -5 && cd -
```

Expected: 全过。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): 挂载 ModelSelector + ModelSwitchOverflowDialog (K-MultiModel)"
```

---

## Task 7: 联调验证

- [ ] **Step 1: 启动 dev（需要 Plan A1 + Plan A2 + Plan B 都已就绪）**

```bash
lsof -i :1420 -t 2>/dev/null && echo PORT_BUSY || true
rm -f packages/server/bin/maxian-server-aarch64-apple-darwin
node apps/desktop/scripts/sync-sidecar.mjs 2>&1 | tail -3
cd apps/desktop && pnpm run tauri:dev > /tmp/maxian-dev.log 2>&1 &
sleep 60
```

- [ ] **Step 2: 浏览器 / Tauri 窗口验证**

依次确认：
- composer 上方 ModelSelector 显示，默认显示"默认模型"或第一个 alias
- 点击下拉，看到所有 is_public 模型，每行有 provider tag / ctx 文字 / 视觉 🖼 图标
- 选一个模型 → toast "已切换到 ..." → 当前模型名更新
- 切换会话 → 选过的模型自动恢复（session.aliasCode 持久化生效）
- 切到不支持视觉的模型 → composer 图片上传按钮消失
- 切到 contextWindow 小的模型且当前 tokens > 85% → 弹超额对话框（三选项）
  - "压缩后切换" → 走 compact → 切成功
  - "直接切换" → 切成功
  - "取消" → 不切

- [ ] **Step 3: 验证 SSE token_usage 跟 model 切换不冲突**

发一条消息，看 token 进度条 limit 显示是当前模型 contextWindow 还是 SSE event 里的 limit。SSE 优先时无 race。

- [ ] **Step 4: 关 dev**

```bash
# 关窗口或 kill
pkill -f "tauri dev" 2>/dev/null
```

---

## Task 8: 全 build + version 准备（不 push 不 tag，按 CLAUDE.md 规矩）

- [ ] **Step 1: 全链路 typecheck + build**

```bash
pnpm --filter @maxian/core --filter @maxian/sdk --filter @maxian/ui --filter @maxian/server run build 2>&1 | tail -8
cd apps/desktop && pnpm run typecheck 2>&1 | tail -3 && pnpm run build 2>&1 | tail -3 && cd -
```

Expected: 全过。

- [ ] **Step 2: 准备 version bump（等用户指令再做）**

3 处 + Cargo.lock：

- `apps/desktop/package.json` 0.2.24 → 0.2.25
- `apps/desktop/src-tauri/tauri.conf.json` 同上
- `apps/desktop/src-tauri/Cargo.toml` 同上
- `cd apps/desktop/src-tauri && cargo update --workspace --offline`

CHANGELOG entry：

```
🎯 多模型选择（核心新功能）：
   · composer 上方加了模型选择器，可以切换不同 AI 模型（Claude / DeepSeek / Qwen 等，具体清单看你账号开了哪些）
   · 每个会话独立绑定模型，切会话自动恢复上次选的
   · 不支持图片的模型：自动隐藏图片上传按钮；切回支持的，按钮自动出来
   · 切到上下文窗口更小的模型：自动弹"上下文超额"对话框，可一键压缩后切换
   · 模型清单走云端 API，管理员加新模型客户端立刻可见，不用发版
```

**不要直接 commit 或 push。等用户指令。**

---

## 自验收清单

- [ ] composer 上方 ModelSelector 可见且可点开
- [ ] 切模型 → 走 SDK setSessionModel → session.aliasCode 持久化 → 切会话恢复
- [ ] 不支持视觉的模型：图片上传按钮隐藏
- [ ] 切到小 contextWindow 模型且超 85%：弹对话框
- [ ] 三个选项（compact / force / cancel）都走对路径
- [ ] tokenLimit 跟模型 contextWindow 同步
- [ ] 模型清单为空时整个 selector 不显示（fallback 老行为）
- [ ] 6 个 commit 都 tag K-MultiModel

---

## Notes

- 完整功能要求 Plan A1 / A2 / B 都已完成
- 如果 sidecar `/available-models` 返回 `{models: [], error: '...'}`，desktop 直接显示无模型，老行为不变，**不弹错误**
- 切模型时的"压缩"复用现有 compactSession SDK 方法，逻辑跟 /compact 命令一致
- 元数据驱动 UI 跟 SSE token_usage 事件可能 race，已用 untrack 规避自循环；如果实际测试发现 token 进度条抖动，再加防抖
- 不主动加键盘快捷键（YAGNI）
