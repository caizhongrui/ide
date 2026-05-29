---
name: test-driven-development
description: 当用户说"写测试 / 加单元测试 / 测试一下 / 我要 TDD"或者要新增一个独立函数/模块时，**必须调用此技能**走 RED-GREEN-REFACTOR 闭环，避免写了测试但其实什么都没测到。
---

# TDD — 测试驱动开发（红绿重构）

## 适用场景

满足以下**任一**时调用：

1. 用户明确要求 TDD / 写测试 / 提高覆盖率
2. 新增独立函数 / 类 / 模块（"为这个写测试"）
3. 修复 bug 时要求"加个回归测试"
4. 重构前要先建立"安全网"

## 核心原则

**TDD = 红 → 绿 → 重构**，**严格按顺序**，不能跳。

- **红（RED）**：先写一个**失败的**测试
- **绿（GREEN）**：写**最少**代码让测试通过
- **重构（REFACTOR）**：在测试保护下优化结构，不改行为

## 完整流程

> **提示**:多个测试用例的 TDD 循环建议先调用 `todo_write` 工具建立 todo 列表(每个用例一条:"用例 X — RED/GREEN/REFACTOR"),执行中实时勾选,方便前端展示进度。

### 第 0 步：选定"一个"行为

不要一次写 10 个测试。**一次只做一个测试用例**。

格式：「函数 X 在情况 Y 时应该 Z」

例：
- 函数 `parseDate` 在输入 `"2026-01-01"` 时应该返回 `Date(2026, 0, 1)`
- 函数 `parseDate` 在输入 `""` 时应该抛 `InvalidDateError`

### 第 1 步：RED — 写失败测试

```ts
// parseDate.test.ts
import { describe, it, expect } from 'vitest';
import { parseDate } from './parseDate.js';

describe('parseDate', () => {
  it('解析 ISO 日期格式', () => {
    expect(parseDate('2026-01-01')).toEqual(new Date(2026, 0, 1));
  });
});
```

**关键**：
- 函数 / 模块**还没实现**（或者实现是空的、抛异常）
- 跑测试，**确认它失败**（看到红色）
- 失败原因要是「断言不通过」或「函数不存在」，不能是「import 错误」「语法错误」

### 第 2 步：GREEN — 写最少代码让它过

```ts
// parseDate.ts
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
```

**关键**：
- **绝对最少**实现，能让测试过就行
- 即便代码很丑、有 hardcode、覆盖不全——**没关系**
- 跑测试，**看到绿色**

如果一上来就写得很完整，TDD 的意义就丢失了——你不知道每行代码是被哪个测试约束的。

### 第 3 步：REFACTOR — 重构

测试在保护你，现在可以放心重构：

- 抽出辅助函数
- 改进命名
- 处理边界（注意：这一步**不加新功能**）
- 加注释

**每次重构后**重新跑测试，确保还是绿色。

### 第 4 步：循环

回到第 0 步，选下一个行为：

- 边界情况：空字符串、null、特殊值
- 错误处理：非法输入抛什么
- 性能要求（如果有）

## 测试要写得好

### A. 测试名字 = 一句话描述行为

❌ `it('test1', ...)`
❌ `it('parseDate', ...)`
✅ `it('解析 ISO 日期格式', ...)`
✅ `it('遇到非法输入抛 InvalidDateError', ...)`

### B. AAA 模式

每个测试三段式：

```ts
it('xxx', () => {
  // Arrange — 准备数据
  const input = '2026-01-01';
  
  // Act — 调用被测对象
  const result = parseDate(input);
  
  // Assert — 断言结果
  expect(result).toEqual(new Date(2026, 0, 1));
});
```

### C. 一个测试只断言一件事

❌ 一个 it 里 5 个 expect 断言不同函数
✅ 每个 it 只测一个行为，命名能体现差异

### D. 不依赖外部状态

- 不读真实数据库 / 文件系统（用 mock）
- 不依赖网络（用 mock）
- 不依赖测试运行顺序（每个 it 独立）

## 反模式

❌ **测试在代码之后写**——这不是 TDD，是事后补测试，会出现"测试通过但实际没测到关键行为"
❌ 一次写 20 个测试——失去节奏，不知道哪个先过
❌ 测试里复制粘贴大量重复——抽 fixture 或 setup
❌ 跳过 RED 阶段——直接写实现+测试，看到绿色就以为对了（可能测试本身就是错的）
❌ REFACTOR 阶段加新功能——破坏 TDD 节奏

## 如何**确认**测试有效

写完一个测试后，**故意改坏代码**：
- 把 `return n + 1` 改成 `return n + 2`
- 跑测试

**测试必须变红**。如果改坏代码测试还是绿——这个测试没用，删掉重写。

## 常用框架

| 项目类型 | 测试框架 |
|---|---|
| **码弦(pnpm workspace + TS)** | **`vitest`**(注意:部分子包未安装 vitest,需先看子包 `package.json`) |
| Node + TS | `vitest` 或 `jest` |
| Java + Maven | `JUnit 5` + `Mockito` |
| Python | `pytest` |
| Rust | `cargo test`(内置) |

## 与其他技能的关系

- 修 bug 时：先 `systematic-debugging` 找根因，再用本技能写回归测试
- 重构前：用本技能建立测试网，再开始重构
- 完成前：用 `verification-before-completion` 确认测试覆盖度
