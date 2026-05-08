---
name: microservices-patterns
description: 任何涉及微服务架构设计 / 服务拆分 / 服务间通信 / 数据一致性的任务，**调用此技能**遵守经典模式（Saga / API Gateway / Service Mesh），避免分布式单体、数据耦合、级联故障等常见坑。
---

# 微服务架构模式

## 适用场景

- 拆分单体到微服务
- 设计新微服务系统
- 服务间通信选型
- 跨服务事务 / 数据一致性
- 服务发现 / 治理

## 先警告：你需要微服务吗？

**默认答案：不需要**。

微服务的代价：
- 调用链复杂（一个请求过 5 个服务）
- 分布式事务难（不能 ACID 了）
- 数据一致性难（最终一致）
- 部署 / 监控 / 调试 / 测试**全部翻几倍**
- 团队协作摩擦（API 契约 / 版本兼容）

**先用单体 / Modular Monolith** 跑起来，团队 > 20 人或部署有明确瓶颈再拆。

## 服务拆分原则

### 按业务领域（DDD bounded context）

❌ 按技术分（DB 服务、API 服务、UI 服务）
✅ 按业务分（订单、库存、支付、用户）

### Conway's Law

服务结构会反映组织结构。**先看团队边界**：
- 每个服务一个团队（2-pizza team，5-9 人）
- 跨团队调用 = 服务边界

### 服务粒度

❌ 太小（每个表一个服务 = 分布式 CRUD）
❌ 太大（半个系统在一个服务里）
✅ 一个 bounded context 一个服务，3-30 个 API endpoint

## 8 条核心模式

### 1. API Gateway

所有客户端请求统一入口：

```
Client
  │
  ▼
┌──────────────────────────────────────┐
│ API Gateway                          │
│ - 路由（/users → user-service）       │
│ - 鉴权                                │
│ - 限流                                │
│ - 聚合（一个客户端请求 = 多个后端调用） │
│ - 缓存                                │
└──────────┬───────────┬───────────────┘
           ▼           ▼
       user-svc    order-svc
```

工具：Kong / Apigee / AWS API Gateway / 自己写（Hono / Fastify + Service Discovery）

### 2. 服务间通信 — 同步 vs 异步

| 模式 | 用途 | 协议 |
|---|---|---|
| 同步 RPC | 立刻需要结果（user-svc 查用户） | gRPC / HTTP |
| 异步消息 | 解耦 / fire-and-forget | Kafka / RabbitMQ / NATS |
| 事件流 | 多消费者、回放 | Kafka |
| Pub/Sub | 通知（不在乎是否有消费者） | Redis Pub/Sub |

**经验**：
- 同步链路 ≤ 2 跳（A → B → C 已经很危险，B 挂掉 A 也挂）
- 异步首选（韧性更好）
- gRPC 内部、HTTP 对外（兼容 / 调试方便）

### 3. Database-per-Service

❌ 共享数据库（**最毒的反模式**）：
- 一改 schema 影响所有服务
- 任何服务可读所有数据 → 安全 / 一致性灾难
- 失去服务自治

✅ 每个服务自己的数据库：
```
user-service    →  postgres-users
order-service   →  postgres-orders
inventory-svc   →  postgres-inventory
```

需要别人的数据 → 调它的 API 或订阅事件，不直读 DB。

### 4. Saga（分布式事务替代）

跨服务的"事务"用 Saga（一连串本地事务 + 补偿）：

```
下单流程：
1. order-service 创建订单（本地事务）
2. → payment-service 扣款 OK 
3. → inventory-service 扣库存 OK
4. → shipping-service 发货
   X 失败
5. ← 补偿：恢复库存
6. ← 补偿：退款
7. ← 补偿：取消订单
```

实现方式：
- **编排式（Orchestration）**：中央协调器（Temporal / Camunda）
- **协同式（Choreography）**：各服务订阅事件自己反应

简单场景用协同式，复杂用编排式。

### 5. CQRS — 读写分离

```
写入路径：       读取路径：
Command        Query
  │              │
  ▼              ▼
Write Model →  Read Model（多个、按查询优化）
  │
  └── 事件 ──▶ Read Model 异步更新
```

适合：读频率 >> 写、查询复杂。
不适合：CRUD 简单系统（过度工程）。

### 6. Outbox 模式（事件可靠投递）

问题：DB 写入成功但发消息失败 → 不一致。

✅ Outbox：
1. 同一事务里写业务表 + 写 outbox 表（事件）
2. 后台 worker 读 outbox → 发消息 → 标记已发

