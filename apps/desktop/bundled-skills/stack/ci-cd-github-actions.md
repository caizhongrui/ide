---
name: ci-cd-github-actions
description: 任何 GitHub Actions 工作流改动（CI / CD / 自动化），**调用此技能**遵守安全和性能规范，避免泄露密钥、构建慢、缓存不命中等常见问题。
---

# GitHub Actions CI/CD 实战

## 适用场景

- 写新 workflow（`.github/workflows/*.yml`）
- 加 CI 检查（lint / test / build）
- 加 CD 自动发布
- 安全 / 密钥管理
- 性能优化（cache / matrix）

## 标准 CI 工作流（Node.js 项目）

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true   # 同一 PR 多次 push，前一次自动取消

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - uses: pnpm/action-setup@v3
        with:
          version: 9

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test --coverage

      - uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
```

## 8 条铁律

### 1. 锁版本（reproducible）

```yaml
# ❌ 永远不要
- uses: actions/checkout@main
- uses: actions/checkout@v4   # 还行，但会跟随 v4 minor 更新

# ✅ 锁 SHA
- uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11  # v4.2.0
```

至少锁到 major（@v4），生产关键链锁 SHA。

### 2. 缓存 — 加速最关键

```yaml
# Node 依赖
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'  # 或 pnpm / yarn

# Maven
- uses: actions/setup-java@v4
  with:
    distribution: 'temurin'
    java-version: '21'
    cache: 'maven'

# Cargo（Rust）
- uses: Swatinem/rust-cache@v2

# Docker BuildX
- uses: docker/build-push-action@v6
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

通用缓存：
```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.cache/pip
      ~/.cargo/registry
    key: ${{ runner.os }}-${{ hashFiles('**/lockfile') }}
    restore-keys: |
      ${{ runner.os }}-
```

### 3. 用 secrets，不要写明文

```yaml
# ❌
env:
  API_KEY: 'sk-actual-key'

# ✅
env:
  API_KEY: ${{ secrets.API_KEY }}
```

设置：Repo → Settings → Secrets and variables → Actions

环境特定：
```yaml
jobs:
  deploy:
    environment: production   # 触发 review 流程
    steps:
      - run: deploy.sh
        env:
          PROD_KEY: ${{ secrets.PROD_KEY }}
```

### 4. 最小权限（GITHUB_TOKEN）

默认 GITHUB_TOKEN 权限太大。每个 job 显式声明：

```yaml
permissions:
  contents: read       # 默认就够 CI 用

jobs:
  release:
    permissions:
      contents: write   # 创建 release 才需要
      packages: write   # push image 才需要
```

### 5. 矩阵 / 并行 — 加速

```yaml
strategy:
  fail-fast: false
  matrix:
    node: [18, 20, 22]
    os: [ubuntu-latest, windows-latest, macos-latest]
runs-on: ${{ matrix.os }}
steps:
  - uses: actions/setup-node@v4
    with:
      node-version: ${{ matrix.node }}
```

排除特定组合：
```yaml
matrix:
  ...
  exclude:
    - os: windows-latest
      node: 18
```

