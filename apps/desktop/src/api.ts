import { MaxianClient } from "@maxian/sdk"

/** 默认 fallback（Rust 端拿不到 server_info 时用）。Rust 默认端口 51847，
 *  被占时会自动 fallback 找空闲端口，实际值可能不同 —— 永远优先 invoke 拿真实值。 */
export const BASE = (import.meta.env.VITE_MAXIAN_URL as string) || "http://127.0.0.1:51847"
export const USER = (import.meta.env.VITE_MAXIAN_USER as string) || "maxian"
export const PASS = (import.meta.env.VITE_MAXIAN_PASS as string) || "test123"

/** 解析后的真实 sidecar 配置（invoke server_info 拿到的）。 */
let resolvedInfo: { baseUrl: string; username: string; password: string } | null = null

/** 通过 Tauri invoke 拿 sidecar 真实 baseUrl/认证（端口可能被 Rust 端 fallback 改过）。
 *  - Tauri 环境：第一次成功后 cache，后续直接返回
 *  - 非 Tauri 环境（浏览器 dev）：返回 null，caller 走 BASE/USER/PASS 默认值 */
async function getServerInfo(): Promise<{ baseUrl: string; username: string; password: string } | null> {
  if (resolvedInfo) return resolvedInfo
  if (!(window as any).__TAURI_INTERNALS__) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core' as any)
    const info = await (invoke as any)('server_info') as { baseUrl?: string; username?: string; password?: string; port?: number } | null
    if (info && info.baseUrl) {
      resolvedInfo = {
        baseUrl:  info.baseUrl,
        username: info.username ?? USER,
        password: info.password ?? PASS,
      }
      console.log(`[maxian] sidecar 实际地址: ${resolvedInfo.baseUrl}`)
      return resolvedInfo
    }
  } catch (e) {
    console.warn('[maxian] invoke server_info 失败，用默认 BASE:', e)
  }
  return null
}

/** 返回当前已解析的 sidecar base（拿不到则返回默认 BASE）。供 browser proxy 等拼 URL 用。 */
export function resolvedBase(): string {
  return resolvedInfo?.baseUrl ?? BASE
}

// ─── server-ready 事件：Rust 在 sidecar 握手完成后主动推送实际端口 ──────────────
// 端口由 OS 动态分配（--port 0），Rust 解析 sidecar 的 __MAXIAN_READY__ 握手后 emit 此事件。
// 监听它 = 第一时间锁定正确端口，不再依赖轮询 server_info 的时序（修复"动态端口连不上、
// 一直连 51847"）。轮询 server_info 仍作兜底（事件可能在监听器注册前就发出）。
let _serverReadyListening = false
export function listenServerReady(): void {
  if (_serverReadyListening) return
  if (!(window as any).__TAURI_INTERNALS__) return
  _serverReadyListening = true
  import('@tauri-apps/api/event' as any)
    .then(({ listen }: any) => listen('maxian:server-ready', (e: any) => {
      const port = e?.payload?.port
      const baseUrl = e?.payload?.baseUrl ?? (port ? `http://127.0.0.1:${port}` : null)
      if (baseUrl) {
        resolvedInfo = { baseUrl, username: USER, password: PASS }
        _client = null   // 丢弃旧 client，下次 getClient 用新端口重建
        console.log('[maxian] 收到 server-ready，锁定 sidecar 实际地址: ' + baseUrl)
      }
    }))
    .catch((e: any) => { _serverReadyListening = false; console.warn('[maxian] 监听 server-ready 失败:', e) })
}

// ─── 本地凭据存储（localStorage） ───────────────────────────────────────────
const CRED_KEY = "maxian_credentials"

export interface SavedCredentials {
  apiUrl: string
  username: string
  password: string
  userInfo: UserInfo
  rememberMe: boolean
}

export interface UserInfo {
  id: string
  userName: string
  nickName?: string
  email?: string
  avatar?: string
  agentPermission?: string[]
}

