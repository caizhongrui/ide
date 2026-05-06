import { createSignal, createMemo, For, Show, onMount, onCleanup, createEffect } from "solid-js"
import type { SessionSummary, Workspace, MaxianEvent, StoredMessage } from "@maxian/sdk"
import { renderMarkdown } from "./markdown"
import hljs from "highlight.js/lib/common"
import "highlight.js/styles/github-dark.css"
import logoUrl from "./assets/logo.png"
import {
  getClient, waitForServer,
  loadSavedCredentials, saveCredentials, clearCredentials,
  loginCheck, configureServerAi, clearServerAi,
  BASE, USER, PASS,
  type SavedCredentials, type UserInfo,
} from "./api"
import { initI18n, t, setLocale, getLocale } from "./i18n"
import { BatchPanel } from "./batch/BatchPanel"
import { SettingsAppearance } from "./settings/SettingsAppearance"
import { SettingsGeneral } from "./settings/SettingsGeneral"
import { SettingsKeybinds } from "./settings/SettingsKeybinds"
import { SettingsTemplates } from "./settings/SettingsTemplates"
import { SettingsUsage } from "./settings/SettingsUsage"
import { SettingsErrors } from "./settings/SettingsErrors"
import { SettingsPlugins } from "./settings/SettingsPlugins"
import { SettingsAbout } from "./settings/SettingsAbout"
import { SettingsMcp } from "./settings/SettingsMcp"
import { SettingsWorktree } from "./settings/SettingsWorktree"
import { QuestionDialog } from "./dialogs/QuestionDialog"
import { PlanExitDialog } from "./dialogs/PlanExitDialog"
import { ApplyToFileDialog } from "./dialogs/ApplyToFileDialog"
import { ToolErrorPanel } from "./panels/ToolErrorPanel"
import { SkillsPanel } from "./panels/SkillsPanel"
import { WorkspaceExplorerPanel } from "./panels/WorkspaceExplorerPanel"
import { FilePreviewPanel } from "./panels/FilePreviewPanel"
import { ContextPanel } from "./panels/ContextPanel"
import { TodoDock } from "./panels/TodoDock"
import { FollowupDock } from "./panels/FollowupDock"
import { RevertDock } from "./panels/RevertDock"
import { CompactingBanner, RateLimitBanner } from "./panels/StatusBanners"
import { Sidebar } from "./sidebar/Sidebar"
import { AnimatedNumber } from "./components/AnimatedNumber"
import { ToastHost, type ToastItem } from "./components/ToastHost"
import { GlobalCommandPalette, type PaletteItem } from "./components/GlobalCommandPalette"
import { KeybindHelpModal } from "./components/KeybindHelpModal"
import { ModeSelector, type ComposerMode } from "./components/ModeSelector"
import { GitStatusBar } from "./components/GitStatusBar"
import { LoginView } from "./components/LoginView"
import { BootingScreen, BootErrorScreen } from "./components/BootScreens"
import { SettingsNav, type SettingsTab } from "./components/SettingsNav"
import type { Theme, ChatMessage, PreviewTab, AttachedImage } from "./lib/types"
import { classifyFileKind } from "./lib/types"
import type {
  FileChangeEntry, TodoItem, RateLimitState, QuestionRequest,
  CompactingState, PlanExitRequest,
} from "./lib/chatEventTypes"
import { TOOL_LABELS, TOOL_ICONS, getToolLabel, getToolSubtitle } from "./lib/toolMeta"
import {
  THEME_KEY, FONT_FAMILY_KEY, FONT_SIZE_KEY, DEFAULT_API_URL, FONT_FAMILIES,
  loadTheme, applyTheme, loadFontFamily, loadFontSize, applyFont, formatBytes,
} from "./lib/themeFont"
import {
  formatTime, formatFullTime, userInitials, shortPath, formatRecv,
  storedToChatMessage,
} from "./lib/format"
import { SLASH_COMMANDS } from "./lib/slashCommands"
import { useApprovalQueue } from "./hooks/useApprovalQueue"
import { useTokenUsage } from "./hooks/useTokenUsage"
import { useFileWatcher } from "./hooks/useFileWatcher"
import { useVimMode } from "./hooks/useVimMode"
import {
  useCustomKeybinds,
  KEYBIND_DEFAULTS,
  eventToKeybind,
  matchKeybind,
  type KeybindAction,
} from "./hooks/useCustomKeybinds"
import { useInChatSearch } from "./hooks/useInChatSearch"
import { createChatEventHandler } from "./hooks/useChatEventHandler"
import { usePromptHistory } from "./hooks/usePromptHistory"
import { useGitBranchPicker } from "./hooks/useGitBranchPicker"
import { MemoryPanel } from "./panels/MemoryPanel"
import { CodebaseIndexPanel } from "./panels/CodebaseIndexPanel"
import { SubagentDashboard } from "./panels/SubagentDashboard"
import {
  ApprovalDialog as SharedApprovalDialog,
  MessageList as SharedMessageList,
  EditDiffView,
  createMessagesStore,
  type ChatMessage as SharedChatMessage,
  TerminalPanel as SharedTerminalPanel,
  type TerminalTab,
  TokenUsageBar as SharedTokenUsageBar,
  CommandPalette as SharedCommandPalette,
  MentionDropdown as SharedMentionDropdown,
  FileChangesPanel as SharedFileChangesPanel,
  DiffViewer as SharedDiffViewer,
} from "@maxian/ui"

/** 等待工具审批时的状态 */
interface ApprovalRequest {
  sessionId: string
  toolUseId: string
  toolName: string
  toolParams: Record<string, unknown>
}

// FileChangeEntry / TodoItem / RateLimitState / QuestionRequest / CompactingState /
// PlanExitRequest 已抽到 ./lib/chatEventTypes.ts
// PreviewTab / AttachedImage / classifyFileKind 已抽到 ./lib/types.ts

/** 弹出确认对话框：Tauri 环境用插件，浏览器用 window.confirm */
async function appConfirm(message: string): Promise<boolean> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog")
      return await confirm(message, { kind: "warning" })
    } catch {
      // 插件不可用时降级
    }
  }
  return window.confirm(message)
}

type AppStatus  = "login" | "booting" | "ready" | "error"
// SettingsTab 类型已抽到 ./components/SettingsNav
// 类型 / 常量 / helpers 已抽到 ./lib/types.ts / ./lib/toolMeta.ts / ./lib/themeFont.ts

