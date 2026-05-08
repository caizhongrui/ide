---
name: nodejs-express-patterns
description: 任何 Node.js + Express 项目代码（路由、中间件、错误处理、异步），**调用此技能**遵守现代实践，避免回调地狱 / 错误吞咽 / 路由耦合等老 Express 项目的常见问题。
---

# Node.js Express 现代实战

## 适用场景

任何 Express 项目代码：
- 路由 / 控制器
- 中间件
- 错误处理
- 数据库（Prisma / Drizzle / Knex）
- 验证（zod / joi）
- 鉴权（JWT / session）

## 项目结构

```
src/
├── index.ts                 # 启动入口
├── app.ts                   # Express 实例 + 中间件
├── routes/
│   ├── index.ts             # 路由聚合
│   ├── users.ts
│   └── posts.ts
├── controllers/             # 业务逻辑
│   └── userController.ts
├── services/                # 跨控制器复用
│   └── userService.ts
├── middleware/
│   ├── auth.ts
│   ├── errorHandler.ts
│   └── validate.ts
├── db/                      # Prisma / Drizzle
├── schemas/                 # zod 校验
└── utils/
```

## 8 条铁律

### 1. ESM + TypeScript

`package.json`:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

### 2. async 路由必须 wrap 错误

Express 不会自动捕获 async 函数抛的错。**必须手动 wrap**：

```ts
// utils/asyncHandler.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express'

export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
```

```ts
router.get('/users/:id', asyncHandler(async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.params.id } })
  if (!user) throw new NotFoundError('USER_NOT_FOUND')
  res.json(user)
}))
```

或者直接用 `express-async-errors`（首行 `import 'express-async-errors'` 后所有 async 错误自动 next）。

### 3. 用 zod 做请求校验中间件

```ts
// middleware/validate.ts
import { ZodSchema } from 'zod'
import type { RequestHandler } from 'express'

export const validate = (schema: { body?: ZodSchema; query?: ZodSchema; params?: ZodSchema }): RequestHandler => 
  (req, res, next) => {
    try {
      if (schema.body)   req.body   = schema.body.parse(req.body)
      if (schema.query)  req.query  = schema.query.parse(req.query) as any
      if (schema.params) req.params = schema.params.parse(req.params) as any
      next()
    } catch (err) {
      next(err)  // 错误处理器统一格式化 zod error
    }
  }

// schemas/user.ts
import { z } from 'zod'

export const createUserSchema = {
  body: z.object({
    email: z.string().email(),
    name: z.string().min(2).max(50),
    age: z.number().int().min(0).max(150).optional(),
  }),
}

// routes/users.ts
router.post('/', validate(createUserSchema), asyncHandler(controller.createUser))
```

### 4. 自定义错误类 + 全局 handler

```ts
// utils/errors.ts
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    Error.captureStackTrace(this, this.constructor)
  }
}
export class NotFoundError extends AppError {
  constructor(code = 'NOT_FOUND') { super(code, '资源不存在', 404) }
}
export class UnauthorizedError extends AppError {
  constructor(code = 'UNAUTHORIZED') { super(code, '未授权', 401) }
}

// middleware/errorHandler.ts
import { ZodError } from 'zod'
import { AppError } from '../utils/errors.js'
import type { ErrorRequestHandler } from 'express'

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // zod 校验
  if (err instanceof ZodError) {
    return res.status(400).json({
      code: 'VALIDATION_FAILED',
      message: '请求字段校验失败',
      errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    })
  }
  // 业务异常
  if (err instanceof AppError) {
    return res.status(err.status).json({ code: err.code, message: err.message })
  }
  // 兜底
  console.error('Unhandled', err)
  res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器开小差' })
}
```

挂载在所有路由**之后**：
```ts
app.use(errorHandler)  // 必须最后
```

### 5. 中间件顺序很关键

