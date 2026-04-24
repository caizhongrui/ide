# third-party/

本目录存放**第三方 fork**，以**独立 git repo** 形式引入，**不被主仓追踪**（见根 `.gitignore`）。

## tianhe-zhikai-ide/

码弦IDE（VS Code fork `tianhe-zhikai` v1.108.4 base）。

- **Git remote**：`git@github.com:caizhongrui/maxian.git`（origin）+ `git@github.com:caizhongrui/zhikai.git`（zhikai）
- **保留分支**：`feature/solo-mode-editor-pane`
- **本地状态**：拥有自己的 `.git/`，可独立 pull / commit / push，但主仓完全不感知

### 新开发机初始化

```bash
cd third-party/
GIT_LFS_SKIP_SMUDGE=1 git clone \
  -b feature/solo-mode-editor-pane \
  git@github.com:caizhongrui/maxian.git \
  tianhe-zhikai-ide
cd tianhe-zhikai-ide
git lfs pull   # 可选：拉取 LFS 资源（字体/图片等）
```

### 为什么不用 git submodule？

- 首次 clone 需要走 LFS smudge filter，在大 repo 上极慢（实测 ≥ 20 分钟）
- `.gitmodules` 引入的跨仓耦合对 CI 不友好
- 主仓目标是"形态中立的 monorepo"，第三方 fork 是辅助开发参考，不需 submodule 级绑定

参考决策：[`docs/adr/005-third-party-as-local-copy.md`](../docs/adr/005-third-party-as-local-copy.md)