export function loadSavedCredentials(): SavedCredentials | null {
  try {
    const raw = localStorage.getItem(CRED_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SavedCredentials
  } catch {
    return null
  }
}

export function saveCredentials(creds: SavedCredentials): void {
  localStorage.setItem(CRED_KEY, JSON.stringify(creds))
}

export function clearCredentials(): void {
  localStorage.removeItem(CRED_KEY)
}

// ─── Tauri plugin-http fetch（绕过 webview CORS） ──────────────────────────
async function makeFetch(): Promise<typeof fetch> {
  try {
    // @ts-ignore
    if ((window as any).__TAURI_INTERNALS__) {
      const mod = await import("@tauri-apps/plugin-http")
      return mod.fetch as unknown as typeof fetch
    }
  } catch (e) {
    console.warn("[maxian] tauri http plugin unavailable, fallback to native fetch", e)
  }
  return fetch
}

let _client: MaxianClient | null = null

export async function getClient(): Promise<MaxianClient> {
  listenServerReady()   // 幂等：确保已挂上 server-ready 监听，第一时间拿到动态端口
  if (_client) return _client
  const f = await makeFetch()
  // 先尝试通过 invoke 拿真实 sidecar 配置（端口可能被 Rust 端 fallback）；拿不到走默认值
  const info = await getServerInfo()
  const baseUrl  = info?.baseUrl  ?? BASE
  const username = info?.username ?? USER
  const password = info?.password ?? PASS
  _client = new MaxianClient({ baseUrl, username, password, fetch: f })
  return _client
}

/** 重置缓存的 client + 已解析端口：启动重试时调用，强制下次 getClient 重新 invoke server_info 拿最新端口。
 *  应对启动竞态：sidecar 还没把实际端口写入 Rust state 时 getServerInfo 会拿到默认端口；
 *  或 sidecar fallback 换了端口、或残留旧 sidecar 被换掉——重置后重新解析即可连上正确端口。 */
export function resetClient(): void {
  _client = null
  resolvedInfo = null
}

// 启动超时放宽到 25s：Windows 刚开机后首次启动，Defender 扫描 60MB sidecar binary + 系统繁忙，
// sidecar 起来可能较慢；超时太短会误判失败弹错误框。
export async function waitForServer(maxMs = 25000, intervalMs = 300): Promise<void> {
  let c = await getClient()
  let usedBase = resolvedInfo?.baseUrl ?? BASE
  const start = Date.now()
  let lastErr: unknown = null
  let attempts = 0
  while (Date.now() - start < maxMs) {
    attempts++
    // 每轮都重取 client：若 server-ready 事件已把 _client 置空并锁定新端口，这里立刻生效
    c = await getClient()
    usedBase = resolvedInfo?.baseUrl ?? BASE
    try {
      const r = await c.health()
      if (r.ok) {
        console.log(`[maxian] server ready in ${Date.now() - start}ms (${attempts} attempts) @ ${usedBase}`)
        return
      }
    } catch (e) {
      lastErr = e
      if (attempts <= 3) console.warn(`[maxian] health attempt ${attempts} failed:`, e)
    }
    // 轮询兜底：每 5 次失败强制重新 invoke server_info 解析端口（应对 server-ready 事件
    // 在监听器注册前就发出、被错过的情况）。事件命中时上面的 getClient 已用新端口，无需等这里
    if (attempts % 5 === 0) {
      resetClient()
      console.warn(`[maxian] 重新解析 sidecar 端口（轮询兜底） @ ${usedBase}`)
    }
    await new Promise((res) => setTimeout(res, intervalMs))
  }
  throw new Error(
    `无法连接到 Maxian Server: ${usedBase}\n最后错误: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

/**
 * 验证用户凭据，调用码弦后端 checkUser 接口。
 * 使用 Tauri plugin-http 发出请求（跳过 CORS 限制）。
 */
export async function loginCheck(
  apiUrl: string,
  username: string,
  password: string,
): Promise<UserInfo> {
  const f = await makeFetch()
  const base = apiUrl.replace(/\/$/, "")
  const url = `${base}/knowledge/appCustomer/checkUser?userName=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  const res = await f(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  })
  if (!res.ok) {
    throw new Error(`服务器错误 ${res.status}，请检查服务器地址是否正确`)
  }
  const json = await res.json() as { code: number; msg?: string; data?: UserInfo }
  if (json.code !== 200) {
    throw new Error(json.msg || "用户名或密码错误")
  }
  if (!json.data || typeof json.data !== "object") {
    throw new Error("登录响应格式异常")
  }
  const raw = json.data as any
  return {
    id: raw.id ?? "",
    userName: raw.userName ?? username,
    nickName: raw.nickName,
    email: raw.email,
    avatar: raw.avatar,
    agentPermission: raw.agentPermission
      ? String(raw.agentPermission).split(",").map((s: string) => s.trim()).filter(Boolean)
      : undefined,
  }
}

/**
 * 将登录凭据推送到 maxian-server 的 /auth/configure，让服务端以此调用 AI 代理。
 * 用户名和密码均以 base64 编码传输（与 AiProxyHandler 规范一致）。
 */
export async function configureServerAi(apiUrl: string, username: string, password: string): Promise<void> {
  const c = await getClient()
  await c.configureAi({
    apiUrl,
    username: btoa(username),
    password: btoa(password),
  })
}

/** 清除服务端 AI 配置（登出时调用） */
export async function clearServerAi(): Promise<void> {
  const c = await getClient()
  await c.clearAiConfig()
}
