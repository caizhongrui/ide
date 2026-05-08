---
name: e2e-testing-playwright
description: 任何写 / 改端到端（E2E）测试的任务，**调用此技能**用 Playwright 编写稳定（不闪退）、可调试、跑得快的测试，避免 sleep / 硬等待 / 选择器脆弱等常见反模式。
---

# Playwright E2E 测试实战

## 适用场景

- 关键用户路径回归测试
- 跨浏览器兼容（Chromium / Firefox / WebKit）
- 视觉回归
- API + UI 混合测试

为什么 Playwright（vs Cypress / Selenium）：
- 跨浏览器（Cypress 只 Chromium）
- 自动等待（不需要 sleep）
- 真并行（多 worker）
- TypeScript 一等支持
- 调试体验最好（trace viewer）

## 项目结构

```
e2e/
├── playwright.config.ts
├── fixtures/
│   ├── auth.ts          # 登录 fixture
│   └── data.ts          # 测试数据
├── pages/                # Page Object Model
│   ├── LoginPage.ts
│   └── DashboardPage.ts
└── tests/
    ├── auth.spec.ts
    └── checkout.spec.ts
```

## 8 条铁律

### 1. 永远不用 sleep / waitForTimeout

```ts
// ❌ 罪魁祸首
await page.waitForTimeout(2000)

// ✅ 等条件
await expect(page.getByText('Loaded')).toBeVisible()
await page.waitForResponse(/\/api\/users/)
await page.waitForLoadState('networkidle')
```

Playwright 的 expect 自带自动重试（默认 5s）。

### 2. 选择器优先级 — 用 user-facing

```ts
// ❌ CSS 选择器脆弱（class 一改就坏）
await page.locator('.btn-primary').click()
await page.locator('#email-input').fill('a@b.com')

// ✅ 按用户能看到的方式找
await page.getByRole('button', { name: '登录' }).click()
await page.getByLabel('邮箱').fill('a@b.com')
await page.getByText('提交').click()
await page.getByPlaceholder('搜索...').fill('foo')
await page.getByTestId('user-menu').click()  // data-testid（最稳定）
```

优先级：getByRole > getByLabel > getByText > getByTestId > CSS。

### 3. Page Object 模式

```ts
// pages/LoginPage.ts
import { type Page, expect } from '@playwright/test'

export class LoginPage {
  constructor(public readonly page: Page) {}

  async goto() {
    await this.page.goto('/login')
  }

  async login(email: string, password: string) {
    await this.page.getByLabel('邮箱').fill(email)
    await this.page.getByLabel('密码').fill(password)
    await this.page.getByRole('button', { name: '登录' }).click()
    await expect(this.page).toHaveURL('/dashboard')
  }

  async expectErrorMessage(text: string) {
    await expect(this.page.getByRole('alert')).toContainText(text)
  }
}

// tests/auth.spec.ts
import { test } from '@playwright/test'
import { LoginPage } from '../pages/LoginPage'

test('successful login', async ({ page }) => {
  const login = new LoginPage(page)
  await login.goto()
  await login.login('user@example.com', 'pwd')
})
```

### 4. Fixtures — 共享 setup

```ts
// fixtures/auth.ts
import { test as base } from '@playwright/test'

type Fixtures = {
  authedPage: Page
}

export const test = base.extend<Fixtures>({
  authedPage: async ({ page }, use) => {
    // 先登录
    await page.goto('/login')
    await page.getByLabel('邮箱').fill('test@example.com')
    await page.getByLabel('密码').fill('pwd')
    await page.getByRole('button', { name: '登录' }).click()
    await use(page)
  },
})

// 用法
test('view dashboard', async ({ authedPage }) => {
  await authedPage.goto('/dashboard')
  await expect(authedPage.getByText('Welcome')).toBeVisible()
})
```

### 5. 用 storageState 加速登录

```ts
// global-setup.ts
import { chromium } from '@playwright/test'

export default async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto('http://localhost:3000/login')
  await page.getByLabel('邮箱').fill('test@example.com')
  await page.getByLabel('密码').fill('pwd')
  await page.getByRole('button', { name: '登录' }).click()
  await page.context().storageState({ path: 'auth.json' })
  await browser.close()
}

// playwright.config.ts
export default defineConfig({
  globalSetup: './global-setup.ts',
  use: { storageState: 'auth.json' },
})
```

后续测试自带登录状态，省去每个测试重复登录。