伪代码：
```sql
BEGIN;
INSERT INTO orders (...) VALUES (...);
INSERT INTO outbox (event_type, payload) VALUES ('OrderCreated', '...');
COMMIT;

-- 后台 worker
SELECT * FROM outbox WHERE sent = false;
-- 发到 Kafka → UPDATE outbox SET sent = true;
```

或用 CDC（Debezium）从 DB binlog 直接读改动。

### 7. Circuit Breaker（防级联故障）

下游挂了，调用方也挂了 → 雪崩。

```ts
import CircuitBreaker from 'opossum'

const breaker = new CircuitBreaker(callOrderService, {
  timeout: 3000,
  errorThresholdPercentage: 50,    // 50% 失败 → 开路
  resetTimeout: 30000,             // 30s 后尝试半开
})

breaker.fallback(() => ({ ok: false, cached: true }))
breaker.on('open', () => alert('Order service down!'))
```

状态：
- **Closed**（关闭）：正常调用
- **Open**（开路）：直接返 fallback，不打下游
- **Half-Open**（半开）：试探性放过几个请求

### 8. Service Mesh（服务网格）

把网络治理（重试、超时、mTLS、限流、tracing）下沉到 sidecar，应用代码无感：

```
┌──────────┐   ┌──────────┐
│ App A    │   │ App B    │
└────┬─────┘   └────┬─────┘
     ▼               ▼
┌──────────┐   ┌──────────┐
│ Envoy A  │←─→│ Envoy B  │
└──────────┘   └──────────┘
   ↑                ↑
   └─── Control ────┘
       Plane（Istio / Linkerd）
```

Istio / Linkerd / Consul Connect。

何时用：服务数 > 20，有强治理需求。少了反而过度复杂。

## 可观测性三件套

### Logs

每个服务结构化 JSON 日志，统一收集到 ELK / Loki：
```json
{ "level": "info", "service": "order", "trace_id": "abc-123", "msg": "Created order", "order_id": "ord-1" }
```

### Metrics

Prometheus + Grafana：
- 请求 QPS / 延迟（p50 / p99）
- 错误率
- 资源使用（CPU / 内存）
- 业务指标（订单数、收入）

### Tracing

OpenTelemetry → Jaeger / Tempo：
```
trace_id: abc-123
├─ order-service.create [120ms]
│  ├─ payment-service.charge [50ms]
│  └─ inventory-service.reserve [60ms]
└─ shipping-service.schedule [30ms]
```

跨服务问题一眼定位。

## 服务发现

| 模式 | 工具 |
|---|---|
| K8s 原生 | Kubernetes DNS / Service |
| 注册中心 | Consul / Etcd / Nacos |
| Service Mesh | Envoy + Istio |
| Cloud | AWS Cloud Map / GCP Service Directory |

K8s 项目最简单：直接用 `http://order-service:80`。

## API 版本管理

服务间 API 改动**不能一夜之间所有调用方都改**。

策略：
- URL 版本：`/api/v1/users`、`/api/v2/users` 共存
- gRPC：proto 加新字段（向后兼容），删字段要 deprecate 6 个月
- 异步消息：事件加版本字段，消费方按版本路由

## 部署策略

| 策略 | 适用 |
|---|---|
| **Rolling Update** | 默认，逐个 Pod 替换 |
| **Blue-Green** | 关键服务，能立刻回滚 |
| **Canary** | 渐进发布，监控指标 |
| **Feature Flag** | 部署 ≠ 上线，运行时控制 |

工具：Argo Rollouts / Flagger / LaunchDarkly。

## 反模式（**不要这样**）

❌ **分布式单体**：服务很多但相互强耦合，一改全改
   ✅ 边界清晰，独立可发布

❌ **共享数据库**
   ✅ Database-per-Service

❌ **同步链路 > 3 跳**
   ✅ 异步事件 + CQRS

❌ **没有 trace_id**
   ✅ OpenTelemetry 全链路 trace

❌ **每个服务自己一套日志格式**
   ✅ 统一结构化日志

❌ **没有 circuit breaker / 重试 / 超时**
   ✅ 一个下游挂掉拖死全栈

❌ **服务粒度过细**（一张表一个服务）
   ✅ 按业务领域聚合

## 何时**回归单体**

如果你看到：
- 80% 的修改要改 ≥ 3 个服务
- 调用链超 5 跳
- 部署需要协调多个团队同步上线
- 调试一个 bug 要查 5 个服务的日志

→ 服务拆得太细了。考虑合并几个服务回单体或 modular monolith。

## 与其他技能的关系

- API 设计 → api-design
- 异步消息 → event-driven-architecture
- 容器部署 → docker-best-practices, kubernetes-deployment
- 数据库 → sql-query-optimization, mongodb-best-practices
- CI/CD → ci-cd-github-actions
