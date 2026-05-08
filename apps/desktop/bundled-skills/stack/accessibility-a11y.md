---
name: accessibility-a11y
description: 任何写 UI 组件 / 表单 / 交互的任务，**调用此技能**保证可访问性（键盘导航、屏幕阅读器、对比度、ARIA），避免常见的"div 当按钮 / 没有 label / 焦点丢失"等问题。
---

# Web 可访问性（A11y）实战

## 适用场景

任何涉及 UI 的任务：
- 写按钮 / 链接 / 表单
- 模态框 / 弹层 / 下拉菜单
- 表格 / 列表 / 导航
- 自定义控件（标签页、滑块、树）
- 颜色 / 对比度选择

## 为什么要做 A11y

1. **法律合规**：欧美很多法规要求（ADA / EAA）
2. **用户群覆盖**：全球 ~15% 人口有不同程度残障
3. **SEO 受益**：语义化 HTML 同时利于搜索
4. **键盘党友好**：即使非残障用户，键盘导航也更高效

## 8 条铁律

### 1. 用语义化 HTML，不用 div 当按钮

❌ 灾难：
```html
<div onClick={handleClick} class="btn">点我</div>
```
**问题**：
- 屏幕阅读器读"div"而不是"button"
- 不能 Tab 聚焦
- Enter / Space 不触发
- 无 disabled 状态

✅ 用原生：
```html
<button onClick={handleClick}>点我</button>
```

### 2. 表单元素必须有 label

❌ placeholder 不算 label：
```html
<input type="email" placeholder="邮箱" />
```

✅ 用 label 或 aria-label：
```html
<label>
  邮箱
  <input type="email" name="email" required />
</label>

<!-- 或用 for/id -->
<label for="email">邮箱</label>
<input id="email" type="email" name="email" />

<!-- 或视觉隐藏的 label -->
<label class="sr-only" for="search">搜索</label>
<input id="search" type="search" />
```

`.sr-only`（screen-reader only）样式：
```css
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0);
  white-space: nowrap; border: 0;
}
```

### 3. 图片必须有 alt

```html
<!-- 信息性图片 -->
<img src="chart.png" alt="2025 年销售曲线，显示 Q3 增长 40%" />

<!-- 装饰性图片（屏幕阅读器跳过）-->
<img src="decoration.svg" alt="" />

<!-- 复杂图（详细描述放别处）-->
<img src="complex.png" alt="组织架构图" aria-describedby="org-desc" />
<p id="org-desc" class="sr-only">CEO → 三个 VP →...</p>
```

### 4. 颜色对比度 ≥ 4.5:1（普通文本）

WCAG 2.1 AA 标准：
- 普通文本：4.5:1
- 大文本（≥18pt 或 ≥14pt 加粗）：3:1
- UI 组件 / 图形：3:1

工具：
- Chrome DevTools → Inspect → 选元素 → 颜色 → 对比度
- https://webaim.org/resources/contrastchecker/

❌ 灰色文字配白色背景常常不够：
```css
color: #999;     /* 对比度只有 2.8 ❌ */
color: #767676;  /* 4.54 ✅ */
```

### 5. 焦点可见 — 不要 outline: none

❌
```css
button:focus { outline: none; }   /* 键盘用户：我在哪？*/
```

✅ 至少给一个清晰的焦点环：
```css
button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
```

`focus-visible` 只在键盘聚焦时显示，鼠标点击不显示，体验最优。

### 6. 键盘导航完整支持

测试：能不能只用键盘走完所有功能？

| 键 | 期望 |
|---|---|
| Tab | 焦点在交互元素间前进 |
| Shift+Tab | 后退 |
| Enter | 激活按钮 / 提交表单 |
| Space | 激活按钮 / 切换 checkbox |
| Esc | 关闭模态框 / 弹出菜单 |
| Arrow | 在 radio / 列表 / tabs 内导航 |

### 7. 模态框（Modal）— 焦点陷阱

打开模态框时焦点必须移进去，关闭时返回触发它的元素：

