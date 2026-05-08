---
name: error-handling-patterns
description: 任何写新代码或重构现有代码的任务，**调用此技能**遵守错误处理规范，避免"吞错误 / try-catch 大全 / 错误信息没用"等让 bug 定位极其困难的反模式。
---

# 错误处理通用模式

## 适用场景

任何编写代码的场景：
- 新功能开发
- 修 bug（要看现有错误处理是否合理）
- API 设计
- 库 / 工具开发

## 核心心智模型

错误分两类：

| 类型 | 例子 | 处理 |
|---|---|---|
| **可预期错误（business）** | 用户名重复、密码错、配额超限 | **业务流的一部分**，应该有专门的类型 + 友好响应 |
| **不可预期错误（system）** | DB 挂了、网络断了、空指针 | **bug 或故障**，记日志 + alert + 优雅降级 |

❌ 把两者**混在一个 try-catch** → 失去精度
✅ 区别对待

## 8 条铁律

### 1. 不要吞错误

```ts
// ❌ 罪魁祸首
try {
  doStuff()
} catch (e) {
  // 啥都不做
}

// ❌ 同样灾难
try {
  doStuff()
} catch (e) {
  console.log("error")  // 没上下文，不知道哪个 stuff 出错
}

// ✅
try {
  doStuff()
} catch (e) {
  log.error('doStuff failed', { error: e, context: { userId, stuffId } })
  throw e  // 或转化错误类型
}
```

**原则**：要么处理（不抛了），要么传上去。**不能默默丢**。

### 2. 错误必须带上下文

```ts
// ❌ 最终用户看到 "Internal error"
throw new Error("failed")

// ❌ 调用方看到 "DB error" 不知道哪条记录
throw new Error("DB query failed")

// ✅ 包含关键标识 + 操作
throw new Error(`createUser failed for email=${email}: ${dbErr.message}`)

// ✅✅ 错误链（保留原 stack）
class CreateUserError extends Error {
  constructor(message: string, public cause: Error, public context: Record<string, unknown>) {
    super(message)
    this.name = 'CreateUserError'
  }
}
throw new CreateUserError('Failed to create user', dbErr, { email })
```

错误信息回答：
- 哪个操作？
- 关键参数？
- 原因？

### 3. 自定义错误类型 — 让调用方 catch 得到要的

```ts
// 业务错误
export class ValidationError extends Error {
  constructor(public field: string, public code: string, message: string) {
    super(message)
  }
}

export class NotFoundError extends Error {
  constructor(public resource: string, public id: string) {
    super(`${resource} ${id} not found`)
  }
}

export class ConflictError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

// 调用方精准 catch
try {
  await createUser(...)
} catch (e) {
  if (e instanceof ValidationError) return res.status(400).json({ field: e.field, ... })
  if (e instanceof ConflictError)   return res.status(409).json({ code: e.code, ... })
  throw e  // 其他：上抛到全局 handler
}
```

不要用 string 比对：`if (e.message === '...')` ← 脆弱。

### 4. Result 类型（FP 风格）

异步分支多、错误有意义时，用 Result 类型让错误成为返回值：

```ts
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

async function fetchUser(id: string): Promise<Result<User, NotFoundError | NetworkError>> {
  try {
    const user = await db.user.findById(id)
    if (!user) return { ok: false, error: new NotFoundError('user', id) }
    return { ok: true, value: user }
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, error: new NetworkError(...) }
    throw e
  }
}

// 调用
const r = await fetchUser(id)
if (!r.ok) {
  if (r.error instanceof NotFoundError) ...
  else ...
} else {
  use(r.value)
}
```

**好处**：编译器逼你处理两种情况，不会忘。
**何时用**：库 API、关键路径、希望显式让调用方处理错误的地方。

Rust / Go 是天然这种风格（`Result<T, E>` / `(value, err)`）。

### 5. try-catch 范围尽量小

```ts
// ❌ try 包了一大坨
try {
  const a = await stepA()
  const b = await stepB(a)
  const c = transform(b)
  await stepD(c)
} catch (e) {
  // 不知道哪一步坏了
}

// ✅ 每步独立处理
const a = await stepA().catch(e => { throw new StepAError(e) })
const b = await stepB(a).catch(e => { throw new StepBError(e) })
const c = transform(b)
await stepD(c)
```

或：用错误类型的 `cause`：
```ts
try {
  const a = await stepA()  // 抛错时 wrap 上 stepA 上下文
} catch (e) {
  throw new Error('Step A failed', { cause: e })  // ES2022 cause
}
```

### 6. 重试 + 指数退避（外部依赖）

外部 API / 网络：临时错误重试，永久错误别重试。

