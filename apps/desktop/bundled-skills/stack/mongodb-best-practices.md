---
name: mongodb-best-practices
description: 任何 MongoDB 项目改动（schema、索引、聚合、连接池），**调用此技能**遵守文档型数据库设计规范，避免内嵌过深、查询全集合扫、聚合内存超限等问题。
---

# MongoDB 最佳实践（6+/Atlas）

## 适用场景

- MongoDB schema 设计
- 索引优化
- 聚合管道（aggregation）
- 连接池配置
- 事务（4.0+）
- 副本集 / 分片

## 核心心智模型：MongoDB 不是 SQL

| 维度 | SQL | MongoDB |
|---|---|---|
| 数据模型 | 表 + 行 + 关系 | 集合 + 文档 + **嵌入或引用** |
| Schema | 强制 | 灵活但**应该约束** |
| JOIN | 一等公民 | $lookup（不推荐重度用） |
| 事务 | 默认 | 4.0+ 副本集 / 4.2+ 分片 支持 |
| 关系 | 通过外键 | 决定**嵌入还是引用** |

## 8 条铁律

### 1. Schema 设计 — 嵌入 vs 引用

**嵌入（embed）**适合：
- 1:1 关系
- 1:few（< 几十个子文档）
- 一起读一起写

```js
// User 嵌入 addresses（地址数量有限）
{
  _id: ObjectId,
  email: 'a@b.com',
  addresses: [
    { type: 'home', street: '...', city: '...' },
    { type: 'office', street: '...' },
  ],
}
```

**引用（reference）**适合：
- 1:many / many:many
- 子文档独立增长（评论、订单）
- 需要单独查子文档

```js
// posts 集合
{ _id: ObjectId, title: '...', authorId: ObjectId('...') }

// users 集合
{ _id: ObjectId, name: '...' }

// 查 post 带作者：用 $lookup 或应用层 join
```

**经验法则**：
- 嵌入数组 < 100 个元素
- 单文档 < 16MB（MongoDB 硬上限）
- 高频更新的子结构 → 引用（不然每次更新整个父文档）

### 2. _id 用 ObjectId 还是自定义

```js
// 默认 ObjectId（推荐）
{ _id: ObjectId('...'), ... }

// 自定义（业务 ID 唯一时）
{ _id: 'user-2026-001', ... }
```

ObjectId 包含时间戳，可以从 _id 提取创建时间：
```js
new Date(parseInt(id.toString().slice(0, 8), 16) * 1000)
```

### 3. 索引 — 查询字段必建

```js
// 单字段
db.users.createIndex({ email: 1 }, { unique: true })

// 复合（顺序很关键）
db.orders.createIndex({ userId: 1, createdAt: -1 })

// 文本搜索
db.posts.createIndex({ title: 'text', body: 'text' })

// 地理位置
db.places.createIndex({ location: '2dsphere' })

// TTL（自动过期）
db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })

// 部分索引（节省空间）
db.users.createIndex(
  { email: 1 },
  { partialFilterExpression: { active: true } }
)
```

复合索引顺序原则（ESR）：
- **E**quality 先：精确匹配字段
- **S**ort 中：排序字段
- **R**ange 后：范围字段

### 4. 查询用 explain() 看执行计划

```js
db.orders.find({ userId: 'x', status: 'paid' })
  .sort({ createdAt: -1 })
  .explain('executionStats')
```

关键指标：
- `winningPlan.stage`: COLLSCAN（全扫）❌ / IXSCAN（用索引）✅
- `executionStats.totalDocsExamined`: 扫描文档数
- `executionStats.nReturned`: 返回数
- `examined / returned > 100` → 索引选择性差

### 5. 聚合管道 — 注意阶段顺序

```js
db.orders.aggregate([
  { $match: { status: 'paid', createdAt: { $gte: lastMonth } } },  // 1. 先过滤
  { $sort: { createdAt: -1 } },                                       // 2. 排序
  { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },  // 3. JOIN
  { $project: { _id: 1, total: 1, user: { $arrayElemAt: ['$user', 0] } } },  // 4. 投影
  { $limit: 20 },                                                     // 5. 限制
])
```

**优化原则**：
- `$match` 越早越好（减少后续阶段处理量）
- `$project` 早做（减少字段）
- `$limit` 在 sort 后立即（让数据库优化）
- `$lookup` 谨慎使用（无关系表的内循环）

### 6. 写操作优先用 update 操作符