```tsx
import { useEffect, useRef } from 'react'

function Modal({ open, onClose, children }) {
  const ref = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<HTMLElement>()

  useEffect(() => {
    if (open) {
      lastFocus.current = document.activeElement as HTMLElement
      // 把焦点移到模态框
      ref.current?.querySelector<HTMLElement>('button, input')?.focus()
      // 锁滚动
      document.body.style.overflow = 'hidden'
      // ESC 关闭
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
      window.addEventListener('keydown', onKey)
      return () => {
        window.removeEventListener('keydown', onKey)
        document.body.style.overflow = ''
        lastFocus.current?.focus()
      }
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="..."
    >
      <h2 id="modal-title">标题</h2>
      {children}
    </div>
  )
}
```

更好：用 Radix UI / Headless UI / @reach/ui，它们已实现焦点陷阱、ARIA、键盘导航全套。

### 8. ARIA — 只在必须时用

**优先用语义 HTML**。ARIA 只是"补丁"：

```html
<!-- ✅ 原生最佳 -->
<button aria-pressed={liked}>{liked ? '❤️' : '🤍'}</button>

<!-- ❌ 不必要的 ARIA -->
<button role="button">点击</button>  <!-- button 本来就是 button -->
```

常用 ARIA：
- `aria-label="..."`：给无文字的按钮添语义
- `aria-labelledby="id"`：用别处的元素当 label
- `aria-describedby="id"`：补充描述
- `aria-expanded={true|false}`：折叠面板状态
- `aria-current="page"`：当前导航项
- `role="alert"`：紧急消息（屏幕阅读器立刻读）
- `role="status"`：非紧急状态变化

## 常见组件模式

### 标签页（Tabs）

```tsx
<div role="tablist">
  <button role="tab" aria-selected={active === 'a'} aria-controls="panel-a" id="tab-a">A</button>
  <button role="tab" aria-selected={active === 'b'} aria-controls="panel-b" id="tab-b">B</button>
</div>
<div role="tabpanel" id="panel-a" aria-labelledby="tab-a" hidden={active !== 'a'}>
  Panel A 内容
</div>
```

键盘：← → 在 tabs 间切换，Home/End 跳首尾。

### 下拉菜单（Combobox / Listbox）

直接用 Headless UI / Radix Combobox。手写出 bug 概率高。

### 通知 / Toast

```tsx
<div role="status" aria-live="polite">
  {toast.message}
</div>
```

`aria-live`:
- `polite`：等用户停下来再读（一般通知）
- `assertive`：立刻打断读（紧急错误）

### 跳到主内容（Skip link）

让键盘用户绕过导航栏：
```html
<a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 ...">
  跳到主内容
</a>
<nav>...</nav>
<main id="main">...</main>
```

## 测试工具

### 自动化

- **eslint-plugin-jsx-a11y**（React 项目必装）
- **axe DevTools**（Chrome 扩展，扫整页）
- **Lighthouse**（Chrome DevTools 内置，A11y 评分）
- **Pa11y**（CI 集成）

### 手动

1. **拔鼠标**：纯键盘走一遍所有功能
2. **打开屏幕阅读器**：
   - Mac：⌘F5（VoiceOver）
   - Windows：NVDA（免费）
3. **缩放 200%**：看布局有无溢出
4. **对比度模式**：Windows 高对比度模式

## 反模式速查

❌ `<a onClick="...">` 没 href → 不是真链接，键盘不能聚焦
✅ 真要"按钮"用 `<button>`；要导航用 `<a href="...">`

❌ `tabindex="3"` 强行排序 → 维护噩梦
✅ 用 DOM 顺序自然 tab，最多用 `tabindex="0"` 或 `"-1"`

❌ "请勿使用 IE / 最低支持..."
✅ 渐进增强：核心功能在所有浏览器都能用

❌ "看视频了解" 没字幕没文本替代
✅ 提供字幕 + 文字摘要

❌ 表单错误用红色边框（仅）
✅ 红色 + 错误文字 + `aria-invalid="true"` + 关联 `aria-describedby` 错误消息 id

## 与其他技能的关系

- React 组件设计 → react-best-practices
- Tailwind 实现 → tailwind-css-patterns
- Next.js 中跑 lint → 配 eslint-plugin-jsx-a11y
