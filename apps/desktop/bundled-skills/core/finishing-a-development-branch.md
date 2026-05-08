---
name: finishing-a-development-branch
description: 当一个功能分支 / 任务分支即将合入 main 或被废弃时，**调用此技能**完成最终自查、合并策略选择、清理动作，避免"代码合了但留下一堆烂尾"。
---

# 收尾开发分支 — 合并、清理、归档

## 适用场景

满足**任一**时调用：

1. 功能开发完毕，准备 merge / rebase / squash 进 main
2. 任务被取消，决定**废弃**这个分支
3. PR 已通过 review，准备落地
4. worktree 用完准备删除

## 核心原则

**收尾不规范，技术债就是这么累积的**。

收尾 = 把脏活累活做完，让 main 始终保持「干净 + 可发布」。

## 收尾决策树

```
功能分支完成
    │
    ├─ 要合并？  → 走 [合并流程]
    │
    └─ 不要了？  → 走 [废弃流程]
```

## 合并流程（**进 main 前**）

### 第 1 步：最终自查

走一遍 `verification-before-completion` + `requesting-code-review` 的清单，**全部 ✅**。

### 第 2 步：与 main 同步

```bash
# 切回功能分支
git checkout feature-x

# 拉 main 最新
git fetch origin main

# rebase 到 main 顶端（保持线性历史）
git rebase origin/main
```

如果有冲突：
- 一个文件一个文件解决
- 解决后 `git add <file>` + `git rebase --continue`
- **解决冲突后必须重跑 typecheck / test**——rebase 后代码可能编译不过

### 第 3 步：选合并策略

| 策略 | 适用 | 命令 |
|---|---|---|
| **Squash merge** | 多次 commit 但只是同一件事的迭代 | GitHub UI 选 "Squash and merge" |
| **Rebase merge** | 每个 commit 都有独立意义 | UI 选 "Rebase and merge" |
| **Merge commit** | 想保留分支历史结构（不推荐） | UI 选 "Create a merge commit" |

**默认推荐 Squash merge**：
- main 历史保持每个 PR 一个 commit，干净
- 可以追溯到 PR 看完整开发过程
- revert 容易（一个 commit revert 整个功能）

### 第 4 步：合并后清理

```bash
# 切回 main
git checkout main
git pull

# 删除本地分支
git branch -d feature-x

# 删除远端分支（GitHub PR 合并后会有按钮，或命令）
git push origin --delete feature-x

# 如果用了 worktree
git worktree remove ../my-project-feature-x
```

### 第 5 步：验证 main

```bash
# 确认 main 上一切正常
pnpm typecheck
pnpm test
# 跑 smoke test
```

## 废弃流程（**不合并**）

### 第 1 步：明确废弃理由

写下来：
- 因为方案 B 更好（用了 B）
- 因为需求变了（不再需要）
- 因为太大了拆成 N 个新分支

**不要默默删**——后人看不懂。

### 第 2 步：归档（如果可能有用）

```bash
# 打 tag 归档
git tag archive/feature-x feature-x
git push origin archive/feature-x

# 之后可以删分支但 tag 还在
git branch -D feature-x
git push origin --delete feature-x
```

需要的时候可以 `git checkout archive/feature-x` 找回。

### 第 3 步：清理 worktree

```bash
git worktree remove ../my-project-feature-x
```

如果有未提交改动想留：

```bash
cd ../my-project-feature-x
git stash push -m "feature-x 废弃备份 2026-05-08"
cd -
git worktree remove ../my-project-feature-x
```

## CHANGELOG / 版本号同步

如果项目用 CHANGELOG 或 semver：

| 改动类型 | 版本号 | CHANGELOG |
|---|---|---|
| 破坏性 API 改动 | major +1 | `### Breaking Changes` |
| 新功能 | minor +1 | `### Added` |
| Bug 修复 | patch +1 | `### Fixed` |
| 内部重构 | 不变 | 可不写 |
| 文档 | 不变 | 不写 |

提 PR 时**就**该改：
- `package.json` / `Cargo.toml` 版本号
- `CHANGELOG.md` 在最顶部加新条目

## 部署 / 发布触发

如果项目有 CI/CD：

- main 合并后 → 看 CI 是否绿
- 打 tag 触发发布 → `git tag v1.2.3 && git push origin v1.2.3`
- 监控发布渠道（GitHub Release / Docker Hub / npm）

## 与其他技能的关系

- 收尾前必走 `verification-before-completion` + `requesting-code-review`
- 如果用了 worktree 见 `using-git-worktrees` 的清理章节
- 如果发现 main 合并后有问题 → `systematic-debugging` 紧急 hotfix

## 反模式

❌ "测试通过了直接 merge"——没看 CI / 没看 review 评论
❌ Squash 后 commit message 还是默认的合并消息（应该改成有意义的）
❌ merge 后不删本地 / 远端分支——分支列表越来越长
❌ 不删 worktree——磁盘占用 + 残留状态
❌ 废弃分支不打 tag 直接删——之后想找回找不到
❌ 改动很大但没改版本号——下游用户不知道升级影响

## 收尾报告模板

合并 / 废弃完成后告诉用户：

```markdown
## 收尾完成

**分支**：feature-x
**结果**：✅ 已 squash merge 到 main（commit abc123）

**清理**：
- ✅ 本地分支已删
- ✅ 远端分支已删
- ✅ Worktree 已移除（如果有）
- ✅ Main 上 typecheck / test 通过

**版本号**：0.2.20 → 0.2.21（patch +1 因为是 bug fix）
**CHANGELOG**：已更新

**后续动作**：
- [ ] 等 CI 跑完发布到 releases.maxian.ai
- [ ] 通知用户升级
```
