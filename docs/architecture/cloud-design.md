# 云端自主模式设计

**场景**：网页填写需求 → 夜间无人值守执行 → 白天人工审核代码。

## 1. 多租户 DB schema（Postgres）

```sql
-- 租户
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  name VARCHAR(100),
  created_at TIMESTAMPTZ,
  daily_token_quota BIGINT,            -- null = 无限
  concurrent_session_quota INT,
  status VARCHAR(20)                    -- active/suspended
);

-- 用户
CREATE TABLE users (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  email VARCHAR(255) UNIQUE,
  display_name VARCHAR(100),
  role VARCHAR(20),                     -- admin/member/viewer
  sso_provider VARCHAR(50),             -- feishu/wework/github
  sso_user_id VARCHAR(100),
  created_at TIMESTAMPTZ,
  UNIQUE(sso_provider, sso_user_id)
);

-- 云端任务（核心表）
CREATE TABLE cloud_tasks (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  title VARCHAR(200),
  description TEXT,
  repo_url TEXT,
  branch VARCHAR(100),
  status VARCHAR(20),                   -- queued/running/review/merged/rejected/failed
  priority INT DEFAULT 0,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  worker_id VARCHAR(100),
  session_id UUID,
  result_pr_url TEXT,
  failure_reason TEXT,
  tokens_used BIGINT DEFAULT 0,
  review_status VARCHAR(20),            -- pending/approved/rejected
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT
);

-- sessions 扩展
ALTER TABLE sessions ADD COLUMN tenant_id UUID;
ALTER TABLE sessions ADD COLUMN user_id UUID;
CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);

-- 审计日志
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID,
  user_id UUID,
  session_id UUID,
  task_id UUID,
  tool_name VARCHAR(50),
  args_hash VARCHAR(64),
  args_summary TEXT,
  result_summary TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);

-- Token 账本
CREATE TABLE usage_ledger (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID,
  user_id UUID,
  session_id UUID,
  model VARCHAR(50),
  input_tokens BIGINT,
  output_tokens BIGINT,
  cost_usd NUMERIC(10, 6),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ledger_tenant_day ON usage_ledger(tenant_id, date_trunc('day', created_at));
```

## 2. 任务队列（BullMQ + Redis）

### 状态机

```
queued ──pickup──▶ running ──ok──▶ review ──approve──▶ merged
                     │              │
                     │              └──reject──▶ rejected
                     ├──error──▶ failed
                     └──cancel─▶ cancelled
```

### 关键策略

- **幂等**：`cloud_tasks.id` = BullMQ job id
- **重试**：`running → failed` 允许最多 2 次自动重试
- **心跳**：worker 每 10s 更新 `last_heartbeat_at`；> 60s 无心跳回 `queued`
- **可中断**：`POST /admin/tasks/:id/cancel` → 走 `sessionManager.cancelTask()`
- **可恢复**：worker 重启时扫描未完成任务按 `started_at` 排序重新 pickup

## 3. 沙箱

每任务独立目录：`/var/maxian/tasks/{task_id}/`

| 层 | 机制 | 防御 |
|---|---|---|
| L0 | `CloudWorkerPlatform.fs.resolvePath()` 强制路径 startsWith sandbox | 路径穿越 |
| L1 | `fs.chown` sandbox 为 worker uid，无权访问 /etc、/root | 越界读写 |
| L2 | 命令白名单：禁 `curl | sh`、`docker`、`sudo`、`chmod 777`、`rm -rf /` | 恶意命令 |
| L3 | 网络出口白名单：github / npm / pypi / AI Provider | 数据外泄 |
| L4 | Docker/K8s 容器隔离（可选） | 极端情况 |

**生产推荐**：最低 L0-L2；理想 L3-L4（K8s）。

## 4. 审计与回放

- 每次工具调用 → `audit_logs` 写一行
- 每次 LLM 调用 → `usage_ledger` 写一行
- **回放**：`GET /tasks/:id/replay` 返回 session 事件时序流，审核页用 `@maxian/ui` 的 `MessageList` 逐帧重放

## 5. 服务拓扑

```
                  ┌──────────────────┐
Browser ─────────▶│  apps/cloud/     │─── Postgres
                  │  (API 网关 + UI)  │
                  └────────┬─────────┘
                           │ BullMQ
                           ▼
                  ┌──────────────────┐
                  │ @maxian/worker × N│── Git clone → Sandbox
                  │ (每任务一进程)    │── @maxian/core → LLM
                  └──────────────────┘
```
