# @maxian/worker

云端任务执行 Worker。

## 状态

🚧 **占位阶段** — 设计见 `docs/architecture/cloud-design.md`。

## 职责（设计中）

- 从 BullMQ (Redis) 拉取 `cloud_tasks` 任务
- 每个任务在 `/var/maxian/tasks/{id}/` 沙箱中用 `CloudWorkerPlatform` 执行
- 心跳、可恢复、可取消
- Token 计费写入 `usage_ledger`