### 6. 网络拦截 / Mock

```ts
// 拦截 API 返 mock 数据
await page.route('/api/users', route =>
  route.fulfill({ json: [{ id: 1, name: 'Alice' }] })
)

// 验证请求
const requestPromise = page.waitForRequest('/api/orders')
await page.getByRole('button', { name: '提交' }).click()
const request = await requestPromise
expect(request.postDataJSON()).toMatchObject({ total: 100 })
```

### 7. 视觉回归

```ts
test('homepage screenshot', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveScreenshot('home.png', {
    maxDiffPixels: 100,
    fullPage: true,
  })
})
```

第一次跑生成 baseline，后续比对。CI 失败时上传 diff 图。

### 8. 配置并行

```ts
// playwright.config.ts
export default defineConfig({
  fullyParallel: true,           // 同 spec 内 test 也并行
  workers: process.env.CI ? 4 : undefined,  // CI 用 4 worker，本地全开
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',     // 失败时录 trace
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
})
```

## 调试技巧

### 1. UI 模式（最好用）

```bash
pnpm exec playwright test --ui
```

可视化看每一步、回放、看 trace。

### 2. trace viewer

```bash
# 失败 trace 自动保存
pnpm exec playwright show-trace test-results/.../trace.zip
```

### 3. 单步 debug

```ts
test('debug', async ({ page }) => {
  await page.goto('/')
  await page.pause()  // 浏览器开 inspector
})
```

### 4. headed 跑 + slowMo

```bash
pnpm exec playwright test --headed --slowmo=500
```

### 5. 只跑一个

```ts
test.only('this one', async ({ page }) => { ... })

// 或命令行
pnpm exec playwright test auth.spec.ts -g "successful login"
```

## 稳定性救急

测试 flaky（时好时坏）的常见原因 + 修法：

### 1. 动画干扰

```ts
// 禁用 CSS 动画
await page.addStyleTag({ content: `* { animation: none !important; transition: none !important; }` })
```

### 2. 时间差异

```ts
// fix 时钟（Playwright 1.45+）
await page.clock.install({ time: new Date('2026-01-01') })
```

### 3. 异步加载

```ts
// ❌
await page.click('button')
await page.click('next-button')   // 第二个还没出现

// ✅
await page.getByRole('button', { name: '提交' }).click()
await page.getByRole('button', { name: '下一步' }).click()  // 自动等
```

### 4. 关键资源加载

```ts
await page.waitForLoadState('networkidle')   // 慎用，单页应用永远不 idle
await page.waitForResponse(resp => resp.url().includes('/api/data') && resp.ok())
```

## 跟单元/集成测试的边界

| 类型 | 框架 | 范围 |
|---|---|---|
| 单元 | vitest / jest | 函数 / 组件 |
| 集成 | vitest / Testing Library | 多组件 + Mock API |
| **E2E** | **Playwright** | **真浏览器 + 真后端** |
| 视觉回归 | Playwright + Percy / Chromatic | UI 像素 |
| API | Playwright request / supertest | 不开浏览器纯调 API |

E2E **不要**测覆盖率 100%。覆盖**关键用户路径** 5-20 个就够。其他靠单测。

## Playwright API 测试

```ts
import { test, expect } from '@playwright/test'

test('POST /users 201', async ({ request }) => {
  const r = await request.post('/api/users', {
    data: { email: 'a@b.com', name: 'A' },
  })
  expect(r.status()).toBe(201)
  const body = await r.json()
  expect(body.email).toBe('a@b.com')
})
```

不开浏览器，纯 API 测试也很顺手。

## 与 CI 集成

```yaml
# .github/workflows/e2e.yml
- uses: actions/setup-node@v4
- run: pnpm install
- run: pnpm exec playwright install --with-deps
- run: pnpm exec playwright test
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: playwright-report
    path: playwright-report/
```

## 反模式

❌ 用 sleep
❌ 用 CSS class 选择器
❌ 一个测试干 10 件事（找一个失败原因要看半天）
❌ 测试间共享状态（一个失败导致其他都失败）
❌ 跑测试需要"刚好的"环境（每次都重置数据）
❌ assert 字段都不指定（`expect(true).toBe(true)`）

## 与其他技能的关系

- 单元测试 → test-driven-development
- 性能测试 → web-performance-optimization
- CI 集成 → ci-cd-github-actions
- 可访问性测试 → 配合 accessibility-a11y + axe
