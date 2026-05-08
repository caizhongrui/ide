---
name: requesting-code-review
description: 当用户说"提个 PR / 提交代码 / code review / 帮我审一下"或要把改动推到远端之前，**必须调用此技能**完成自查清单和 PR 描述，避免提一堆草率代码污染团队仓库。
---

# 请求代码审查 — 提交前自查与 PR 描述

## 适用场景

满足**任一**时调用：

1. 用户说"提交 / 提 PR / push"
2. 用户说"帮我审一下" / "review 一下"
3. 一个功能 / bug fix 完成，准备合入主分支
4. 在调用 `git push` 或 `gh pr create` 之前

## 核心原则

**PR 是给团队看的，不是给自己看的**。

代码审查不是"等别人来发现问题"，而是**先把容易发现的问题自己发现**，省别人时间。

## 自查清单（推 PR 前**必须**全部走完）

### A. 代码质量

- [ ] 代码能编译 / 类型检查通过
- [ ] 测试通过（参考 `verification-before-completion`）
- [ ] 没有 `console.log` / `print` debug 输出
- [ ] 没有注释掉的死代码
- [ ] 没有 `TODO` / `FIXME` 没说明的（要么完成，要么开 issue）
- [ ] 命名规范：变量 / 函数 / 类符合项目风格
- [ ] 没有硬编码密钥 / token / 密码（看一眼 diff）
- [ ] 没有 `.env` / 大文件 / 二进制意外提交

### B. 改动范围

- [ ] 每个改动文件都和本次任务相关
- [ ] 没有顺手重构无关代码（应该单独 PR）
- [ ] 没有改格式化引起的"全文件 diff"（应该单独 PR 或先用 lint 统一）
- [ ] 没有意外改 `package.json` 版本号（除非任务包含版本升级）

### C. 测试覆盖

- [ ] 新功能有单元测试
- [ ] Bug fix 有回归测试
- [ ] 测试名字清楚表达「测什么」
- [ ] 测试不依赖外部状态（数据库 / 网络）

### D. 文档同步

- [ ] 改了公开 API → README / API.md 更新
- [ ] 改了配置 → `.env.example` / 文档更新
- [ ] 改了行为 → CHANGELOG 或 commit message 说明
- [ ] 加了导出 → `index.ts` re-export 同步

### E. 提交规范

- [ ] commit message 符合项目风格（Conventional Commits / 自定义）
- [ ] 一个 commit 一件事（不要把 5 件事塞一个 commit）
- [ ] commit message 能让人看懂**为什么**改，不只是改了什么

## PR 描述模板

```markdown
## 概述
[1-3 句话讲清这个 PR 做了什么 + 为什么]

## 改动
- `src/xxx.ts` — 新增 yyy 函数处理 zzz 场景
- `src/aaa.ts` — 调整 bbb 调用 yyy
- `tests/xxx.test.ts` — 5 个新测试覆盖 yyy 的 happy / error 路径

## 测试
- ✅ `pnpm test` 通过
- ✅ `pnpm typecheck` 通过
- ✅ 手动验证：[关键场景的具体操作和观察]

## 风险
- xxx 改动可能影响 yyy（已测）
- 不影响 zzz 流程（已确认）

## Checklist
- [x] 测试覆盖
- [x] 文档更新
- [ ] 需要 reviewer 关注：[具体问题]

## 相关 Issue
关联 #123
```

## 关键原则

### A. PR 越小越好

- ✅ 50-300 行 diff，一个清晰目标
- ❌ 2000 行 diff，混着重构 + 新功能 + 修 bug

如果一个任务做出来超过 500 行，**主动拆**：
1. 重构 / 准备工作 → PR 1
2. 核心功能 → PR 2
3. 文档 / 测试 → PR 3

### B. PR 描述要"读者友好"

- 把 reviewer 当成不熟悉这块代码的人
- 解释**为什么**这样设计（不只是 what）
- 列出你**纠结过但没选**的方案，理由
- 标注**需要重点 review** 的地方

### C. 自己先 review 一遍

把 diff 一行行看一遍，问自己：
- 这一行真的必要吗？
- 这个变量名清楚吗？
- 这个函数可以不写吗（能内联）？
- 边界情况都覆盖了吗？

## 反模式

❌ "可以了，提 PR 吧" → 没自查直接推
❌ commit message 写"fix"、"update"、"misc"
❌ 一个 PR 包含 10 个不相关的小改动
❌ PR 描述只有标题没有正文
❌ 在 PR 里加大段重构 + 一句话功能改动
❌ 用 force push 覆盖已被 review 过的 commit（应该新增 commit）

## 反向技能：接受代码审查

收到 review 评论时：

- **不要立即反驳**，先确认你理解 reviewer 的关注点
- 如果同意 → 改并回复"已修复，见 commit xxx"
- 如果不同意 → 解释你的理由，给出 trade-off 分析，**让 reviewer 决定**
- 如果不确定 → 问清楚再改

## 与其他技能的关系

- 提 PR 前必须先 `verification-before-completion` 验证
- 复杂改动建议先 `writing-plans` 让 reviewer 看计划
- 修 bug 的 PR 必须有 `systematic-debugging` 的根因说明