```js
// ❌ 替换整个文档（丢失其他字段）
db.users.replaceOne({ _id }, { email: 'new@x.com' })

// ✅ 用操作符
db.users.updateOne({ _id }, {
  $set: { email: 'new@x.com', updatedAt: new Date() },
  $inc: { loginCount: 1 },
  $push: { history: { action: 'updated_email', at: new Date() } },
})
```

常用操作符：
- `$set` / `$unset`：设置 / 删字段
- `$inc` / `$mul`：数值增减
- `$push` / `$pull` / `$addToSet`：数组操作
- `$min` / `$max`：取小 / 取大

### 7. 分页 — 游标式优于 skip/limit

```js
// ❌ skip 大值时慢（要扫过全部）
db.posts.find({}).skip(10000).limit(20)

// ✅ 游标式：用上一页最后一个 _id
db.posts.find({ _id: { $gt: lastId } }).sort({ _id: 1 }).limit(20)
```

### 8. 事务 — 仅在必要时用

```js
const session = client.startSession()
try {
  await session.withTransaction(async () => {
    await db.collection('accounts').updateOne(
      { _id: from }, { $inc: { balance: -100 } }, { session }
    )
    await db.collection('accounts').updateOne(
      { _id: to }, { $inc: { balance: 100 } }, { session }
    )
  })
} finally {
  await session.endSession()
}
```

事务有性能开销，**优先用单文档原子操作**（MongoDB 单文档操作天然原子）。

## 连接池

```js
// Node.js MongoDB driver
const client = new MongoClient(uri, {
  maxPoolSize: 50,        // 默认 100，根据负载调
  minPoolSize: 5,
  maxIdleTimeMS: 60000,
  connectTimeoutMS: 10000,
})
```

Mongoose 也可以传同样选项。

## Schema 验证（4.0+）

虽然 MongoDB 灵活，但**强烈建议加约束**：

```js
db.createCollection('users', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['email', 'name'],
      properties: {
        email: { bsonType: 'string', pattern: '^.+@.+$' },
        name: { bsonType: 'string', minLength: 2, maxLength: 50 },
        age: { bsonType: 'int', minimum: 0, maximum: 150 },
      },
    },
  },
  validationLevel: 'strict',
  validationAction: 'error',
})
```

或在应用层用 zod / mongoose schema。

## 常见陷阱

### 陷阱 1：N+1（应用层关联）

```js
// ❌ 1 + N
const posts = await db.posts.find().toArray()
for (const p of posts) {
  p.author = await db.users.findOne({ _id: p.authorId })
}

// ✅ 一次 lookup
const posts = await db.posts.aggregate([
  { $lookup: { from: 'users', localField: 'authorId', foreignField: '_id', as: 'author' } },
  { $unwind: '$author' },
]).toArray()

// 或：批量 IN
const ids = posts.map(p => p.authorId)
const users = await db.users.find({ _id: { $in: ids } }).toArray()
const userMap = new Map(users.map(u => [u.toString(), u]))
posts.forEach(p => p.author = userMap.get(p.authorId.toString()))
```

### 陷阱 2：投影忘 _id

```js
// _id 默认返回，要排除：
db.users.find({}, { name: 1, _id: 0 })
```

### 陷阱 3：Aggregation 内存超限

`$sort` / `$group` 默认内存上限 100MB。超过会失败。

```js
// 加 allowDiskUse
db.orders.aggregate([...], { allowDiskUse: true })
```

或预先 $match 减少数据。

### 陷阱 4：写关注（write concern）

```js
// 默认 w: 1（只确认 primary）
// 重要数据用 majority
await db.orders.insertOne(doc, { writeConcern: { w: 'majority', j: true } })
```

### 陷阱 5：日期时区

MongoDB 存的是 UTC。应用层格式化时记得 toLocaleString / Intl.DateTimeFormat。

### 陷阱 6：$regex 不走索引（除非锚定）

```js
// ❌ 全扫
db.users.find({ name: /alice/i })

// ✅ 锚定开头能用索引
db.users.find({ name: /^Alice/ })
```

模糊搜索建议用 Atlas Search 或 ElasticSearch。

## 性能监控

```js
// 慢查询
db.setProfilingLevel(1, { slowms: 100 })
db.system.profile.find().sort({ ts: -1 }).limit(10)

// Atlas 自带 dashboard
```

## 备份

- **mongodump**：小库 / 一次性
- **副本集 + Oplog**：实时恢复
- **Atlas 自动快照**：生产推荐

## 与其他技能的关系

- API 设计 → api-design
- 安全 → security-best-practices（特别是注入：永远过滤用户输入到 query）
- 缓存 → redis-caching-patterns
