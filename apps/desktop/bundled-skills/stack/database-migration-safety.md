---
name: database-migration-safety
description: 任何改动数据库 schema（建表 / 改字段 / 加索引 / 数据迁移）的任务，**必须调用此技能**走安全迁移流程，避免线上数据丢失 / 长锁表 / 无法回滚等灾难。
---

# 数据库迁移安全实践

## 适用场景

满足**任一**时调用：

1. 新建 / 修改表结构
2. 加 / 改 / 删字段
3. 加 / 改索引
4. 修改约束（NOT NULL / UNIQUE / FK）
5. 大批量数据回填 / 改动
6. 数据库引擎切换 / 版本升级

## 核心原则（**生产数据库 5 戒**）

1. **不可逆操作必须备份**
2. **大表改动必须分批 / 在线**
3. **每个迁移必须有回滚脚本**
4. **重要改动先在 staging 跑**
5. **避免 DROP / TRUNCATE / 全表 UPDATE 在高峰期**

## 迁移工具

| 数据库 | 推荐工具 |
|---|---|
| PostgreSQL / MySQL | Flyway / Liquibase（Java），Prisma Migrate / Drizzle Kit（JS） |
| MongoDB | mongodb-migrations / migrate-mongo |
| 多源 | dbmate / golang-migrate |

**禁止**手工在生产 psql 里 `ALTER TABLE`——历史无追溯，复制环境无法重现。

## 迁移文件命名

```
V20260508_120000__create_users_table.sql
V20260508_120100__add_email_index.sql
V20260508_120200__add_status_column.sql
```

- 前缀时间戳保证顺序
- 描述清晰
- 一个迁移一件事

## 安全模式：每个迁移必有 up / down

```sql
-- V20260508_120200__add_status_column.sql

-- ===== UP =====
ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT 'active' NOT NULL;
CREATE INDEX idx_users_status ON users(status);

-- ===== DOWN =====
DROP INDEX idx_users_status;
ALTER TABLE users DROP COLUMN status;
```

每个迁移都要写 down。即使你"觉得"不会回滚——出问题时你会感谢自己。

## 危险操作清单

### 🚨 高危（生产慎用）

| 操作 | 风险 | 替代方案 |
|---|---|---|
| `DROP TABLE` | 数据全丢 | 先 RENAME `users → users_deprecated_2026_05`，1 周后再 DROP |
| `DROP COLUMN` | 老代码可能在写 | 先停写 → 部署 → 等几个版本 → 再 DROP |
| `ALTER COLUMN type` 不兼容 | 数据丢失 | 加新列 → 双写 → 回填 → 切读 → 删旧列 |
| `RENAME COLUMN` | 老代码引用 | 同上：加新列 + 双写 + 切换 |
| `ADD COLUMN NOT NULL` 无默认 | 已有行报错 | 先 ADD（NULL 允许），回填，再 ALTER 改 NOT NULL |
| 大表 `UPDATE WHERE` 全量 | 长锁，复制延迟 | 分批：`WHERE id BETWEEN x AND y` |
| 大表 `CREATE INDEX` | 锁表 | PostgreSQL 用 `CREATE INDEX CONCURRENTLY`；MySQL 用 pt-osc |

### ⚠️ 需要审慎

- 加 UNIQUE 约束 → 已有重复数据会失败
- 加 FK → 已有孤儿数据会失败
- 改字段长度变小 → 数据可能截断

## 兼容性原则（**多版本共存**）

线上经常**多个应用版本同时跑**（蓝绿 / 金丝雀 / 客户端版本不一致）。

迁移要保证：
- 老代码 + 新 schema 不报错
- 新代码 + 老 schema 不报错（**至少一个版本窗口**）

### 安全升级 6 步法（Expand-Contract 模式）

以"重命名字段 `name` → `full_name`"为例：

#### 第 1 步：Expand — 加新字段（兼容老代码）

```sql
ALTER TABLE users ADD COLUMN full_name VARCHAR(100);
```

老代码继续读写 `name`，新字段先空着。

#### 第 2 步：双写

新代码同时写两个字段：

```ts
await db.update({ name: x, full_name: x }).where(...);
```

