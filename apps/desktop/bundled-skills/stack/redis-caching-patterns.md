---
name: redis-caching-patterns
description: 任何引入 Redis 缓存的任务，**调用此技能**遵守 cache pattern / 失效策略 / 雪崩防护，避免缓存击穿、缓存穿透、数据不一致等经典坑。
---

# Redis 缓存模式实战

## 适用场景

- 给热接口加缓存
- 数据库压力大
- 限流 / 排行榜 / 计数器
- 分布式锁 / pub-sub
- session 存储

## 缓存的 3 个真相

1. **缓存解决"读多写少"问题**——写多读少加缓存反而更慢
2. **缓存数据可能脏**——必须有失效策略
3. **缓存依赖必须有 fallback**——Redis 挂了应用要还能跑（降级）

## 4 种基础模式

### 1. Cache-Aside（最常用）

```
读：缓存有 → 返回
   缓存无 → 查 DB → 写缓存 → 返回
写：写 DB → 失效缓存（不是更新）
```

```ts
async function getUser(id: number): Promise<User> {
  const key = `user:${id}`
  
  const cached = await redis.get(key)
  if (cached) return JSON.parse(cached)
  
  const user = await db.user.findUnique({ where: { id } })
  if (user) {
    await redis.setex(key, 300, JSON.stringify(user))  // 5 分钟 TTL
  }
  return user
}

async function updateUser(id: number, data: any) {
  await db.user.update({ where: { id }, data })
  await redis.del(`user:${id}`)  // 失效
}
```

**为什么删而不更新**：
- 多副本场景，更新缓存可能写入旧值（覆盖新值）
- 删除是幂等的，下次读自然刷新

### 2. Write-Through

```
写：写 DB → 同步写缓存
读：直接读缓存
```

适合：数据变化频率低 + 强一致需求。
缺点：写延迟高（双写）。

### 3. Write-Behind（异步写）

```
写：写缓存（立即返回）→ 异步刷到 DB
```

性能最好但**有丢数据风险**。慎用，仅适合：计数器 / 日志类容忍丢失。

### 4. Read-Through

库（Redis Module、CacheClient）自动读 DB → 业务代码看不到。

## 失效策略（很关键）

### TTL — 主动过期

```ts
// 简单 TTL
await redis.setex(key, 300, value)  // 300 秒后过期

// 永不过期（危险）
await redis.set(key, value)  // 没 TTL 容易堆积
```

**所有缓存 key 都该有 TTL**。除非明确知道为什么不要。

### 主动失效

写 DB 后立即 DEL 对应缓存：
```ts
async function updateOrder(id: number) {
  await db.order.update(...)
  await redis.del(`order:${id}`)
  await redis.del(`user:${userId}:orders`)  // 关联缓存也失效
}
```

### Tag-Based 失效

让一组缓存共享一个版本号：
```ts
async function getCachedPostList(userId: number) {
  const ver = await redis.get(`user:${userId}:posts:ver`) ?? '0'
  const key = `user:${userId}:posts:list:v${ver}`
  
  const cached = await redis.get(key)
  if (cached) return JSON.parse(cached)
  // ...

}

async function invalidateUserPosts(userId: number) {
  await redis.incr(`user:${userId}:posts:ver`)  // 版本号 +1，所有 list 失效
}
```

## 三大经典问题

### 1. 缓存穿透（查不存在的数据）

**场景**：恶意请求查 id=99999999（不存在），缓存没有，每次都打 DB。

**对策**：

A. 缓存空值（短 TTL）
```ts
const user = await db.user.findUnique({ where: { id } })
if (!user) {
  await redis.setex(key, 60, 'null')  // 缓存空，1 分钟
  return null
}

// 读取时
if (cached === 'null') return null
```

B. 布隆过滤器（先判断 id 可能存在）
```ts
import { BloomFilter } from 'bloom-filters'
// 启动时把所有 id 灌进 bloom
const exists = bloom.has(id)  // false 直接返 null，不打 DB
```

### 2. 缓存击穿（热点 key 过期瞬间）

**场景**：单个热点 key（首页配置）TTL 到期，瞬间 10K 请求一起打 DB。

**对策**：

A. 互斥锁（重建缓存只允许一个请求）
```ts
async function getHotData() {
  let cached = await redis.get(key)
  if (cached) return JSON.parse(cached)
  
  // 抢锁
  const lockKey = `${key}:lock`
  const got = await redis.set(lockKey, '1', 'NX', 'EX', 10)
  if (got !== 'OK') {
    // 没抢到 → 等一下再试
    await sleep(50)
    return getHotData()  // 递归
  }
  
  try {
    const data = await db.findData()
    await redis.setex(key, 300, JSON.stringify(data))
    return data
  } finally {
    await redis.del(lockKey)
  }
}
```

