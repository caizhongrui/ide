---
name: web-performance-optimization
description: 当前端性能有问题（页面慢、TBT 高、LCP 大、内存泄漏）时，**调用此技能**按 Core Web Vitals 指标系统化优化，避免凭直觉乱改。
---

# 前端性能优化（Core Web Vitals）

## 适用场景

- 用户反馈"卡 / 慢 / 卡顿"
- Lighthouse 分数低
- Web Vitals 不达标
- 首屏白屏长
- 长列表 / 滚动卡顿
- 内存泄漏

## 核心指标（Core Web Vitals）

| 指标 | 含义 | 好 | 差 |
|---|---|---|---|
| **LCP**（Largest Contentful Paint） | 最大元素加载时间 | < 2.5s | > 4.0s |
| **INP**（Interaction to Next Paint） | 交互响应时间 | < 200ms | > 500ms |
| **CLS**（Cumulative Layout Shift） | 累积布局偏移 | < 0.1 | > 0.25 |

辅助指标：
- **FCP**（First Contentful Paint）：首次内容绘制
- **TTFB**（Time to First Byte）：服务器首字节
- **TBT**（Total Blocking Time）：主线程阻塞总时长

## 测量优先

**不要凭感觉优化**。先用工具测出真实瓶颈。

### 1. Chrome DevTools Performance

录制 5-10s 用户操作 → 看：
- 主线程是否长时间被脚本占用
- Layout / Paint 频率
- 哪个函数最长（火焰图最高）

### 2. Lighthouse

```bash
# CI 集成
npx lighthouse https://example.com --output=json --output-path=./report.json
```

### 3. Web Vitals 实测（生产）

```ts
// app/_app.tsx 或入口
import { onCLS, onLCP, onINP, onTTFB } from 'web-vitals'

const send = (metric) => {
  navigator.sendBeacon('/api/metrics', JSON.stringify(metric))
}
onCLS(send); onLCP(send); onINP(send); onTTFB(send);
```

## 优化清单（按效果排序）

### 1. 减少主 JS bundle（影响 FCP / LCP / INP）

```bash
# 看 bundle 组成
npx webpack-bundle-analyzer .next/static/chunks
# 或 vite build --mode=analyze
```

**常见减小手段**：

| 手段 | 收益 |
|---|---|
| **代码分割**（route-based） | 大 |
| **lazy load**（条件性组件） | 中 |
| **Tree shaking**（确认 sideEffects: false） | 中 |
| **替换大库** | 看库 |
| **移除 polyfills**（target: modern browsers） | 中 |

```tsx
// React lazy
const Heavy = lazy(() => import('./Heavy'))
<Suspense fallback={<Skeleton />}><Heavy /></Suspense>

// Next dynamic
const Heavy = dynamic(() => import('./Heavy'), { loading: () => <Skeleton /> })
```

**经典换库**：
- moment.js (300KB) → date-fns (按需) / dayjs (2KB)
- lodash (70KB) → lodash-es / 自己写工具
- big chart libs → recharts / lightweight-charts

### 2. 图片优化（影响 LCP）

```tsx
// Next.js Image 自动转 WebP/AVIF + lazy load
import Image from 'next/image'
<Image src="/hero.jpg" width={1200} height={600} alt="..." priority />
```

要点：
- **首屏图片** `priority` 不要 lazy load
- **下面的图片**默认 lazy
- 提供 `width × height` 防止 CLS
- 用 `srcset` 多分辨率（Next/Image 自动）

非 Next 项目：
```html
<picture>
  <source srcset="hero.avif" type="image/avif" />
  <source srcset="hero.webp" type="image/webp" />
  <img src="hero.jpg" width="1200" height="600" alt="..." loading="lazy" />
</picture>
```

### 3. 字体优化（影响 LCP / CLS）

```tsx
// Next.js next/font 自动 self-host + 防 FOIT
import { Inter } from 'next/font/google'
const inter = Inter({ subsets: ['latin'], display: 'swap' })
```

- `display: 'swap'`：先用系统字体后切换（避免 FOIT 白屏）
- 子集化：只加载用到的字符
- 预加载：`<link rel="preload" as="font" crossorigin>`

### 4. 减少长任务（影响 INP / TBT）

