---
name: event-driven-architecture
description: 任何涉及消息队列 / 事件流 / 异步通信（Kafka / RabbitMQ / NATS / SQS）的设计或实现，**调用此技能**遵守事件设计、幂等、有序、重试规范，避免重复消费、消息丢失、顺序错乱等问题。
---

# 事件驱动架构（Event-Driven Architecture）

## 适用场景

- 服务解耦（A 不直接调 B）
- 异步任务（邮件、通知、计算密集）
- 事件溯源（Event Sourcing）
- 实时数据流（点击流、日志聚合）
- CDC（Change Data Capture）

## 选型矩阵

| 工具 | 模型 | 适用 | 不适用 |
|---|---|---|---|
| **Kafka** | 持久化日志 | 高吞吐、回放、流处理 | 复杂路由、低延迟（< 5ms） |
| **RabbitMQ** | 经典 MQ | 灵活路由、传统消息 | 大吞吐（> 10w QPS） |
| **NATS / NATS JetStream** | Pub-Sub + 持久化 | 微服务通信、低延迟 | 大数据回溯 |
| **AWS SQS** | 简单队列 | 任务队列、解耦 | 实时流、Pub-Sub |
| **Redis Streams** | 轻量流 | 小规模、已有 Redis | 大规模、长保留 |

**默认选 Kafka 或 NATS**。RabbitMQ 适合传统企业。

## 事件类型 — 4 种主流

### 1. Event Notification（轻量通知）

```json
{ "type": "OrderCreated", "orderId": "ord-1", "timestamp": 1234567890 }
```

消费者要详细信息 → 自己去 API 拉。
**优点**：消息小、解耦
**缺点**：消费者要回调 → 增加调用方负担

### 2. Event-Carried State Transfer（携带状态）

```json
{
  "type": "OrderCreated",
  "data": {
    "orderId": "ord-1",
    "userId": "user-1",
    "items": [...],
    "total": 99.99,
    "createdAt": "2026-05-08T10:00:00Z"
  }
}
```

消费者不用回调。
**优点**：消费者自给自足
**缺点**：消息大、可能携带过时数据

### 3. Event Sourcing（事件作为真相源）

不存"当前状态"，存"所有事件"，状态是事件流的归约：

```
[OrderCreated] → [ItemAdded] → [PaymentReceived] → [Shipped]
```

读取 = replay 事件。

**优点**：完整审计、时间穿越调试
**缺点**：复杂、查询难（要建 read model / CQRS）

### 4. CQRS + Event Stream

写命令 → 事件 → 多个 read model 投影：
```
Command → Aggregate → Events → Kafka
                                  ├─→ Postgres（业务查询）
                                  ├─→ Elasticsearch（搜索）
                                  └─→ Redis（缓存）
```

## 8 条铁律

### 1. 事件命名 — 过去式 + 业务语义

```
✅ OrderPlaced / PaymentReceived / UserRegistered
❌ CreateOrder / DoPayment（命令式，不是事件）
❌ OrderEvent / Event1（无意义）
```

事件 = "已发生的事实"，过去式。

### 2. 消息**必须**带 schema + 版本

```json
{
  "schema": "OrderCreated",
  "version": 1,
  "id": "evt-uuid",                  // 事件唯一 ID（去重用）
  "timestamp": "2026-05-08T10:00:00Z",
  "trace_id": "trace-abc",            // 跨服务追踪
  "data": { ... }
}
```

工具：Avro / Protobuf / JSON Schema + Schema Registry。

升级原则：
- 加字段 ✅（向后兼容）
- 改字段类型 ❌
- 删字段 ❌（改成 deprecated 字段）
- 重命名 ❌（加新字段，旧的保留）

### 3. 消费者**必须**幂等

消息可能重复（at-least-once 是默认语义）：

```ts
async function handleOrderCreated(event: OrderCreatedEvent) {
  // ✅ 用业务 ID 做去重
  const exists = await db.processedEvents.findOne({ where: { eventId: event.id } })
  if (exists) return
  
  await db.transaction(async (tx) => {
    await processOrder(tx, event.data)
    await tx.processedEvents.create({ data: { eventId: event.id } })
  })
}
```

或：操作天然幂等
```ts
// ✅ idempotent
db.users.update({ where: { id }, data: { email: 'x@y.com' } })  // 重复跑结果一样

// ❌ 非幂等
db.users.update({ where: { id }, data: { balance: { increment: 100 } } })  // 重复加钱！
```

### 4. 错误处理 — DLQ（死信队列）

消费失败 N 次 → 进 DLQ，人工或自动 review：

```ts
async function consume(msg: Message) {
  try {
    await handle(msg)
    msg.ack()
  } catch (err) {
    if (msg.deliveryCount > 5) {
      await sendToDLQ(msg, err)
      msg.ack()  // 从主队列移除
    } else {
      msg.nack()  // 重试
    }
  }
}
```

DLQ 必须有监控告警（不能埋着）。

### 5. 顺序保证（如果需要）

