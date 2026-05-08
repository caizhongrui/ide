---
name: api-design
description: 当用户要设计 / 评审 / 重构 HTTP API（REST 或 RPC 风格）时，**必须调用此技能**遵守一致性、版本化、错误处理、分页等通用规约，避免 API 设计混乱难以演进。
---

# API 设计规范（HTTP / REST 优先）

## 适用场景

满足**任一**时调用：

1. 设计新接口（路径、方法、请求/响应格式）
2. 评审已有接口设计
3. 给老接口加版本 / 兼容改造
4. 设计公开 API（SDK / 第三方调用）

## 核心原则

1. **一致性 > 完美**：所有接口风格统一，比每个都"最优"重要
2. **可演进**：今天的接口要能在不破坏调用方的情况下升级
3. **错误信息可机器读**：除了人类可读，还要有 code / field 让客户端能精确处理

## URL 设计

### REST 风格（推荐用于 CRUD）

```
GET    /api/v1/users               列表
POST   /api/v1/users               创建
GET    /api/v1/users/123           读取
PUT    /api/v1/users/123           整体替换
PATCH  /api/v1/users/123           部分更新
DELETE /api/v1/users/123           删除

GET    /api/v1/users/123/orders    嵌套子资源
```

### RPC 风格（推荐复杂操作）

REST 难以表达"非 CRUD 动作"时，用动词路径：

```
POST /api/v1/users/123:transfer    资源动作
POST /api/v1/orders/456:cancel
POST /api/v1/auth:login
```

### 命名约定

- **资源用复数**：`/users` 不是 `/user`
- **小写连字符**：`/api/order-items` 不是 `/orderItems`
- **不带后缀**：`/users` 不是 `/users.json`（用 Accept header 协商）
- **避免动词嵌入路径**：`/users/get-by-email` ❌ → 用查询参数

### 查询参数

```
GET /api/v1/users
    ?page=1&page_size=20             分页
    &sort=created_at:desc             排序
    &filter[status]=active            过滤
    &fields=id,email                  字段筛选
    &search=alice                     全文搜索
```

## HTTP 方法语义

| 方法 | 安全 | 幂等 | 用途 |
|---|---|---|---|
| GET | ✅ | ✅ | 读，不改状态 |
| HEAD | ✅ | ✅ | 同 GET，不返回 body |
| POST | ❌ | ❌ | 创建 / 非幂等动作 |
| PUT | ❌ | ✅ | 整体替换（同样请求多次结果一样） |
| PATCH | ❌ | ❌ | 部分更新 |
| DELETE | ❌ | ✅ | 删除（删了再删返 204 或 404） |

**安全** = 不改服务端状态。**幂等** = 同样请求多次效果相同。

## 状态码

| 范围 | 含义 |
|---|---|
| 2xx | 成功 |
| 3xx | 重定向 |
| 4xx | 客户端错（请求格式错） |
| 5xx | 服务端错 |

常用：

| Code | 用法 |
|---|---|
| 200 OK | 成功（GET / 有响应体的 POST） |
| 201 Created | 创建成功（POST） |
| 204 No Content | 成功无响应体（DELETE） |
| 400 Bad Request | 请求格式错（缺字段 / 类型错） |
| 401 Unauthorized | 未登录 / token 过期 |
| 403 Forbidden | 已登录但无权限 |
| 404 Not Found | 资源不存在 |
| 409 Conflict | 冲突（重复创建 / 版本冲突） |
| 422 Unprocessable Entity | 语义错（业务校验失败） |
| 429 Too Many Requests | 限流 |
| 500 Internal Server Error | 服务端 bug |
| 503 Service Unavailable | 服务不可用（依赖挂了） |

❌ 不要把所有错误都返 200 + body 里 `success: false`——损失了 HTTP 语义和监控能力。

## 错误响应格式

**统一**用同一个结构（推荐 RFC 7807 Problem Details 或自定义）：

```json
{
  "code": "EMAIL_ALREADY_EXISTS",
  "message": "该邮箱已注册",
  "details": {
    "field": "email",
    "value": "alice@example.com"
  },
  "trace_id": "abc-123-def"
}
```

- `code` — 机器可读，客户端 switch 用
- `message` — 人类可读（注意国际化）
- `details` — 字段级错误（表单校验场景）
- `trace_id` — 关联服务端日志

