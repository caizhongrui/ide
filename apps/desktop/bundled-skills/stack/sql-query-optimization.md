---
name: sql-query-optimization
description: 当 SQL 查询慢、CPU 高、生产数据库压力大时，**调用此技能**用 EXPLAIN 系统化诊断 + 优化，避免凭直觉乱加索引或改 SQL。
---

# SQL 查询优化（PostgreSQL / MySQL 通用）

## 适用场景

- 接口慢（响应时间 > 200ms 且确认在 SQL）
- 数据库 CPU / IO 高
- 慢查询日志报警
- 大表扫描 / N+1 问题
- 加索引前后效果验证

## 优化原则（**严格按顺序**）

```
1. 测出真实瓶颈（不要凭感觉）
   ↓
2. 用 EXPLAIN ANALYZE 看执行计划
   ↓
3. 改写 SQL（消除全表扫 / 不必要的 JOIN）
   ↓
4. 加索引（最后手段）
   ↓
5. 验证：再跑一次 EXPLAIN，对比时间
```

不要跳过步骤 2 直接加索引——大概率没用还浪费写入性能。

## 第 1 步：测出瓶颈

### PostgreSQL

```sql
-- 启用慢查询日志
ALTER SYSTEM SET log_min_duration_statement = 100;  -- 单位 ms
SELECT pg_reload_conf();

-- 看 pg_stat_statements（最耗时的 SQL）
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT query, calls, total_exec_time, mean_exec_time
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

### MySQL

```sql
-- 慢查询日志
SET GLOBAL slow_query_log = 1;
SET GLOBAL long_query_time = 0.1;

-- performance_schema
SELECT digest_text, count_star, avg_timer_wait/1e9 AS avg_ms
FROM performance_schema.events_statements_summary_by_digest
ORDER BY sum_timer_wait DESC LIMIT 20;
```

应用层日志：每个 SQL 打耗时 + 参数（用 ORM 的 logging）。

## 第 2 步：EXPLAIN ANALYZE

### PostgreSQL

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM users WHERE email = 'x@y.com';
```

读输出（关键字）：

| 算子 | 含义 | 好坏 |
|---|---|---|
| `Seq Scan` | 全表扫 | ❌ 大表上是灾难 |
| `Index Scan` | 走索引 | ✅ |
| `Index Only Scan` | 只读索引（不回表） | ✅✅ 最快 |
| `Bitmap Index Scan` | 多 OR 条件优化 | ⭐ 中性 |
| `Nested Loop` | 嵌套循环 JOIN | 小表 OK，大表灾难 |
| `Hash Join` | 哈希 JOIN | 大表 ✅ |
| `Merge Join` | 排序合并 | 已排序 ✅ |

数字含义：
- `actual time=10.5..200.3` — 第一行 10ms，最后一行 200ms
- `rows=1234` — 实际返回行数
- `loops=N` — 该节点被执行 N 次（嵌套循环里 inner 会高）

**估计 vs 实际**：如果 `rows=10` 但 `actual rows=10000` → 统计信息过期，跑 `ANALYZE table_name`。

### MySQL

```sql
EXPLAIN FORMAT=JSON SELECT * FROM users WHERE email = 'x@y.com';
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'x@y.com';  -- 8.0+
```

`type` 字段（从好到坏）：`system > const > eq_ref > ref > range > index > ALL`
- `ALL` = 全表扫，必修
- `range` 以下 OK

## 第 3 步：改写 SQL

### 反模式 1：SELECT *

```sql
-- ❌ 多读字段 = 多 IO + 防止 covering index
SELECT * FROM orders WHERE user_id = 123;

-- ✅ 只取需要的列
SELECT id, total, created_at FROM orders WHERE user_id = 123;
```

### 反模式 2：函数包列 → 索引失效

```sql
-- ❌ 索引 (created_at) 失效
SELECT * FROM orders WHERE DATE(created_at) = '2026-05-08';

-- ✅
SELECT * FROM orders 
WHERE created_at >= '2026-05-08' AND created_at < '2026-05-09';
```

```sql
-- ❌
WHERE LOWER(email) = 'x@y.com'

-- ✅ 要么应用层 lowercase 后存
-- ✅ 要么建函数索引
CREATE INDEX idx_users_lower_email ON users (LOWER(email));
```

### 反模式 3：OR 条件

```sql
-- ❌ MySQL 可能不走索引
WHERE status = 'active' OR vip = true

-- ✅ UNION ALL 让两边各自走索引
SELECT * FROM users WHERE status = 'active'
UNION ALL
SELECT * FROM users WHERE vip = true AND status != 'active';
```

### 反模式 4：N+1

应用层伪代码：
```python
# ❌ 1 + N 次查询
users = db.query("SELECT * FROM users LIMIT 100")
for u in users:
    posts = db.query("SELECT * FROM posts WHERE user_id = ?", u.id)

# ✅ 一次 JOIN 或 IN
SELECT * FROM users u
LEFT JOIN posts p ON p.user_id = u.id
LIMIT 100;

# 或：
user_ids = [u.id for u in users]
posts = db.query("SELECT * FROM posts WHERE user_id IN (...)", user_ids)
```

ORM：`Preload`（GORM）/ `selectinload`（SQLAlchemy）/ `with`（Prisma）。

### 反模式 5：LIMIT 偏移大

