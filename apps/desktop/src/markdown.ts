/**
 * Markdown → sanitized HTML
 * Uses marked for parsing + DOMPurify for XSS sanitization.
 */
import { marked, type Renderer, type Tokens, type Token } from "marked"
import DOMPurify from "dompurify"
import hljs from "highlight.js/lib/common"

// ─── K-Perf #3：超大代码块跳过 hljs ──────────────────────────────────────
// hljs.highlightAuto 会试 11 种语言、对长文本可能 200-500ms 同步阻塞。
// 流式中 AI 一边输出代码一边触发解析，每帧都重新高亮整个不断增长的代码块，
// 主线程立刻被吃满 → Windows "(未响应)"。
//
// 两类代码块跳过高亮（仅做 HTML 转义）：
//   1. 未闭合的 fence（流式中 ``` 还没出现配对的 ```）—— 流式特征
//   2. 闭合但 > HUGE_CODE_LIMIT 的代码块 —— 极端长代码（如生成大段 JSON / 完整文件）
//
// 这两种场景下，"无高亮的可读 pre"远胜于"高亮的卡死"。
const HUGE_CODE_LIMIT = 8 * 1024

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ─── 自定义渲染器：代码块带语法高亮 + 复制按钮 ────────────────────────
const renderer: Partial<Renderer> = {
  code(token: Tokens.Code): string {
    const text = token.text
    const lang = token.lang
    // walkTokens 钩子（见下方 marked.use）会给未闭合的 fence token 打标记。
    const isIncomplete = (token as Tokens.Code & { __incomplete?: boolean }).__incomplete === true
    const isHuge       = text.length > HUGE_CODE_LIMIT
    const skipHighlight = isIncomplete || isHuge

    // 用 highlight.js 高亮（已知 lang 走指定语言，未知走 auto-detect）
    let highlighted: string
    let detectedLang = lang ?? ''
    if (skipHighlight) {
      highlighted = escapeHtml(text)
    } else {
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        } else {
          const auto = hljs.highlightAuto(text)
          highlighted = auto.value
          if (!detectedLang && auto.language) detectedLang = auto.language
        }
      } catch {
        // 高亮失败回退原文（HTML 转义）
        highlighted = escapeHtml(text)
      }
    }
    const langClass = detectedLang ? ` class="language-${detectedLang} hljs"` : ' class="hljs"'
    const langLabel = detectedLang ? `<span class="code-block-lang">${detectedLang}</span>` : ''
    const b64 = btoa(unescape(encodeURIComponent(text)))
    return `<div class="code-block-wrap">
  <div class="code-block-header">
    ${langLabel}
    <div style="flex:1"></div>
    <button class="code-copy-btn" data-code-b64="${b64}" title="复制" onclick="
      const btn=this;
      try {
        const b=btn.getAttribute('data-code-b64');
        const text=decodeURIComponent(escape(atob(b)));
        navigator.clipboard.writeText(text).then(()=>{
          btn.classList.add('copied');
          setTimeout(()=>{btn.classList.remove('copied')},1500)
        })
      } catch(e) {}
    ">
      <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>
        <rect x='9' y='9' width='13' height='13' rx='2' ry='2'/>
        <path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/>
      </svg>
    </button>
  </div>
  <pre><code${langClass}>${highlighted}</code></pre>
</div>`
  },
}

marked.use({
  renderer,
  // K-Perf #3：在 token 阶段就识别未闭合 fence，给 token 打 __incomplete 标记，
  // renderer.code 据此跳过 hljs 高亮（流式中 AI 一边输出代码、fence 还没闭合时
  // 反复同步高亮是主线程被吃满的元凶之一）。
  walkTokens(token: Token) {
    if (token.type !== 'code') return
    const t = token as Tokens.Code & { __incomplete?: boolean }
    // 缩进代码块（4 空格）不存在"未闭合"，正常高亮
    if (t.codeBlockStyle === 'indented') return
    const raw = t.raw ?? ''
    const trimmed = raw.trimEnd()
    // marked 不会主动补 closing fence；raw 不以 ``` / ~~~ 结尾即视为未闭合
    if (!trimmed.endsWith('```') && !trimmed.endsWith('~~~')) {
      t.__incomplete = true
    }
  },
})

// Configure marked: GitHub-style, sync rendering
marked.setOptions({
  gfm: true,        // GitHub Flavored Markdown (tables, strikethrough, etc.)
  breaks: true,     // Newlines → <br> (like chat apps)
})

/**
 * 将文本节点中的 `file.ext:42[:col]` 模式替换为可点击的跳转链接。
 * 不会处理 <pre>、<code>、<a> 内部文本（保留代码块原貌）。
 */
