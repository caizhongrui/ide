---
name: using-git-worktrees
description: 当需要并行开发多个分支 / 同时跑多个长任务 / 切分支会丢失工作上下文时，**调用此技能**用 git worktree 创建独立工作目录，避免来回 stash 和切分支带来的混乱。
---

# 使用 Git Worktree — 多分支并行开发

> ⚠️ **码弦项目提示**:码弦是**单一 git 仓库的 pnpm monorepo**(根目录即仓库根),`packages/*` 与 `apps/*` 同处一个仓库。
> - `git worktree` 命令在仓库根目录执行即可,无需选择子仓库

## 适用场景

满足以下**任一**时调用：

1. 用户说"我想同时做 X 和 Y"（不同分支同时进行）
2. 当前分支有未提交改动，又要紧急切到另一个分支修 bug
3. 跑长任务（编译 / 测试 / docker build）期间想做别的
4. 需要对比两个分支的代码（直接打开两个 VSCode 窗口）
5. AI agent 跑无人值守任务，主分支不该被污染

## 核心概念

`git worktree` = 一个 git 仓库可以**同时**有多个工作目录，每个目录 checkout 不同分支。

```
my-project/                ← 主 worktree（main 分支）
my-project-feature-x/      ← 第二个 worktree（feature-x 分支）
my-project-hotfix/         ← 第三个 worktree（hotfix 分支）
```

它们**共享同一个 .git**，但工作目录互相独立。

## 常用命令

### 创建新 worktree

```bash
# 在当前仓库的同级目录创建 worktree（推荐）
git worktree add ../my-project-feature-x feature-x

# 不存在的分支会自动从 HEAD 创建
git worktree add ../my-project-new-feat -b new-feat

# 基于远端分支
git worktree add ../my-project-pr-42 origin/pr-42
```

### 列出所有 worktree

```bash
git worktree list
# /Users/me/my-project          abc1234 [main]
# /Users/me/my-project-feature-x  def5678 [feature-x]
```

### 删除 worktree（**推荐**，安全）

```bash
# 删除目录后清理引用
git worktree remove ../my-project-feature-x

# 强制删除（即使有未提交改动）
git worktree remove --force ../my-project-feature-x
```

### 清理已不存在的 worktree 引用

```bash
git worktree prune
```

## 典型工作流

### 场景 1：紧急 hotfix（不打断当前工作）

你在 `feature-login` 上写到一半，老板来说 `main` 上有 bug 要立刻修：

```bash
# 不需要 commit / stash
git worktree add ../proj-hotfix main
cd ../proj-hotfix
# 修 bug、commit、push、提 PR
git worktree remove ../proj-hotfix
# 回到 feature-login 继续工作
```

### 场景 2：并行实验

想试两种实现方案选哪个好：

```bash
git worktree add ../proj-impl-a -b impl-a
git worktree add ../proj-impl-b -b impl-b

# 在两个目录分别实现
# 跑测试对比，留下好的，删掉差的
git worktree remove ../proj-impl-b
```

### 场景 3：长任务期间继续工作

`mvn clean install` 要跑 10 分钟：

```bash
git worktree add ../proj-other-task -b other-task
cd ../proj-other-task
# 在新窗口做别的事，不受 mvn 影响
```

### 场景 4：AI agent 沙箱

让 AI 在独立 worktree 跑任务，不污染主分支：

```bash
git worktree add ../proj-ai-task -b ai-task-2026-05-08
# 让 AI 在该目录工作
# 完成后 review diff 决定是否 merge
```

## 最佳实践

### A. 命名约定

worktree 目录名 = `<repo-name>-<purpose>` 或 `<repo-name>-<branch>`：

```
✅ my-project-feature-login
✅ my-project-hotfix-2026-05
❌ my-project-2  （不知道是什么）
❌ my-project (1)（容易和主目录混）
```

### B. 放在仓库**同级**而不是**内部**

```
✅ ~/work/my-project/         ← 主
   ~/work/my-project-feat-x/  ← worktree
   
❌ ~/work/my-project/
       ./worktrees/feat-x/    ← worktree（容易被 git status 看见）
```

### C. 一个 worktree = 一个分支 = 一个任务

不要在一个 worktree 里频繁切分支——失去 worktree 的意义。

### D. 完成后**及时清理**

```bash
git worktree list  # 定期看看
git worktree remove <path>  # 不用就删
```

不删的代价：磁盘占用 + 心智负担（永远记得"还有个 worktree"）

## 限制 & 坑

### 1. 同一分支不能在两个 worktree 同时 checkout

```bash
# 主目录 main 分支
git worktree add ../another main  # ❌ 报错
```

如果真要在另一个目录看 main，用 detached HEAD：

```bash
git worktree add --detach ../another main
```

### 2. submodules

worktree 默认**不会**自动初始化 submodules，需要手动：

```bash
cd ../my-project-feat-x
git submodule update --init --recursive
```

### 3. node_modules / Cargo target

每个 worktree 有自己的 `node_modules` / `target/`，**不共享**——要分别跑 `pnpm install` / `cargo build`。

省盘可以用：
- `pnpm install` 用 hardlink（默认）/ symlink，重复安装不真的复制
- `cargo build --target-dir=../shared-target` 共享 build cache

### 4. 不要在 main worktree 里 `rm -rf ../some-worktree`

直接删目录会留下"幽灵引用"。**始终用** `git worktree remove`。

如果误删了，用 `git worktree prune` 清理。

## 何时**不**用 worktree

- 简单的单分支开发——多余的复杂度
- 需要严格的环境隔离（用 docker / VM 更好）
- 团队不熟悉 worktree 概念——可能引起混乱

## 与其他技能的关系

- 任务结束清理 worktree → `finishing-a-development-branch`
- 在 worktree 里完成功能 → `requesting-code-review` 提 PR
- 发现复杂 bug → `systematic-debugging`（在独立 worktree 调试不污染主分支）
