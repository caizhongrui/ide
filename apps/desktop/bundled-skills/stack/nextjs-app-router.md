---
name: nextjs-app-router
description: 任何涉及 Next.js 13+ App Router 项目的代码（Server Component、Client Component、Server Action、路由），**调用此技能**正确划分 server/client 边界、避免 hydration 错误和 RSC 误用。
---

# Next.js App Router（13/14/15）实战

## 适用场景

任何 Next.js App Router 项目代码：
- 新建页面 / 路由
- Server Component vs Client Component
- 数据获取（fetch / cache / revalidate）
- Server Action
- 中间件 / Layout

## 核心心智模型

App Router 默认是 **Server Component**。"use client" 才是 Client Component。

```
┌──────────────────────────────────────┐
│ Server Component（默认）              │
│ - 在 server 渲染（Edge 或 Node）       │
│ - 不能用 useState / useEffect / on*   │
│ - 可以 await fetch / 直接读 DB        │
│ - 不进客户端 bundle，0 KB JS          │
└──────────────────────────────────────┘
            │ 可以 import
            ▼
┌──────────────────────────────────────┐
│ Client Component（"use client"）      │
│ - 浏览器执行                          │
│ - 用 useState / useEffect / on*       │
│ - 不能直接读 DB / 文件系统             │
│ - 进 bundle                           │
└──────────────────────────────────────┘
```

## 8 条铁律

### 1. 默认 Server Component，必要才 Client

❌ 一上来全文件加 `"use client"`：
- 失去 SSR 优势
- bundle 变大
- Server 资源访问能力丢失

✅ 自上而下设计：
- 页面 / Layout / 数据展示 → Server
- 交互（按钮点击、输入、动画）→ Client
- 把 Client 边界**下推**到最小子组件

```tsx
// app/page.tsx - Server Component
export default async function Page() {
  const posts = await db.posts.findMany()  // ✅ 直接读 DB
  return (
    <div>
      <h1>Posts</h1>
      <PostList posts={posts} />
      <SearchBar />  {/* 唯一需要交互的拆出去 */}
    </div>
  )
}

// app/components/SearchBar.tsx
"use client"
import { useState } from 'react'
export function SearchBar() {
  const [q, setQ] = useState('')
  return <input value={q} onChange={e => setQ(e.target.value)} />
}
```

### 2. Client 不能 import Server-only 代码

```ts
// ❌ Client Component 里 import db
"use client"
import { db } from '@/lib/db'  // 报错：无法打包到客户端

// ✅ 通过 Server Action 调用
"use client"
import { createPost } from '@/actions/posts'

const onSubmit = async (data) => {
  await createPost(data)  // RSC RPC
}
```

### 3. Server Action — 表单提交首选

```ts
// app/actions/posts.ts
"use server"
import { db } from '@/lib/db'
import { revalidatePath } from 'next/cache'

export async function createPost(formData: FormData) {
  const title = formData.get('title') as string
  await db.posts.create({ data: { title } })
  revalidatePath('/posts')  // 关键：让对应页面重新生成
}
```

```tsx
// app/posts/new/page.tsx
import { createPost } from '@/actions/posts'

export default function Page() {
  return (
    <form action={createPost}>
      <input name="title" />
      <button>Submit</button>
    </form>
  )
}
```

无需自己写 API endpoint + fetch。

### 4. 数据获取的缓存语义

```ts
// 默认：fetch 自动缓存（force-cache 等价）
const data = await fetch('https://api.example.com')

// 不缓存（每次请求新鲜数据）
const data = await fetch(url, { cache: 'no-store' })

// 时间型重验证
const data = await fetch(url, { next: { revalidate: 60 } })

// 标签型重验证（精确控制）
const data = await fetch(url, { next: { tags: ['posts'] } })
// 然后在某处：revalidateTag('posts')
```

**注意**：Next 15 默认改成 `no-store`了，要用缓存需显式指定。

### 5. 路由文件特殊命名