Kafka：同 partition 内顺序保证。**按业务 key 分 partition**：
```ts
producer.send({
  topic: 'orders',
  messages: [{
    key: order.userId,        // 同 user 的事件进同一 partition → 顺序保证
    value: JSON.stringify(event),
  }],
})
```

注意：partition 数 = 并发上限。多了浪费、少了瓶颈。

NATS / RabbitMQ：单消费者顺序，多消费者并发会乱。

### 6. 消费者组（Consumer Group）

让多消费者共享一个 topic 的负载：

```
Topic: orders（10 partitions）
Consumer Group: notification-svc（3 实例）
  → 实例 1 消费 partition 1, 4, 7
  → 实例 2 消费 partition 2, 5, 8
  → 实例 3 消费 partition 3, 6, 9, 10
```

加副本横向扩展，每个 partition 严格只被组内一个实例消费。

### 7. Offset / Ack 时机

```ts
async function consume(msg) {
  // ❌ 先 ack 后处理 → 失败丢消息
  msg.ack()
  await handle(msg)
  
  // ✅ 后 ack
  await handle(msg)
  msg.ack()
}
```

但要小心：
- handle 跑很久 → 消费滞后
- handle 抛错 → 不 ack → 自动重试

### 8. Outbox 模式（事件可靠投递）

```
应用业务 + 写 outbox 表（同事务）
        ↓
    Worker / CDC
        ↓
    Kafka / MQ
```

避免"DB 写成功但消息发失败"。

伪代码：
```ts
await db.transaction(async (tx) => {
  await tx.orders.create({ data: order })
  await tx.outbox.create({ data: { event: 'OrderCreated', payload: order } })
})

// 后台 worker
const events = await db.outbox.findMany({ where: { sent: false } })
for (const e of events) {
  await kafka.produce(e)
  await db.outbox.update({ where: { id: e.id }, data: { sent: true } })
}
```

## Kafka 实战

### Producer

```ts
import { Kafka } from 'kafkajs'

const kafka = new Kafka({ brokers: ['kafka:9092'] })
const producer = kafka.producer({
  idempotent: true,             // 防止重发
  maxInFlightRequests: 5,
})

await producer.connect()
await producer.send({
  topic: 'orders',
  messages: [{
    key: order.userId,
    value: JSON.stringify({ schema: 'OrderCreated', version: 1, data: order }),
    headers: { trace_id: traceId },
  }],
})
```

### Consumer

```ts
const consumer = kafka.consumer({ groupId: 'notification-svc' })
await consumer.subscribe({ topic: 'orders', fromBeginning: false })

await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {
    const event = JSON.parse(message.value!.toString())
    try {
      await handle(event)
      // 自动 ack（commit offset）
    } catch (err) {
      await sendToDLQ(message, err)
    }
  },
})
```

### Topic 设计

```
order.events            → 主业务事件
order.events.dlq        → DLQ
order.events.retry.1    → 1 分钟后重试
order.events.retry.10   → 10 分钟后重试
```

Topic 名字反映业务，不要 `topic1, topic2`。

## NATS 实战（轻量）

```ts
import { connect, JSONCodec } from 'nats'

const nc = await connect({ servers: 'nats://localhost:4222' })
const jc = JSONCodec()

// JetStream（持久化）
const js = nc.jetstream()
await js.publish('orders.created', jc.encode({ id: 'ord-1' }))

// 消费
const sub = await js.subscribe('orders.>', { config: { durable_name: 'notif-svc' } })
for await (const m of sub) {
  const event = jc.decode(m.data)
  await handle(event)
  m.ack()
}
```

## 测试

### 单元测试 handler

```ts
test('handleOrderCreated', async () => {
  await handle({ id: 'evt-1', data: { orderId: 'ord-1' } })
  expect(await db.orders.findOne('ord-1')).toBeTruthy()
})
```

### 集成测试 — Testcontainers

```ts
import { KafkaContainer } from '@testcontainers/kafka'

const kafka = await new KafkaContainer().start()
const broker = kafka.getBootstrapServers()
// 用真 kafka 测端到端
```

## 监控 / 告警

- **延迟（lag）**：消费比生产慢多少 → 高了说明消费 不过来
- **DLQ 增长率**：> 0 必查
- **吞吐 QPS**：监控容量
- **消费失败率**

Kafka：用 burrow / kafka-exporter + Prometheus。

## 反模式

❌ **同步等待消费结果**
   消息系统是"发完就走"，要结果用 RPC

❌ **大消息（> 1MB）**
   把 payload 存 S3，消息只放 ID

❌ **事件 = CRUD（CreateOrder / UpdateOrder）**
   事件应该是业务事实（OrderPlaced / OrderShipped）

❌ **无版本字段，破坏改动直接发**
   消费者读不懂，运行时崩

❌ **DLQ 不监控**
   消息默默丢，业务不一致

❌ **跨服务**事务**用消息凑**
   用 Saga 模式或 Outbox

## 与其他技能的关系

- 微服务架构 → microservices-patterns
- API 同步通信 → api-design
- 数据库写入 + 事件 → 用 Outbox（结合 database-migration-safety）
- 错误重试 → error-handling-patterns
