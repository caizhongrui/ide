# ADR-005: 第三方 fork 用本地副本而非 git submodule

- 状态：Accepted
- 日期：2026-04-24（取代 ADR-001 隐含的 submodule 策略）

## 背景

码弦IDE（VS Code fork `tianhe-zhikai`）需要在主仓内可见，供：
- 开发者查看 IDE 侧实现（如 Maxian 工具接入）
- 将来 N3 阶段把重复工具替换为对 `@maxian/core` 的依赖

原本的 ADR 默认用 `git submodule`。实际尝试时遇到两个阻塞问题：

1. **LFS 首次 clone 慢到不可接受**：`git-lfs filter-process` 拉取 LFS 对象（字体/图片等）持续 ≥ 20 分钟不结束
2. **跨仓 CI 复杂**：每个 CI job 都要 submodule 递归 checkout + LFS 缓存策略

## 决策

**不用 git submodule，改为"本地 nested git repo + 主仓 .gitignore 排除"**。

具体做法：
- `third-party/tianhe-zhikai-ide/` 是一个**独立 git repo**，拥有自己的 `.git/` 目录
- 主仓 `.gitignore` 排除整个 `third-party/tianhe-zhikai-ide/`
- 新开发机自行 `git clone` 到该位置（见 `third-party/README.md`）

## 考虑过的替代

- **git submodule**：已被 LFS/CI 问题阻塞（见背景）
- **git subtree**：合并历史到主仓，但第三方改动会污染主仓 log，且无法向上游 push
- **完全不引入**：断开与 IDE 的关联，N3 阶段工具替换工作无参考

## 理由

- `third-party/` 的语义本就是"外部代码，参考用"，无需主仓 CI 校验
- 主仓 pure 保持小而快
- 开发机上仍是本地 git repo，可以 pull / 切换分支 / 提交改动并 push 回 IDE 仓

## 影响

- 主仓 checkout 时 `third-party/` 是空的，开发机必须按 `third-party/README.md` 手动 clone
- CI 默认跑主仓 typecheck 不需要 IDE 代码，通过
- 如果将来 N3 阶段 IDE 代码需要被主仓脚本读取（例如一致性检查），需要在 CI 中单独 `git clone` 一次
- IDE 自己的改动仍然 push 到 `caizhongrui/maxian.git`，不经过主仓