#### 第 3 步：回填

```sql
-- 分批，每批 10000 行
UPDATE users SET full_name = name 
WHERE full_name IS NULL AND id BETWEEN 1 AND 10000;
-- 重复直到完成
```

或后台 worker 慢慢跑。

#### 第 4 步：切读

代码改成读 `full_name`。验证一周。

#### 第 5 步：停写老字段

代码不再写 `name`。

#### 第 6 步：Contract — 删老字段

```sql
ALTER TABLE users DROP COLUMN name;
```

每步之间间隔**至少一个发布周期**，确保所有实例都更新到位。

## 回填大量数据

### 模式 1：分批 SQL

```sql
DO $$
DECLARE
  batch_size INT := 1000;
  affected INT;
BEGIN
  LOOP
    UPDATE users SET status = 'active'
    WHERE id IN (
      SELECT id FROM users WHERE status IS NULL LIMIT batch_size
    );
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
    PERFORM pg_sleep(0.1);  -- 100ms 喘口气
  END LOOP;
END $$;
```

### 模式 2：应用层后台 worker

```python
while True:
    rows = db.query("SELECT * FROM users WHERE status IS NULL LIMIT 1000")
    if not rows: break
    for r in rows:
        db.update(r.id, status='active')
    time.sleep(0.1)
```

优点：可监控、可暂停、不阻塞主库。

## 索引管理

### PostgreSQL：CREATE INDEX CONCURRENTLY

```sql
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```

**不锁表**，但慢一点。生产必用 CONCURRENTLY。

注意：迁移工具默认包事务，CONCURRENTLY 不能在事务内——查工具文档配置 transactional: false。

### MySQL：用 pt-online-schema-change 或 gh-ost

直接 ALTER 在大表会锁很久。

```bash
pt-online-schema-change \
  --alter "ADD INDEX idx_email (email)" \
  D=mydb,t=users \
  --execute
```

工具创建影子表 + 触发器同步 + 切换。

## 备份与回滚

### 迁移前**强制**备份

```bash
# PostgreSQL
pg_dump -h host -U user -d mydb -F c -f backup_2026_05_08.dump

# MySQL
mysqldump --single-transaction --routines mydb > backup.sql
```

### 测试回滚脚本

在 staging 跑：
1. apply up
2. 验证应用还能跑
3. apply down
4. 验证回到迁移前状态

down 没测试就不算有 down。

### Point-in-Time Recovery

主库开启 WAL / binlog 归档，紧急情况可以恢复到任意秒。

## 多租户额外注意

如果 schema 含 `tenant_id`：

- 所有查询 `WHERE tenant_id = ?`，否则跨租户泄露
- 索引必含 `tenant_id`：`(tenant_id, email)` 而不是单 `(email)`
- 用 PostgreSQL Row-Level Security（RLS）做兜底

## 部署流程

```
1. 在 staging apply 迁移 + smoke test
2. 备份生产
3. 维护窗口（如需要）/ 通知用户
4. 在生产 apply 迁移
5. 监控错误率 / 慢查询 / 复制延迟
6. 灰度部署应用代码
7. 全量发布
```

## CI 检查（自动化）

- 迁移文件必须有 down
- 迁移名字符合命名规范
- 迁移在 ephemeral 库跑通（GitHub Actions 起 PostgreSQL service）
- 不允许直接 `DROP TABLE` / `DROP COLUMN`（要求标注 `-- ALLOW_DESTRUCTIVE`）

## 常见反模式

❌ 迁移没 down 脚本
❌ 一个迁移做 5 件事（拆开！）
❌ 在迁移里写应用代码（业务逻辑放回 worker）
❌ 高峰期改大表
❌ 加 NOT NULL 不给默认值
❌ 没备份就改生产
❌ 在 prod psql 手敲 ALTER TABLE

## 与其他技能的关系

- 改 schema 前先 `writing-plans` 把 6 步迁移流程写出来
- 涉及性能 / 大数据回填 → 先在 staging 验证
- 完成后 `verification-before-completion` 包含：备份验证 / down 验证
- 多租户场景叠加 `security-best-practices`