function linkifyFilePaths(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
    const root = doc.body.firstChild as HTMLElement
    if (!root) return html
    const FILE_PATTERN = /([A-Za-z_][\w\-.\/]*\.[A-Za-z0-9]{1,6})(?::(\d+))(?::(\d+))?/g
    const walk = (el: Element) => {
      const tag = el.tagName
      if (tag === 'PRE' || tag === 'CODE' || tag === 'A' || tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE') return
      const children = Array.from(el.childNodes)
      for (const child of children) {
        if (child.nodeType === 3 /* TEXT_NODE */) {
          const text = child.textContent ?? ''
          if (!text || text.length < 4) continue
          if (!/[A-Za-z]\.[A-Za-z0-9]{1,6}:\d/.test(text)) continue
          FILE_PATTERN.lastIndex = 0
          let last = 0
          const frag = doc.createDocumentFragment()
          let m: RegExpExecArray | null
          let replaced = false
          while ((m = FILE_PATTERN.exec(text)) !== null) {
            const file = m[1]
            // 排除版本号、URL、纯数字等误判
            if (/^(https?|ftp|file|data):/.test(file)) continue
            if (file.length > 300) continue
            if (!/[\/.]/.test(file)) continue
            // 跳过 "1.0:3"、"v2.0:5" 之类（扩展名部分必须含字母）
            const ext = file.split('.').pop() ?? ''
            if (!/^[A-Za-z]/.test(ext)) continue
            replaced = true
            if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)))
            const span = doc.createElement('span')
            span.className = 'file-jump-link'
            span.setAttribute('data-file-jump', file)
            span.setAttribute('data-line-jump', m[2])
            if (m[3]) span.setAttribute('data-col-jump', m[3])
            span.textContent = m[0]
            frag.appendChild(span)
            last = m.index + m[0].length
          }
          if (replaced) {
            if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)))
            child.parentNode?.replaceChild(frag, child)
          }
        } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
          walk(child as Element)
        }
      }
    }
    walk(root)
    return root.innerHTML
  } catch {
    return html
  }
}

const SANITIZE_OPTS = {
  ALLOWED_TAGS: [
    "p", "br", "strong", "em", "del", "code", "pre",
    "ul", "ol", "li", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td",
    "a", "hr", "span", "div", "button",
    "img",  // 图像生成输出（P1-16）
  ],
  ALLOWED_ATTR: [
    "href", "class", "target", "rel",
    "data-code", "data-code-b64", "data-apply", "data-lang",
    "data-file-jump", "data-line-jump", "data-col-jump",
    "onclick", "src", "alt", "title", "style",
  ],
  // 允许 data:image/* URI 用于 AI 生成/返回的图像
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml));|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

function renderPipeline(text: string): string {
  const raw = marked.parse(text) as string
  const linkified = linkifyFilePaths(raw)
  return DOMPurify.sanitize(linkified, SANITIZE_OPTS)
}

// ─── K-Perf：稳定段落 HTML 缓存 ──────────────────────────────────────────
// 流式渲染期间，每个 token 到来都会整篇重新 marked.parse + DOMParser 遍历 +
// DOMPurify。一条 60KB 的消息按 20 token/s 速率，一秒内会跑 20 次完整管线，
// 把 webview 主线程跑满 → Windows "(未响应)"。
// 优化思路：找到最后一个不在围栏代码块内的 `\n\n` 边界，之前的"稳定前缀"
// 按内容哈希缓存 HTML，只对边界后的"尾段"（通常 < 一段）重新 parse。
const STABLE_PREFIX_THRESHOLD = 4 * 1024   // 短文本走全量，免增量开销
const STABLE_PREFIX_CACHE_MAX = 200
const stablePrefixCache = new Map<string, string>()

/**
 * 找文本中最后一个**不在围栏代码块内**的段落分隔（连续 `\n\n+`），
 * 返回其结束位置（含尾部所有连续 `\n`）。找不到返回 0。
 *
 * 围栏检测：行首 ``` 切换状态（不严格处理 ~~~ 与缩进围栏，对 chat 输出足够）。
 */
function findStablePrefixEnd(text: string): number {
  let inFence = false
  let i = 0
  let lastEnd = 0
  const n = text.length
  while (i < n) {
    if ((i === 0 || text.charCodeAt(i - 1) === 10 /* \n */) &&
        text.charCodeAt(i) === 96 /* ` */ &&
        text.charCodeAt(i + 1) === 96 &&
        text.charCodeAt(i + 2) === 96) {
      inFence = !inFence
      const nl = text.indexOf('\n', i)
      if (nl === -1) break
      i = nl + 1
      continue
    }
    if (!inFence && text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10) {
      let j = i + 2
      while (j < n && text.charCodeAt(j) === 10) j++
      lastEnd = j
      i = j
      continue
    }
    i++
  }
  return lastEnd
}