```
app/
├── layout.tsx           # 根 layout（持久，跨路由保持状态）
├── page.tsx             # 路径 /
├── loading.tsx          # 显示在加载时（自动 Suspense）
├── error.tsx            # 错误边界（必须 "use client"）
├── not-found.tsx        # 404
├── posts/
│   ├── layout.tsx       # /posts/* 共享 layout
│   ├── page.tsx         # /posts
│   └── [id]/
│       ├── page.tsx     # /posts/123
│       └── @modal/      # 平行路由（modal 风格）
│           └── page.tsx
└── api/
    └── route.ts         # /api 处理 GET/POST 等
```

### 6. params / searchParams 在 Next 15 是 Promise

```ts
// Next 15+
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ q?: string }>
}) {
  const { id } = await params
  const { q } = await searchParams
}
```

### 7. middleware.ts — 边缘运行时限制

```ts
// middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // 鉴权
  const token = request.cookies.get('auth-token')
  if (!token && request.nextUrl.pathname.startsWith('/admin')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/admin/:path*', '/api/:path*'],
}
```

**限制**：
- Edge Runtime：不能用 fs / Node 原生模块
- 请求耗时计入用户响应时间，**不要**做重活

### 8. metadata API（SEO）

```ts
// 静态
export const metadata = {
  title: 'Posts',
  description: '...',
}

// 动态
export async function generateMetadata({ params }) {
  const { id } = await params
  const post = await db.posts.findById(id)
  return { title: post.title }
}
```

## 常见陷阱

### 陷阱 1：在 Server Component 里写 onClick

```tsx
// ❌ 报错
export default function Page() {
  return <button onClick={() => alert('!')}>Click</button>
}

// ✅ 拆出 Client 子组件
import { Button } from './Button'  // "use client"
export default function Page() {
  return <Button />
}
```

### 陷阱 2：Hydration mismatch

```tsx
// ❌ Server 和 Client 输出不同
<div>{new Date().toString()}</div>

// ✅ 用 useEffect 在 Client 设
"use client"
const [now, setNow] = useState('')
useEffect(() => { setNow(new Date().toString()) }, [])
```

### 陷阱 3：Suspense 边界

页面级数据慢 → 用户看到 loading.tsx。但如果想**部分流式**：

```tsx
// app/dashboard/page.tsx
import { Suspense } from 'react'
import { Posts, Comments } from './...'

export default function Page() {
  return (
    <>
      <Suspense fallback={<PostsSkeleton />}>
        <Posts />  {/* 慢的 RSC */}
      </Suspense>
      <Suspense fallback={<CommentsSkeleton />}>
        <Comments />
      </Suspense>
    </>
  )
}
```

### 陷阱 4：Cookie / Headers 在 Server Component 是只读

```ts
import { cookies, headers } from 'next/headers'

export default async function Page() {
  const cookieStore = await cookies()
  const token = cookieStore.get('token')
  
  // Next 15+：cookies/headers 也是 Promise
}
```

写 cookie 必须在 Server Action / Route Handler / Middleware。

### 陷阱 5：环境变量

```
NEXT_PUBLIC_*   ← 暴露给浏览器（小心！）
其他            ← 仅服务端（不进 bundle）
```

❌ 把 `STRIPE_SECRET_KEY` 写成 `NEXT_PUBLIC_STRIPE_SECRET_KEY` → 进 client bundle，泄露密钥

## 性能优化

### 静态生成（SSG）

页面无个性化数据：默认会被静态生成。检查 build 日志：
```
○ /          (Static)
λ /dashboard (Dynamic - server-rendered on demand)
```

### Image / Font 优化

```tsx
import Image from 'next/image'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })

export default function Page() {
  return (
    <div className={inter.className}>
      <Image src="/photo.jpg" width={800} height={600} alt="..." />
    </div>
  )
}
```

### 流式渲染

把 `<Suspense>` 包在慢组件外，让快内容先 paint。

## 常用脚手架

```
✅ pnpm create next-app@latest --ts --tailwind --eslint --app
   选 App Router、TypeScript、Tailwind
✅ Auth：Clerk / NextAuth (Auth.js v5)
✅ DB：Prisma / Drizzle
✅ Form：react-hook-form + zod
✅ UI：Shadcn UI / Radix + Tailwind
```

## 与其他技能的关系

- 写 Client Component → react-best-practices
- 表单交互 → 与 typescript-strict-mode 配合用 zod 校验
- 数据库迁移 → database-migration-safety
- API 设计（route handler）→ api-design
