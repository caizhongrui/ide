/**
 * Markdown → sanitized HTML
 * Uses marked for parsing + DOMPurify for XSS sanitization.
 */
import { marked, type Renderer } from "marked"
import DOMPurify from "dompurify"
import hljs from "highlight.js/lib/common"

// ─── 自定义渲染器：代码块带语法高亮 + 复制按钮 ────────────────────────
const renderer: Partial<Renderer> = {
  code({ text, lang }: { text: string; lang?: string }): string {
    // 用 highlight.js 高亮（已知 lang 走指定语言，未知走 auto-detect）
    let highlighted: string
    let detectedLang = lang ?? ''
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
      highlighted = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
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

marked.use({ renderer })

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

/** Render markdown string to safe HTML string */
export function renderMarkdown(text: string): string {
  if (!text) return ""
  const raw = marked.parse(text) as string
  const linkified = linkifyFilePaths(raw)
  // Sanitize to prevent XSS (even though source is local server)
  return DOMPurify.sanitize(linkified, {
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
  })
}
