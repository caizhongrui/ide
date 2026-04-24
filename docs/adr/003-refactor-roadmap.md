# ADR-003: N / M / L 三期整改路线图

- 状态：Accepted
- 日期：2026-04-24

## 背景

当前两种形态（Desktop v0.2.10 + 码弦IDE）存在 4 处耦合热点，阻碍新形态接入。详见 [overview.md § 5](../architecture/overview.md)。

## 决策

按 N (近期) / M (中期) / L (远期) 三期演进：

### Phase N — 现在就做，为新形态铺路，不新增功能

| 编号 | 任务 | 优先级 | 影响 |
|---|---|---|---|
| N1 | Core 清理 fs 直调（约 50 处 `fs.*Sync`） | P0 | 所有形态 |
| N1b | 新增 `NodePlatform.ts` + `createNodePlatform()` | P0 | server / worker |
| N1c | 扩展 `MaxianPlatform` 可选字段 | P0 | 契约 |
| N1d | 补齐 `MaxianEvent` union（8 种缺失事件） | P0 | 契约 |
| N2 | 抽取 `@maxian/ui` 包（从 App.tsx 8534 行拆出） | P0 | 所有 UI 形态 |
| N3 | 码弦IDE 改用 `@maxian/core`，删重复工具 | P0 | 码弦IDE 维护成本 |
| N4 | HTTP 协议文档化 + `X-Maxian-Protocol` header | P1 | 所有客户端 |
| N5 | 协议 CHANGELOG 首条 baseline | P1 | 文档 |

### Phase M — 新形态依次接入（触发式）

| 编号 | 任务 | 触发 | 预估 |
|---|---|---|---|
| M1 | VS Code 官方插件 | N 期完成 | 1-2w |
| M2 | Web 模式 | M1 完成 | 2-3w |
| M3 | IDEA 插件 (sidecar) | M1 完成 | 3-4w |

### Phase L — 云端自主模式

| 编号 | 任务 | 触发 | 预估 |
|---|---|---|---|
| L1 | 多租户 DB schema + SSO | 云端立项 | 1-2w |
| L2 | `@maxian/worker` + BullMQ | L1 完成 | 2w |
| L3 | 云端控制台 + 审核工作台 | L2 完成 | 2-3w |
| L4 | 审计日志 + 回放 | L3 完成 | 1w |
| L5 | 沙箱加固 (L3/L4 层) | 上线前 | 1-2w |

## 验收

### N 期完成标准
- [ ] `grep -rE "readFileSync|writeFileSync" packages/core/src/tools/` 为空
- [ ] `wc -l apps/desktop/src/App.tsx` < 2000
- [ ] 码弦IDE 工具重复实现数量 = 0
- [ ] `maxian-server/API.md` 覆盖全部路由
- [ ] Desktop v0.2.10 所有回归项 PASS
- [ ] 码弦IDE 相应回归 PASS

## 变更记录

（按需追加）