### 6. 拆 Job + 依赖

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps: [...]
  
  build:
    needs: test
    runs-on: ubuntu-latest
    steps: [...]
  
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps: [...]
```

需要的话用 `outputs` 在 job 间传值：
```yaml
jobs:
  setup:
    outputs:
      version: ${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=$(cat package.json | jq -r .version)" >> $GITHUB_OUTPUT
  
  deploy:
    needs: setup
    steps:
      - run: echo "Deploying ${{ needs.setup.outputs.version }}"
```

### 7. 复用 — composite action / reusable workflow

```yaml
# .github/actions/setup/action.yml
name: 'Setup Node + pnpm'
runs:
  using: 'composite'
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
    - uses: pnpm/action-setup@v3
      with:
        version: 9
    - run: pnpm install --frozen-lockfile
      shell: bash

# 用法
- uses: ./.github/actions/setup
```

跨仓库复用 → reusable workflow：
```yaml
# .github/workflows/test.yml
on:
  workflow_call:
jobs:
  test:
    runs-on: ubuntu-latest
    steps: [...]

# 调用方
jobs:
  call-test:
    uses: org/repo/.github/workflows/test.yml@main
```

### 8. 条件触发

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'package.json'
      - '.github/workflows/**'
  pull_request:
  schedule:
    - cron: '0 2 * * *'   # UTC 02:00 每天
  workflow_dispatch:        # 手动触发
    inputs:
      environment:
        type: choice
        options: [staging, production]
```

step 内条件：
```yaml
- name: Deploy
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  run: deploy.sh
```

## 常用 Action 速查

| 用途 | Action |
|---|---|
| 检出代码 | `actions/checkout@v4` |
| 安装语言 | `actions/setup-node`, `setup-java`, `setup-python`, `setup-go` |
| 缓存 | `actions/cache@v4`（自定义路径） |
| 上传产物 | `actions/upload-artifact@v4` |
| 下载产物 | `actions/download-artifact@v4` |
| Docker build | `docker/build-push-action@v6` |
| 部署 ssh | `appleboy/ssh-action@v1` |
| Slack 通知 | `slackapi/slack-github-action@v1` |
| Release | `softprops/action-gh-release@v2` |
| Codecov | `codecov/codecov-action@v4` |

## 标准 CD 工作流（推 Docker 镜像）

```yaml
name: Build & Push

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=tag
            type=sha,prefix={{branch}}-

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64,linux/arm64
```

## 部署到 K8s 示例

```yaml
- uses: azure/setup-kubectl@v4
  with:
    version: v1.30.0

- run: |
    echo "${{ secrets.KUBE_CONFIG }}" | base64 -d > kubeconfig
    export KUBECONFIG=$PWD/kubeconfig
    kubectl set image deployment/app app=ghcr.io/org/app:${{ github.sha }} -n prod
    kubectl rollout status deployment/app -n prod --timeout=2m
```

## 安全增强

### 1. 限制 PR fork 用 secrets

默认 fork PR 拿不到 secrets，但要小心 workflow_run 触发：
```yaml
# ❌ 危险：fork 可以触发并拿到 secrets
on:
  pull_request_target:

# ✅ 用普通 pull_request，需要 secrets 的 job 加条件
on: pull_request
jobs:
  build:
    if: github.event.pull_request.head.repo.full_name == github.repository
```

### 2. SBOM + 漏洞扫描

```yaml
- uses: anchore/sbom-action@v0
  with:
    image: ghcr.io/org/app:${{ github.sha }}

- uses: aquasecurity/trivy-action@master
  with:
    image-ref: ghcr.io/org/app:${{ github.sha }}
    severity: HIGH,CRITICAL
    exit-code: 1
```

### 3. 签名镜像（cosign）

```yaml
- uses: sigstore/cosign-installer@v3
- run: cosign sign --yes ghcr.io/org/app:${{ github.sha }}
  env:
    COSIGN_EXPERIMENTAL: 1
```

## 常见反模式

❌ `${{ env.VAR }}` 写在 if 里（bash 替换）
   ✅ 用 `${{ vars.VAR == 'x' }}` 或 step 输出

❌ 每个 job 都重新 checkout + install → 浪费时间
   ✅ 用 cache 或 composite action

❌ 在 workflow 里硬写 sha / version
   ✅ 用 secrets / vars 或脚本动态生成

❌ workflow 全在 main，PR 改不了
   ✅ 用 reusable workflow，业务在子文件里

❌ 没设 timeout
   ✅ `timeout-minutes: 30`

## 调试技巧

```yaml
- name: Debug
  if: failure()
  run: |
    echo "::group::Env"
    env | sort
    echo "::endgroup::"
    echo "::group::Files"
    ls -la
    echo "::endgroup::"
```

启用 debug 日志：repo Settings → Secrets → 加 `ACTIONS_RUNNER_DEBUG=true`

## 与其他技能的关系

- 容器构建 → docker-best-practices
- 部署 → kubernetes-deployment
- 测试 → e2e-testing-playwright
- 安全 → security-best-practices