// ─── ProcStats: 左下角进程资源监控（webview + sidecar 内存/CPU 实时） ───────
// formatBytes 已抽到 ./lib/themeFont
function ProcStats() {
  const [stats, setStats] = createSignal<{
    self:    { pid: number; memBytes: number; cpuPercent: number }
    sidecar: { pid: number | null; memBytes: number; cpuPercent: number }
    total:   { memBytes: number; cpuPercent: number }
    system:  { totalMemBytes: number; usedMemBytes: number }
  } | null>(null)
  const [hover, setHover] = createSignal(false)
  let timer: ReturnType<typeof setInterval> | null = null

  onMount(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core' as any)
      const poll = async () => {
        try {
          const r = await invoke('process_stats')
          setStats(r as any)
        } catch (e) {
          console.warn('[ProcStats] poll failed:', e)
        }
      }
      void poll()
      timer = setInterval(poll, 2000)
    } catch (e) {
      console.warn('[ProcStats] tauri core unavailable:', e)
    }
    onCleanup(() => { if (timer) clearInterval(timer) })
  })

  return (
    <Show when={stats()}>
      {(s) => (
        <div
          class="proc-stats"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          title={
            `桌面进程 PID=${s().self.pid}  内存=${formatBytes(s().self.memBytes)}  CPU=${s().self.cpuPercent.toFixed(1)}%\n`
            + `Sidecar  PID=${s().sidecar.pid ?? '-'}  内存=${formatBytes(s().sidecar.memBytes)}  CPU=${s().sidecar.cpuPercent.toFixed(1)}%\n`
            + `系统已用=${formatBytes(s().system.usedMemBytes)} / ${formatBytes(s().system.totalMemBytes)}`
          }
        >
          <span class="proc-stats-icon">⏱</span>
          <Show when={!hover()} fallback={
            <span class="proc-stats-text">
              UI {formatBytes(s().self.memBytes)} · SC {formatBytes(s().sidecar.memBytes)} · CPU {s().total.cpuPercent.toFixed(0)}%
            </span>
          }>
            <span class="proc-stats-text">
              内存 {formatBytes(s().total.memBytes)} · CPU {s().total.cpuPercent.toFixed(0)}%
            </span>
          </Show>
        </div>
      )}
    </Show>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  // App status
  const [appStatus, setAppStatus] = createSignal<AppStatus>("login")
  const [bootError, setBootError] = createSignal("")

  // Auth
  const [currentUser, setCurrentUser] = createSignal<UserInfo | null>(null)
  const [loginApiUrl, setLoginApiUrl] = createSignal(DEFAULT_API_URL)
  const [loginUsername, setLoginUsername] = createSignal("")
  const [loginPassword, setLoginPassword] = createSignal("")
  const [loginRemember, setLoginRemember] = createSignal(true)
  const [loginError, setLoginError] = createSignal("")
  const [loginLoading, setLoginLoading] = createSignal(false)

  // View
  const [showSettings, setShowSettings] = createSignal(false)
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("appearance")

  // Theme
  const [theme, setThemeSignal] = createSignal<Theme>(loadTheme())

  // Font
  const [fontFamily, setFontFamilySignal] = createSignal<string>(loadFontFamily())
  const [fontSize, setFontSizeSignal] = createSignal<number>(loadFontSize())

  // Mode: 'code' (Agent + tools) or 'chat' (Q&A only)
  const [globalMode, setGlobalMode] = createSignal<'code' | 'chat'>('code')

  // Sidebar user panel
  const [userExpanded, setUserExpanded] = createSignal(false)

  // Inline rename state
  const [editingWorkspaceId, setEditingWorkspaceId] = createSignal<string | null>(null)
  const [editingWorkspaceName, setEditingWorkspaceName] = createSignal("")
  const [editingSessionId, setEditingSessionId] = createSignal<string | null>(null)
  const [editingSessionTitle, setEditingSessionTitle] = createSignal("")

  // Collapsed workspace groups (Set of workspace IDs)
  const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set())

  // Tool card expand state (Set of toolUseIds that are EXPANDED; completed tools are collapsed by default)
  // expandedTools：旧 viewGroups 时代用，迁移到 SharedMessageList 后由 ToolBatchCard / ToolCallCard 自管
  // Reasoning block expand state (Set of msg IDs that are expanded; completed reasoning collapsed by default)
  const [expandedReasonings, setExpandedReasonings] = createSignal<Set<string>>(new Set())

  // ── 权限审批对话框 ─────────────────────────────────────────────────────────
  const [approvalRequest, setApprovalRequest] = createSignal<ApprovalRequest | null>(null)

  // ── 文件变更树面板 ─────────────────────────────────────────────────────────
  const [showFileTree, setShowFileTree] = createSignal(false)
  const [changedFiles, setChangedFiles] = createSignal<Map<string, FileChangeEntry>>(new Map())

  // ── 右侧预览面板 ──────────────────────────────────────────────────────────
  const [previewTabs, setPreviewTabs] = createSignal<PreviewTab[]>([])
  const [activePreviewPath, setActivePreviewPath] = createSignal<string | null>(null)
  // 预览面板宽度（像素），可拖动
  const [previewWidth, setPreviewWidth] = createSignal(520)

  // ── 工作区文件浏览器面板 ──────────────────────────────────────────────────
  const [showExplorer, setShowExplorer] = createSignal(false)
  const [explorerSearch, setExplorerSearch] = createSignal("")

  // ── Diff 视图模式（P1-12）: unified / split ─────────────────────────────
  const [diffViewMode, setDiffViewMode] = createSignal<'unified' | 'split'>('unified')

  // ── Todo 跟踪面板（P0-1）—— TodoItem 类型已抽到 lib/chatEventTypes ──
  const [todos, setTodos] = createSignal<TodoItem[]>([])
  const [todoDockCollapsed, setTodoDockCollapsed] = createSignal(false)
  // 任务结束时如果还有 in_progress/pending 项，标记为"AI 提前结束未完成"以便 UI 显示警告
  const [todosLeftover, setTodosLeftover] = createSignal(false)

  // ── Followup 建议队列（P0-2） ───────────────────────────────────────────
  const [followupSuggestions, setFollowupSuggestions] = createSignal<string[]>([])
  const [followupQueue, setFollowupQueue] = createSignal<string[]>([])
  const [followupCollapsed, setFollowupCollapsed] = createSignal(false)

  // ── Rate-limit 重试 UI（P0-6）—— RateLimitState 已抽到 lib/chatEventTypes ──
  const [rateLimit, setRateLimit] = createSignal<RateLimitState>({ active: false, resetAt: 0, attempt: 0, message: '' })

  // ── Context 标签页（P1-10） ─────────────────────────────────────────────
  const [showContextPanel, setShowContextPanel] = createSignal(false)
  // contextFiles memo 移到 messages 信号声明之后，避免 TDZ

  // ── Session revert dock（P1-11） ────────────────────────────────────────
  const [showRevertDock, setShowRevertDock] = createSignal(false)

  // ── Agent 提问 / 上下文压缩 / Plan Exit 状态 —— 类型已抽到 lib/chatEventTypes ──
  const [questionRequest, setQuestionRequest]   = createSignal<QuestionRequest | null>(null)
  const [compactingState, setCompactingState]   = createSignal<CompactingState | null>(null)
  const [questionAnswer,  setQuestionAnswer]    = createSignal('')
  const [questionSelected, setQuestionSelected] = createSignal<string[]>([])
  const [planExitRequest, setPlanExitRequest]   = createSignal<PlanExitRequest | null>(null)
  const [planExitFeedback, setPlanExitFeedback] = createSignal('')

  async function revertToMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    const ok = await appConfirm('确定要回退到此消息吗？该消息及其后所有消息将被永久删除。')
    if (!ok) return
    try {
      const c = await getClient()
      const res = await c.revertToMessage(sid, msgId)
      if (!res.ok) throw new Error(res.error ?? '回退失败')
      showToast({ message: `已回退，删除 ${res.deleted} 条消息`, kind: 'success' })
      // 重新加载消息
      const data = await c.getSessionMessages(sid, { limit: 50 })
      setMessages(data.messages.map(storedToChatMessage))
      setShowRevertDock(false)
    } catch (e) {
      showToast({ message: '回退失败: ' + (e as Error).message, kind: 'error' })
    }
  }

  // ── 图像生成输出（P1-16）: 消息里解析 [[image:base64]] 标记 ────────────

  // ── Skills 面板 ───────────────────────────────────────────────────────────
  type SkillEntry = {
    name:        string
    description: string
    path:        string
    source:      'workspace-maxian' | 'workspace-claude' | 'user-maxian' | 'user-claude'
    size:        number
  }
  const [showSkillsPanel, setShowSkillsPanel] = createSignal(false)

  // ── B1: 子代理任务编排面板 ────────────────────────────────────────────
  const [showSubagentPanel, setShowSubagentPanel] = createSignal(false)
  const [subagentRecords, setSubagentRecords] = createSignal<import('@maxian/sdk').SubagentRecord[]>([])
  const [subagentLoading, setSubagentLoading] = createSignal(false)
  const [subagentStatusFilter, setSubagentStatusFilter] = createSignal<import('@maxian/sdk').SubagentStatus | 'all'>('all')
  let _subagentEventsUnsub: (() => void) | null = null

  async function loadSubagents() {
    setSubagentLoading(true)
    try {
      const c = await getClient()
      const r = await c.listSubagents()
      setSubagentRecords(r.records as import('@maxian/sdk').SubagentRecord[])
    } catch (e) {
      console.error('[Subagent] load failed:', e)
    } finally {
      setSubagentLoading(false)
    }
  }

  /** 打开面板时拉一次 + 订阅 SSE；关闭时 unsub */
  createEffect(() => {
    if (!showSubagentPanel()) {
      _subagentEventsUnsub?.()
      _subagentEventsUnsub = null
      return
    }
    void loadSubagents()
    void (async () => {
      try {
        const c = await getClient()
        _subagentEventsUnsub?.()
        const sub = c.subscribeSubagentEvents({
          onUpdate: (rec) => {
            // 实时合并：已存在则更新，否则追加
            setSubagentRecords((prev) => {
              const idx = prev.findIndex(r => r.taskId === rec.taskId)
              if (idx >= 0) {
                const next = prev.slice()
                next[idx] = rec as import('@maxian/sdk').SubagentRecord
                return next
              }
              return [rec as import('@maxian/sdk').SubagentRecord, ...prev]
            })
          },
        })
        _subagentEventsUnsub = sub.close
      } catch (e) {
        console.error('[Subagent] subscribe failed:', e)
      }
    })()
  })

  // ── B4: 项目知识库面板 ─────────────────────────────────────────────────
  const [showCodebasePanel, setShowCodebasePanel] = createSignal(false)
  const [codebaseSnapshot, setCodebaseSnapshot] = createSignal<import('@maxian/sdk').CodebaseIndexSnapshot | null>(null)
  const [codebaseLoading, setCodebaseLoading] = createSignal(false)
  const [codebaseProgress, setCodebaseProgress] = createSignal('')
  const [codebaseTab, setCodebaseTab] = createSignal<import('./panels/CodebaseIndexPanel').CodebaseTab>('architecture')
  const [codebaseSearchQuery, setCodebaseSearchQuery] = createSignal('')
  const [codebaseSearchHits, setCodebaseSearchHits] = createSignal<import('@maxian/sdk').CodebaseSearchHit[]>([])
  const [codebaseSearchLoading, setCodebaseSearchLoading] = createSignal(false)
  async function loadCodebaseSnapshot() {
    const ws = activeWorkspace()
    if (!ws) { setCodebaseSnapshot(null); return }
    try {
      const c = await getClient()
      const r = await c.getCodebaseSnapshot(ws.id)
      setCodebaseSnapshot(r.snapshot)
    } catch (e) {
      console.error('[Codebase] load snapshot failed:', e)
    }
  }

  let _codebaseRefreshUnsub: (() => void) | null = null

  async function refreshCodebaseIndexUI(incremental: boolean) {
    const ws = activeWorkspace()
    if (!ws) {
      showToast({ message: '请先选择工作区', kind: 'warn', duration: 2500 })
      return
    }
    if (codebaseLoading()) return  // 防止并发触发
    setCodebaseLoading(true)
    setCodebaseProgress(incremental ? '增量扫描中…' : '全量重建中…')
    try {
      const c = await getClient()
      _codebaseRefreshUnsub?.()
      const sub = c.subscribeCodebaseRefresh(ws.id, {
        incremental,
        onStart:    (e) => setCodebaseProgress(`开始${e.incremental ? '增量' : '全量'}扫描…`),
        onProgress: (e) => setCodebaseProgress(e.message),
        onDone:     (e) => {
          if (e.ok && e.snapshot) {
            setCodebaseSnapshot(e.snapshot)
            showToast({
              message: `索引完成：${e.snapshot.fileCount} 文件 / ${e.snapshot.apiCount} API（${(e.durationMs / 1000).toFixed(1)}s）`,
              kind: 'success',
              duration: 4000,
            })
          }
          setCodebaseLoading(false)
          setCodebaseProgress('')
          _codebaseRefreshUnsub?.()
          _codebaseRefreshUnsub = null
        },
        onError:    (e) => {
          showToast({ message: `索引失败：${e.message}`, kind: 'error', duration: 6000 })
          pushError('codebase', `索引失败：${e.message}`)
          setCodebaseLoading(false)
          setCodebaseProgress('')
          _codebaseRefreshUnsub?.()
          _codebaseRefreshUnsub = null
        },
      })
      _codebaseRefreshUnsub = sub.close
    } catch (e) {
      const msg = (e as Error).message
      showToast({ message: `索引启动失败：${msg}`, kind: 'error', duration: 6000 })
      pushError('codebase', `索引启动失败：${msg}`)
      setCodebaseLoading(false)
      setCodebaseProgress('')
    }
  }

  async function searchCodebaseUI(query: string) {
    const ws = activeWorkspace()
    if (!ws) return
    if (!query.trim()) { setCodebaseSearchHits([]); return }
    setCodebaseSearchLoading(true)
    try {
      const c = await getClient()
      const r = await c.searchCodebase(ws.id, query, 30)
      setCodebaseSearchHits(r.hits)
    } catch (e) {
      pushError('codebase', `搜索失败：${(e as Error).message}`)
    } finally {
      setCodebaseSearchLoading(false)
    }
  }

  /** 打开面板时拉一次快照；切工作区也重拉 */
  createEffect(() => {
    if (!showCodebasePanel()) return
    void activeWorkspace()  // 订阅
    void loadCodebaseSnapshot()
  })

  // ── B3: 记忆面板 ──────────────────────────────────────────────────────
  const [showMemoryPanel, setShowMemoryPanel] = createSignal(false)
  const [memoryRecords, setMemoryRecords] = createSignal<import('@maxian/sdk').MemoryRecord[]>([])
  const [memoryLoading, setMemoryLoading] = createSignal(false)
  const [memoryScopeFilter, setMemoryScopeFilter] = createSignal<import('@maxian/sdk').MemoryScope | 'all'>('all')
  const [memoryCategoryFilter, setMemoryCategoryFilter] = createSignal<import('@maxian/sdk').MemoryCategory | 'all'>('all')
  const [memorySearchQuery, setMemorySearchQuery] = createSignal('')

  async function loadMemories() {
    setMemoryLoading(true)
    try {
      const c = await getClient()
      const sc = memoryScopeFilter()
      const filter: { scope?: import('@maxian/sdk').MemoryScope; workspaceId?: string; sessionId?: string } = {}
      if (sc !== 'all') filter.scope = sc
      if (sc === 'workspace') {
        const ws = activeWorkspace()
        if (ws) filter.workspaceId = ws.id
      } else if (sc === 'session') {
        const sid = activeSessionId()
        if (sid) filter.sessionId = sid
      }
      const r = await c.listMemories(filter)
      setMemoryRecords(r.records)
    } catch (err) {
      console.error('[Memory] load failed:', err)
      pushError('memory', `加载记忆失败：${(err as Error).message}`)
    } finally {
      setMemoryLoading(false)
    }
  }

  async function searchMemoriesUI(query: string) {
    if (!query.trim()) { void loadMemories(); return }
    setMemoryLoading(true)
    try {
      const c = await getClient()
      const sc = memoryScopeFilter()
      const r = await c.searchMemories({
        query,
        scope:        sc !== 'all' ? sc : undefined,
        workspaceId:  sc === 'workspace' ? activeWorkspace()?.id : undefined,
        sessionId:    sc === 'session'   ? (activeSessionId() ?? undefined) : undefined,
        category:     memoryCategoryFilter() !== 'all' ? memoryCategoryFilter() as import('@maxian/sdk').MemoryCategory : undefined,
        maxResults:   50,
        minScore:     0.05,
      })
      setMemoryRecords(r.hits.map(h => h.record))
    } catch (err) {
      console.error('[Memory] search failed:', err)
      pushError('memory', `搜索记忆失败：${(err as Error).message}`)
    } finally {
      setMemoryLoading(false)
    }
  }

  /** 切换 scope/打开面板时重新加载 */
  createEffect(() => {
    if (!showMemoryPanel()) return
    void memoryScopeFilter()  // 订阅
    void loadMemories()
  })
  const [skillsList, setSkillsList] = createSignal<SkillEntry[]>([])
  const [skillsLoading, setSkillsLoading] = createSignal(false)
  const [skillsSearchedDirs, setSkillsSearchedDirs] = createSignal<Array<{ path: string; source: string; exists: boolean }>>([])

  // ── Token 用量（K11a-cont：抽到 ./hooks/useTokenUsage） ────────────────────
  // tokenLimit 由后端根据实际模型窗口上报（token_usage 事件的 limit 字段）
  // 默认 1M（Qwen3-coder-plus / Claude 1M / Qwen-max-longcontext），
  // 后端通过 MAXIAN_CONTEXT_WINDOW 环境变量可覆盖，上报给前端后实时更新
  const _tokenUsage = useTokenUsage({ defaultLimit: 1_000_000 })
  const tokenUsed    = _tokenUsage.tokenUsed
  const tokenLimit   = _tokenUsage.tokenLimit
  const setTokenUsed = _tokenUsage.setTokenUsed
  const setTokenLimit = _tokenUsage.setTokenLimit

  // ── Slash 命令面板 ─────────────────────────────────────────────────────────
  const [showSlash, setShowSlash] = createSignal(false)
  const [slashQuery, setSlashQuery] = createSignal("")
  const [slashIdx, setSlashIdx] = createSignal(0)

  // ── 图片附件 ──────────────────────────────────────────────────────────────
  const [attachedImages, setAttachedImages] = createSignal<AttachedImage[]>([])

  // ── 全局 Toast 系统（带 action 按钮） ─────────────────────────────────────
  // ToastItem 类型 + ToastHost 组件已抽到 ./components/ToastHost.tsx
  const [toasts, setToasts] = createSignal<ToastItem[]>([])
  function showToast(opts: {
    message:  string
    kind?:    ToastItem['kind']
    action?:  ToastItem['action']
    duration?: number
  }) {
    const id = Math.random().toString(36).slice(2)
    const toast: ToastItem = {
      id,
      message:  opts.message,
      kind:     opts.kind ?? 'info',
      action:   opts.action,
      duration: opts.duration ?? 4000,
    }
    setToasts(prev => [...prev, toast])
    if (toast.duration > 0) {
      setTimeout(() => dismissToast(id), toast.duration)
    }
    return id
  }
  function dismissToast(id: string) {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  // K11b: prompt 历史已抽到 ./hooks/usePromptHistory
  const _promptHistoryHook = usePromptHistory()
  const promptHistory     = _promptHistoryHook.promptHistory
  const historyIdx        = _promptHistoryHook.historyIdx
  const setHistoryIdx     = _promptHistoryHook.setHistoryIdx
  const historyDraft      = _promptHistoryHook.historyDraft
  const setHistoryDraft   = _promptHistoryHook.setHistoryDraft
  const pushPromptHistory = _promptHistoryHook.pushPromptHistory

  // ── 键盘快捷键速查面板 ───────────────────────────────────────────────────
  const [showKeybindHelp, setShowKeybindHelp] = createSignal(false)
  const [keybindSearch, setKeybindSearch] = createSignal('')

  // K11b: Vim 模式逻辑已抽到 ./hooks/useVimMode
  const { vimEnabled, toggleVim, vimMode, setVimMode, handleVimKey } = useVimMode()

  // ── 项目级自定义 command（从 .maxian/commands/*.md 加载，动态合入 slash 面板） ──
  interface CustomCmdEntry { name: string; description: string; template: string; agent?: string }
  const [customCommands, setCustomCommands] = createSignal<CustomCmdEntry[]>([])
  async function refreshProjectConfig() {
    const ws = activeWorkspace()
    if (!ws) { setCustomCommands([]); return }
    try {
      const c = await getClient()
      const r = await c.getProjectConfig(ws.id)
      setCustomCommands(r.commands ?? [])
    } catch { /* ignore */ }
  }
  createEffect(() => {
    const ws = activeWorkspace()
    if (ws) void refreshProjectConfig()
  })

  // ── Session 模板 ────────────────────────────────────────────────────
  const TEMPLATE_KEY = 'maxian:session-templates'
  interface SessionTemplate { name: string; content: string; tags?: string[] }
  const [sessionTemplates, setSessionTemplates] = createSignal<SessionTemplate[]>(
    (() => { try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '[]') } catch { return [] } })()
  )
  function addSessionTemplate(t: SessionTemplate) {
    const next = [...sessionTemplates(), t]
    setSessionTemplates(next)
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(next)) } catch {}
  }
  function removeSessionTemplate(name: string) {
    const next = sessionTemplates().filter(t => t.name !== name)
    setSessionTemplates(next)
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(next)) } catch {}
  }

  // ── 错误追踪（最近 50 条错误事件）────────────────────────────────────
  interface ErrorEntry { id: string; ts: number; sessionId?: string; source: string; message: string }
  const [errorLog, setErrorLog] = createSignal<ErrorEntry[]>([])
  function pushError(source: string, message: string, sessionId?: string) {
    setErrorLog(prev => [
      { id: Math.random().toString(36).slice(2), ts: Date.now(), source, message, sessionId },
      ...prev,
    ].slice(0, 50))
  }

  // K11b: 自定义快捷键已抽到 ./hooks/useCustomKeybinds
  const { customKeybinds, getKeybind, setKeybind, resetKeybind } = useCustomKeybinds()

  // ── 全局命令面板（⌘P）────────────────────────────────────────────────
  // PaletteItem 类型 + GlobalCommandPalette 组件已抽到 ./components/GlobalCommandPalette.tsx
  const [showCmdPalette, setShowCmdPalette] = createSignal(false)
  const [cmdPaletteQuery, setCmdPaletteQuery] = createSignal('')
  const [cmdPaletteIdx, setCmdPaletteIdx] = createSignal(0)
  const [cmdPaletteLoading, setCmdPaletteLoading] = createSignal(false)
  const [cmdPaletteItems, setCmdPaletteItems] = createSignal<PaletteItem[]>([])

  // ── 消息键盘导航（j/k 或 ↑/↓）──────────────────────────────────────────
  const [focusedMsgIdx, setFocusedMsgIdx] = createSignal<number>(-1)

  // ── 代码块 "应用到文件"（P0-2）───────────────────────────────────────────
  const [applyDialog, setApplyDialog] = createSignal<{
    open:    boolean
    code:    string
    lang?:   string
    target:  string
    mode:    'overwrite' | 'append'
    loading: boolean
    error?:  string
  }>({ open: false, code: '', lang: undefined, target: '', mode: 'overwrite', loading: false })
  function openApplyToFileDialog(code: string, lang?: string) {
    // 默认目标：首个已打开的预览；否则空
    const firstPreview = previewTabs()[0]?.path ?? ''
    setApplyDialog({
      open: true,
      code,
      lang,
      target: firstPreview,
      mode: 'overwrite',
      loading: false,
    })
  }
  async function confirmApplyToFile() {
    const dlg = applyDialog()
    const ws = activeWorkspace()
    if (!ws) { setApplyDialog(d => ({ ...d, error: '未打开工作区' })); return }
    const target = dlg.target.trim()
    if (!target) { setApplyDialog(d => ({ ...d, error: '请选择目标文件' })); return }
    setApplyDialog(d => ({ ...d, loading: true, error: undefined }))
    try {
      const c = await getClient()
      let finalContent = dlg.code
      if (dlg.mode === 'append') {
        // 读现有文件，追加（加一个空行分隔）
        try {
          const cur = await c.readFileContent(ws.id, target)
          const base = cur?.content ?? ''
          finalContent = base.endsWith('\n') ? base + dlg.code : base + '\n' + dlg.code
        } catch {
          // 不存在就直接用新内容
        }
      }
      const res = await c.writeFileContent(ws.id, target, finalContent, { createIfMissing: true })
      showToast({
        message: `已${res.created ? '创建' : '写入'}：${target}`,
        kind: 'success',
        action: { label: '查看', onClick: () => void openPreview(target, { viewMode: 'source' }) },
      })
      // 若该文件有打开标签：刷新内容
      const existing = previewTabs().find(t => t.path === target)
      if (existing) {
        const data = await c.readFileContent(ws.id, target)
        setPreviewTabs(prev => prev.map(t => t.path === target
          ? { ...t, content: data.content, size: data.size, mimeType: data.mimeType, loading: false }
          : t
        ))
      }
      setApplyDialog({ open: false, code: '', lang: undefined, target: '', mode: 'overwrite', loading: false })
    } catch (e) {
      setApplyDialog(d => ({ ...d, loading: false, error: (e as Error).message }))
    }
  }

  // K11b: 会话内 ⌘F 搜索已抽到 ./hooks/useInChatSearch
  const _inChatSearch = useInChatSearch({
    messages:         () => messages(),
    setFocusedMsgIdx: (idx) => setFocusedMsgIdx(idx),
  })
  const showInChatSearch    = _inChatSearch.showInChatSearch
  const setShowInChatSearch = _inChatSearch.setShowInChatSearch
  const inChatSearchQuery    = _inChatSearch.inChatSearchQuery
  const setInChatSearchQuery = _inChatSearch.setInChatSearchQuery
  const inChatSearchIdx      = _inChatSearch.inChatSearchIdx
  const setInChatSearchIdx   = _inChatSearch.setInChatSearchIdx
  const inChatSearchHits     = _inChatSearch.inChatSearchHits
  const openInChatSearch     = _inChatSearch.openInChatSearch
  const closeInChatSearch    = _inChatSearch.closeInChatSearch
  const jumpToSearchHit      = _inChatSearch.jumpToSearchHit
  let inChatSearchInputRef: HTMLInputElement | undefined  // 兼容老代码 ref={...} 用法

  // ── 消息过滤器（P1-13）: 隐藏内部工具、折叠 reasoning ─────────────────────
  const FILTER_STORAGE_KEY = 'maxian:msg-filter'
  interface MsgFilter { hideTodos: boolean; hideReasoning: boolean; hideInternalTools: boolean }
  const [msgFilter, setMsgFilter] = createSignal<MsgFilter>(
    (() => { try { return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '') } catch { return null } })()
      ?? { hideTodos: false, hideReasoning: false, hideInternalTools: false }
  )
  const [showFilterMenu, setShowFilterMenu] = createSignal(false)
  /** 强制展开所有 reasoning（"展开全部思考"按钮联动） */
  const [expandAllReasoning, setExpandAllReasoning] = createSignal(false)
  function updateMsgFilter(patch: Partial<MsgFilter>) {
    const next = { ...msgFilter(), ...patch }
    setMsgFilter(next)
    try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(next)) } catch {}
  }
  /** 一批内部工具名（AI 调用但通常对用户价值不高） */
  const INTERNAL_TOOL_NAMES = new Set(['todo_write', 'load_skill', 'ask_followup_question', 'update_todo_list'])

  // ── 权限记忆（P1-14）: 持久化到 localStorage ──────────────────────────────
  // K11a-cont: 审批白名单 已抽到 ./hooks/useApprovalQueue
  const _approvalQueue = useApprovalQueue()
  const allowAlways      = _approvalQueue.allowAlways
  const addAllowAlways   = _approvalQueue.addAllowAlways
  const removeAllowAlways = _approvalQueue.removeAllowAlways
  const addSessionAllow  = _approvalQueue.addSessionAllow
  const isAutoApproved   = _approvalQueue.isAutoApproved

  // ── 作曲模式 (Code / Ask / Plan / Bypass) ────────────────────────────────
  // ComposerMode 类型已从 ./components/ModeSelector 导入
  const [composerMode, setComposerMode] = createSignal<ComposerMode>('code')
  const [showModeDropdown, setShowModeDropdown] = createSignal(false)

  // ── 面板位置（slash / mention 下拉用 fixed 定位）────────────────────────────
  const [paletteRect, setPaletteRect] = createSignal({ bottom: 100, left: 0, width: 600 })
  let composerWrapRef: HTMLDivElement | undefined

  // K11b: Git 分支选择器已抽到 ./hooks/useGitBranchPicker
  const _branchPicker = useGitBranchPicker({
    activeWorkspace: () => activeWorkspace(),
    getClient: () => getClient() as any,
  })
  const currentBranch           = _branchPicker.currentBranch
  const setCurrentBranch        = _branchPicker.setCurrentBranch
  const showBranchPicker        = _branchPicker.showBranchPicker
  const setShowBranchPicker     = _branchPicker.setShowBranchPicker
  const branchPickerBranches    = _branchPicker.branchPickerBranches
  const setBranchPickerBranches = _branchPicker.setBranchPickerBranches
  const branchPickerLoading     = _branchPicker.branchPickerLoading
  const branchPickerSearch      = _branchPicker.branchPickerSearch
  const setBranchPickerSearch   = _branchPicker.setBranchPickerSearch
  const branchPickerRect        = _branchPicker.branchPickerRect

  // ── 集成终端 ──────────────────────────────────────────────────────────────
  const [showTerminal, setShowTerminal] = createSignal(false)
  const [terminalCollapsed, setTerminalCollapsed] = createSignal(false)
  const [terminalHeight, setTerminalHeight] = createSignal(280)
  const [terminalTabs, setTerminalTabs] = createSignal<TerminalTab[]>([])
  const [activeTermId, setActiveTermId] = createSignal<string | null>(null)
  /** xterm.js + WebSocket 实例 Map（id → 实例），生命周期与 App 相同 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /**
   * 终端实例。
   * 注意：从 v0.2.16 起 PTY 改由 Tauri Rust（portable-pty）侧管理，绕开 Bun 运行时
   * 在 @lydell/node-pty 上的 PTY 子进程 bug。前端通过 Tauri command 启停 / 写 / 调整尺寸，
   * 通过 listen('terminal://data') 接收输出。`terminalId` 是 Rust 侧返回的唯一标识，
   * 命令调用必须用这个 id；前端 tab 自己的 id 仅用于 DOM key（两者独立）。
   */
  type TerminalInstance = {
    term:        any
    fit:         any
    terminalId:  string                   // Rust portable-pty 返回的会话 id
    unlistenFns: Array<() => void>        // listen() 返回的 unsub
    resizeObs?:  ResizeObserver
  }
  const termInstances = new Map<string, TerminalInstance>()
  /** 每个会话的终端状态快照（仅记录 show/collapsed/height，tabs 通过 sessionId 字段过滤） */
  interface SessionTerminalSnapshot {
    show: boolean
    collapsed: boolean
    height: number
    activeTermId: string | null
  }
  const sessionTerminalSnapshots = new Map<string, SessionTerminalSnapshot>()

  // Main state
  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([])
  // v0.2.16+：任务批次面板显隐（在主区覆盖渲染）
  const [showBatchPanel, setShowBatchPanel] = createSignal(false)
  // v0.2.16+：从 Task → 看日志 跳转时，临时记下跳前的 activeSessionId，
  // 用户点 Chat/Code 段切换离开"被临时打开的任务会话"时恢复，避免污染最近会话。
  // selectSession 默认会清掉它（任何"非跳转"的会话切换 = 用户的新选择，覆盖回退目标）。
  const [_jumpReturnSessionId, _setJumpReturnSessionId] = createSignal<string | null>(null)
  /** 切到 chat/code 段：若刚才是从 Task → 看日志 临时跳过来的，恢复跳前的会话 */
  const leaveBatchPanelToMode = (mode: 'chat' | 'code'): void => {
    setShowBatchPanel(false)
    setGlobalMode(mode)
    const saved = _jumpReturnSessionId()
    if (saved && saved !== activeSessionId()) {
      // selectSession 内部会自动清掉 _jumpReturnSessionId
      void selectSession(saved)
    }
  }
  // 给 BatchPanel 用的 client（lazy 拿一次缓存）
  const [batchClient, setBatchClient] = createSignal<Awaited<ReturnType<typeof getClient>> | null>(null)
  createEffect(() => {
    if (showBatchPanel() && !batchClient()) {
      void getClient().then(c => setBatchClient(c))
    }
  })
  const [activeWorkspace, setActiveWorkspace] = createSignal<Workspace | null>(null)
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  // 会话搜索（sidebar 顶部，按标题模糊过滤）
  const [sessionSearch, setSessionSearch] = createSignal('')
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  // 内存硬防御：超过 800 条 → 丢最老的 200 条保留最新 600。
  // 大任务（100+ 工具调用、超长会话）会让 messages 数组撑爆 webview 内存。
  // 历史在 sidecar SQLite 还在，需要回看可滚到顶触发 fetchOlderMessages（如已有）。
  createEffect(() => {
    const len = messages().length
    if (len > 800) {
      setMessages(prev => prev.slice(-600))
    }
  })
  // ─── @maxian/ui 共享 store 镜像 ─────────────────────────────────────────────
  // desktop 现有 messages signal 是真相源；这里做"单向镜像"到共享 store，
  // 让未来共享 MessageList / 三端共用代码可以无缝消费。镜像只读不写回。
  //
  // 🔥 引用稳定化（关键防闪策略）：
  //   每个 ChatMessage 缓存对应 SharedChatMessage；只有源消息真正"变化"时
  //   （字段差异）才生成新引用，否则复用上一轮的同一对象。
  //
  //   不做这个缓存：messages() 信号每次 SSE chunk 都变 → effect 跑 → 全量 map
  //   生成全新对象 → setAll 整体替换 → MessageList <For> 按引用判等全部 miss
  //   → 所有 MessageBubble / ToolCallCard 都被 unmount + remount → :hover/transition
  //   反复重启 → 整个列表"闪"。Map 持久化的展开状态保住了数值，但组件 DOM 还是
  //   在不停销毁重建，所以视觉上仍然闪。
  const sharedMessagesStore = createMessagesStore()
  const sharedMirrorCache = new Map<string, { src: ChatMessage; out: SharedChatMessage }>()
  createEffect(() => {
    const local = messages()
    const newCache = new Map<string, { src: ChatMessage; out: SharedChatMessage }>()
    const shared: SharedChatMessage[] = []
    for (const m of local) {
      const cached = sharedMirrorCache.get(String(m.id))
      // 源消息引用未变 → 直接复用同一个 SharedChatMessage 对象
      if (cached && cached.src === m) {
        shared.push(cached.out)
        newCache.set(String(m.id), cached)
        continue
      }
      // 字段全等也算"未变"（patch 重写了源对象但内容一致——很少见，但便宜的二次保险）
      if (cached
        && cached.src.role === m.role
        && cached.src.content === m.content
        && cached.src.isPartial === m.isPartial
        && cached.src.toolResult === m.toolResult
        && cached.src.toolSuccess === m.toolSuccess
        && cached.src.liveOutput === m.liveOutput
        && cached.src.toolParams === m.toolParams
        && cached.src.charCount === m.charCount
      ) {
        // 仅更新 src 指针（保 out 引用不变）
        cached.src = m
        shared.push(cached.out)
        newCache.set(String(m.id), cached)
        continue
      }
      // 真的变化 → 生成新 SharedChatMessage
      const out: SharedChatMessage = {
        id:          String(m.id),
        role:        m.role === 'system' || m.role === 'tool' || m.role === 'reasoning' || m.role === 'error' || m.role === 'assistant' || m.role === 'user'
          ? m.role
          : 'system',
        content:     m.content ?? '',
        createdAt:   m.createdAt ?? Date.now(),
        isPartial:   m.isPartial,
        toolName:    m.toolName,
        toolId:      m.toolUseId,
        toolParams:  m.toolParams,
        toolResult:  m.toolResult,
        toolSuccess: m.toolSuccess,
        liveOutput:  m.liveOutput,
        charCount:   m.charCount,
      }
      shared.push(out)
      newCache.set(String(m.id), { src: m, out })
    }
    sharedMirrorCache.clear()
    for (const [k, v] of newCache) sharedMirrorCache.set(k, v)
    sharedMessagesStore.setAll(shared)
  })
  // contextFiles: 从消息里提取 @ 文件引用（P1-10）
  const contextFiles = createMemo(() => {
    const set = new Set<string>()
    for (const m of messages()) {
      if (m.role !== 'user') continue
      const matches = m.content.match(/@[\S]+/g)
      if (matches) for (const x of matches) set.add(x.slice(1))
    }
    return [...set]
  })
  const [input, setInput] = createSignal("")
  const [sending, setSending] = createSignal(false)
  // 本次任务累计接收到的字符数（每次 send 重置为 0）
  const [receivedChars, setReceivedChars] = createSignal(0)

  let chatEndRef: HTMLDivElement | undefined
  let chatTimelineRef: HTMLDivElement | undefined
  // 滚动位置 reactive 标记（控制"加载更早消息"按钮 + "回到底部"按钮的显示）
  const [isNearTop, setIsNearTop] = createSignal(false)
  const [isNearBottomSignal, setIsNearBottomSignal] = createSignal(true)
  function scrollChatToBottom(): void {
    if (!chatTimelineRef) return
    chatTimelineRef.scrollTop = chatTimelineRef.scrollHeight
  }
  /** 贴底滚动跟踪：用户手动往上翻时暂停 auto-scroll；回到底部重新启用 */
  let stickToBottom = true
  const STICK_THRESHOLD_PX = 80
  /** 判断当前是否离底部 < THRESHOLD（允许继续 auto-scroll） */
  function isNearBottom(el: HTMLElement): boolean {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < STICK_THRESHOLD_PX
  }
  /**
   * 尝试滚到底。仅当 stickToBottom=true 时才执行。
   * 用户手动往上翻后，新消息不会打断他们阅读。
   */
  function maybeScrollToBottom() {
    if (!stickToBottom) return
    requestAnimationFrame(() => chatEndRef?.scrollIntoView({ behavior: 'smooth' }))
  }
  let textareaRef: HTMLTextAreaElement | undefined
  /** 用户通过 composer 顶部拖条调整的输入框总高度；null = auto（默认高度） */
  const [composerHeight, setComposerHeight] = createSignal<number | null>(null)
  /** per-session 的 todos 快照（切会话时保留 / 恢复任务清单） */
  const _sessionTodosSnapshot = new Map<string, { todos: TodoItem[]; leftover: boolean }>()
  let unsubscribe: (() => void) | null = null
  let msgId = 0

  // 消息分页状态
  const [msgHasMore, setMsgHasMore] = createSignal(false)
  const [msgLoadingMore, setMsgLoadingMore] = createSignal(false)
  // 当前会话最早一条消息的 createdAt（用作 before 游标）
  const [msgOldestTs, setMsgOldestTs] = createSignal<number | undefined>(undefined)

  // SLASH_COMMANDS 已抽到 ./lib/slashCommands.ts

  // 接收计数器：用普通变量 + DOM ref 直接写，绕过 SolidJS batching，保证每次事件立即更新
  let _recvCount = 0
  let _lastEventAt = 0   // 最近收到任意 SSE 事件的时间戳（用于任务卡死兜底）
  let recvTextRef: HTMLSpanElement | undefined
  let recvDotRef:  HTMLSpanElement | undefined

  function _bumpRecv(n: number) {
    _recvCount += n
    _lastEventAt = Date.now()
    if (recvTextRef) recvTextRef.textContent = `已接收 ${formatRecv(_recvCount)}`
    // 第一次有数据时亮蓝点
    if (_recvCount > 0 && recvDotRef) recvDotRef.classList.add('recv-dot-active')
  }

  function _resetRecv() {
    _recvCount = 0
    _lastEventAt = Date.now()
    setReceivedChars(0)  // 用于 <Show> show/hide 逻辑
    if (recvTextRef) recvTextRef.textContent = '等待响应…'
    if (recvDotRef) recvDotRef.classList.remove('recv-dot-active')
  }

  // ─── 平台检测：给 body 加 class，让 CSS 能区分 macOS / Windows / Linux ──
  // macOS 用 titleBarStyle:Overlay + 我们自己的标题栏（替代原生）
  // Windows / Linux 用系统原生标题栏（隐藏我们自定义的那条，避免双标题栏）
  onMount(() => {
    const ua = navigator.userAgent.toLowerCase()
    let platformKey: 'mac' | 'win' | 'linux' | 'other' = 'other'
    if (ua.includes('mac')) platformKey = 'mac'
    else if (ua.includes('win')) platformKey = 'win'
    else if (ua.includes('linux')) platformKey = 'linux'
    document.body.classList.add(`platform-${platformKey}`)
  })

  // ─── 任务卡死兜底检测 ──────────────────────────────────────────────────
  // 若 sending=true 但 60 秒内没收到任何 SSE 事件，主动从服务端查一次消息快照
  //（大概率 SSE 被中间层 idle-kill 了），把 UI 补齐到最新状态。
  onMount(() => {
    const check = async () => {
      if (!sending()) return
      const idle = Date.now() - _lastEventAt
      if (idle < 60000) return
      // 已经静默 > 60s，可能 SSE 断了没重连成功
      const sid = activeSessionId()
      if (!sid) return
      try {
        const c = await getClient()
        const data = await c.getSessionMessages(sid, { limit: 200 })
        if (Array.isArray(data?.messages) && data.messages.length > 0) {
          setMessages(data.messages.map(storedToChatMessage))
          // 如果最后一条已经是 assistant / error / tool 完整结果 → 判定任务已结束
          const last = data.messages[data.messages.length - 1] as any
          if (last && (last.role === 'assistant' || last.role === 'error')) {
            setSending(false)
            showToast({ message: '检测到事件流静默，已从服务器补齐消息', kind: 'info', duration: 3000 })
          }
        }
      } catch (e) {
        console.warn('[watchdog] 状态同步失败:', e)
      }
      _lastEventAt = Date.now()   // 避免短时间内连续触发
    }
    const timer = setInterval(check, 10000)
    onCleanup(() => clearInterval(timer))
  })

  // Apply theme + font on change
  createEffect(() => applyTheme(theme()))
  createEffect(() => applyFont(fontFamily(), fontSize()))

  // ── 语言状态（用于触发重新渲染） ──────────────────────────────────────────
  const [locale, setLocaleSignal] = createSignal(getLocale())

  function switchLocale(l: 'zh-CN' | 'en') {
    setLocale(l)
    setLocaleSignal(l)
  }

  onMount(() => {
    initI18n()
    setLocaleSignal(getLocale())
    applyTheme(loadTheme())
    applyFont(loadFontFamily(), loadFontSize())
    const saved = loadSavedCredentials()
    if (saved) {
      setCurrentUser(saved.userInfo)
      setLoginApiUrl(saved.apiUrl)
      setLoginUsername(saved.username)
      void bootWithCredentials(saved)
    }
  })
  onCleanup(() => unsubscribe?.())

  function setTheme(t: Theme) {
    setThemeSignal(t)
    applyTheme(t)
  }
  function setFontFamily(v: string) {
    setFontFamilySignal(v)
    localStorage.setItem(FONT_FAMILY_KEY, v)
    applyFont(v, fontSize())
  }
  function setFontSize(v: number) {
    setFontSizeSignal(v)
    localStorage.setItem(FONT_SIZE_KEY, String(v))
    applyFont(fontFamily(), v)
  }

  // ─── Grouped sessions memo ─────────────────────────────────────────────────
  // 是否显示归档
  const [showArchived, setShowArchived] = createSignal(false)

  const groupedSessions = createMemo(() => {
    const groups: Array<{ workspace: Workspace | null; workspacePath: string; sessions: SessionSummary[] }> = []
    const groupMap = new Map<string, SessionSummary[]>()

    const currentUiMode = globalMode()
    const q = sessionSearch().trim().toLowerCase()
    const filteredSessions = sessions().filter(s => {
      if ((s.uiMode ?? 'code') !== currentUiMode) return false
      if (!showArchived() && s.archived) return false   // 默认不显示归档
      if (showArchived() && !s.archived) return false   // 归档视图只显示归档
      if (!q) return true
      return (s.title ?? '').toLowerCase().includes(q)
    })

    for (const s of filteredSessions) {
      const path = s.workspacePath ?? ""
      if (!groupMap.has(path)) groupMap.set(path, [])
      groupMap.get(path)!.push(s)
    }

    // Known workspaces first
    for (const ws of workspaces()) {
      const sList = groupMap.get(ws.path) ?? []
      groups.push({ workspace: ws, workspacePath: ws.path, sessions: sList })
      groupMap.delete(ws.path)
    }

    // Unknown workspace paths (orphaned sessions)
    groupMap.forEach((sList, path) => {
      if (sList.length > 0) {
        groups.push({ workspace: null, workspacePath: path, sessions: sList })
      }
    })

    return groups
  })

  // ─── 切换 globalMode 时自动切换会话 ───────────────────────────────────────
  createEffect(() => {
    const mode = globalMode()
    const current = sessions().find(s => s.id === activeSessionId())
    // 当前会话属于另一个模式，需要切换
    if (current && (current.uiMode ?? 'code') !== mode) {
      const matching = sessions().filter(s => (s.uiMode ?? 'code') === mode)
      if (matching.length > 0) {
        selectSession(matching[0].id)
      } else {
        setActiveSessionId(null)
        setMessages([])
        setSending(false)
      }
    }
  })

  // viewGroups 系统已迁移到 @maxian/ui SharedMessageList — 旧实现 80+ 行（tool 批次合并、
  // 包装缓存、虚拟化兜底等）整段下线。需要 tool 批次折叠等高级功能时按需补到 @maxian/ui。

  // ─── Login ────────────────────────────────────────────────────────────────
  async function handleLogin() {
    const apiUrl = loginApiUrl().trim()
    const username = loginUsername().trim()
    const password = loginPassword()
    if (!apiUrl || !username || !password) { setLoginError("请填写所有字段"); return }
    setLoginLoading(true); setLoginError("")
    try {
      const userInfo = await loginCheck(apiUrl, username, password)
      const creds: SavedCredentials = { apiUrl, username, password, userInfo, rememberMe: loginRemember() }
      if (loginRemember()) saveCredentials(creds)
      setCurrentUser(userInfo)
      await bootWithCredentials(creds)
    } catch (e: any) {
      // 暴露真实错误原因（而不是固定的"登录失败"fallback），便于用户自查
      const raw = e?.message ?? String(e ?? '')
      let msg = raw || "登录失败，请重试"
      // 识别常见 Tauri plugin-http 权限拒绝的错误特征
      if (/not allowed|scope|permission|http\.fetch/i.test(raw)) {
        msg = `服务器地址未被放行：${apiUrl}\n原始错误：${raw}`
      } else if (/network|fetch|failed to fetch|unable to connect|ENETUNREACH|ECONNREFUSED/i.test(raw)) {
        msg = `无法连接到 ${apiUrl}\n原始错误：${raw}`
      }
      setLoginError(msg)
      console.error('[login] failed:', e)
    } finally {
      setLoginLoading(false)
    }
  }

  async function bootWithCredentials(creds: SavedCredentials) {
    setAppStatus("booting"); setBootError("")
    try {
      await waitForServer()
      await configureServerAi(creds.apiUrl, creds.username, creds.password)
      await refreshWorkspaces()
      await refreshSessions()
      setAppStatus("ready")
      // 启动后静默检查更新（后台，不影响 UI）
      void checkForUpdatesSilent()
    } catch (e: any) {
      setBootError(String(e?.message || e))
      setAppStatus("error")
    }
  }

  /** 静默更新检查：有新版本时显示 toast 提示 */
  const [updateAvailable, setUpdateAvailable] = createSignal(false)
  const [updateVersion, setUpdateVersion] = createSignal("")

  async function checkForUpdatesSilent() {
    try {
      if (!(window as any).__TAURI_INTERNALS__) return
      const { check } = await import('@tauri-apps/plugin-updater' as any)
      const update = await check()
      if (update?.available) {
        setUpdateAvailable(true)
        setUpdateVersion(update.version ?? '')
      }
    } catch { /* 忽略更新检查错误 */ }
  }

  async function installUpdateFromToast() {
    setUpdateAvailable(false)
    try {
      const { check } = await import('@tauri-apps/plugin-updater' as any)
      const update = await check()
      if (update?.available) {
        await update.downloadAndInstall()
        const { relaunch } = await import('@tauri-apps/plugin-process' as any)
        await relaunch()
      }
    } catch (e) { alert("更新失败：" + (e as Error).message) }
  }

  async function handleLogout() {
    clearCredentials()
    try { await clearServerAi() } catch { /**/ }
    unsubscribe?.(); unsubscribe = null
    setCurrentUser(null); setActiveSessionId(null)
    setMessages([]); setSessions([]); setWorkspaces([])
    setLoginPassword(""); setLoginError("")
    setShowSettings(false); setUserExpanded(false)
    setAppStatus("login")
  }

  // ─── Workspaces ───────────────────────────────────────────────────────────
  async function refreshWorkspaces() {
    const c = await getClient()
    const r = await c.listWorkspaces()
    setWorkspaces(r.workspaces)
    if (!activeWorkspace() && r.workspaces.length > 0) setActiveWorkspace(r.workspaces[0])
  }

  async function pickFolder() {
    try {
      const dialog = await import("@tauri-apps/plugin-dialog")
      const path = await dialog.open({ directory: true, multiple: false })
      if (!path || typeof path !== "string") return
      const c = await getClient()
      const ws = await c.addWorkspace(path)
      await refreshWorkspaces()
      setActiveWorkspace(ws)
    } catch (e) { alert("添加工作区失败：" + (e as Error).message) }
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────
  async function refreshSessions() {
    const c = await getClient()
    const r = await c.listSessions()
    setSessions(r.sessions.sort((a, b) => b.updatedAt - a.updatedAt))
  }

  async function createSession() {
    const c = await getClient()

    // Chat 模式：无需关联工作区，直接创建
    if (globalMode() === 'chat') {
      const s = await c.createSession({
        title: `对话 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
        workspacePath: '',
        mode: 'ask',
        uiMode: 'chat',
      })
      await refreshSessions()
      await selectSession(s.id)
      return
    }

    // Code 模式：需要工作区
    let ws = activeWorkspace()
    if (!ws) {
      const all = workspaces()
      if (all.length === 0) { alert("请先点击右上角文件夹图标添加工作区"); return }
      ws = all[0]
      setActiveWorkspace(ws)
    }
    const s = await c.createSession({
      title: `会话 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      workspacePath: ws.path,
      mode: composerMode(),
      uiMode: 'code',
    })
    await refreshSessions()
    await selectSession(s.id)
  }

  async function selectSession(id: string) {
    // 任意"显式选会话"都意味着用户的最新意图覆盖了"看日志临时跳转"的回退目标。
    // 看日志 handler 会在 selectSession 完成 *之后* 重新写入 _jumpReturnSessionId，从而保住跳前的会话。
    _setJumpReturnSessionId(null)
    // ── 保存当前会话的终端状态快照 ──
    const outgoingId = activeSessionId()
    if (outgoingId) {
      sessionTerminalSnapshots.set(outgoingId, {
        show: showTerminal(),
        collapsed: terminalCollapsed(),
        height: terminalHeight(),
        activeTermId: activeTermId(),
        // tabs 不保存：tab 通过 sessionId 字段永久留在 terminalTabs 中
      })
    }

    // 切会话前先把当前会话的 todos 快照存起来；
    // 切到目标会话后从快照恢复（让任务清单跟随会话切换不丢）
    const prevSid = activeSessionId()
    if (prevSid) {
      _sessionTodosSnapshot.set(prevSid, { todos: todos(), leftover: todosLeftover() })
    }
    setActiveSessionId(id); setMessages([])
    setChangedFiles(new Map())
    setTokenUsed(0)
    setApprovalRequest(null)
    setSending(false)   // 切换会话时重置发送状态，防止 '等待响应…' 残留
    _resetRecv()
    setMsgHasMore(false)
    setMsgOldestTs(undefined)
    const snapTodo = _sessionTodosSnapshot.get(id)
    setTodos(snapTodo?.todos ?? [])
    setTodosLeftover(snapTodo?.leftover ?? false)
    setFollowupSuggestions([])
    setFollowupQueue([])
    setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
    setFocusedMsgIdx(-1)
    setQuestionRequest(null)
    setPlanExitRequest(null)
    setCompactingState(null)
    unsubscribe?.()

    // ── 恢复目标会话的终端状态 ──
    // terminalTabs 不清空也不恢复 —— 所有 tab 的 DOM 容器始终存在，
    // TerminalPanel 通过 sessionId 过滤来显示当前会话的 tab。
    const snap = sessionTerminalSnapshots.get(id)
    if (snap) {
      setShowTerminal(snap.show)
      setTerminalCollapsed(snap.collapsed)
      setTerminalHeight(snap.height)
      setActiveTermId(snap.activeTermId)
    } else {
      // 新会话默认不显示终端面板
      setShowTerminal(false)
      // activeTermId 不重置：新会话切换时找不到 sessionId 匹配的 tab 即可
    }

    // 同步 activeWorkspace 到会话所属工作区，确保 @ 文件提及显示正确项目文件
    const sess = sessions().find(s => s.id === id)
    if (sess?.workspacePath) {
      const matchWs = workspaces().find(w => w.path === sess.workspacePath)
      if (matchWs) setActiveWorkspace(matchWs)
    }
    // 若该会话在后台仍在运行，显示"生成中"状态（subscribeEvents 下文会重新连接）
    if (sess?.status === 'running') {
      setSending(true)
      _bumpRecv(1)  // 让接收指示器亮起
    }
    const c = await getClient()

    // 加载该会话历史的文件变更列表（从 file_snapshots 表）
    // 后端 v0.2.12+ 在 details 里返回真实 action（K4），旧版本仅 files 列表则统一按 'modified' fallback
    // 用 currentSessionId 校验防止快速切换会话的竞态
    void (async () => {
      try {
        const r = await c.getChangedFiles(id)
        if (activeSessionId() !== id) return  // 用户已切走，丢弃过期结果
        const items: Array<{ path: string; action: 'created' | 'modified' | 'deleted' }> =
          Array.isArray(r.details) && r.details.length > 0
            ? r.details
            : (Array.isArray(r.files) ? r.files.map(p => ({ path: p, action: 'modified' as const })) : [])
        if (items.length > 0) {
          setChangedFiles(prev => {
            const next = new Map(prev)
            for (const it of items) {
              if (!next.has(it.path)) next.set(it.path, { path: it.path, action: it.action })
            }
            return next
          })
        }
      } catch (e) {
        console.warn('[maxian] failed to load changed-files for session', id, e)
      }
    })()

    // Load persisted messages from server（最近 50 条，滚到底部）
    try {
      const { messages: stored, hasMore } = await c.getSessionMessages(id, { limit: 50 })
      if (stored.length > 0) {
        setMessages(stored.map(storedToChatMessage))
        setMsgHasMore(hasMore)
        setMsgOldestTs(stored[0].createdAt)
      }
      // 切换会话：视为"刚进来想看最新"，重置贴底状态 + 直接滚底（不走 maybe）
      stickToBottom = true
      requestAnimationFrame(() => chatEndRef?.scrollIntoView({ behavior: "instant" }))
    } catch (e) {
      console.warn("[maxian] failed to load session messages:", e)
    }

    unsubscribe = c.subscribeEvents(id, handleEvent, (err) => console.error("[SSE]", err))
    setShowSettings(false)
    setUserExpanded(false)
  }

  // 向上滚动时加载更早的消息
  async function loadMoreMessages() {
    const sid = activeSessionId()
    const oldestTs = msgOldestTs()
    if (!sid || !msgHasMore() || msgLoadingMore() || oldestTs === undefined) return
    setMsgLoadingMore(true)
    try {
      const c = await getClient()
      const { messages: older, hasMore } = await c.getSessionMessages(sid, { limit: 50, before: oldestTs })
      if (older.length > 0) {
        // 记录当前滚动高度，加载后维持滚动位置
        const el = chatTimelineRef
        const prevScrollHeight = el?.scrollHeight ?? 0
        setMessages(prev => [
          ...older.map(storedToChatMessage),
          ...prev,
        ])
        setMsgOldestTs(older[0].createdAt)
        setMsgHasMore(hasMore)
        // 保持视口位置（新消息插入顶部后不跳动）
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevScrollHeight
        })
      } else {
        setMsgHasMore(false)
      }
    } catch (e) {
      console.warn("[maxian] loadMoreMessages failed:", e)
    } finally {
      setMsgLoadingMore(false)
    }
  }

  async function deleteSession(e: MouseEvent, id: string) {
    e.stopPropagation()
    if (!await appConfirm("确定要删除这个会话？")) return
    const c = await getClient()
    await c.deleteSession(id)
    if (activeSessionId() === id) {
      setActiveSessionId(null); unsubscribe?.(); unsubscribe = null; setMessages([])
    }
    await refreshSessions()
  }

  async function togglePinSession(id: string, pinned: boolean) {
    try {
      const c = await getClient()
      await c.setSessionPinned(id, pinned)
      await refreshSessions()
    } catch (e) {
      showToast({ message: '置顶失败：' + (e as Error).message, kind: 'error' })
    }
  }

  async function toggleArchiveSession(id: string, archived: boolean) {
    try {
      const c = await getClient()
      await c.setSessionArchived(id, archived)
      if (archived && activeSessionId() === id) {
        // 若归档了当前会话则关闭
        setActiveSessionId(null); unsubscribe?.(); unsubscribe = null; setMessages([])
      }
      await refreshSessions()
      showToast({ message: archived ? '已归档' : '已取消归档', kind: 'success', duration: 2000 })
    } catch (e) {
      showToast({ message: '操作失败：' + (e as Error).message, kind: 'error' })
    }
  }

  // ── 消息操作（删除 / 编辑 / 重生成 / fork-from-here）────────────────────
  async function deleteMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    if (!await appConfirm('删除这条消息？')) return
    try {
      const c = await getClient()
      await c.deleteMessage(sid, msgId)
      setMessages(prev => prev.filter(m => m.id !== msgId))
      showToast({ message: '已删除', kind: 'success', duration: 1500 })
    } catch (e) {
      showToast({ message: '删除失败：' + (e as Error).message, kind: 'error' })
    }
  }

  const [editingMessageId, setEditingMessageId] = createSignal<string | null>(null)
  const [editingMessageContent, setEditingMessageContent] = createSignal('')
  async function commitEditMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    const newContent = editingMessageContent()
    setEditingMessageId(null)
    try {
      const c = await getClient()
      const r = await c.editUserMessage(sid, msgId, newContent)
      if (!r.ok) throw new Error(r.error ?? '编辑失败')
      // 重新加载 + 自动用新内容重跑一次 AI
      const data = await c.getSessionMessages(sid, { limit: 50 })
      setMessages(data.messages.map(storedToChatMessage))
      // 发送一条空触发以让 agent 继续（实际上后端会用新的 history）
      setInput('')
      setSending(true)
      unsubscribe?.()
      unsubscribe = c.subscribeEvents(sid, handleEvent, (err) => console.error("[SSE]", err))
      await c.sendMessage(sid, { content: newContent })
    } catch (e) {
      showToast({ message: '编辑失败：' + (e as Error).message, kind: 'error' })
      setSending(false)
    }
  }

  async function regenerateMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    try {
      const c = await getClient()
      const r = await c.regenerateFromMessage(sid, msgId)
      if (!r.ok || !r.promptUserId) throw new Error('无法定位触发用户消息')
      // 重新加载 messages
      const data = await c.getSessionMessages(sid, { limit: 50 })
      setMessages(data.messages.map(storedToChatMessage))
      // 取保留的最后一条 user 消息内容再发一次
      const promptMsg = data.messages.find(m => m.id === r.promptUserId)
      if (!promptMsg) throw new Error('找不到触发消息')
      setSending(true)
      unsubscribe?.()
      unsubscribe = c.subscribeEvents(sid, handleEvent, (err) => console.error("[SSE]", err))
      await c.sendMessage(sid, { content: promptMsg.content })
    } catch (e) {
      showToast({ message: '重生成失败：' + (e as Error).message, kind: 'error' })
      setSending(false)
    }
  }

  async function forkFromMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    try {
      const c = await getClient()
      const r = await c.forkFromMessage(sid, msgId)
      if (!r.ok || !r.newSessionId) throw new Error('Fork 失败')
      await refreshSessions()
      await selectSession(r.newSessionId)
      showToast({ message: '已分叉到新会话', kind: 'success' })
    } catch (e) {
      showToast({ message: 'Fork 失败：' + (e as Error).message, kind: 'error' })
    }
  }

  async function deleteWorkspace(e: MouseEvent, ws: Workspace) {
    e.stopPropagation()
    if (!await appConfirm(`确定要移除项目「${ws.name}」？\n（仅移除项目记录，不会删除磁盘文件）`)) return
    const c = await getClient()
    await c.removeWorkspace(ws.id)
    if (activeWorkspace()?.id === ws.id) setActiveWorkspace(null)
    await refreshWorkspaces()
    await refreshSessions()
  }

  // ─── Rename ────────────────────────────────────────────────────────────────
  function startRenameWorkspace(e: MouseEvent, ws: Workspace) {
    e.stopPropagation()
    setEditingWorkspaceId(ws.id)
    setEditingWorkspaceName(ws.name)
  }
  async function commitRenameWorkspace(id: string) {
    const name = editingWorkspaceName().trim()
    setEditingWorkspaceId(null)
    if (!name) return
    try {
      const c = await getClient()
      await c.renameWorkspace(id, name)
      await refreshWorkspaces()
    } catch (e) { alert("重命名失败：" + (e as Error).message) }
  }
  function cancelRenameWorkspace() { setEditingWorkspaceId(null) }

  function startRenameSession(e: MouseEvent, s: SessionSummary) {
    e.stopPropagation()
    setEditingSessionId(s.id)
    setEditingSessionTitle(s.title)
  }
  async function commitRenameSession(id: string) {
    const title = editingSessionTitle().trim()
    setEditingSessionId(null)
    if (!title) return
    try {
      const c = await getClient()
      await c.renameSession(id, title)
      await refreshSessions()
    } catch (e) { alert("重命名失败：" + (e as Error).message) }
  }
  function cancelRenameSession() { setEditingSessionId(null) }

  // Create session in a specific workspace
  async function createSessionInWorkspace(e: MouseEvent, ws: Workspace) {
    e.stopPropagation()
    setActiveWorkspace(ws)
    const c = await getClient()
    const s = await c.createSession({
      title: `会话 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      workspacePath: ws.path,
      mode: globalMode() === 'chat' ? 'ask' : composerMode(),
      uiMode: globalMode(),
    })
    await refreshSessions()
    await selectSession(s.id)
  }

  // ─── SSE ──────────────────────────────────────────────────────────────────
  // K11b: handleEvent (465 行 SSE 事件分发) 已抽到 ./hooks/useChatEventHandler。
  // 内部封装 _abortedAt（取消时间戳）和事件分发逻辑；通过 deps 注入所有需要的 setter / helper。
  const _chatEventHandler = createChatEventHandler({
    setMessages: (updater) => setMessages(updater),
    setSending,
    bumpRecv: _bumpRecv,
    setChangedFiles: (updater) => setChangedFiles(updater),
    setTokenUsed,
    tokenLimit,
    setTokenLimit,
    todos,
    setTodos: (list) => setTodos(list),
    setTodosLeftover,
    setFollowupSuggestions: (list) => setFollowupSuggestions(list),
    setRateLimit: (state) => setRateLimit(state),
    setQuestionRequest: (req) => setQuestionRequest(req),
    setQuestionAnswer,
    setQuestionSelected: (list) => setQuestionSelected(list),
    setPlanExitRequest: (req) => setPlanExitRequest(req),
    setPlanExitFeedback,
    compactingState,
    setCompactingState: (s) => setCompactingState(s),
    setApprovalRequest: (req) => setApprovalRequest(req),
    isAutoApproved,
    getClient: () => getClient() as any,
    showToast,
    pushError,
    refreshSessions: () => refreshSessions(),
    maybeScrollToBottom,
    nextMsgId: () => String(++msgId),
  })
  const handleEvent = _chatEventHandler.handle


  // ─── Send ──────────────────────────────────────────────────────────────────
  async function send() {
    const sid = activeSessionId(); const content = input().trim()
    if (!sid || !content || sending()) return
    setSending(true)
    _resetRecv()  // 重置接收计数器 + 直接清空 DOM
    _chatEventHandler.resetAbortedAt()  // 新任务开始，清掉上次取消的丢弃窗口
    const imgs = attachedImages()
    const displayContent = imgs.length > 0
      ? `${content}\n\n[附图 ${imgs.length} 张]`
      : content
    setMessages((prev) => [...prev, { id: String(++msgId), role: "user", content: displayContent, createdAt: Date.now() }])
    // 用户主动发消息 → 视为"想看响应"，重置贴底状态让后续 auto-scroll 生效
    stickToBottom = true
    requestAnimationFrame(() => chatEndRef?.scrollIntoView({ behavior: 'instant' }))
    pushPromptHistory(content)
    setInput("")
    setAttachedImages([])
    try {
      const c = await getClient()
      // 每次发送前重新建立 SSE 连接，避免 WKWebView 长时间运行后 XHR onprogress 停止触发
      unsubscribe?.()
      unsubscribe = c.subscribeEvents(sid, handleEvent, (err) => console.error("[SSE reconnect]", err))
      // 发送消息，附带 base64 图片（只取 base64 部分，去掉 data:...;base64, 前缀）
      const images = imgs.map(img => img.dataUrl.split(',')[1]).filter(Boolean)
      await c.sendMessage(sid, { content, images: images.length > 0 ? images : undefined })
      await refreshSessions()
    } catch (e) {
      setMessages((prev) => [...prev, { id: String(++msgId), role: "error", content: "发送失败：" + (e as Error).message, createdAt: Date.now() }])
      setSending(false)
    }
  }

  async function cancel() {
    const sid = activeSessionId(); if (!sid) return
    const c = await getClient(); await c.cancelTask(sid); setSending(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    // Vim 模式拦截（enabled 时）
    if (vimEnabled() && textareaRef) {
      if (handleVimKey(e, textareaRef)) return
    }

    // @ 提及导航
    if (showMention() && mentionFiles().length > 0) {
      if (e.key === "Escape") { e.preventDefault(); setShowMention(false); return }
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx(i => Math.min(i + 1, mentionFiles().length - 1)); return }
      if (e.key === "ArrowUp")   { e.preventDefault(); setMentionIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const f = mentionFiles()[mentionIdx()]
        if (f) { insertMention(f); return }
      }
    }
    // Slash 命令面板导航
    if (showSlash()) {
      if (e.key === "Escape") { e.preventDefault(); setShowSlash(false); return }
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx(i => Math.min(i + 1, filteredSlash().length - 1)); return }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSlashIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const cmd = filteredSlash()[slashIdx()]
        if (cmd) { execSlashCommand(cmd.name); return }
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
    if (e.key === "Escape" && sending()) { e.preventDefault(); void cancel() }

    // Prompt 历史：光标位于首行且 textarea 为空或未修改时，↑/↓ 翻历史
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const ta = textareaRef
      if (!ta) return
      const atFirstLine = ta.selectionStart === 0 || !ta.value.slice(0, ta.selectionStart).includes('\n')
      const atLastLine  = ta.selectionEnd >= ta.value.length || !ta.value.slice(ta.selectionEnd).includes('\n')
      const hist = promptHistory()
      if (hist.length === 0) return

      if (e.key === "ArrowUp" && atFirstLine) {
        e.preventDefault()
        if (historyIdx() === -1) {
          // 保存当前草稿
          setHistoryDraft(input())
          setHistoryIdx(hist.length - 1)
          setInput(hist[hist.length - 1])
        } else if (historyIdx() > 0) {
          const next = historyIdx() - 1
          setHistoryIdx(next)
          setInput(hist[next])
        }
      } else if (e.key === "ArrowDown" && atLastLine) {
        if (historyIdx() === -1) return
        e.preventDefault()
        const next = historyIdx() + 1
        if (next >= hist.length) {
          setHistoryIdx(-1)
          setInput(historyDraft())
        } else {
          setHistoryIdx(next)
          setInput(hist[next])
        }
      }
    }
  }

  // 全局快捷键（支持用户自定义绑定）
  function onGlobalKeyDown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey

    // 先匹配自定义绑定（如果命中则短路掉默认逻辑）
    if (meta) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const inInput = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
      const bindings: Array<[KeybindAction, () => void]> = [
        ['new-session',   () => { if (!inInput) { e.preventDefault(); void createSession() } }],
        ['close-session', () => {
          if (!inInput) {
            e.preventDefault()
            const sid = activeSessionId()
            if (sid) void deleteSession({ stopPropagation: () => {} } as any, sid)
          }
        }],
        ['prev-session',  () => {
          e.preventDefault()
          const list = sessions(); const cur = activeSessionId()
          const idx = list.findIndex(s => s.id === cur)
          if (idx > 0) void selectSession(list[idx - 1].id)
        }],
        ['next-session',  () => {
          e.preventDefault()
          const list = sessions(); const cur = activeSessionId()
          const idx = list.findIndex(s => s.id === cur)
          if (idx >= 0 && idx < list.length - 1) void selectSession(list[idx + 1].id)
        }],
        ['slash-cmd',     () => {
          e.preventDefault()
          textareaRef?.focus()
          if (!input().startsWith('/')) {
            setInput('/'); setShowSlash(true); setSlashQuery(''); setSlashIdx(0)
          }
        }],
        ['cmd-palette',   () => {
          e.preventDefault()
          setShowCmdPalette(true); setCmdPaletteQuery(''); setCmdPaletteIdx(0)
          void refreshCmdPalette('')
        }],
        ['terminal',      () => {
          e.preventDefault()
          if (!showTerminal()) void addTerminalTab()
          else setShowTerminal(v => !v)
        }],
        ['settings',      () => { e.preventDefault(); setShowSettings(v => !v) }],
        ['help',          () => { e.preventDefault(); setShowKeybindHelp(v => !v) }],
      ]
      for (const [action, fn] of bindings) {
        if (matchKeybind(e, getKeybind(action))) { fn(); return }
      }
    }

    // 消息间键盘导航 (j/k or ↑/↓)：滚到对应消息（不在输入框内 + 无 meta）
    if (!meta) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const inInput = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
      if (!inInput && (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const list = messages()
        if (list.length === 0) return
        e.preventDefault()
        const dir = (e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1
        const cur = focusedMsgIdx() === -1 ? (dir > 0 ? -1 : list.length) : focusedMsgIdx()
        const next = Math.max(0, Math.min(list.length - 1, cur + dir))
        setFocusedMsgIdx(next)
        const targetId = list[next]?.id
        if (targetId) {
          queueMicrotask(() => {
            const el = document.querySelector(`[data-msg-id="${targetId}"]`) as HTMLElement | null
            el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          })
        }
        return
      }
    }
    if (!meta) return

    // Cmd+N — 新建会话（文本框外）
    if (e.key === "n") {
      const tagName = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tagName !== "input" && tagName !== "textarea") {
        e.preventDefault()
        void createSession()
      }
    }

    // Cmd+W — 关闭当前会话（文本框外）
    if (e.key === "w") {
      const tagName = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tagName !== "input" && tagName !== "textarea") {
        e.preventDefault()
        const sid = activeSessionId()
        if (sid) {
          // deleteSession 需要一个 MouseEvent，构造一个合成事件
          const syntheticEvent = { stopPropagation: () => {} } as MouseEvent
          void deleteSession(syntheticEvent, sid)
        }
      }
    }

    // Cmd+[ — 上一个会话
    if (e.key === "[") {
      e.preventDefault()
      const list = sessions()
      const cur  = activeSessionId()
      const idx  = list.findIndex(s => s.id === cur)
      if (idx > 0) void selectSession(list[idx - 1].id)
    }

    // Cmd+] — 下一个会话
    if (e.key === "]") {
      e.preventDefault()
      const list = sessions()
      const cur  = activeSessionId()
      const idx  = list.findIndex(s => s.id === cur)
      if (idx >= 0 && idx < list.length - 1) void selectSession(list[idx + 1].id)
    }

    // Cmd+K — Slash 命令面板（聚焦输入框 + 插入 /）
    if (e.key === "k") {
      e.preventDefault()
      textareaRef?.focus()
      if (!input().startsWith('/')) {
        setInput('/')
        setShowSlash(true)
        setSlashQuery('')
        setSlashIdx(0)
      }
    }

    // Cmd+` — 切换终端
    if (e.key === "`") {
      e.preventDefault()
      if (!showTerminal()) {
        void addTerminalTab()
      } else {
        setShowTerminal(v => !v)
      }
    }

    // Cmd+, — 打开设置
    if (e.key === ",") {
      e.preventDefault()
      setShowSettings(v => !v)
    }

    // Cmd+/ 或 Cmd+? — 快捷键速查
    if (e.key === "/" || e.key === "?") {
      e.preventDefault()
      setShowKeybindHelp(v => !v)
    }

    // Cmd+P — 全局命令面板
    if (e.key === "p") {
      e.preventDefault()
      setShowCmdPalette(true)
      setCmdPaletteQuery('')
      setCmdPaletteIdx(0)
      void refreshCmdPalette('')
    }

    // Cmd+F — 会话内搜索（P0-3）：仅当有活动会话时生效
    if (e.key === "f" && activeSessionId()) {
      e.preventDefault()
      if (showInChatSearch()) {
        // 已打开：聚焦输入框
        setTimeout(() => { inChatSearchInputRef?.focus(); inChatSearchInputRef?.select() }, 0)
      } else {
        openInChatSearch()
      }
    }
  }

  // 刷新命令面板条目（本地会话 + 斜杠命令 + 远程文件符号搜索）
  async function refreshCmdPalette(query: string) {
    const q = query.trim().toLowerCase()
    const items: PaletteItem[] = []

    // 1. 会话（未归档）
    const sessions_all = sessions().filter(s => !s.archived).slice(0, 50)
    for (const s of sessions_all) {
      if (!q || (s.title ?? '').toLowerCase().includes(q)) {
        items.push({
          type: 'session',
          label: s.title || s.id.slice(0, 8),
          desc: `会话 · ${s.uiMode ?? 'code'}`,
          onSelect: async () => {
            setShowCmdPalette(false)
            await selectSession(s.id)
          },
        })
      }
    }

    // 2. 斜杠命令
    for (const cmd of SLASH_COMMANDS) {
      if (!q || cmd.name.includes(q) || cmd.label.toLowerCase().includes(q)) {
        items.push({
          type: 'command',
          label: `/${cmd.name} ${cmd.icon}`,
          desc: cmd.desc,
          onSelect: async () => {
            setShowCmdPalette(false)
            await execSlashCommand(cmd.name)
          },
        })
      }
    }

    // 3. 远程搜索：文件 + 符号（只在有查询时调）
    if (q.length >= 2) {
      const ws = activeWorkspace()
      if (ws) {
        setCmdPaletteLoading(true)
        try {
          const c = await getClient()
          const r = await c.searchSymbols(ws.id, query)
          for (const f of r.files.slice(0, 20)) {
            items.push({
              type: 'file',
              label: f.split('/').pop() ?? f,
              desc: `文件 · ${f}`,
              onSelect: () => {
                setShowCmdPalette(false)
                void openPreview(f)
              },
            })
          }
          for (const sym of r.symbols.slice(0, 20)) {
            const loc = (sym as any).location?.uri ?? (sym as any).location?.targetUri ?? ''
            items.push({
              type: 'symbol',
              label: (sym as any).name ?? '?',
              desc: `符号 · ${(sym as any).containerName ?? ''} · ${loc.replace('file://', '')}`,
              onSelect: () => {
                setShowCmdPalette(false)
                if (loc) void openPreview(loc.replace('file://', ''))
              },
            })
          }
        } catch { /* ignore */ }
        finally { setCmdPaletteLoading(false) }
      }
    }

    setCmdPaletteItems(items)
    setCmdPaletteIdx(0)
  }

  // 防抖 palette 搜索
  let cmdPaletteDebounce: number | undefined
  createEffect(() => {
    const q = cmdPaletteQuery()
    if (!showCmdPalette()) return
    if (cmdPaletteDebounce) clearTimeout(cmdPaletteDebounce)
    cmdPaletteDebounce = setTimeout(() => { void refreshCmdPalette(q) }, 150) as unknown as number
  })

  // Esc 关闭快捷键帮助（非 meta）
  createEffect(() => {
    if (!showKeybindHelp()) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setShowKeybindHelp(false) }
    }
    document.addEventListener('keydown', onEsc)
    onCleanup(() => document.removeEventListener('keydown', onEsc))
  })

  onMount(() => {
    document.addEventListener("keydown", onGlobalKeyDown)
    // 点击外部关闭下拉
    document.addEventListener("click", (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.mode-selector-wrap')) setShowModeDropdown(false)
      if (!t.closest('.git-status-branch-btn') && !t.closest('.branch-picker-popup')) setShowBranchPicker(false)
      if (!t.closest('.filter-menu') && !(t.closest('button')?.getAttribute('title') === '消息过滤')) setShowFilterMenu(false)
      // 点击 slash/mention 面板外部时关闭（textarea 内输入不关闭）
      if (!t.closest('.slash-palette') && !t.closest('textarea')) {
        setShowSlash(false)
        setShowMention(false)
      }
    })
    onCleanup(() => document.removeEventListener("keydown", onGlobalKeyDown))
  })

  // ─── 工作区切换时获取当前 git 分支 ────────────────────────────────────────
  createEffect(() => {
    const ws = activeWorkspace()
    if (!ws) { setCurrentBranch(null); setBranchPickerBranches([]); return }
    void (async () => {
      try {
        const c = await getClient()
        const r = await c.getCurrentBranch(ws.id)
        setCurrentBranch(r.branch ?? null)
        if (r.isGitRepo) {
          const br = await c.listBranches(ws.id)
          setBranchPickerBranches(br.branches ?? [])
        } else {
          setBranchPickerBranches([])
        }
      } catch {
        setCurrentBranch(null)
      }
    })()
  })

  // ─── @ 提及文件 ───────────────────────────────────────────────────────────
  const [showMention, setShowMention] = createSignal(false)
  const [mentionQuery, setMentionQuery] = createSignal("")
  const [mentionFiles, setMentionFiles] = createSignal<string[]>([])
  const [mentionIdx, setMentionIdx] = createSignal(0)
  // 全量文件缓存（按工作区 ID 分组，切换工作区时重新加载）
  const [wsFileCache, setWsFileCache] = createSignal<{ id: string; files: string[] } | null>(null)
  const [wsFileCacheLoading, setWsFileCacheLoading] = createSignal(false)

  /** 工作区变化时预加载全量文件缓存 */
  createEffect(() => {
    const ws = activeWorkspace()
    if (!ws) { setWsFileCache(null); return }
    const cached = wsFileCache()
    if (cached?.id === ws.id) return        // 已是最新缓存，无需重新加载
    setWsFileCacheLoading(true)
    void (async () => {
      try {
        const c = await getClient()
        const res = await c.listFiles(ws.id)
        setWsFileCache({ id: ws.id, files: res.files ?? [] })
      } catch {
        setWsFileCache({ id: ws.id, files: [] })
      } finally {
        setWsFileCacheLoading(false)
      }
    })()
  })

  /**
   * 本地模糊搜索：优先文件名完全包含 query，其次路径包含。
   * 按相关度排序后取前 15 条。
   */
  function filterMentionFiles(query: string): string[] {
    const cache = wsFileCache()
    if (!cache) return []
    const all = cache.files
    if (!query) {
      // 无查询：按路径深度从浅到深返回前 15 条（优先展示根目录文件）
      return [...all].sort((a, b) => {
        const depthA = a.split('/').length
        const depthB = b.split('/').length
        return depthA !== depthB ? depthA - depthB : a.localeCompare(b)
      }).slice(0, 15)
    }
    const q = query.toLowerCase()
    const scored = all
      .map(f => {
        const basename = f.split('/').pop()!.toLowerCase()
        const full = f.toLowerCase()
        let score = 0
        if (basename === q) score = 100
        else if (basename.startsWith(q)) score = 80
        else if (basename.includes(q)) score = 60
        else if (full.includes(q)) score = 30
        else return null
        return { f, score }
      })
      .filter(Boolean) as { f: string; score: number }[]

    scored.sort((a, b) => b.score - a.score || a.f.localeCompare(b.f))
    return scored.slice(0, 15).map(x => x.f)
  }

  function searchMentionFiles(query: string) {
    setMentionFiles(filterMentionFiles(query))
  }

  function insertMention(filePath: string) {
    const cur = input()
    // 找到最后一个 @ 的位置并替换到此处
    const atIdx = cur.lastIndexOf('@')
    const before = cur.slice(0, atIdx)
    const newVal = `${before}@${filePath} `
    setInput(newVal)
    setShowMention(false)
    setMentionFiles([])
    // 聚焦输入框
    textareaRef?.focus()
  }

  // ─── 计算并缓存 composer-wrap 位置（供 fixed 定位面板使用） ───────────────
  function updatePalettePos() {
    if (!composerWrapRef) return
    const rect = composerWrapRef.getBoundingClientRect()
    setPaletteRect({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left,
      width: rect.width,
    })
  }

  // ─── 输入框变化（检测 /slash 和 @mention） ───────────────────────────────
  function onInputChange(value: string) {
    setInput(value)
    // Slash 命令检测
    if (value.startsWith("/") && !value.includes(" ")) {
      updatePalettePos()
      const query = value.slice(1)
      setSlashQuery(query)
      setSlashIdx(0)
      setShowSlash(true)
      setShowMention(false)
      return
    }
    setShowSlash(false)

    // @ 文件提及检测
    const atIdx = value.lastIndexOf('@')
    if (atIdx >= 0 && !value.slice(atIdx).includes(' ')) {
      updatePalettePos()
      const query = value.slice(atIdx + 1)
      setMentionQuery(query)
      setMentionIdx(0)
      setShowMention(true)
      // 本地缓存过滤，无需防抖，即时响应
      searchMentionFiles(query)
    } else {
      setShowMention(false)
    }
  }

  // 过滤 slash 命令（内置 + 项目自定义）
  const filteredSlash = createMemo(() => {
    const q = slashQuery().toLowerCase()
    const customAsSlash = customCommands().map(c => ({
      name:  c.name,
      label: c.name,
      desc:  c.description || '（项目自定义命令）',
      icon:  '🎯',
      custom: true as const,
    }))
    const all: Array<typeof SLASH_COMMANDS[number] | { name: string; label: string; desc: string; icon: string; custom: true }> = [
      ...SLASH_COMMANDS, ...customAsSlash,
    ]
    if (!q) return all
    return all.filter(c => c.name.includes(q) || c.label.includes(q))
  })

  // 执行 slash 命令
  async function execSlashCommand(name: string) {
    setShowSlash(false)
    setInput("")
    // 先尝试项目自定义命令
    const custom = customCommands().find(c => c.name === name)
    if (custom) {
      // 简单模板应用：$ARGUMENTS 用当前输入（已清空）
      const applied = custom.template
        .replace(/\$ARGUMENTS\b/g, '')
        .replace(/\$FILE\b/g, '')
        .replace(/\$SELECTION\b/g, '')
      setInput(applied.trim())
      showToast({ message: `已加载模板「${name}」，编辑后按 ⌘↵ 发送`, kind: 'info', duration: 3000 })
      textareaRef?.focus()
      return
    }
    switch (name) {
      case "clear":
        setMessages([])
        setChangedFiles(new Map())
        break
      case "new":
        await createSession()
        break
      case "compact": {
        const sid = activeSessionId()
        if (!sid) { showToast({ message: '请先选择会话', kind: 'warn' }); break }
        // 结果通过 SSE context_compacting / context_compacted 事件展示
        try {
          const c = await getClient()
          await c.compactSession(sid)
        } catch (e) {
          showToast({ message: '压缩失败：' + (e as Error).message, kind: 'error' })
          setCompactingState(null)
        }
        break
      }
      case "plan": {
        const sid = activeSessionId()
        const nextMode: ComposerMode = composerMode() === 'plan' ? 'code' : 'plan'
        setComposerMode(nextMode)
        if (sid) {
          try {
            const c = await getClient()
            await c.updateSessionMode(sid, nextMode)
          } catch { /* 忽略 */ }
        }
        setMessages(prev => [...prev, {
          id: String(++msgId), role: "system",
          createdAt: Date.now(),
          content: nextMode === 'plan'
            ? "📋 已进入计划模式：AI 只规划不执行文件操作，输入任务描述后 AI 将生成实现计划"
            : "⚡ 已退出计划模式，切换回 Code 模式"
        }])
        break
      }
      case "fork": {
        const sid = activeSessionId()
        if (!sid) break
        try {
          const c = await getClient()
          const res = await c.forkSession(sid)
          if (res.ok && res.session) {
            await refreshSessions()
            await selectSession(res.session.id)
          }
        } catch (e) { alert("分叉失败：" + (e as Error).message) }
        break
      }
      case "terminal":
        void addTerminalTab()
        break
      case "files":
        setShowFileTree(true)
        break
      case "export":
        await exportSession('markdown')
        break
      case "help":
        setMessages(prev => [...prev, {
          id: String(++msgId), role: "system",
          createdAt: Date.now(),
          content: SLASH_COMMANDS.map(c => `• **/${c.name}** — ${c.desc}`).join('\n')
        }])
        break
    }
  }

  // ─── 集成终端 ─────────────────────────────────────────────────────────────

  /** 判断当前是否处于深色模式（兼容 system 自动） */
  function resolveIsDark(): boolean {
    const t = theme()
    if (t === 'dark') return true
    if (t === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  /**
   * 根据明暗模式返回 xterm.js ITheme 配置。
   * 深色：经典暗底亮字；浅色：macOS Terminal 浅灰背景风格。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getXtermTheme(isDark: boolean): Record<string, string> {
    if (isDark) {
      return {
        background:          '#111111',
        foreground:          '#e5e5e5',
        cursor:              '#e5e5e5',
        cursorAccent:        '#111111',
        selectionBackground: 'rgba(255,255,255,0.18)',
        selectionForeground: '#e5e5e5',
        black:         '#262626',
        red:           '#f87171',
        green:         '#4ade80',
        yellow:        '#fbbf24',
        blue:          '#60a5fa',
        magenta:       '#c084fc',
        cyan:          '#22d3ee',
        white:         '#e5e5e5',
        brightBlack:   '#525252',
        brightRed:     '#fca5a5',
        brightGreen:   '#86efac',
        brightYellow:  '#fde68a',
        brightBlue:    '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan:    '#67e8f9',
        brightWhite:   '#f5f5f5',
      }
    } else {
      // 浅色主题：使用浅灰背景（#f2f2f2），接近 macOS Terminal 默认浅色。
      // 所有 ANSI 颜色都为深色系（除 ANSI black 外），确保在浅色背景上清晰可见。
      //
      // 关键 hack：**theme.black（ANSI color 0）== background**。
      //   - 大多数 prompt 主题（agnoster / Powerlevel10k / spaceship）会在段间隙
      //     emit `%K{black}`（即 `\e[40m` 把 bg 设成 ANSI 0）作为 powerline filler。
      //     原本设计预期是黑色终端，filler 段隐形与 bg 融合；浅色终端下就会露出突兀的黑条。
      //   - 把 ANSI 0 重映射到浅灰 bg 后，所有 `%K{black}` 段直接与 bg 融为一体，
      //     powerline 箭头在两个彩色段之间干净过渡，不再有黑条。
      //   - 副作用：`\e[30m`（ANSI 黑前景）也会变成 bg 色不可见。但实际 CLI 工具
      //     在浅色终端上用 ANSI 黑前景画文字本就罕见（git/ls/diff 用彩色），代价可接受。
      //   - 用户输入的文本走默认 foreground（#1c1c1e），不受影响。
      return {
        background:          '#f2f2f2',
        foreground:          '#1c1c1e',
        cursor:              '#1c1c1e',
        cursorAccent:        '#f2f2f2',
        selectionBackground: 'rgba(0,0,0,0.15)',
        selectionForeground: '#1c1c1e',
        // ANSI black 重映射到 bg —— 让 agnoster/p10k 的 %K{black} filler 与 bg 融合
        black:         '#f2f2f2',
        red:           '#c0392b',
        green:         '#27ae60',
        yellow:        '#c67c00',
        blue:          '#2980b9',
        magenta:       '#8e44ad',
        cyan:          '#16a085',
        white:         '#636366',
        brightBlack:   '#48484a',
        brightRed:     '#e74c3c',
        brightGreen:   '#2ecc71',
        brightYellow:  '#f39c12',
        brightBlue:    '#3498db',
        brightMagenta: '#9b59b6',
        brightCyan:    '#1abc9c',
        brightWhite:   '#3a3a3c',
      }
    }
  }

  /** 主题变化时同步外层 .terminal-body 背景色到 UI 主题
   *
   * 注意（xterm v6 已知问题）：
   *   不在运行时调 `term.options.theme = ...` 更新已开终端的颜色 —— v6 的 DOM renderer
   *   在动态切 theme 时会清掉 viewport 内容、并 dispose helper-textarea，导致终端
   *   "白屏 + 不接收输入"，没有公开的可靠 workaround。
   *
   *   折中策略：
   *   1) 已有的终端实例保留创建时的颜色不动（用户切主题不会破坏 session）。
   *   2) `--terminal-bg` CSS 变量同步 UI 主题，让外层 panel 背景与 UI 协调。
   *   3) 新建终端使用当前 UI 主题对应配色。
   *   4) 如想让所有终端跟着切，关闭旧 tab 重开即可。
   */
  createEffect(() => {
    const isDark = resolveIsDark()
    void theme()  // 订阅主题变化
    document.documentElement.style.setProperty(
      '--terminal-bg', isDark ? '#111111' : '#f2f2f2'
    )
  })

  /**
   * 终端面板显示/激活 tab 变化时，fit 活跃终端。
   * DOM 容器始终存在（全部 tab 都在 DOM 里，仅用 CSS display 切换），
   * 所以不需要重新 open，只需 fit 即可。
   */
  createEffect(() => {
    const show = showTerminal()
    const collapsed = terminalCollapsed()
    const activeTerm = activeTermId()
    if (!show || collapsed || !activeTerm) return
    // 用 rAF 等浏览器完成布局后再 fit（切换会话后从 display:none 恢复时特别重要）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const inst = termInstances.get(activeTerm)
        if (inst) {
          try { inst.fit.fit(); inst.term.focus() } catch { /* 忽略 */ }
        }
      })
    })
  })

  /**
   * 创建新终端 tab。
   *
   * 实现路径（v0.2.16）：Tauri Rust 侧（portable-pty）管 PTY，前端只负责 xterm.js 渲染。
   * 流程：
   *   1. 创建 xterm Terminal 实例（不挂 DOM，等 mountTerminalToDOM 异步挂）
   *   2. invoke('terminal_create') → Rust 侧 spawn shell + 开 reader 线程
   *   3. listen('terminal://data') 把 Rust 推过来的字节直接写进 xterm
   *   4. listen('terminal://exit') 显示退出码并清理
   *   5. xterm.onData → invoke('terminal_write') 把用户输入回传 PTY
   *
   * 旧实现（WebSocket /terminal）已废弃 —— Bun --compile sidecar 无法正确驱动 @lydell/node-pty。
   */
  async function addTerminalTab() {
    const { Terminal } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')
    const { invoke }   = await import('@tauri-apps/api/core')
    const { listen }   = await import('@tauri-apps/api/event')

    const tabId    = Math.random().toString(36).slice(2, 10)
    const tabTitle = `终端 ${terminalTabs().length + 1}`
    const cwd      = activeWorkspace()?.path ?? '/'

    const term = new Terminal({
      // 终端跟随 UI 主题（light/dark）切换。
      // 注意：用户若使用 agnoster / Powerlevel10k 等假设深色终端背景的 prompt 主题，
      // 在 light mode 下可能看到 prompt 内嵌的硬编码黑色 filler 段 —— 这是 prompt 主题
      // 设计选择，不是终端 bug。
      theme: getXtermTheme(resolveIsDark()),
      // 优先 Powerline / Nerd font（按用户机器实测顺序排列），fallback 到 Menlo。
      // Powerline / Nerd Font 能正确渲染 agnoster / Powerlevel10k 用的箭头与图标，
      // 否则会显示成方框 □。
      fontFamily: [
        '"Meslo LG M for Powerline"',     // 用户已装（macOS 常见 oh-my-zsh 默认推荐字体）
        '"MesloLGS NF"',                   // p10k 默认
        '"Hack Nerd Font Mono"',
        '"FiraCode Nerd Font Mono"',
        '"JetBrainsMono Nerd Font"',
        '"Menlo"',
        '"Monaco"',
        '"Courier New"',
        'monospace',
      ].join(', '),
      fontSize: 13,
      // lineHeight: agnoster 默认设计是 1.0；1.4 会把行拉太宽，破坏 powerline 段之间的连续色块。
      lineHeight: 1.0,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      // macOS 上 Option 键作 Meta（Bash readline / vim Esc 序列等）
      macOptionIsMeta: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    // 占位 instance — terminalId 等 Rust 创建后填入
    const inst: TerminalInstance = { term, fit, terminalId: '', unlistenFns: [] }
    termInstances.set(tabId, inst)

    const sessionId = activeSessionId() ?? '__global__'
    setTerminalTabs(prev => [...prev, { id: tabId, title: tabTitle, sessionId }])
    setActiveTermId(tabId)
    setShowTerminal(true)
    setTerminalCollapsed(false)

    // 异步挂 DOM（等 SolidJS 把 term-body-${tabId} 渲染出来）
    queueMicrotask(() => mountTerminalToDOM(tabId))

    // Rust 侧 spawn PTY
    let terminalId: string
    try {
      terminalId = await invoke<string>('terminal_create', {
        args: { cwd, cols: term.cols, rows: term.rows },
      })
    } catch (e) {
      term.write(`\r\n\x1b[31m[创建终端失败: ${(e as Error).message}]\x1b[0m\r\n`)
      console.error('[Terminal] terminal_create 失败:', e)
      return
    }
    inst.terminalId = terminalId
    console.log(`[Terminal] Rust PTY 已创建 (id=${terminalId})`)

    // 接 PTY → xterm 数据流
    const unlistenData = await listen<{ id: string; data: number[] }>('terminal://data', (event) => {
      if (event.payload.id !== terminalId) return
      // payload.data 是 number[] —— Tauri 的 serde 把 Vec<u8> 序列化成 JS 数组
      term.write(new Uint8Array(event.payload.data))
    })
    inst.unlistenFns.push(unlistenData)

    // 接 PTY 退出事件
    const unlistenExit = await listen<{ id: string; exitCode: number | null }>('terminal://exit', (event) => {
      if (event.payload.id !== terminalId) return
      const code = event.payload.exitCode ?? 0
      term.write(`\r\n\x1b[90m[进程已退出 (exitCode=${code})]\x1b[0m\r\n`)
    })
    inst.unlistenFns.push(unlistenExit)

    // xterm → PTY（用户输入）
    term.onData((data: string) => {
      const id = inst.terminalId
      if (!id) return
      void invoke('terminal_write', { args: { id, data } }).catch(e => {
        console.error(`[Terminal ${id}] write 失败:`, e)
      })
    })
  }

  /** 将 xterm 挂载到指定容器元素（id 对应 DOM） */
  async function mountTerminalToDOM(id: string) {
    const inst = termInstances.get(id)
    if (!inst) return
    const container = document.getElementById(`term-body-${id}`)
    if (!container) {
      // 若 DOM 尚未渲染，延迟重试
      setTimeout(() => mountTerminalToDOM(id), 50)
      return
    }
    if (container.querySelector('.xterm')) return  // 已挂载

    const { term, fit } = inst
    // **关键**：把 xterm theme 的 bg 钉到 term-body 容器的 inline style，
    // 不走 CSS 变量。这样切换全局主题时，已开的终端不会被改 bg —— xterm
    // 内部 fg 色已经烘焙到 color cache，container bg 必须保持原色，否则
    // 出现"深色 fg + 深色 bg = 看不见"。
    const xtermTheme = (term.options as any).theme ?? {}
    if (xtermTheme.background) {
      container.style.backgroundColor = xtermTheme.background as string
    }
    term.open(container)

    const { invoke } = await import('@tauri-apps/api/core')

    // 通知 Rust PTY 当前尺寸（仅在 terminalId 就绪时；初次创建可能还在 await 中）
    const pushSizeToBackend = () => {
      const tid = inst.terminalId
      if (!tid) return
      void invoke('terminal_resize', { args: { id: tid, cols: term.cols, rows: term.rows } })
        .catch(e => console.error(`[Terminal ${tid}] resize 失败:`, e))
    }

    // 用 rAF 确保浏览器完成布局后再 fit，避免 display:none 父容器导致 0 尺寸
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (container.clientWidth > 0) {
          fit.fit()
          term.focus()
          pushSizeToBackend()
        } else {
          requestAnimationFrame(() => {
            fit.fit()
            term.focus()
            pushSizeToBackend()
          })
        }
      })
    })

    // ResizeObserver 自动适配
    // 关键：只在容器实际可见（clientWidth > 0）时才 fit，
    // 否则 display:none 时 clientWidth=0，fit 会把终端尺寸压成 0 行 0 列，
    // 导致会话切换后内容消失（PTY 被 resize 到 0 则 SIGHUP 或内容清空）。
    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fit.fit()
        pushSizeToBackend()
      }
    })
    observer.observe(container)
    inst.resizeObs = observer
  }

  /** 切换 terminal tab
   *
   * 只设置 activeTermId 即可 —— 由 activeTermId 触发的 createEffect（约 2935 行）
   * 用 double-rAF 等 DOM 完成 display:none → '' 的切换后再 fit + focus。
   *
   * 历史教训：之前这里用 queueMicrotask 立即 fit + focus，但 microtask 跑在 Solid
   * 完成 DOM 更新之前，term-body 还是 display:none，fit 把尺寸算成 0，focus 也无效。
   * 用户表现为"点一下 tab 不响应，点两下才生效"。
   */
  function switchTerminalTab(id: string) {
    setActiveTermId(id)
  }

  /** 关闭 terminal tab */
  async function closeTerminalTab(id: string, e: MouseEvent) {
    e.stopPropagation()
    const inst = termInstances.get(id)
    if (inst) {
      inst.resizeObs?.disconnect()
      // 取消所有 listen 订阅
      for (const fn of inst.unlistenFns) {
        try { fn() } catch { /* ignore */ }
      }
      // 通知 Rust 关闭 PTY（kill shell 进程）
      if (inst.terminalId) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('terminal_close', { args: { id: inst.terminalId } })
        } catch (err) {
          console.error('[Terminal] terminal_close 失败:', err)
        }
      }
      inst.term.dispose()
      termInstances.delete(id)
    }
    const tabs = terminalTabs().filter(t => t.id !== id)
    setTerminalTabs(tabs)
    if (activeTermId() === id) {
      // 找当前会话的下一个可用 tab
      const sid = activeSessionId() ?? '__global__'
      const sessionTabs = tabs.filter(t => t.sessionId === sid)
      const next = sessionTabs[sessionTabs.length - 1]
      if (next) {
        setActiveTermId(next.id)
        queueMicrotask(() => switchTerminalTab(next.id))
      } else {
        setActiveTermId(null)
        setShowTerminal(false)
      }
    }
  }

  /** 调整终端高度（拖拽 resize handle） */
  let resizingTerminal = false
  let resizeStartY = 0
  let resizeStartH = 280

  function onTerminalResizeStart(e: PointerEvent) {
    resizingTerminal = true
    resizeStartY = e.clientY
    resizeStartH = terminalHeight()
    document.addEventListener('pointermove', onTerminalResizeMove)
    document.addEventListener('pointerup', onTerminalResizeEnd)
    e.preventDefault()
  }

  function onTerminalResizeMove(e: PointerEvent) {
    if (!resizingTerminal) return
    const delta = resizeStartY - e.clientY  // 向上拖动 = 增大
    const newH = Math.max(120, Math.min(600, resizeStartH + delta))
    setTerminalHeight(newH)
    // 重新 fit 当前终端
    const id = activeTermId()
    if (id) termInstances.get(id)?.fit.fit()
  }

  function onTerminalResizeEnd() {
    resizingTerminal = false
    document.removeEventListener('pointermove', onTerminalResizeMove)
    document.removeEventListener('pointerup', onTerminalResizeEnd)
  }

  /** TerminalPanel 组件 */
  // K10b: TerminalPanel 已抽到 @maxian/ui，作为 SharedTerminalPanel 使用。
  // 渲染处见 main 区（约第 8620 行）—— 通过 props 传入 App 内的所有终端状态/回调。

  // ─── 图片附件处理 ──────────────────────────────────────────────────────────
  function handleImageFile(file: File) {
    if (!file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string
      if (!dataUrl) return
      setAttachedImages(prev => [...prev, {
        id: Math.random().toString(36).slice(2),
        dataUrl,
        name: file.name,
      }])
    }
    reader.readAsDataURL(file)
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) handleImageFile(file)
      }
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (!files) return
    for (const file of files) {
      if (file.type.startsWith("image/")) handleImageFile(file)
    }
  }

  function removeImage(id: string) {
    setAttachedImages(prev => prev.filter(img => img.id !== id))
  }

  // ─── Agent 提问回答 ────────────────────────────────────────────────────
  async function handleAnswerQuestion(cancelled = false) {
    const req = questionRequest()
    if (!req) return
    setQuestionRequest(null)
    try {
      const c = await getClient()
      await c.answerQuestion(req.sessionId, {
        answer:    questionAnswer(),
        selected:  questionSelected().length > 0 ? questionSelected() : undefined,
        cancelled,
      })
    } catch (e) {
      console.error('[Question] 回答提交失败:', e)
    }
  }

  async function handlePlanExit(approved: boolean) {
    const req = planExitRequest()
    if (!req) return
    setPlanExitRequest(null)
    try {
      const c = await getClient()
      await c.respondPlanExit(req.sessionId, approved, planExitFeedback() || undefined)
      if (approved) {
        // 切换到 code 模式
        try { await c.updateSessionMode(req.sessionId, 'code') } catch { /* ignore */ }
        showToast({ message: '已切换到 Code 模式开始执行', kind: 'success' })
      }
    } catch (e) {
      console.error('[PlanExit] 提交失败:', e)
    }
  }

  // ─── 审批对话框操作 ────────────────────────────────────────────────────────
  async function handleApprove(approved: boolean, remember?: 'session' | 'always') {
    const req = approvalRequest()
    if (!req) return
    setApprovalRequest(null)
    // 记忆选择
    if (approved && remember === 'session') addSessionAllow(req.sessionId, req.toolName)
    if (approved && remember === 'always')  addAllowAlways(req.toolName)
    try {
      const c = await getClient()
      await c.approveToolCall(req.sessionId, req.toolUseId, approved)
    } catch (e) {
      console.error("[Approval] 审批请求失败:", e)
    }
  }

  // ─── 会话导出 ──────────────────────────────────────────────────────────────
  async function exportSession(format: 'markdown' | 'json') {
    const sid = activeSessionId()
    const msgs = messages()
    if (!sid || msgs.length === 0) { alert("暂无消息可导出"); return }

    let content: string
    let filename: string
    const timestamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')

    if (format === 'markdown') {
      const lines: string[] = [`# 码弦 AI 会话导出\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n`]
      for (const m of msgs) {
        if (m.role === 'user') {
          lines.push(`\n## 用户\n\n${m.content}\n`)
        } else if (m.role === 'assistant') {
          lines.push(`\n## AI\n\n${m.content}\n`)
        } else if (m.role === 'tool') {
          lines.push(`\n> 🔧 ${TOOL_LABELS[m.toolName ?? ''] ?? m.toolName}: ${getToolSubtitle(m.toolName ?? '', m.toolParams)}\n`)
        }
      }
      content = lines.join('')
      filename = `maxian-session-${timestamp}.md`
    } else {
      content = JSON.stringify(msgs.map(m => ({
        role: m.role, content: m.content,
        toolName: m.toolName, toolParams: m.toolParams,
      })), null, 2)
      filename = `maxian-session-${timestamp}.json`
    }

    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const dialogMod = await import('@tauri-apps/plugin-dialog' as any)
        const fsMod = await import('@tauri-apps/plugin-fs' as any)
        const savePath = await dialogMod.save({ defaultPath: filename, filters: [{ name: 'File', extensions: [format === 'markdown' ? 'md' : 'json'] }] })
        if (savePath) {
          await fsMod.writeTextFile(savePath, content)
          alert(`已导出到: ${savePath}`)
        }
      } else {
        // 浏览器环境：触发下载
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = filename; a.click()
        URL.revokeObjectURL(url)
      }
    } catch (e) { alert("导出失败：" + (e as Error).message) }
  }

  // ─── 在外部编辑器打开文件 ─────────────────────────────────────────────────
  async function openInEditor(filePath: string) {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const { Command } = await import('@tauri-apps/plugin-shell' as any)
        // 依次尝试常见编辑器
        const editors = ['cursor', 'code', 'vim', 'nano']
        for (const editor of editors) {
          try {
            await Command.create(editor, [filePath]).execute()
            return
          } catch { /* 该编辑器不存在，继续尝试 */ }
        }
        alert('未找到可用编辑器（已尝试 cursor/code/vim/nano）')
      } else {
        alert(`文件路径：${filePath}\n请手动在编辑器中打开`)
      }
    } catch (e) {
      console.error('[openInEditor]', e)
    }
  }

  // ─── 文件树面板 ────────────────────────────────────────────────────────────
  async function revertFile(filePath: string) {
    const sid = activeSessionId()
    if (!sid) return
    const ok = await appConfirm(`确定要撤销对文件的修改吗？\n${filePath}`)
    if (!ok) return
    try {
      const c = await getClient()
      const res = await c.revertFile(sid, filePath)
      if (res.ok) {
        setChangedFiles(prev => {
          const next = new Map(prev)
          next.delete(filePath)
          return next
        })
        // 清除该文件 preview tab 中的 diff 缓存，并切回源码
        setPreviewTabs(prev => prev.map(t =>
          t.path === filePath
            ? { ...t, viewMode: 'source', changed: undefined, diffOriginal: null, diffCurrent: '' }
            : t
        ))
      } else {
        alert("撤销失败：" + (res.error ?? "未知错误"))
      }
    } catch (e) {
      alert("撤销失败：" + (e as Error).message)
    }
  }

  // ─── 预览面板操作 ────────────────────────────────────────────────────────
  /** 根据扩展名/MIME 判定 PreviewTab.kind */
  // classifyFileKind 已抽到 ./lib/types

  /** 打开一个文件到预览面板（或激活已打开的标签） */
  async function openPreview(filePath: string, opts?: { viewMode?: PreviewTab['viewMode']; line?: number }) {
    const ws = activeWorkspace()
    if (!ws) { alert('请先打开工作区'); return }

    // 已打开 → 仅激活 + 可能切换视图 + 跳转行号
    const existing = previewTabs().find(t => t.path === filePath)
    if (existing) {
      setActivePreviewPath(filePath)
      if (opts?.viewMode) {
        setPreviewTabs(prev => prev.map(t =>
          t.path === filePath ? { ...t, viewMode: opts.viewMode! } : t
        ))
        if (opts.viewMode === 'diff') void loadDiffForTab(filePath)
      }
      if (opts?.line && opts.line > 0) {
        // 直接滚动（已加载）
        setTimeout(() => scrollPreviewToLine(filePath, opts.line!), 50)
      }
      return
    }

    // 新建 loading 标签
    const title = filePath.split(/[\\/]/).pop() || filePath
    const changed = changedFiles().get(filePath)?.action
    const initialViewMode: PreviewTab['viewMode'] =
      opts?.viewMode ?? (changed ? 'diff' : 'source')

    const placeholder: PreviewTab = {
      path:     filePath,
      title,
      kind:     'text',
      content:  '',
      mimeType: 'text/plain',
      size:     0,
      loading:  true,
      viewMode: initialViewMode,
      changed,
      pendingLine: opts?.line && opts.line > 0 ? opts.line : undefined,
    }
    setPreviewTabs(prev => [...prev, placeholder])
    setActivePreviewPath(filePath)

    try {
      const c = await getClient()
      const data = await c.readFileContent(ws.id, filePath)
      const kind = classifyFileKind(data)
      // 同步抓一次 mtime 作为 P0-4 基线
      let mtimeMs: number | undefined
      try {
        const st = await c.getFileStat(ws.id, filePath)
        if (st.exists) mtimeMs = st.mtimeMs
      } catch { /* ignore */ }

      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? {
              ...t,
              kind,
              content: data.content,
              mimeType: data.mimeType,
              size: data.size,
              error: data.error,
              loading: false,
              mtimeMs,
              extChangedAt: undefined,
            }
          : t
      ))

      if (initialViewMode === 'diff') void loadDiffForTab(filePath)
      // P0-1: 跳转到指定行
      if (opts?.line && opts.line > 0) {
        setTimeout(() => scrollPreviewToLine(filePath, opts.line!), 80)
      }
    } catch (e) {
      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? { ...t, loading: false, error: (e as Error).message }
          : t
      ))
    }
  }

  /**
   * 滚动预览到指定行号（1-based）并短暂高亮（P0-1）
   * 思路：代码行号预览是 `<pre class="preview-code-lineno">` 单个 pre，按行高计算偏移滚动。
   */
  function scrollPreviewToLine(filePath: string, line: number) {
    if (activePreviewPath() !== filePath) setActivePreviewPath(filePath)
    const wrap = document.querySelector('.preview-code-wrap') as HTMLElement | null
    if (!wrap) return
    const lineno = wrap.querySelector('.preview-code-lineno') as HTMLElement | null
    if (!lineno) return
    // 用第一行高度估算（等宽字体下所有行高相同）
    const firstTxt = (lineno.textContent ?? '').split('\n')[0] ?? '1'
    // 借助一个探测 span
    const probe = document.createElement('span')
    probe.style.cssText = 'font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;font-size:inherit;visibility:hidden;position:absolute'
    probe.textContent = firstTxt
    lineno.appendChild(probe)
    const lh = probe.getBoundingClientRect().height || 18
    probe.remove()
    const scrollable = wrap.parentElement as HTMLElement | null  // .preview-body
    if (!scrollable) return
    const targetTop = Math.max(0, (line - 3) * lh)
    scrollable.scrollTo({ top: targetTop, behavior: 'smooth' })
    // 短暂高亮：在 .preview-code 中给第 line 行包一层
    const code = wrap.querySelector('.preview-code code') as HTMLElement | null
    if (!code) return
    const oldHl = wrap.querySelector('.preview-line-hl')
    oldHl?.remove()
    const hl = document.createElement('div')
    hl.className = 'preview-line-hl'
    hl.style.cssText = `position:absolute;left:0;right:0;top:${(line - 1) * lh + code.offsetTop}px;height:${lh}px;background:rgba(255,220,60,0.18);border-left:2px solid #ffd83d;pointer-events:none;z-index:2;transition:opacity 0.5s`
    wrap.style.position = 'relative'
    wrap.appendChild(hl)
    setTimeout(() => { hl.style.opacity = '0'; setTimeout(() => hl.remove(), 600) }, 1600)
  }

  /** 重载 preview 内容（P0-4: 外部变更后点击"重新加载"） */
  async function reloadPreview(filePath: string) {
    const ws = activeWorkspace()
    if (!ws) return
    try {
      const c = await getClient()
      const data = await c.readFileContent(ws.id, filePath)
      const kind = classifyFileKind(data)
      let mtimeMs: number | undefined
      try {
        const st = await c.getFileStat(ws.id, filePath)
        if (st.exists) mtimeMs = st.mtimeMs
      } catch { /* ignore */ }
      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? {
              ...t,
              kind,
              content: data.content,
              mimeType: data.mimeType,
              size: data.size,
              error: data.error,
              loading: false,
              mtimeMs,
              extChangedAt: undefined,
            }
          : t
      ))
    } catch (e) {
      showToast({ message: '重载失败: ' + (e as Error).message, kind: 'error' })
    }
  }

  // P0-4: 外部文件变更检测（K11a-cont：抽到 ./hooks/useFileWatcher）
  useFileWatcher<Workspace>({
    workspace: activeWorkspace,
    getWorkspaceId: (ws) => ws.id,
    tabs: previewTabs,
    getFileStat: async (wsId, path) => {
      const c = await getClient()
      return c.getFileStat(wsId, path)
    },
    onExternalChange: (path) => {
      setPreviewTabs(prev => prev.map(t =>
        t.path === path ? { ...t, extChangedAt: Date.now() } : t
      ))
    },
    intervalMs: 3000,
    tolerance: 2,
  })

  /** 懒加载某标签的 diff 数据 */
  async function loadDiffForTab(filePath: string) {
    const sid = activeSessionId()
    if (!sid) return
    const tab = previewTabs().find(t => t.path === filePath)
    if (!tab) return
    if (tab.diffOriginal !== undefined) return  // 已加载
    setPreviewTabs(prev => prev.map(t =>
      t.path === filePath ? { ...t, diffLoading: true } : t
    ))
    try {
      const c = await getClient()
      const data = await c.getFileDiff(sid, filePath)
      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? { ...t, diffOriginal: data.original, diffCurrent: data.current, diffLoading: false }
          : t
      ))
    } catch {
      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? { ...t, diffOriginal: null, diffCurrent: '', diffLoading: false }
          : t
      ))
    }
  }

  function closePreviewTab(filePath: string) {
    setPreviewTabs(prev => {
      const idx = prev.findIndex(t => t.path === filePath)
      if (idx < 0) return prev
      const next = prev.filter(t => t.path !== filePath)
      if (activePreviewPath() === filePath) {
        // 激活邻近标签
        const neighbor = next[idx] ?? next[idx - 1] ?? null
        setActivePreviewPath(neighbor?.path ?? null)
      }
      return next
    })
  }

  function setTabViewMode(filePath: string, mode: PreviewTab['viewMode']) {
    setPreviewTabs(prev => prev.map(t =>
      t.path === filePath ? { ...t, viewMode: mode } : t
    ))
    if (mode === 'diff') void loadDiffForTab(filePath)
  }

  // 保留旧 API 名以兼容调用点：openFileDiff → 直接打开 preview 的 diff 视图
  async function openFileDiff(filePath: string) {
    await openPreview(filePath, { viewMode: 'diff' })
  }

  // 纯格式化工具（formatTime / formatFullTime / userInitials / shortPath / formatRecv /
  // storedToChatMessage）已抽到 ./lib/format.ts

  function toggleReasoning(id: string) {
    setExpandedReasonings(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ─── Settings panels ──────────────────────────────────────────────────────
  // K11c-1: SettingsAppearance 已抽到 ./settings/SettingsAppearance.tsx
  // 渲染处见 settings tab dispatch（约第 7648 行）。

  // K11c-2: SettingsGeneral 已抽到 ./settings/SettingsGeneral.tsx

  // ─── Git Worktree 管理设置面板 ───────────────────────────────────────────
  // K11c-10: SettingsWorktree 已抽到 ./settings/SettingsWorktree.tsx

  // ─── MCP Server 管理设置面板 ──────────────────────────────────────────────
  /**
   * MCP Server 配置存储在 ~/.maxian/mcp-servers.json
   * 格式：[{ id, name, command, args, env, enabled }]
   */
  // K11c-9: SettingsMcp + McpServer 类型 + loadMcpServers/saveMcpServers 已抽到 ./settings/SettingsMcp.tsx

  // ─── SettingsKeybinds（自定义快捷键）─────────────────────────────────
  // K11c-3: SettingsKeybinds 已抽到 ./settings/SettingsKeybinds.tsx
  // K11c-4: SettingsTemplates 已抽到 ./settings/SettingsTemplates.tsx

  // ─── SettingsUsage（Token 用量 dashboard）────────────────────────────
  // K11c-5: SettingsUsage 已抽到 ./settings/SettingsUsage.tsx
  // K11c-6: SettingsErrors 已抽到 ./settings/SettingsErrors.tsx


  // ─── SettingsPlugins：插件开发文档（P1-14）────────────────────────────────
  const PLUGIN_DEV_MD = `# 码弦（Maxian）插件开发指南

## 1. 插件存放位置

所有插件放在 \`~/.maxian/plugins/\`：

- **单文件插件**：\`*.js\` / \`*.mjs\` / \`*.cjs\`（如 \`~/.maxian/plugins/my-plugin.mjs\`）
- **目录插件**：目录下含 \`package.json\`（\`main\` 字段指向入口），入口必须是 ESM 格式

服务端启动时自动扫描加载；加载失败不会中断服务。

## 2. 插件模块结构

\`\`\`js
export default {
  name:    'my-plugin',
  version: '1.0.0',

  // 自定义工具（AI Agent 可调用）
  tools: [
    {
      name:        'hello_world',
      description: '打印问候语；参数 name: 收件人名字',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      async execute(params, ctx) {
        return \`你好, \${params.name}！\`;
      },
    },
  ],

  // 生命周期 Hooks（可选）
  hooks: {
    async 'session.created'(ctx) {
      console.log('新会话:', ctx.sessionId);
    },
    async 'tool.execute.before'(ctx) {
      // 返回 false 可取消该工具调用
      if (ctx.toolName === 'bash' && String(ctx.params.command).includes('rm -rf /')) {
        return false;
      }
    },
  },
};
\`\`\`

## 3. 工具规范

| 字段 | 类型 | 说明 |
|------|------|------|
| \`name\` | string | 工具名（snake_case，不能与内置工具重名） |
| \`description\` | string | 给 AI 看的工具用途 |
| \`parameters\` | JSONSchema | 参数 Schema（\`type: 'object'\` + \`properties\` + \`required\`） |
| \`execute\` | function | \`(params, ctx) => Promise<string\\|unknown>\` |

**返回值**：字符串直接作为工具输出；对象会 \`JSON.stringify\`；抛异常转为错误字符串。

## 4. Hooks 事件

| 事件 | 触发时机 | Context | 特殊行为 |
|------|---------|---------|----------|
| \`session.created\` | 新会话创建 | \`{ sessionId }\` | — |
| \`message.sent\` | 用户消息发送 | \`{ sessionId, content }\` | — |
| \`tool.execute.before\` | 工具执行前 | \`{ toolName, params, sessionId }\` | 返回 \`false\` 可取消 |
| \`tool.execute.after\` | 工具执行后 | \`{ toolName, params, result, success, sessionId }\` | — |
| \`agent.iteration\` | 每轮迭代结束 | \`{ sessionId, iter, toolCalls }\` | — |

## 5. 示例：埋点插件

\`\`\`js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const logFile = path.join(os.homedir(), '.maxian', 'agent-metrics.jsonl');

export default {
  name: 'metrics-logger',
  version: '0.1.0',
  tools: [],
  hooks: {
    async 'agent.iteration'(ctx) {
      const row = { ts: Date.now(), ...ctx };
      try { await fs.appendFile(logFile, JSON.stringify(row) + '\\n', 'utf8'); } catch {}
    },
  },
};
\`\`\`

## 6. 示例：HTTP 查询工具

\`\`\`js
export default {
  name: 'http-fetch-plugin',
  version: '0.1.0',
  tools: [
    {
      name: 'get_weather',
      description: '查询城市天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      async execute({ city }) {
        const res = await fetch(\`https://wttr.in/\${encodeURIComponent(city)}?format=%l:+%C+%t+%w\`);
        if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
        return await res.text();
      },
    },
  ],
};
\`\`\`

## 7. 安全与限制

- 插件在服务端 Node.js 进程中运行，拥有完整 FS/网络/子进程权限——只加载信任的插件
- 不要在 hook 中触发新的工具调用（可能无限递归）
- 工具名与内置工具冲突时，**内置工具优先**，插件工具会被忽略
- 不建议在 \`tool.execute.before\` 做重计算（会阻塞工具调用）

## 8. 调试建议

1. 启动时观察控制台：\`[Plugin] 加载 N 个插件\`
2. 若加载失败，插件管理列表的 \`error\` 字段会显示错误信息
3. ESM 格式要求：\`.mjs\` 或 \`package.json\` 里 \`"type": "module"\`

## 内置工具清单（请勿重名）

\`read_file\`, \`write_to_file\`, \`edit_file\`, \`multiedit_file\`, \`list_files\`, \`search_files\`, \`grep_search\`, \`bash\`, \`todo_write\`, \`web_fetch\`, \`web_search\`, \`lsp\`, \`load_skill\`, \`update_todo_list\`, \`ask_followup_question\`, \`plan_exit\`
`

  // K11c-7: SettingsPlugins 已抽到 ./settings/SettingsPlugins.tsx

  // K11c-8: SettingsAbout 已抽到 ./settings/SettingsAbout.tsx

  // ─── Sidebar ──────────────────────────────────────────────────────────────
  function toggleGroupCollapse(wsId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(wsId)) next.delete(wsId)
      else next.add(wsId)
      return next
    })
  }

  // ─── 会话条目（chat/code 通用） ──────────────────────────────────────────────
  // K11c-cont: SessionItem + Sidebar 已抽到 ./sidebar/

  // ─── ApprovalDialog ───────────────────────────────────────────────────────
  // 共享自 @maxian/ui 的纯 UI 组件，外部传入 request + onDecide 即可。
  // ApprovalDialog 直接 inline SharedApprovalDialog（K10-A 已抽，无需本地包装函数）
  // K11c-cont: QuestionDialog / PlanExitDialog / ApplyToFileDialog 已抽到 ./dialogs/

  // K10e: FileTreePanel 已抽到 @maxian/ui 改名 SharedFileChangesPanel（更准确：是变更文件列表，非目录树）
  // 渲染处见 main 区右侧侧边栏（约第 8487 行）。

  // ─── 工作区浏览器面板（列出所有工作区文件，点击打开预览）──────────────
  // 层级文件树节点
  // 展开的目录路径
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set())
  function toggleDir(path: string) {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // K11c-cont: WorkspaceExplorerPanel 已抽到 ./panels/WorkspaceExplorerPanel

  // ─── Skills 面板 ─────────────────────────────────────────────────────────
  async function loadSkills() {
    const ws = activeWorkspace()
    if (!ws) return
    setSkillsLoading(true)
    try {
      const c = await getClient()
      const res = await c.listSkills(ws.id)
      setSkillsList(res.skills)
      setSkillsSearchedDirs(res.searchedDirs)
    } catch (e) {
      setSkillsList([])
      setSkillsSearchedDirs([])
    } finally {
      setSkillsLoading(false)
    }
  }

  // 打开 Skills 面板时自动加载一次
  createEffect(() => {
    if (showSkillsPanel() && activeWorkspace()) {
      void loadSkills()
    }
  })

  // K11c-cont: SkillsPanel 已抽到 ./panels/SkillsPanel

  // ─── 文件预览面板（右侧滑入，多标签）────────────────────────────────────
  // K10f: LCS diff 算法 + 渲染已抽到 @maxian/ui 的 SharedDiffViewer / computeUnifiedDiff。
  // K11c-cont: FilePreviewPanel + hljsLangFromPath + escapeHtml 已抽到 ./panels/FilePreviewPanel

  // ─── TokenUsageBar（带动画数字）────────────────────────────────────────
  // K10c: TokenUsageBar 已抽到 @maxian/ui，作为 SharedTokenUsageBar 使用。
  // 渲染处见 composer 上方（约第 8399 行）—— 通过 props 传入 tokens 数据 + 压缩回调。

  // ─── O7: 工具错误展示（默认折叠，点击展开） ────────────────────────────
  // K11c-cont: ToolErrorPanel 已抽到 ./panels/ToolErrorPanel

  // ─── TodoDock（P0-1）: 在 composer 上方显示当前 todos 进度 ─────────────
  // K11c-cont: TodoDock 已抽到 ./panels/TodoDock

  // ─── FollowupDock（P0-2）: 建议追问 + 队列 ───────────────────────────────
  // K11c-cont: FollowupDock 已抽到 ./panels/FollowupDock

  // ─── ContextPanel（P1-10）: 显示当前会话已附加的上下文 ──────────────────
  // K11c-cont: ContextPanel 已抽到 ./panels/ContextPanel

  // K11c-cont: RevertDock / CompactingBanner / RateLimitBanner 已抽到 ./panels/

  // K11a: ToastHost 已抽到 ./components/ToastHost.tsx

  // K11a: GlobalCommandPalette (⌘P) 已抽到 ./components/GlobalCommandPalette.tsx

  // K11a: KeybindHelpModal (⌘/) 已抽到 ./components/KeybindHelpModal.tsx

  // ─── AnimatedNumber: 平滑数字过渡（P2-20） ───────────────────────────────
  // K11c-cont: AnimatedNumber 已抽到 ./components/AnimatedNumber

  // ─── SlashCommandPalette ──────────────────────────────────────────────────
  // K10d: SlashCommandPalette + FileMentionDropdown 已抽到 @maxian/ui
  // 作为 SharedCommandPalette / SharedMentionDropdown 使用。渲染处见外层 fragment（约 7820 行附近）。

  // K11a: ModeSelector / MODE_OPTIONS / ModeSvgIcon / ComposerMode 类型 已抽到
  // ./components/ModeSelector.tsx；下面渲染处通过 props 注入状态。
  // composerMode 切换的副作用（updateSessionMode + 注入提示消息）由 onSelectMode 回调封装。
  const onSelectComposerMode = async (mode: ComposerMode, prevMode: ComposerMode) => {
    setComposerMode(mode)
    const sid = activeSessionId()
    if (sid) {
      try {
        const c = await getClient()
        await c.updateSessionMode(sid, mode)
      } catch { /* 忽略 */ }
    }
    if (mode === 'plan') {
      setMessages(prev => [...prev, {
        id: String(++msgId), role: "system",
        createdAt: Date.now(),
        content: "📋 已进入计划模式：AI 只规划，不执行文件操作",
      }])
    } else if (prevMode === 'plan') {
      setMessages(prev => [...prev, {
        id: String(++msgId), role: "system",
        createdAt: Date.now(),
        content: "⚡ 已退出计划模式",
      }])
    }
  }

  // K11a: GitStatusBar 已抽到 ./components/GitStatusBar.tsx
  // K11b: branch picker 操作回调来自 useGitBranchPicker，下面取别名给外部 JSX 用
  const loadBranchPicker  = _branchPicker.loadBranchPicker
  const openBranchPicker  = _branchPicker.openBranchPicker
  const switchBranch      = _branchPicker.switchBranch

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* 登录/启动状态也需要给 traffic lights 留空（Overlay 模式） */}
      <Show when={appStatus() !== "ready"}>
        <div class="window-titlebar-placeholder" data-tauri-drag-region />
      </Show>

      {/* Login */}
      <Show when={appStatus() === "login"}>
        <LoginView
          logoUrl={logoUrl}
          apiUrl={loginApiUrl} setApiUrl={setLoginApiUrl}
          username={loginUsername} setUsername={setLoginUsername}
          password={loginPassword} setPassword={setLoginPassword}
          remember={loginRemember} setRemember={setLoginRemember}
          error={loginError} loading={loginLoading}
          onSubmit={handleLogin}
        />
      </Show>

      {/* Booting */}
      <Show when={appStatus() === "booting"}>
        <BootingScreen logoUrl={logoUrl} />
      </Show>

      {/* Error */}
      <Show when={appStatus() === "error"}>
        <BootErrorScreen
          error={bootError}
          onLogout={handleLogout}
          onRetry={() => bootWithCredentials(loadSavedCredentials()!)}
        />
      </Show>

      {/* Ready */}
      <Show when={appStatus() === "ready"}>
        {/* 自定义标题栏（macOS Overlay 模式，替代原生标题栏） */}
        <div class="window-titlebar" data-tauri-drag-region>
          <img class="window-title-logo" src={logoUrl} alt="" data-tauri-drag-region />
          <span class="window-title-text" data-tauri-drag-region>码弦 Maxian</span>
        </div>

        {/* Slash 命令面板 & @ 文件提及（K10d：抽到 @maxian/ui）
            fixed 定位，渲染在最外层避免 z-index 问题 */}
        <SharedCommandPalette
          visible={showSlash()}
          rect={paletteRect()}
          commands={filteredSlash()}
          activeIdx={slashIdx()}
          onHover={(idx) => setSlashIdx(idx)}
          onSelect={(name) => execSlashCommand(name)}
        />
        <SharedMentionDropdown
          visible={showMention()}
          rect={paletteRect()}
          files={mentionFiles()}
          activeIdx={mentionIdx()}
          query={mentionQuery()}
          workspaceName={activeWorkspace()?.name}
          totalFiles={wsFileCache()?.files.length ?? 0}
          loading={wsFileCacheLoading()}
          onHover={(idx) => setMentionIdx(idx)}
          onSelect={(file) => insertMention(file)}
        />

        <div class="app-shell" data-mode={globalMode()}>
          <Show when={!showBatchPanel()}>
            <Sidebar
              currentUser={currentUser}
              globalMode={globalMode}
              showBatchPanel={showBatchPanel}
              showSettings={showSettings}
              userExpanded={userExpanded}
              setUserExpanded={(v) => setUserExpanded(v as any)}
              setShowSettings={(v) => setShowSettings(v)}
              setSettingsTab={(t) => setSettingsTab(t)}
              leaveBatchPanelToMode={leaveBatchPanelToMode}
              setShowBatchPanel={(v) => setShowBatchPanel(v)}
              handleLogout={handleLogout}
              sessions={sessions}
              workspaces={workspaces}
              groupedSessions={groupedSessions}
              sessionSearch={sessionSearch}
              setSessionSearch={(v) => setSessionSearch(v)}
              showArchived={showArchived}
              setShowArchived={(v) => setShowArchived(v as any)}
              collapsedGroups={collapsedGroups}
              toggleGroupCollapse={toggleGroupCollapse}
              activeSessionId={activeSessionId}
              editingSessionId={editingSessionId}
              editingSessionTitle={editingSessionTitle}
              setEditingSessionTitle={(v) => setEditingSessionTitle(v)}
              selectSession={(id) => void selectSession(id)}
              startRenameSession={startRenameSession}
              commitRenameSession={(id) => void commitRenameSession(id)}
              cancelRenameSession={cancelRenameSession}
              togglePinSession={(id, p) => void togglePinSession(id, p)}
              toggleArchiveSession={(id, a) => void toggleArchiveSession(id, a)}
              deleteSession={(e, id) => void deleteSession(e, id)}
              createSession={() => void createSession()}
              pickFolder={() => void pickFolder()}
              editingWorkspaceId={editingWorkspaceId}
              editingWorkspaceName={editingWorkspaceName}
              setEditingWorkspaceName={(v) => setEditingWorkspaceName(v)}
              createSessionInWorkspace={(e, ws) => void createSessionInWorkspace(e, ws)}
              startRenameWorkspace={startRenameWorkspace}
              commitRenameWorkspace={(id) => void commitRenameWorkspace(id)}
              cancelRenameWorkspace={cancelRenameWorkspace}
              deleteWorkspace={(e, ws) => void deleteWorkspace(e, ws)}
              userInitials={userInitials}
              shortPath={shortPath}
            />
          </Show>

          {/* 自动更新提示 Toast */}
          <Show when={updateAvailable()}>
            <div class="update-toast">
              <div class="update-toast-content">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2">
                  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                  <polyline points="17 6 23 6 23 12"/>
                </svg>
                <span>新版本 <strong>{updateVersion()}</strong> 已就绪</span>
                <button class="btn btn-primary" style="font-size:11px;padding:3px 10px" onClick={installUpdateFromToast}>立即更新</button>
                <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" onClick={() => setUpdateAvailable(false)}>稍后</button>
              </div>
            </div>
          </Show>

          {/* 工具审批对话框（阻塞式） */}
          <SharedApprovalDialog
            request={approvalRequest()}
            getToolLabel={(n) => TOOL_LABELS[n] ?? n}
            onDecide={(d) => {
              if (d.approved) void handleApprove(true, d.remember)
              else void handleApprove(false)
            }}
          />
          {/* Agent 提问对话框 */}
          <QuestionDialog
            request={questionRequest}
            answer={questionAnswer}
            selected={questionSelected}
            setAnswer={setQuestionAnswer}
            toggleOption={(o) => {
              const req = questionRequest()
              if (!req) return
              if (req.multi) {
                setQuestionSelected(prev => prev.includes(o) ? prev.filter(x => x !== o) : [...prev, o])
              } else {
                setQuestionSelected([o])
              }
            }}
            onSubmit={() => void handleAnswerQuestion(false)}
            onCancel={() => void handleAnswerQuestion(true)}
          />
          {/* Plan Exit 对话框 */}
          <PlanExitDialog
            request={planExitRequest}
            feedback={planExitFeedback}
            setFeedback={setPlanExitFeedback}
            renderMarkdown={renderMarkdown}
            onApprove={() => void handlePlanExit(true)}
            onReject={() => void handlePlanExit(false)}
          />
          {/* 应用代码到文件对话框（P0-2） */}
          <ApplyToFileDialog
            state={applyDialog}
            setState={(updater) => setApplyDialog(updater)}
            close={() => setApplyDialog({ open: false, code: '', lang: undefined, target: '', mode: 'overwrite', loading: false })}
            onConfirm={() => void confirmApplyToFile()}
          />


          {/* Settings view */}
          <Show when={showSettings()}>
            <div class="settings-shell">
              <SettingsNav
                tab={settingsTab as () => SettingsTab}
                setTab={(t) => setSettingsTab(t)}
                onClose={() => setShowSettings(false)}
                errorCount={() => errorLog().length}
              />
              <div class="settings-content">
                <Show when={settingsTab() === "general"}>
                  <SettingsGeneral
                    currentUser={currentUser}
                    loginApiUrl={loginApiUrl}
                    allowAlways={allowAlways}
                    locale={locale}
                    toolLabels={TOOL_LABELS}
                    handleLogout={handleLogout}
                    removeAllowAlways={removeAllowAlways}
                    switchLocale={switchLocale}
                  />
                </Show>
                <Show when={settingsTab() === "appearance"}>
                  <SettingsAppearance
                    vimEnabled={vimEnabled}
                    theme={theme}
                    fontFamily={fontFamily}
                    fontSize={fontSize}
                    fontFamilies={FONT_FAMILIES}
                    toggleVim={toggleVim}
                    setTheme={setTheme}
                    setFontFamily={setFontFamily}
                    setFontSize={setFontSize}
                  />
                </Show>
                <Show when={settingsTab() === "worktree"}>
                  <SettingsWorktree
                    activeWorkspace={activeWorkspace}
                    getClient={getClient}
                    appConfirm={appConfirm}
                  />
                </Show>
                <Show when={settingsTab() === "mcp"}>
                  <SettingsMcp
                    getClient={getClient as any}
                    showToast={showToast}
                  />
                </Show>
                <Show when={settingsTab() === "keybinds"}>
                  <SettingsKeybinds
                    keybindDefaults={KEYBIND_DEFAULTS}
                    customKeybinds={customKeybinds}
                    getKeybind={getKeybind}
                    setKeybind={setKeybind}
                    resetKeybind={resetKeybind}
                    eventToKeybind={eventToKeybind}
                  />
                </Show>
                <Show when={settingsTab() === "templates"}>
                  <SettingsTemplates
                    sessionTemplates={sessionTemplates}
                    addSessionTemplate={addSessionTemplate}
                    removeSessionTemplate={removeSessionTemplate}
                    showToast={showToast}
                    createSession={createSession}
                    setInput={setInput}
                    setShowSettings={setShowSettings}
                  />
                </Show>
                <Show when={settingsTab() === "usage"}>
                  <SettingsUsage sessions={sessions} />
                </Show>
                <Show when={settingsTab() === "errors"}>
                  <SettingsErrors errorLog={errorLog} setErrorLog={setErrorLog} />
                </Show>
                <Show when={settingsTab() === "plugins"}>
                  <SettingsPlugins
                    pluginDevMarkdown={PLUGIN_DEV_MD}
                    renderMarkdown={renderMarkdown}
                    showToast={showToast}
                  />
                </Show>
                <Show when={settingsTab() === "about"}>
                  <SettingsAbout
                    logoUrl={logoUrl}
                    appVersion={__APP_VERSION__}
                    activeSessionId={activeSessionId}
                    getClient={getClient}
                    showToast={showToast}
                    refreshSessions={refreshSessions}
                  />
                </Show>
              </div>
            </div>
          </Show>

          {/* Batch panel：v0.2.16+ 全屏独占视图（自带顶部三段式切换） */}
          <Show when={!showSettings() && showBatchPanel() && batchClient()}>
            <main class="main main-batch-fullwidth">
              <BatchPanel
                client={batchClient()!}
                workspaces={workspaces()}
                currentMode={globalMode()}
                onSwitchToChat={() => leaveBatchPanelToMode('chat')}
                onSwitchToCode={() => leaveBatchPanelToMode('code')}
                onJumpToSession={async (sessionId, workspaceId) => {
                  // 看日志 = "临时打开任务会话"，不应污染用户最近会话。
                  // 记下跳前的 activeSessionId，用户点 Chat/Code 段切换时恢复。
                  // selectSession 之前先读，避免被清掉。
                  const existingReturn = _jumpReturnSessionId()
                  const prevSession = activeSessionId()
                  // 关闭批次面板 → 切到 code 视图（agent 任务都是 code 模式）→ 选中该 session
                  setShowBatchPanel(false)
                  setGlobalMode('code')
                  // 先尝试直接切工作区（避免 selectSession 找不到 session 时 workspace 不同步）
                  const ws = workspaces().find(w => w.id === workspaceId)
                  if (ws) setActiveWorkspace(ws)
                  // 批次创建的 session 可能还不在本地缓存里，先 refresh
                  await refreshSessions()
                  await selectSession(sessionId)  // 内部会清掉 _jumpReturnSessionId
                  // 在 selectSession 之 *后* 写入回退目标。
                  // 多次连续点"看日志"时优先保留最初的回退目标，而不是上一次的任务会话；
                  // 用户手动选过会话才会让 existingReturn 为空，那时再用 prevSession。
                  if (existingReturn) {
                    _setJumpReturnSessionId(existingReturn)
                  } else if (prevSession && prevSession !== sessionId) {
                    _setJumpReturnSessionId(prevSession)
                  }
                }}
              />
            </main>
          </Show>

          {/* Chat view
             *
             * ⚠️ 关键：用 CSS display 控制可见性，**不**用 <Show> 包裹卸载 DOM。
             * 因为这里包含集成终端面板（SharedTerminalPanel），里面挂载着 xterm.js 实例。
             * xterm 把渲染状态绑死在它的 DOM container 上 —— 一旦容器被卸载（<Show>
             * 切假分支会卸载子树），重新挂载后 xterm 不会自动重连到新 DOM，导致
             * 切换到 settings 再回来后终端整片空白且无法操作。
             *
             * 用 display:none 时 DOM 始终在树里，xterm 仅"不可见"，
             * 切回来恢复后即可继续工作（已在 PTY tab 间复用同样手法）。
             *
             * 包裹一层 div 是因为 chat-view 内部除了 <main>，还有右侧 explorer/preview
             * 等兄弟节点，需一起隐藏；外层 <Show>（line ~5552）已被这个 div 替代。
             */}
          <div class="chat-view-wrap" style={(!showSettings() && !showBatchPanel()) ? 'display:contents' : 'display:none'}>
            <main class="main">
              {/* Chat header — mode badge + new session */}
              <div class="chat-header">
                <div class="chat-header-left">
                  <Show when={composerMode() === 'plan'}>
                    <span class="mode-badge mode-badge-plan">📋 Plan</span>
                  </Show>
                  <Show when={composerMode() !== 'plan' && globalMode() === 'code'}>
                    <span class="mode-badge mode-badge-code">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="16 18 22 12 16 6"/>
                        <polyline points="8 6 2 12 8 18"/>
                      </svg>
                      Code
                    </span>
                  </Show>
                  <Show when={composerMode() !== 'plan' && globalMode() === 'chat'}>
                    <span class="mode-badge mode-badge-chat">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                      </svg>
                      Chat
                    </span>
                  </Show>
                </div>
                <div class="chat-header-right">
                  {/* Context 标签页（P1-10） */}
                  <button
                    class="icon-btn"
                    classList={{ active: showContextPanel() }}
                    onClick={() => setShowContextPanel(v => !v)}
                    title="会话上下文"
                    style="position:relative"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M20 7h-3V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/>
                      <line x1="8" y1="12" x2="16" y2="12"/>
                    </svg>
                    <Show when={contextFiles().length > 0 || attachedImages().length > 0}>
                      <span class="file-badge">{contextFiles().length + attachedImages().length}</span>
                    </Show>
                  </button>
                  {/* Session revert dock（P1-11） */}
                  <button
                    class="icon-btn"
                    classList={{ active: showRevertDock() }}
                    onClick={() => setShowRevertDock(v => !v)}
                    title="回退对话"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="1 4 1 10 7 10"/>
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                  </button>
                  {/* 消息过滤器（P1-13） */}
                  <div style="position:relative">
                    <button
                      class="icon-btn"
                      classList={{ active: msgFilter().hideTodos || msgFilter().hideReasoning || msgFilter().hideInternalTools }}
                      onClick={() => setShowFilterMenu(v => !v)}
                      title="消息过滤"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                      </svg>
                    </button>
                    <Show when={showFilterMenu()}>
                      <div class="filter-menu" onClick={(e) => e.stopPropagation()}>
                        <div class="filter-menu-title">消息过滤</div>
                        <label class="filter-menu-item">
                          <input type="checkbox" checked={msgFilter().hideReasoning}
                            onChange={(e) => updateMsgFilter({ hideReasoning: e.currentTarget.checked })} />
                          <span>隐藏思考过程（reasoning）</span>
                        </label>
                        <label class="filter-menu-item">
                          <input type="checkbox" checked={msgFilter().hideTodos}
                            onChange={(e) => updateMsgFilter({ hideTodos: e.currentTarget.checked })} />
                          <span>隐藏待办工具调用</span>
                        </label>
                        <label class="filter-menu-item">
                          <input type="checkbox" checked={msgFilter().hideInternalTools}
                            onChange={(e) => updateMsgFilter({ hideInternalTools: e.currentTarget.checked })} />
                          <span>隐藏内部工具（load_skill 等）</span>
                        </label>
                      </div>
                    </Show>
                  </div>
                  {/* 全部展开 / 折叠思考 */}
                  <button
                    class="icon-btn"
                    classList={{ active: expandAllReasoning() }}
                    onClick={() => setExpandAllReasoning(v => !v)}
                    title={expandAllReasoning() ? '折叠所有思考' : '展开所有思考'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <Show when={expandAllReasoning()} fallback={
                        <>
                          <polyline points="6 9 12 15 18 9"/>
                          <polyline points="6 4 12 10 18 4" opacity="0.4"/>
                        </>
                      }>
                        <polyline points="18 15 12 9 6 15"/>
                        <polyline points="18 20 12 14 6 20" opacity="0.4"/>
                      </Show>
                    </svg>
                  </button>
                  {/* 集成终端切换按钮 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showTerminal() }}
                    onClick={() => {
                      if (!showTerminal()) {
                        void addTerminalTab()
                      } else {
                        setShowTerminal(v => !v)
                      }
                    }}
                    title="终端 (⌘`)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                    </svg>
                  </button>
                  {/* 工作区文件浏览器（预览任意文件） */}
                  <button
                    class="icon-btn"
                    classList={{ active: showExplorer() }}
                    onClick={() => setShowExplorer(v => !v)}
                    title="文件浏览器"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>
                    </svg>
                  </button>
                  {/* Skills 面板 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showSkillsPanel() }}
                    onClick={() => setShowSkillsPanel(v => !v)}
                    title="Skills 技能文档"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 2l2.5 7.5H22l-6 4.5 2.5 7.5L12 17l-6.5 4.5L8 14 2 9.5h7.5z"/>
                    </svg>
                  </button>
                  {/* B3: AI 记忆面板 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showMemoryPanel() }}
                    onClick={() => setShowMemoryPanel(v => !v)}
                    title="AI 记忆（跨会话偏好/约定）"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M9 12l2 2 4-4"/>
                      <path d="M21 12c.552 0 1.005-.45.95-1A10 10 0 0 0 12 2c-5.523 0-10 4.477-10 10 0 5.523 4.477 10 10 10a10 10 0 0 0 9-5.95c.05-.55-.398-1-.95-1z"/>
                    </svg>
                  </button>
                  {/* B4: 项目知识库面板 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showCodebasePanel() }}
                    onClick={() => setShowCodebasePanel(v => !v)}
                    title="项目知识库（架构 / 模块 / API 索引）"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="16 18 22 12 16 6"/>
                      <polyline points="8 6 2 12 8 18"/>
                    </svg>
                  </button>
                  {/* B1: 子代理任务编排面板 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showSubagentPanel() }}
                    onClick={() => setShowSubagentPanel(v => !v)}
                    title="子代理任务编排（task() 派出的并行子代理）"
                    style="position:relative"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="2" y="3" width="20" height="14" rx="2"/>
                      <line x1="8" y1="21" x2="16" y2="21"/>
                      <line x1="12" y1="17" x2="12" y2="21"/>
                    </svg>
                    <Show when={subagentRecords().filter(r => r.status === 'running').length > 0}>
                      <span class="file-badge" style="background:#3b82f6;color:#fff">
                        {subagentRecords().filter(r => r.status === 'running').length}
                      </span>
                    </Show>
                  </button>
                  {/* 变更记录按钮（有变更时显示角标），点击在右侧打开 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showFileTree() }}
                    onClick={() => setShowFileTree(v => !v)}
                    title="变更记录"
                    style="position:relative"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <Show when={changedFiles().size > 0}>
                      <span class="file-badge"><AnimatedNumber value={changedFiles().size} duration={300} /></span>
                    </Show>
                  </button>
                </div>
              </div>

              <Show when={sending()}>
                <div class="progress-bar"><div class="progress-bar-inner" /></div>
              </Show>

              {/* 会话内搜索条（P0-3: Cmd+F） */}
              <Show when={showInChatSearch() && activeSessionId()}>
                <div class="in-chat-search-bar">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    ref={inChatSearchInputRef}
                    class="in-chat-search-input"
                    placeholder="在会话中查找…"
                    value={inChatSearchQuery()}
                    onInput={(e) => { setInChatSearchQuery(e.currentTarget.value); setInChatSearchIdx(0); queueMicrotask(() => { if (inChatSearchHits().length > 0) jumpToSearchHit(0) }) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); closeInChatSearch() }
                      else if (e.key === 'Enter') {
                        e.preventDefault()
                        const hits = inChatSearchHits()
                        if (hits.length === 0) return
                        jumpToSearchHit(e.shiftKey ? inChatSearchIdx() - 1 : inChatSearchIdx() + 1)
                      }
                    }}
                  />
                  <span class="in-chat-search-count">
                    <Show
                      when={inChatSearchHits().length > 0}
                      fallback={<span style="opacity:.55">{inChatSearchQuery() ? '无结果' : ''}</span>}
                    >
                      {inChatSearchIdx() + 1} / {inChatSearchHits().length}
                    </Show>
                  </span>
                  <button
                    class="in-chat-search-btn"
                    title="上一个 (Shift+Enter)"
                    onClick={() => jumpToSearchHit(inChatSearchIdx() - 1)}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
                  </button>
                  <button
                    class="in-chat-search-btn"
                    title="下一个 (Enter)"
                    onClick={() => jumpToSearchHit(inChatSearchIdx() + 1)}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <button class="in-chat-search-btn" title="关闭 (Esc)" onClick={closeInChatSearch}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              </Show>

              <Show
                when={activeSessionId()}
                fallback={
                  <div class="empty-state">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:var(--text-faint)">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <div class="title">开始对话</div>
                    <div class="sub">从左侧选择会话，或点击右上角 ✏ 创建新会话</div>
                  </div>
                }
              >
                <div class="chat-timeline-wrap">
                <div
                  class="chat-timeline"
                  ref={chatTimelineRef}
                  onScroll={(e) => {
                    const el = e.currentTarget
                    // 滚到顶部 80px 内时触发加载更多 + 显示按钮
                    const nearTop = el.scrollTop < 80
                    setIsNearTop(nearTop)
                    if (nearTop && msgHasMore() && !msgLoadingMore()) {
                      void loadMoreMessages()
                    }
                    // 贴底跟踪：用户近底 → 保持 auto-scroll；离底 → 暂停（不打断阅读）
                    const nearBot = isNearBottom(el)
                    stickToBottom = nearBot
                    setIsNearBottomSignal(nearBot)
                  }}
                  onClick={(e) => {
                    const target = e.target as HTMLElement
                    if (!target) return
                    // P0-1: 文件位置跳转
                    const jumpEl = target.closest('[data-file-jump]') as HTMLElement | null
                    if (jumpEl) {
                      e.preventDefault()
                      e.stopPropagation()
                      const file = jumpEl.getAttribute('data-file-jump') ?? ''
                      const line = parseInt(jumpEl.getAttribute('data-line-jump') ?? '0', 10) || undefined
                      if (file) void openPreview(file, { viewMode: 'source', line })
                      return
                    }
                    // P0-2: 应用代码到文件
                    const applyEl = target.closest('[data-apply="1"]') as HTMLElement | null
                    if (applyEl) {
                      e.preventDefault()
                      e.stopPropagation()
                      const b64 = applyEl.getAttribute('data-code-b64') ?? ''
                      const lang = applyEl.getAttribute('data-lang') ?? undefined
                      try {
                        const text = decodeURIComponent(escape(atob(b64)))
                        openApplyToFileDialog(text, lang)
                      } catch {
                        showToast({ message: '代码解码失败', kind: 'error' })
                      }
                    }
                  }}
                >
                  {/* "加载更早的消息" 仅在用户滚到顶部附近时出现；加载完所有历史时给提示 */}
                  <Show when={isNearTop() && messages().length > 0}>
                    <div class="msg-load-more">
                      <Show
                        when={msgLoadingMore()}
                        fallback={
                          <Show
                            when={msgHasMore()}
                            fallback={<span class="msg-load-more-end">— 已是最早的消息 —</span>}
                          >
                            <button class="msg-load-more-btn" onClick={loadMoreMessages}>
                              加载更早的消息
                            </button>
                          </Show>
                        }
                      >
                        <span class="msg-load-more-spinning">加载中…</span>
                      </Show>
                    </div>
                  </Show>
                  {/* @maxian/ui 共享 MessageList — 三端唯一渲染入口 */}
                  <SharedMessageList
                    messages={sharedMessagesStore.messages}
                    renderContent={(text) => <div innerHTML={renderMarkdown(text)} />}
                    getToolLabel={(n) => TOOL_LABELS[n] ?? n}
                    renderAvatar={(role) => {
                      if (role === 'user') {
                        const u = currentUser()
                        return u ? userInitials(u) : '我'
                      }
                      return null  // assistant 走默认 'AI'
                    }}
                    /* edit / multiedit 用红绿 diff 视图替代默认工具卡片 */
                    toolRenderers={{
                      edit:      (p) => EditDiffView(p),
                      multiedit: (p) => EditDiffView(p),
                    }}
                    actions={{
                      onRegenerate: (m) => { void regenerateMessage(m.id) },
                      onFork:       (m) => { void forkFromMessage(m.id) },
                      onDelete:     (m) => { void deleteMessage(m.id) },
                    }}
                    /* 让外层 .chat-timeline 接管 scroll，使 onScroll 能触发滚动跟踪 */
                    externalScrollHost={() => chatTimelineRef}
                    /* 设置面板里的"隐藏 todos / 思考 / 内部工具"开关现在真生效 */
                    filter={msgFilter()}
                    internalToolNames={INTERNAL_TOOL_NAMES}
                    maxRender={800}
                    expandAllReasoning={expandAllReasoning()}
                  />
                  {/* 任务进行中：实时接收计数（直接写 DOM，不走 SolidJS 批更新） */}
                  <Show when={sending()}>
                    <div class="recv-status-bar">
                      <span
                        ref={(el) => {
                          recvDotRef = el
                          if (el && _recvCount > 0) el.classList.add('recv-dot-active')
                        }}
                        class="recv-status-dot"
                      />
                      <span
                        ref={(el) => {
                          recvTextRef = el
                          // 元素创建时立即同步最新状态（避免 Show 渲染滞后）
                          if (el) el.textContent = _recvCount > 0 ? `已接收 ${formatRecv(_recvCount)}` : '等待响应…'
                        }}
                        class="recv-status-text"
                      >等待响应…</span>
                    </div>
                  </Show>
                  <div ref={chatEndRef} />
                </div>
                {/* 浮动"回到底部"按钮：absolute 定位在 wrap 右下角 */}
                <Show when={!isNearBottomSignal()}>
                  <button class="scroll-to-bottom-btn" onClick={scrollChatToBottom} title="回到底部">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                </Show>
                </div>

                {/* Git 状态栏 */}
                <GitStatusBar
                  hasWorkspace={() => !!activeWorkspace()}
                  currentBranch={currentBranch}
                  showBranchPicker={showBranchPicker}
                  branchPickerBranches={branchPickerBranches}
                  branchPickerLoading={branchPickerLoading}
                  branchPickerSearch={branchPickerSearch}
                  setBranchPickerSearch={setBranchPickerSearch}
                  branchPickerRect={branchPickerRect}
                  onOpenPicker={openBranchPicker}
                  onSwitchBranch={switchBranch}
                  onCreateBranch={() => {
                    setShowBranchPicker(false)
                    setShowSettings(true)
                    setSettingsTab("worktree")
                  }}
                  rightSlot={<ProcStats />}
                />

                <div
                  ref={composerWrapRef}
                  class="composer-wrap"
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onDrop={handleDrop}
                >
                  {/* Token 用量条（K10c：抽到 @maxian/ui 的 SharedTokenUsageBar） */}
                  <SharedTokenUsageBar
                    tokenUsed={tokenUsed()}
                    tokenLimit={tokenLimit()}
                    compactDisabled={sending() || !activeSessionId()}
                    onCompact={async () => {
                      const sid = activeSessionId()
                      if (!sid) return
                      try {
                        const c = await getClient()
                        const r = await c.compactSession(sid)
                        const freed = (r as any)?.tokensFreed ?? (r as any)?.freed ?? 0
                        showToast({
                          message: freed > 0 ? `✅ 上下文已压缩，释放约 ${Number(freed).toLocaleString()} tokens` : `✅ 上下文已压缩`,
                          kind: 'info',
                          duration: 3000,
                        })
                      } catch (e) {
                        showToast({ message: `压缩失败：${(e as Error).message}`, kind: 'error', duration: 4000 })
                      }
                    }}
                  />

                  {/* 上下文压缩进行中 banner */}
                  <CompactingBanner state={compactingState} />

                  {/* Rate-limit 重试提示（P0-6） */}
                  <RateLimitBanner
                    state={rateLimit}
                    onCancel={() => {
                      setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
                      void cancel()
                    }}
                  />

                  {/* Session revert dock（P1-11） */}
                  <Show when={showRevertDock()}>
                    <RevertDock
                      messages={messages}
                      onClose={() => setShowRevertDock(false)}
                      onRevertTo={(id) => void revertToMessage(id)}
                    />
                  </Show>

                  {/* Todo 跟踪面板（P0-1）
                      显示条件：有 todos 且（还有未完成 OR AI 提前结束未收尾）。
                      所有 todo 都 completed/cancelled → 立即隐藏，不再等 sending 结束
                      （AI 收尾打字期间继续显示已全勾的清单是噪声）。 */}
                  <Show when={todos().length > 0 && (
                    todosLeftover() ||
                    todos().some(t => t.status === 'in_progress' || t.status === 'pending')
                  )}>
                    <TodoDock
                      todos={todos}
                      leftover={todosLeftover}
                      collapsed={todoDockCollapsed}
                      setCollapsed={(v) => setTodoDockCollapsed(v as any)}
                    />
                  </Show>

                  {/* Followup 建议队列（P0-2） */}
                  <Show when={followupSuggestions().length > 0 || followupQueue().length > 0}>
                    <FollowupDock
                      suggestions={followupSuggestions}
                      queue={followupQueue}
                      collapsed={followupCollapsed}
                      sending={sending}
                      setCollapsed={(v) => setFollowupCollapsed(v as any)}
                      setInput={(s) => setInput(s)}
                      setQueue={(updater) => setFollowupQueue(updater)}
                      setSuggestions={(updater) => setFollowupSuggestions(updater)}
                      send={() => send()}
                    />
                  </Show>

                  {/* Slash / @ 面板通过 fixed 定位渲染（已在 body 级别，无需特殊包装） */}

                  <div class="composer-inner" style={{ height: composerHeight() ? `${composerHeight()}px` : undefined }}>
                    {/* 顶部拖条：用户拖拽调整 composer 高度（最高占整窗 1/3） */}
                    <div
                      class="composer-resize-handle"
                      title="拖动调整输入框高度"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        const startY = e.clientY
                        const startH = composerHeight() ?? (textareaRef?.offsetHeight ? textareaRef.offsetHeight + 60 : 100)
                        const maxH = Math.floor(window.innerHeight / 3)
                        const onMove = (mv: MouseEvent) => {
                          const dy = startY - mv.clientY  // 往上拖 dy>0 → 高度增
                          setComposerHeight(Math.max(120, Math.min(maxH, startH + dy)))
                        }
                        const onUp = () => {
                          window.removeEventListener('mousemove', onMove)
                          window.removeEventListener('mouseup', onUp)
                        }
                        window.addEventListener('mousemove', onMove)
                        window.addEventListener('mouseup', onUp)
                      }}
                    />
                    {/* 图片附件预览 */}
                    <Show when={attachedImages().length > 0}>
                      <div class="image-attachments">
                        <For each={attachedImages()}>
                          {(img) => (
                            <div class="image-attachment-item">
                              <img src={img.dataUrl} class="image-attachment-thumb" alt={img.name} />
                              <button class="image-remove-btn" onClick={() => removeImage(img.id)} title="移除">×</button>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <textarea
                      ref={textareaRef}
                      class="composer-textarea"
                      value={input()}
                      onInput={(e) => onInputChange(e.currentTarget.value)}
                      onKeyDown={onKeyDown}
                      onPaste={handlePaste}
                      placeholder={globalMode() === 'code'
                        ? "描述你要完成的编码任务… (⌘↵ 发送, / 命令)"
                        : "提问或描述你的问题… (⌘↵ 发送, / 命令)"}
                      disabled={sending()}
                    />
                    <div class="composer-footer">
                      <div style="display:flex;gap:6px;align-items:center">
                        {/* 模式选择器：仅 Code 模式显示 */}
                        <Show when={globalMode() === 'code'}>
                          <ModeSelector
                            currentMode={composerMode}
                            showDropdown={showModeDropdown}
                            setShowDropdown={setShowModeDropdown}
                            onSelectMode={onSelectComposerMode}
                          />
                        </Show>
                        {/* 图片上传按钮 */}
                        <label class="attach-image-btn" title="附加图片 (也可直接粘贴)">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <polyline points="21 15 16 10 5 21"/>
                          </svg>
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            style="display:none"
                            onChange={(e) => {
                              const files = e.currentTarget.files
                              if (files) for (const f of files) handleImageFile(f)
                              e.currentTarget.value = ""
                            }}
                          />
                        </label>
                        <span class="composer-hint">
                          <Show when={vimEnabled()}>
                            <span class={`vim-mode-indicator vim-mode-${vimMode()}`}>
                              {vimMode() === 'normal' ? '-- NORMAL --' : vimMode() === 'visual' ? '-- VISUAL --' : '-- INSERT --'}
                            </span>
                          </Show>
                          <Show when={sending()}>正在生成回复…</Show>
                        </span>
                      </div>
                      <div style="display:flex;gap:6px;align-items:center">
                        <Show when={sending()}>
                          <button
                            class="btn btn-ghost"
                            onMouseDown={(e) => { e.preventDefault(); void cancel() }}
                          >停止 (Esc)</button>
                        </Show>
                        <button
                          class="btn btn-primary"
                          onMouseDown={(e) => {
                            // preventDefault 阻止 textarea blur（防止中间状态触发重渲染导致 click 丢失）
                            e.preventDefault()
                            if (!sending() && input().trim()) void send()
                          }}
                          disabled={sending() || !input().trim()}
                        >
                          <Show when={!sending()} fallback={
                            <><span class="spinner" style="width:12px;height:12px;border-width:1.5px;border-color:rgba(255,255,255,0.3);border-top-color:#fff" />回复中</>
                          }>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                            </svg>
                            发送
                          </Show>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </Show>

              {/* 集成终端面板（K10b：抽到 @maxian/ui 的 SharedTerminalPanel）
                  用 CSS display 控制可见性，避免 DOM 卸载导致 xterm canvas 丢失 */}
              <div style={showTerminal() ? '' : 'display:none'}>
                <SharedTerminalPanel
                  allTabs={terminalTabs()}
                  sessionTabs={terminalTabs().filter(t => t.sessionId === (activeSessionId() ?? '__global__'))}
                  activeTermId={activeTermId()}
                  collapsed={terminalCollapsed()}
                  height={terminalHeight()}
                  onResizeStart={onTerminalResizeStart}
                  onSwitchTab={switchTerminalTab}
                  onCloseTab={closeTerminalTab}
                  onAddTab={addTerminalTab}
                  onToggleCollapse={() => setTerminalCollapsed(v => !v)}
                  onClose={() => {
                    // 仅关闭当前会话的终端
                    const sess = terminalTabs().filter(t => t.sessionId === (activeSessionId() ?? '__global__'))
                    for (const tab of sess) closeTerminalTab(tab.id, new MouseEvent('click'))
                    setShowTerminal(false)
                  }}
                />
              </div>
            </main>
            {/* 工作区文件浏览器（右侧） */}
            <Show when={showExplorer()}>
              <WorkspaceExplorerPanel
                files={() => wsFileCache()?.files ?? []}
                loading={wsFileCacheLoading}
                changedFiles={changedFiles}
                expandedDirs={expandedDirs}
                search={explorerSearch}
                setSearch={setExplorerSearch}
                toggleDir={toggleDir}
                onClose={() => setShowExplorer(false)}
                onOpenPreview={(p) => void openPreview(p)}
              />
            </Show>
            {/* Skills 面板（右侧） */}
            <Show when={showSkillsPanel()}>
              <SkillsPanel
                skills={skillsList}
                searchedDirs={skillsSearchedDirs}
                loading={skillsLoading}
                onClose={() => setShowSkillsPanel(false)}
                onReload={loadSkills}
                onOpenPreview={(p) => void openPreview(p)}
              />
            </Show>
            {/* 会话上下文面板（右侧，P1-10） */}
            <Show when={showContextPanel()}>
              <ContextPanel
                contextFiles={contextFiles}
                attachedImages={attachedImages}
                changedFiles={changedFiles}
                onClose={() => setShowContextPanel(false)}
                onOpenPreview={(p, opts) => void openPreview(p, opts as any)}
                onRemoveImage={(id) => removeImage(id)}
              />
            </Show>
            {/* B1: 子代理任务编排面板（右侧） */}
            <SubagentDashboard
              visible={showSubagentPanel}
              records={subagentRecords}
              loading={subagentLoading}
              statusFilter={subagentStatusFilter}
              setStatusFilter={(s) => setSubagentStatusFilter(s)}
              activeSessionId={() => activeSessionId() ?? null}
              sessionTitle={(sid) => sessions().find(s => s.id === sid)?.title ?? ''}
              onClose={() => setShowSubagentPanel(false)}
              onRefresh={loadSubagents}
              onCancel={async (taskId) => {
                try {
                  const c = await getClient()
                  await c.cancelSubagent(taskId)
                  showToast({ message: '已发送取消信号', kind: 'info', duration: 2500 })
                  await loadSubagents()
                } catch (e) {
                  pushError('subagent', `取消失败：${(e as Error).message}`)
                }
              }}
              onOpenSession={(sessionId) => {
                void selectSession(sessionId)
                setShowSubagentPanel(false)   // 跳转后自动关面板
              }}
            />
            {/* B4: 项目知识库面板（右侧，架构/模块/API） */}
            <CodebaseIndexPanel
              visible={showCodebasePanel}
              snapshot={codebaseSnapshot}
              loading={codebaseLoading}
              progress={codebaseProgress}
              tab={codebaseTab}
              setTab={(t) => setCodebaseTab(t)}
              searchQuery={codebaseSearchQuery}
              setSearchQuery={(q) => setCodebaseSearchQuery(q)}
              searchHits={codebaseSearchHits}
              searchLoading={codebaseSearchLoading}
              onClose={() => setShowCodebasePanel(false)}
              onRefresh={refreshCodebaseIndexUI}
              onSearch={searchCodebaseUI}
              onOpenFile={(p, line) => void openPreview(p, line ? { viewMode: 'source', line } : { viewMode: 'source' })}
              renderMarkdown={renderMarkdown}
            />
            {/* B3: AI 记忆面板（右侧，跨会话偏好/约定） */}
            <MemoryPanel
              visible={showMemoryPanel}
              records={memoryRecords}
              loading={memoryLoading}
              scopeFilter={memoryScopeFilter}
              setScopeFilter={(s) => setMemoryScopeFilter(s)}
              categoryFilter={memoryCategoryFilter}
              setCategoryFilter={(c) => setMemoryCategoryFilter(c)}
              searchQuery={memorySearchQuery}
              setSearchQuery={(q) => setMemorySearchQuery(q)}
              onClose={() => setShowMemoryPanel(false)}
              onRefresh={loadMemories}
              onSearch={searchMemoriesUI}
              onToggleStarred={async (id, starred) => {
                try {
                  const c = await getClient()
                  await c.setMemoryStarred(id, starred)
                  await loadMemories()
                } catch (e) {
                  pushError('memory', `标星失败：${(e as Error).message}`)
                }
              }}
              onEdit={async (id, content, category) => {
                try {
                  const c = await getClient()
                  await c.updateMemory(id, { content, category })
                  await loadMemories()
                } catch (e) {
                  pushError('memory', `编辑失败：${(e as Error).message}`)
                }
              }}
              onDelete={async (id) => {
                try {
                  const c = await getClient()
                  await c.deleteMemory(id)
                  await loadMemories()
                } catch (e) {
                  pushError('memory', `删除失败：${(e as Error).message}`)
                }
              }}
              onCreate={async (input) => {
                try {
                  const c = await getClient()
                  await c.createMemory({
                    scope:       input.scope,
                    workspaceId: input.scope === 'workspace' ? activeWorkspace()?.id : undefined,
                    sessionId:   input.scope === 'session'   ? (activeSessionId() ?? undefined) : undefined,
                    category:    input.category,
                    content:     input.content,
                    source:      'manual',
                  })
                  await loadMemories()
                  showToast({ message: '已添加记忆', kind: 'success', duration: 2000 })
                } catch (e) {
                  pushError('memory', `添加失败：${(e as Error).message}`)
                }
              }}
              onClear={async (scope) => {
                try {
                  const c = await getClient()
                  const filter: { scope?: import('@maxian/sdk').MemoryScope; workspaceId?: string; sessionId?: string } = {}
                  if (scope !== 'all') filter.scope = scope
                  if (scope === 'workspace') filter.workspaceId = activeWorkspace()?.id
                  if (scope === 'session') filter.sessionId = activeSessionId() ?? undefined
                  const r = await c.clearMemories(Object.keys(filter).length > 0 ? filter : undefined)
                  await loadMemories()
                  showToast({ message: `已清空 ${r.removed} 条`, kind: 'success', duration: 2500 })
                } catch (e) {
                  pushError('memory', `清空失败：${(e as Error).message}`)
                }
              }}
            />
            {/* 变更记录面板（K10e：抽到 @maxian/ui 的 SharedFileChangesPanel） */}
            <Show when={showFileTree()}>
              <SharedFileChangesPanel
                files={Array.from(changedFiles().values())}
                onClose={() => setShowFileTree(false)}
                onOpenPreview={(p, opts) => openPreview(p, opts as any)}
                onOpenInEditor={(p) => openInEditor(p)}
                onRevert={(p) => revertFile(p)}
              />
            </Show>
            {/* 文件预览面板（右侧滑入，多标签） */}
            <Show when={previewTabs().length > 0}>
              <FilePreviewPanel
                tabs={previewTabs}
                activePath={activePreviewPath}
                width={previewWidth}
                diffViewMode={diffViewMode}
                renderMarkdown={renderMarkdown}
                setActivePath={(p) => setActivePreviewPath(p)}
                setWidth={(w) => setPreviewWidth(w)}
                setTabs={(updater) => setPreviewTabs(updater)}
                setDiffViewMode={(m) => setDiffViewMode(m)}
                closeTab={(p) => closePreviewTab(p)}
                setTabViewMode={(p, m) => setTabViewMode(p, m)}
                openInEditor={(p) => void openInEditor(p)}
                revertFile={(p) => void revertFile(p)}
                reloadPreview={(p) => void reloadPreview(p)}
                clearAllTabs={() => { setPreviewTabs([]); setActivePreviewPath(null) }}
              />
            </Show>
          </div>
        </div>
      </Show>

      {/* 键盘快捷键速查面板（⌘/） */}
      <Show when={showKeybindHelp()}>
        <KeybindHelpModal
          search={keybindSearch}
          setSearch={setKeybindSearch}
          onClose={() => setShowKeybindHelp(false)}
        />
      </Show>

      {/* 全局命令面板（⌘P） */}
      <Show when={showCmdPalette()}>
        <GlobalCommandPalette
          query={cmdPaletteQuery}
          setQuery={setCmdPaletteQuery}
          items={cmdPaletteItems}
          idx={cmdPaletteIdx}
          setIdx={setCmdPaletteIdx}
          loading={cmdPaletteLoading}
          onClose={() => setShowCmdPalette(false)}
        />
      </Show>

      {/* 全局 Toast 宿主 */}
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </>
  )
}