```ts
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import rateLimit from 'express-rate-limit'

const app = express()

// 1. 安全 / 性能（最早）
app.use(helmet())
app.use(compression())

// 2. CORS（在路由之前）
app.use(cors({ origin: ['https://example.com'], credentials: true }))

// 3. 限流
app.use('/api/', rateLimit({ windowMs: 60_000, max: 100 }))

// 4. body 解析
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

// 5. 日志
app.use(morgan('combined'))

// 6. 业务路由
app.use('/api/v1', apiRouter)

// 7. 404
app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }))

// 8. 错误处理（最后）
app.use(errorHandler)
```

### 6. 控制器薄，逻辑放 Service

```ts
// controllers/userController.ts
export const createUser = async (req: Request, res: Response) => {
  const user = await userService.create(req.body)
  res.status(201).json(user)
}

// services/userService.ts
export const userService = {
  async create(data: CreateUserInput): Promise<User> {
    if (await db.user.findUnique({ where: { email: data.email } })) {
      throw new AppError('EMAIL_EXISTS', '邮箱已注册', 409)
    }
    return db.user.create({ data })
  },
}
```

### 7. 配置 + 环境变量

```ts
// config.ts
import { z } from 'zod'
import 'dotenv/config'

const env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32),
}).parse(process.env)

export const config = env
```

启动时校验 → 缺配置直接挂掉，不让起。

### 8. 优雅关闭

```ts
// index.ts
import { config } from './config.js'
import { app } from './app.js'
import { db } from './db.js'

const server = app.listen(config.PORT, () => {
  console.log(`Listening on ${config.PORT}`)
})

const shutdown = async () => {
  console.log('Shutting down...')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

让 K8s / Docker 优雅缩容时连接不中断。

## 鉴权

### JWT middleware

```ts
import jwt from 'jsonwebtoken'
import { config } from '../config.js'

export const authRequired: RequestHandler = (req, res, next) => {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError()
  try {
    const payload = jwt.verify(auth.slice(7), config.JWT_SECRET) as { sub: string }
    ;(req as any).userId = payload.sub
    next()
  } catch {
    throw new UnauthorizedError('INVALID_TOKEN')
  }
}

router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const user = await db.user.findUnique({ where: { id: (req as any).userId } })
  res.json(user)
}))
```

### 角色 / 权限

```ts
export const requireRole = (...roles: string[]): RequestHandler => async (req, res, next) => {
  const user = await db.user.findUnique({ where: { id: (req as any).userId } })
  if (!user || !roles.includes(user.role)) throw new AppError('FORBIDDEN', '无权限', 403)
  next()
}

router.delete('/users/:id', authRequired, requireRole('admin'), asyncHandler(controller.delete))
```

## 测试

```ts
// 用 supertest + vitest
import request from 'supertest'
import { app } from '../src/app.js'

describe('POST /users', () => {
  it('returns 201', async () => {
    const r = await request(app).post('/users').send({ email: 'a@b.com', name: 'Alice' })
    expect(r.status).toBe(201)
  })
})
```

## 常见陷阱

### 陷阱 1：CORS 加 credentials 但 origin: '*'

```ts
// ❌ 浏览器拒绝
cors({ origin: '*', credentials: true })

// ✅
cors({ origin: ['https://example.com'], credentials: true })
```

### 陷阱 2：req.body 是 undefined

忘了 `app.use(express.json())`。

### 陷阱 3：内存泄漏 — 监听器累积

```ts
// ❌ 每个请求加一个 listener，永不释放
app.use((req, res, next) => {
  someEmitter.on('event', handler)
  next()
})

// ✅
app.use((req, res, next) => {
  someEmitter.once('event', handler)  // 或显式 off
  next()
})
```

### 陷阱 4：日志泄密

```ts
// ❌
console.log('user login', { email, password })

// ✅ 用 pino + redact
import pino from 'pino'
const logger = pino({
  redact: ['req.headers.authorization', '*.password', '*.token'],
})
```

## 何时**不**用 Express

- 高并发 → Fastify / Hono / uWebSockets.js（更快）
- TypeScript 优先 → NestJS / Hono
- 边缘运行（CF Workers / Vercel Edge）→ Hono / itty-router

## 与其他技能的关系

- API 设计 → api-design
- 数据库 → database-migration-safety
- 安全 → security-best-practices（特别是 helmet / rate-limit / CORS）
