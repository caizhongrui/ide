---
name: tailwind-css-patterns
description: 任何 Tailwind CSS 项目改动，**调用此技能**遵守命名/抽取/响应式/暗色模式的规范，避免 className 字符串爆炸、复用混乱、性能踩坑等常见问题。
---

# Tailwind CSS 实战模式

## 适用场景

- 写新组件用 Tailwind
- 重构 inline className 字符串过长的组件
- 设计系统 / 主题
- 性能优化（purge / JIT）
- 暗色模式

## 8 条铁律

### 1. 不写自定义 CSS，先看 Tailwind utility

90% 需求都有现成 utility。先查 docs。

```html
<!-- ❌ 自定义 -->
<div style={{ padding: 16, marginTop: 24 }}>

<!-- ✅ -->
<div className="p-4 mt-6">
```

### 2. className 长 → 拆组件，不是抽 @apply

```html
<!-- ❌ 难维护 -->
<button className="bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
```

❌ 别用 @apply 抽 .btn-primary：失去 Tailwind 优势，违反组合性。

✅ 抽 React 组件：
```tsx
// components/Button.tsx
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant = 'primary', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        // 基础
        'inline-flex items-center justify-center font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        // 变体
        variant === 'primary' && 'bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-700',
        variant === 'ghost'   && 'text-gray-700 hover:bg-gray-100',
        variant === 'danger'  && 'bg-red-500 text-white hover:bg-red-600',
        // 尺寸
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4',
        size === 'lg' && 'h-12 px-5 text-lg',
        className,
      )}
      {...props}
    />
  )
}
```

`cn` 工具：
```ts
// lib/utils.ts
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: any[]) {
  return twMerge(clsx(inputs))
}
```

`twMerge` 解决"`p-2 p-4` 谁覆盖谁"的冲突：自动后者胜。

### 3. 响应式：移动优先

```html
<!-- 默认（手机）→ md(≥768) → lg(≥1024) -->
<div className="text-sm md:text-base lg:text-lg">
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
```

断点速记：
- `sm` ≥ 640
- `md` ≥ 768
- `lg` ≥ 1024
- `xl` ≥ 1280
- `2xl` ≥ 1536

### 4. 暗色模式：用 dark: 前缀

```html
<div className="bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
```

配置（tailwind.config.js）：
```js
module.exports = {
  darkMode: 'class',  // 推荐：手动切换
  // 或 'media'：跟随系统
}
```

切换：
```ts
document.documentElement.classList.toggle('dark')
```

### 5. 任意值（Arbitrary values）— 救急用

```html
<!-- 设计系统没的值 -->
<div className="top-[117px] grid-cols-[200px_1fr_100px]">

<!-- 任意属性 -->
<div className="[mask-type:luminance]">
```

❌ 不要把任意值当默认，用了一两次以上就加进 theme：

```js
// tailwind.config.js
theme: {
  extend: {
    spacing: { '18': '4.5rem' },
  }
}
```

### 6. 状态修饰符链

```html
<button className="
  bg-blue-500
  hover:bg-blue-600
  focus:ring-2 focus:ring-blue-300
  disabled:opacity-50 disabled:cursor-not-allowed
  group-hover:scale-105
  peer-checked:bg-green-500
">
```

常用：
- `hover:` `focus:` `focus-visible:` `active:`
- `disabled:` `checked:` `placeholder:` `required:`
- `first:` `last:` `odd:` `even:` `nth-2:`
- `dark:` `motion-reduce:` `print:`
- `group-hover:` `peer-checked:`（关联其他元素）

### 7. group / peer 解决跨元素状态

```html
<!-- group: 父 hover 影响子 -->
<a href="#" className="group">
  <span className="text-gray-700 group-hover:text-blue-500">Link</span>
  <svg className="opacity-0 group-hover:opacity-100" />
</a>

<!-- peer: 兄弟之间 -->
<input type="checkbox" className="peer" />
<div className="hidden peer-checked:block">复选时显示</div>
```

### 8. 动画 — transition + motion

```html
<button className="
  transition-all duration-200 ease-in-out
  hover:scale-105 active:scale-95
">
```

复杂动画用 Framer Motion / Motion One，不要在 Tailwind 里 keyframes。

## 设计 token 化

定义全站一致的色板 / 字号 / 间距：

```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: {
          50:  '#eff6ff',
          500: '#3b82f6',
          900: '#1e3a8a',
        },
      },
      fontSize: {
        'display': ['3rem', { lineHeight: '1.1', fontWeight: '700' }],
      },
      borderRadius: {
        'xxl': '1.5rem',
      },
    },
  },
}
```

CSS variables 配合（暗色 / 主题切换）：
```css
@layer base {
  :root {
    --color-bg: 255 255 255;
    --color-fg: 0 0 0;
  }
  .dark {
    --color-bg: 0 0 0;
    --color-fg: 255 255 255;
  }
}
```

```js
// tailwind.config.js
theme: {
  extend: {
    colors: {
      bg: 'rgb(var(--color-bg) / <alpha-value>)',
      fg: 'rgb(var(--color-fg) / <alpha-value>)',
    }
  }
}
```

## 常用模式

### 卡片

```html
<div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
  <h3 className="text-lg font-semibold">Title</h3>
  <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Desc</p>
</div>
```

### Stack（垂直/水平间距）

```html
<!-- 垂直堆叠 -->
<div className="flex flex-col gap-4">

<!-- 水平 -->
<div className="flex items-center gap-2">
```

或用 `space-y-4` / `space-x-2`（兼容老浏览器但有边界 case）。

### 表单组

```html
<label className="block">
  <span className="text-sm font-medium text-gray-700">Email</span>
  <input
    type="email"
    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
  />
  <span className="mt-1 text-sm text-red-500">{error}</span>
</label>
```

### Skeleton 加载

```html
<div className="animate-pulse">
  <div className="h-4 w-3/4 rounded bg-gray-200" />
  <div className="mt-2 h-4 w-1/2 rounded bg-gray-200" />
</div>
```

## 性能

### Purge / JIT

Tailwind 3+ 默认 JIT，自动只生成用到的 class。

但**动态 className 不会被识别**：
```ts
// ❌ Tailwind 看不到
const cls = `bg-${color}-500`

// ✅ 写完整字符串，让扫描器识别
const cls = color === 'red' ? 'bg-red-500' : 'bg-blue-500'

// 或加 safelist
// tailwind.config.js
safelist: ['bg-red-500', 'bg-blue-500', 'bg-green-500']
```

### 生产 bundle

正常 < 10KB（gzipped），过大检查：
```bash
pnpm build && cat dist/style.css | wc -c
```

## 反模式

❌ `style={{ ... }}` 内联（失去 Tailwind 优势）
❌ `@apply` 抽 .btn-xxx（失去组合性 + 难追溯）
❌ 全在 className 里硬编码颜色，不用 theme
❌ 动态拼接 `bg-${color}-500`（JIT 识别不到）
❌ 任意值滥用 `top-[117px]`（应该加进 spacing）
❌ 不用 cn / twMerge，多个 className 合并冲突

## 与其他技能的关系

- React 组件 → react-best-practices
- 可访问性 → accessibility-a11y（focus 样式、对比度）
- Vue 用 Tailwind 同理 → 配合 vue3-composition-api