```sql
-- ❌ OFFSET 100000 → 扫 100100 行扔掉前 100000
SELECT * FROM posts ORDER BY id LIMIT 100 OFFSET 100000;

-- ✅ 游标分页（用上一页最后一行 id）
SELECT * FROM posts WHERE id > 100000 ORDER BY id LIMIT 100;
```

### 反模式 6：子查询能 JOIN 就不用子查询

```sql
-- ❌ 相关子查询，每行执行一次
SELECT u.*, (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS post_count
FROM users u;

-- ✅ JOIN + GROUP BY
SELECT u.*, COALESCE(p.cnt, 0) AS post_count
FROM users u
LEFT JOIN (SELECT user_id, COUNT(*) AS cnt FROM posts GROUP BY user_id) p
  ON p.user_id = u.id;
```

## 第 4 步：加索引（**最后手段**）

### 索引黄金法则

1. **WHERE / JOIN ON / ORDER BY 字段**才建
2. **选择性高**才建（性别这种 male/female 没意义）
3. **查询频率 >> 写入频率**才建
4. **复合索引看顺序**：(a, b, c) 等价于 (a) + (a,b) + (a,b,c)，但**不**等价于 (b)

```sql
-- 经常按 (user_id, created_at DESC) 查最新订单
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at DESC);

-- ❌ 顺序错：单查 created_at 用不上
CREATE INDEX idx_orders_created_user ON orders (created_at DESC, user_id);
```

### Covering Index（PG 11+ / MySQL 8）

INCLUDE 非过滤字段，让查询不回表：
```sql
CREATE INDEX idx_orders_lookup ON orders (user_id) INCLUDE (total, created_at);
-- 查 user_id, total, created_at 时直接读索引，跳过表
```

### 部分索引（PostgreSQL）

```sql
-- 只索引 active 用户（VIP 用户少）
CREATE INDEX idx_users_active_email ON users (email) WHERE status = 'active';
```

### 大表加索引必须 CONCURRENTLY（PG）

```sql
-- ❌ 锁表
CREATE INDEX idx_x ON huge_table (col);

-- ✅ 不锁表（慢一点）
CREATE INDEX CONCURRENTLY idx_x ON huge_table (col);
```

注意：迁移工具默认事务，CONCURRENTLY 不能在事务内 → 配置 transactional: false。

### 索引也有代价

每个索引：
- 写入慢（INSERT/UPDATE/DELETE 都要更新索引）
- 占用磁盘
- 占用内存（索引希望进 buffer pool）

**禁忌**：所有列都加索引。最多 3-5 个 索引/表 是合理的。

## 第 5 步：验证

```sql
-- 跑前后 EXPLAIN ANALYZE 对比
-- 看 actual time 是否真的下降
-- 不光看，还要看 buffer hits / IO 次数
```

### 看缓存命中率（PG）

```sql
SELECT relname, heap_blks_read, heap_blks_hit,
       round(100.0 * heap_blks_hit / NULLIF(heap_blks_hit + heap_blks_read, 0), 2) AS hit_rate
FROM pg_statio_user_tables
ORDER BY heap_blks_read DESC;
```

热表 hit_rate 应该 ≥ 99%。低了说明 work_mem / shared_buffers 不够。

## 高级技巧

### 1. PARTITIONING（分区）

时间分片：
```sql
CREATE TABLE events (
  id BIGINT,
  created_at TIMESTAMP NOT NULL,
  data JSONB
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_05 PARTITION OF events
FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
```

查询自动只扫相关分区。

### 2. 物化视图

复杂聚合定期刷新：
```sql
CREATE MATERIALIZED VIEW daily_stats AS
SELECT date_trunc('day', created_at) AS day, COUNT(*), SUM(amount)
FROM orders
GROUP BY 1;

REFRESH MATERIALIZED VIEW CONCURRENTLY daily_stats;
```

### 3. JSONB 索引（PG）

```sql
-- 整个 JSON 列建 GIN 索引
CREATE INDEX idx_data_gin ON events USING GIN (data);

-- 只索引特定路径
CREATE INDEX idx_user_id ON events ((data->>'user_id'));
```

### 4. 全文搜索

```sql
-- PG
CREATE INDEX idx_posts_search ON posts USING GIN (to_tsvector('chinese', title || ' ' || body));
SELECT * FROM posts WHERE to_tsvector('chinese', title || ' ' || body) @@ to_tsquery('foo & bar');

-- 大量需要专业全文搜索 → ElasticSearch / OpenSearch
```

## 常见反模式

❌ `SELECT COUNT(*) FROM big_table` 没条件 → 全表扫秒变报警
   ✅ 用 `pg_class.reltuples`（估计值）或维护计数器

❌ 跨库 JOIN
   ✅ 应用层做关联，或用消息队列同步

❌ 在事务里跑慢查询 → 锁等待 + 连接池耗尽
   ✅ 把读操作放事务外或用 read committed

❌ 索引建了不删
   ✅ `pg_stat_user_indexes` 看 idx_scan = 0 的删掉

## 监控指标

- **慢查询数 / 分钟**
- **连接池使用率** > 80% 报警
- **缓存命中率** < 99% 检查
- **复制延迟** > 1s 检查
- **死锁数** > 0 调查

## 与其他技能的关系

- 数据库结构改动 → database-migration-safety（加索引也要走迁移）
- API 设计 → api-design（接口分页 / 字段筛选影响 SQL）
- 系统调试 → systematic-debugging（流程找瓶颈）