字段验证错误（多字段）：

```json
{
  "code": "VALIDATION_FAILED",
  "message": "请求字段校验失败",
  "errors": [
    { "field": "email", "code": "INVALID_FORMAT", "message": "邮箱格式不对" },
    { "field": "age",   "code": "TOO_SMALL",      "message": "年龄必须 ≥ 18" }
  ]
}
```

## 响应格式

### 单个资源

```json
{
  "id": 123,
  "email": "alice@example.com",
  "name": "Alice",
  "created_at": "2026-05-08T10:00:00Z"
}
```

### 列表 + 分页

```json
{
  "data": [ /* items */ ],
  "pagination": {
    "page": 1,
    "page_size": 20,
    "total": 156,
    "total_pages": 8
  }
}
```

或游标分页（**大数据量推荐**）：

```json
{
  "data": [...],
  "next_cursor": "eyJpZCI6MTIzfQ==",
  "has_more": true
}
```

### 字段命名

- **统一一种风格**：snake_case 或 camelCase 选一个，全 API 一致
- 时间用 ISO 8601 字符串：`"2026-05-08T10:00:00Z"`（不要返 unix timestamp 数字，缺乏时区）
- 金额用字符串避免精度：`"amount": "99.99"` 不是 `99.99` 浮点

## 分页 / 排序 / 过滤

### 分页

```
?page=1&page_size=20         传统分页
?cursor=xxx&limit=20         游标分页（大数据量）
```

### 排序

```
?sort=created_at:desc
?sort=name:asc,created_at:desc   多字段
```

### 过滤

```
?status=active                       简单
?filter[status]=active&filter[role]=admin   嵌套
?created_at_gte=2026-01-01           范围
```

## 版本化

### 推荐：URL 版本

```
/api/v1/users
/api/v2/users
```

简单清晰，调用方一眼看出。

### 或：Header 版本

```
GET /api/users
X-API-Version: 1
```

URL 干净，但需要客户端配合发 header。

### 升级策略

- 加字段 → 不破坏，**不需要**升 major
- 改字段类型 / 删字段 → 破坏，**必须**升 major
- 老版本至少**保留 6 个月** + deprecation header
- `Sunset: Sat, 31 Dec 2026 23:59:59 GMT` 提示停服时间

## 鉴权

```
Authorization: Bearer <token>
```

不要：
- 把 token 放 URL 参数（会进日志 / referer 泄露）
- 自己设计 cookie 协议（用现成的 session / JWT）
- 在响应体里返 token（应该 Set-Cookie httpOnly）

## 速率限制

响应头：

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 73
X-RateLimit-Reset: 1715169000
Retry-After: 30
```

超限返 `429 Too Many Requests`。

## 幂等性（关键场景）

POST 创建有时需要幂等（防网络重试导致重复创建）：

```
POST /api/v1/orders
Idempotency-Key: <uuid>
```

服务端在指定时间窗内（24h）记住该 key 的响应，重复请求返同样结果。

## 文档

- OpenAPI / Swagger 文档**必须**有
- 用 `zod-to-openapi` / `springdoc` / `@nestjs/swagger` 自动生成
- 所有接口都要：路径 / 方法 / 请求 schema / 响应 schema / 错误码列表 / 示例

## 常见反模式

❌ GET 接口改数据库（破坏安全语义）
❌ 同一接口根据参数返不同结构（应该拆 / 用 union）
❌ 把所有逻辑塞 `/api/do?action=xxx`（用 RESTful 路径）
❌ 字段命名一会 `userId` 一会 `user_id`
❌ 错误信息只返字符串没 code（客户端只能字符串匹配）
❌ 删除接口返 200 + 空 body（应该 204）
❌ 不分页的列表接口（数据涨了就 OOM）

## 公开 API 额外要求

- CORS：白名单 origin
- API key：管理后台可创建 / revoke / 限流
- Webhook：必须签名（HMAC）
- SDK：先有 OpenAPI，再自动生成 SDK
- Changelog：每次 API 改动写下来

## 与其他技能的关系

- 设计前先 `brainstorming` 明确需求
- 复杂 API 先 `writing-plans` 出方案
- 安全相关字段（密码 / token）走 `security-best-practices`
- 实现完成 → `verification-before-completion`（包括 OpenAPI 文档同步）
