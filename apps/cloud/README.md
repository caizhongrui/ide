# maxian-cloud

云端控制台 + 多租户 API 网关（占位）。

## 状态

🚧 **占位阶段**。

## 设计

- 基于 `@maxian/server` 扩展，增加：
  - 多租户鉴权中间件（SSO：飞书 / 企业微信 / GitHub）
  - `cloud_tasks` 队列管理路由（BullMQ）
  - 审计日志与配额
- 静态前端（审核工作台）复用 `@maxian/ui`
- 详见 `docs/architecture/cloud-design.md`

## 运行时

- Docker 镜像：`maxian/cloud:x.y.z`
- 依赖：Postgres（多租户数据）+ Redis（BullMQ）
- Worker 横向扩展：`@maxian/worker`