任何超过 50ms 的 JS 任务都阻塞交互。

**手段**：
- 大循环切片：`scheduler.postTask()` / `setTimeout(0)` 让出主线程
- Web Worker：CPU 密集（大文件解析、加密）放 worker
- 防抖 / 节流：input、scroll、resize 事件
- Virtual list：超长列表只渲染可见行

```ts
// 切片处理大数组
async function processLarge(items) {
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100)
    chunk.forEach(process)
    await new Promise(r => setTimeout(r, 0))  // 让出主线程
  }
}
```

### 5. 防止 CLS

```css
/* ❌ 高度未定 → 内容到位时跳动 */
.banner { /* no height */ }

/* ✅ 占位 */
.banner { aspect-ratio: 16/9; }
.banner img { width: 100%; height: 100%; object-fit: cover; }
```

广告 / 嵌入：保留固定高度容器。

### 6. CSS 优化

- **关键 CSS 内联**（首屏样式直接进 HTML）
- **延迟非关键 CSS**：`<link rel="preload" as="style">` + 懒加载
- **去除未用样式**：Tailwind JIT / PurgeCSS

### 7. 服务端优化（影响 TTFB）

- **CDN**：静态资源走 CDN
- **缓存**：HTTP Cache-Control + ETag
- **HTTP/2 或 HTTP/3**：多路复用，无队头阻塞
- **Brotli 压缩**（比 gzip 强 15-25%）
- **Edge Function**：把 API 放到用户附近

### 8. 列表 / 表格虚拟滚动

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'

function List({ items }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 50,
  })

  return (
    <div ref={parentRef} style={{ height: 600, overflow: 'auto' }}>
      <div style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((it) => (
          <div key={it.key} style={{ position: 'absolute', top: it.start }}>
            {items[it.index]}
          </div>
        ))}
      </div>
    </div>
  )
}
```

数据 > 100 行考虑用，> 1000 行必须用。

## React 特定优化

### memo / useMemo / useCallback

只在 profiler 显示瓶颈时用。**不是越多越好**。

```tsx
const ExpensiveComp = memo(function ExpensiveComp({ data }) { ... })

const expensive = useMemo(() => heavyCompute(deps), [deps])

const stableHandler = useCallback(() => handle(...), [...])
```

### 状态下推

把 state 放在**真正用到的最低共同父**，避免顶层 state 触发整棵树。

### Concurrent features

```tsx
import { useTransition, useDeferredValue } from 'react'

// useTransition：把状态更新标记为低优先级
const [isPending, startTransition] = useTransition()
const onSearch = (q) => {
  setQuery(q)  // 高优先级（input 立刻响应）
  startTransition(() => {
    setResults(filter(allItems, q))  // 低优先级（可被打断）
  })
}

// useDeferredValue：派生值延后
const deferredQuery = useDeferredValue(query)
```

## 内存泄漏

### 常见来源

1. **未清理的 listener**：
```ts
useEffect(() => {
  const onResize = () => ...
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)  // 必须清
}, [])
```

2. **未清理的 timer**：
```ts
useEffect(() => {
  const id = setInterval(tick, 1000)
  return () => clearInterval(id)
}, [])
```

3. **闭包持有大对象**：
```ts
// ❌ heavyObject 被永久持有
const onClick = () => useHeavy(heavyObject)

// ✅ 不需要时就不持
const onClick = useCallback(() => useHeavy(getHeavy()), [])
```

4. **Detached DOM**：拿了 ref 但元素移除后没清

### 检测

Chrome DevTools → Memory → Heap snapshot → 比对前后

## 反模式

❌ "感觉慢 → 加 useMemo 一把梭" → 大概率没用还增加心智负担
❌ "数据多了再优化" → 应该一开始就识别热路径
❌ "只看 Lighthouse 评分" → 真实用户数据更重要（field data）
❌ "本地跑得快就上线" → 4G 慢网必测
❌ "加 loading 转圈圈代替优化" → 用户还是要等

## 与其他技能的关系

- React 优化 → react-best-practices
- 列表渲染 → 配合 virtualization 库
- 网络请求慢 → 检查 api-design / 后端 SQL 优化
- 整体诊断 → systematic-debugging