```ts
async function withRetry<T>(
  fn: () => Promise<T>,
  opts = { maxAttempts: 3, baseDelay: 200, maxDelay: 5000 }
): Promise<T> {
  let lastErr: Error
  for (let i = 1; i <= opts.maxAttempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e as Error
      if (!isRetryable(e) || i === opts.maxAttempts) throw e
      const delay = Math.min(opts.baseDelay * 2 ** (i - 1), opts.maxDelay)
      const jitter = Math.random() * delay * 0.3
      await sleep(delay + jitter)
    }
  }
  throw lastErr!
}

function isRetryable(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  // 网络超时、5xx、限流
  if (e.message.includes('ECONNRESET')) return true
  if ((e as any).status >= 500) return true
  if ((e as any).status === 429) return true
  return false
}
```

**关键**：
- jitter 防止 thundering herd
- 最多重试 3-5 次（更多通常没意义）
- 4xx（除 429）不要重试（永久错误）

### 7. 全局兜底处理器

```ts
// Node.js
process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', err)
  // 优雅关闭，不要直接 exit(1)
  shutdown(1)
})

process.on('unhandledRejection', (reason) => {
  log.fatal('Unhandled rejection', reason)
  shutdown(1)
})

// Express
app.use((err, req, res, next) => {
  log.error('Request failed', { err, path: req.path })
  res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务异常' })
})

// 浏览器
window.addEventListener('error', (e) => sentry.capture(e))
window.addEventListener('unhandledrejection', (e) => sentry.capture(e.reason))
```

接 Sentry / Bugsnag / Datadog 实时告警。

### 8. 不要用错误控流

```ts
// ❌ 用 try-catch 当 if-else
try {
  user = await db.findById(id)
} catch {
  user = createDefaultUser()
}

// ✅
user = await db.findById(id) ?? createDefaultUser()
```

```ts
// ❌
function parseInt(s: string) {
  if (!/^\d+$/.test(s)) throw new Error('not a number')
  ...
}

// ✅
function parseInt(s: string): number | null {
  if (!/^\d+$/.test(s)) return null
  ...
}
```

错误是**异常情况**，不是控制流。

## 错误响应格式（HTTP API）

统一格式：
```json
{
  "code": "VALIDATION_FAILED",
  "message": "请求字段校验失败",
  "details": {
    "field": "email",
    "value": "abc"
  },
  "trace_id": "abc-123-def",
  "timestamp": "2026-05-08T10:00:00Z"
}
```

- `code`：机器可读，客户端 switch
- `message`：人类可读（注意国际化）
- `trace_id`：关联日志（必备！）

## 不要泄露内部细节

```json
// ❌ 客户端看到内部错
{
  "error": "ER_DUP_ENTRY: Duplicate entry 'a@b.com' for key 'users.email_unique'"
}

// ✅
{
  "code": "EMAIL_EXISTS",
  "message": "该邮箱已被注册",
  "trace_id": "..."
}
```

内部用 trace_id 关联日志，外部友好。

## 日志记录

错误日志包含：
- **timestamp**
- **level**（error / fatal）
- **message**
- **stack trace**
- **context**：trace_id, user_id, request_id, 关键参数
- **error code / type**

```ts
log.error('Failed to charge', {
  error: { name: e.name, message: e.message, stack: e.stack },
  context: { userId, orderId, amount, paymentMethod },
  trace_id,
})
```

避免日志风暴：
- 同类错误聚合（5 分钟内同 error 聚合一条）
- 不要在循环里每次失败都 log（log 一次 + 计数）

## 优雅降级

不能完成核心功能时，降级而非崩溃：

```ts
async function getUserDashboard(id: string) {
  const user = await getUser(id)  // 必须成功
  
  // 优雅降级
  const recommendations = await getRecs(id).catch(() => [])  // 推荐失败用空
  const stats = await getStats(id).catch(() => null)
  
  return { user, recommendations, stats }
}
```

Circuit Breaker：连续失败时直接返回降级值，不打挂上游：参见 microservices-patterns。

## 防御性编程边界

不是所有地方都需要 try-catch。**信任边界内的代码**只在边界处校验：

```
外部输入 → 边界（API）：严格校验 + 错误处理
内部函数 → 内部函数：信任，不重复校验（除非该函数本身要做"已知风险操作"）
```

每层都 try-catch + 校验 = 代码膨胀 + 性能浪费 + 真错误被埋。

## 反模式总结

❌ catch 不传上下文
❌ catch 后只 console.log
❌ try 太大，一次包很多步骤
❌ 用 string 比对错误
❌ 把所有错都返 500
❌ 把内部错原样返客户端
❌ 不设全局 handler
❌ 重试 5xx 但不带退避

## 与其他技能的关系

- 调试错误 → systematic-debugging
- API 错误响应 → api-design
- 重试 / 熔断（分布式）→ microservices-patterns
- 日志 → 配合 logging-observability（如果已经做了的话）