/** FNV-1a 32-bit hash，足以做大段文本去重 key。*/
function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export type MarkdownSplit = {
  stableHtml: string
  tailHtml:   string
  /** 稳定前缀的指纹；推进到新边界时变化，否则保持不变 */
  stableKey:  string
}

/**
 * 把 text 拆成"稳定前缀 HTML + 尾段 HTML + 稳定 key"。
 * - 稳定前缀按 key 缓存（FIFO 上限 200）。
 * - 尾段每次重渲（通常 < 一段话）。
 * - 短文本（< 4KB）或找不到 \n\n 边界时，全段当 tail 走全量。
 *
 * 这是 updateMarkdownInto 的底层渲染器，也作为 renderMarkdown 字符串接口的实现。
 */
export function renderMarkdownSplit(text: string): MarkdownSplit {
  if (!text) return { stableHtml: '', tailHtml: '', stableKey: '' }
  if (text.length < STABLE_PREFIX_THRESHOLD) {
    return { stableHtml: '', tailHtml: renderPipeline(text), stableKey: '__short' }
  }
  const splitAt = findStablePrefixEnd(text)
  if (splitAt === 0) {
    return { stableHtml: '', tailHtml: renderPipeline(text), stableKey: '__nosplit' }
  }
  const stable = text.slice(0, splitAt)
  const stableKey = `${fnv1a32(stable).toString(36)}:${stable.length}`
  let stableHtml = stablePrefixCache.get(stableKey)
  if (stableHtml === undefined) {
    stableHtml = renderPipeline(stable)
    if (stablePrefixCache.size >= STABLE_PREFIX_CACHE_MAX) {
      const firstKey = stablePrefixCache.keys().next().value
      if (firstKey !== undefined) stablePrefixCache.delete(firstKey)
    }
    stablePrefixCache.set(stableKey, stableHtml)
  }
  const tail = text.slice(splitAt)
  const tailHtml = tail ? renderPipeline(tail) : ''
  return { stableHtml, tailHtml, stableKey }
}

/** Render markdown string to safe HTML string */
export function renderMarkdown(text: string): string {
  if (!text) return ""
  const split = renderMarkdownSplit(text)
  return split.stableHtml + split.tailHtml
}

// ─── K-Perf #1：稳定 host 就地更新 ────────────────────────────────────────
// SolidJS `<div innerHTML={renderMarkdown(text)} />` 这种写法每次 text 变化
// 都会**创建新的 div 元素 + 替换整棵 DOM 子树**。哪怕 HTML 字符串已经命中
// stablePrefixCache，浏览器还是要重新 parse 整段 HTML 串并重建 DOM。
//
// 这里改成：调用方持有一个稳定的 host 元素，每次 text 变化调 updateMarkdownInto。
// 内部维护 stableEl + tailEl 两个子 div：stable 段命中缓存时**完全不动 DOM**，
// 仅 tail 段更新 innerHTML（且 tail 通常 < 一段话）。
const HOST_STATE = Symbol('mu-md-host-state')
interface HostState {
  stableEl:      HTMLDivElement
  tailEl:        HTMLDivElement
  prevStableKey: string
  prevTailHtml:  string
}

export function updateMarkdownInto(host: HTMLElement, text: string): void {
  let state = (host as unknown as Record<symbol, HostState | undefined>)[HOST_STATE]
  if (!state) {
    host.innerHTML = ''
    const stableEl = document.createElement('div')
    stableEl.className = 'mu-md-stable'
    const tailEl = document.createElement('div')
    tailEl.className = 'mu-md-tail'
    host.appendChild(stableEl)
    host.appendChild(tailEl)
    state = { stableEl, tailEl, prevStableKey: '', prevTailHtml: '' }
    ;(host as unknown as Record<symbol, HostState>)[HOST_STATE] = state
  }
  const split = renderMarkdownSplit(text)
  if (split.stableKey !== state.prevStableKey) {
    state.stableEl.innerHTML = split.stableHtml
    state.prevStableKey = split.stableKey
  }
  if (split.tailHtml !== state.prevTailHtml) {
    state.tailEl.innerHTML = split.tailHtml
    state.prevTailHtml = split.tailHtml
  }
}