B. 异步刷新（永不过期 + 后台更新）
```ts
async function getHotData() {
  const cached = await redis.get(key)
  if (!cached) {
    // 第一次：同步读 DB
    return refreshAndCache()
  }
  
  const { data, refreshAt } = JSON.parse(cached)
  if (Date.now() > refreshAt) {
    // 已过期：返回旧数据，触发后台刷新
    refreshAndCache()  // 不 await
  }
  return data
}
```

### 3. 缓存雪崩（大量 key 同时过期）

**场景**：大量 key 设置同一 TTL，到期瞬间数据库被打爆。

**对策**：

A. TTL 加随机扰动
```ts
const ttl = 300 + Math.floor(Math.random() * 60)  // 300-360 秒
await redis.setex(key, ttl, value)
```

B. 多层缓存（local + Redis + DB）
```ts
// 内存 LRU（节点级）→ Redis（集群级）→ DB
const lruCache = new LRU({ max: 1000, ttl: 30_000 })

async function get(id: number) {
  if (lruCache.has(id)) return lruCache.get(id)
  const r = await redis.get(`user:${id}`)
  if (r) {
    lruCache.set(id, r)
    return JSON.parse(r)
  }
  const u = await db.user.findUnique({ where: { id } })
  // ...
}
```

C. Redis 高可用（哨兵 / Cluster）

## 数据结构选型

| 场景 | 类型 | 命令 |
|---|---|---|
| 简单 K/V | string | GET / SET |
| 计数器 | string + INCR | INCR / DECR |
| 列表（消息队列） | list | LPUSH / RPOP |
| 去重集合 | set | SADD / SISMEMBER |
| 排行榜 | sorted set | ZADD / ZRANGE |
| 用户 profile | hash | HSET / HGETALL |
| Bitmap（用户活跃日历） | bitmap | SETBIT / GETBIT |
| 大量去重计数 | HyperLogLog | PFADD / PFCOUNT |
| 实时 PubSub | pub/sub | SUBSCRIBE / PUBLISH |
| 流处理 | stream | XADD / XREAD |
| 地理位置 | geo | GEOADD / GEORADIUS |

## 常用模式代码

### 排行榜

```ts
// 加积分
await redis.zincrby('leaderboard', 10, userId)

// Top 10
const top = await redis.zrevrange('leaderboard', 0, 9, 'WITHSCORES')

// 我的排名
const rank = await redis.zrevrank('leaderboard', userId)
```

### 限流（固定窗口）

```ts
async function isAllowed(userId: string, max = 100, window = 60): Promise<boolean> {
  const key = `rate:${userId}:${Math.floor(Date.now() / 1000 / window)}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, window)
  return count <= max
}
```

更精确：滑动窗口 / 令牌桶（用 sorted set 或 Lua 脚本）。

### 分布式锁（Redlock）

```ts
import Redlock from 'redlock'
const redlock = new Redlock([redis], { retryCount: 3, retryDelay: 200 })

async function processOrder(orderId: string) {
  const lock = await redlock.acquire([`lock:order:${orderId}`], 5000)
  try {
    // 业务
  } finally {
    await lock.release()
  }
}
```

**警告**：分布式锁有时钟假设 + 网络分区问题。**关键场景用 DB 唯一索引 / Postgres advisory lock**，不要单纯靠 Redis。

### Session 存储

```ts
// Express + connect-redis
import RedisStore from 'connect-redis'
import session from 'express-session'

app.use(session({
  store: new RedisStore({ client: redis }),
  secret: 'xxx',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}))
```

## 反模式

❌ 缓存所有查询结果 → 命中率低 + 浪费内存
   ✅ 只缓存**高频热点**

❌ 缓存大对象（10MB JSON）→ Redis 卡住
   ✅ 拆字段或用 hash

❌ 没设 TTL → 内存堆爆
   ✅ 默认必须有 TTL

❌ 用 KEYS * 扫描 → 阻塞 Redis
   ✅ 用 SCAN 游标

❌ 缓存命中失败就报错 → Redis 挂掉影响业务
   ✅ try/catch + 降级到 DB

❌ 写穿透：写 DB 同时写 Redis → 一致性问题
   ✅ Cache-Aside（写 DB + 删 Redis）

## 监控

- **命中率**：keyspace_hits / (keyspace_hits + keyspace_misses) → > 90%
- **内存使用**：used_memory / maxmemory → < 80%
- **驱逐数**：evicted_keys → 长期 > 0 说明内存不够
- **慢查询**：`SLOWLOG GET 10`
- **连接数**：connected_clients

## 与其他技能的关系

- DB 慢 → 加 Redis 之前先 sql-query-optimization
- API 设计 → api-design（接口幂等才好缓存）
- 高可用架构 → microservices-patterns
