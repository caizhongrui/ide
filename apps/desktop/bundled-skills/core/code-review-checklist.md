---
name: code-review-checklist
description: 当用户要你对一段代码 / 一个 PR / 一个文件做 code review 时，**调用此技能**按 7 大维度系统化审查，避免只看表面格式问题忽略真正的设计 / 安全 / 性能隐患。
---

# 代码审查清单 — 7 大维度系统化检查

## 适用场景

满足**任一**时调用：

1. 用户说"帮我审一下这段代码 / 这个 PR / 这个文件"
2. 用户说"看看有没有问题 / 有没有可以改进的"
3. 用户提交 PR 描述里点名要 review
4. 你（AI）作为 reviewer 角色被指派

## 核心原则

**Review 不是只看格式**。格式问题用 lint 工具，review 应该看 lint 看不出来的：
- 设计是否合理
- 是否引入新风险
- 是否漏处理边界
- 是否符合项目惯例

**给具体可改的建议**，不要泛泛说"可以更好"。

## 7 大维度（**逐个走完**）

### 1. 正确性（Correctness）

- 代码真的做了 PR 描述说的事吗？
- 边界条件覆盖：null / 空数组 / 0 / 负数 / 极大值 / 并发？
- 异常路径：报错时会怎样？错误信息有意义吗？
- 副作用：改了全局状态？写了文件？发了网络请求？
- 异步：Promise / async 用对了吗？race condition？

### 2. 设计（Design）

- 函数 / 类的职责是否单一？
- 命名是否准确反映意图？
- 抽象层级是否一致（不要在高层 API 里突然出现底层细节）？
- 是否引入了不必要的灵活性（YAGNI）？
- 是否符合项目现有模式 / 约定？

### 3. 可读性（Readability）

- 一个函数超过 50 行？太长，建议拆
- 嵌套超过 3 层？想想能不能用 early return 拍平
- 魔法数字 / 字符串？抽常量
- 复杂逻辑没注释？加 1-2 行说明 **why**（不是 what）
- 不直观的代码？加 `// 这里特意不用 X，因为 ...` 类的解释

### 4. 测试（Testing）

- 新增功能有测试？
- 测试名字能看懂在测什么？
- 测试覆盖了 happy path + error path？
- 测试不依赖外部状态（DB / 网络）？
- 修 bug 的 PR 有回归测试？

### 5. 性能（Performance）

只在以下情况关心，**不要过早优化**：
- 循环里调用昂贵函数（DB 查询 / 文件 IO / 网络）
- N+1 查询
- 大量字符串拼接（用数组 join）
- 同步阻塞 I/O
- 内存泄漏：监听器没移除 / 引用没释放

如果代码不在热路径，"性能"维度可以跳过。

### 6. 安全（Security）

**永远要看的**：

- 用户输入是否被验证 / 转义？
- SQL 是否参数化（不是拼字符串）？
- 是否有硬编码密钥 / token / 密码？
- HTTP 请求是否带了认证？响应是否校验？
- 文件路径：是否允许 `../../` 越界？
- shell 命令：用户输入是否被 shell 转义？
- 反序列化：是否信任了不可信数据？
- 权限检查：是否做了？做对了吗？

### 7. 文档与协作（Docs & Collaboration）

- 公开 API 改动了 → README / API.md 更新？
- 配置改动了 → `.env.example` 更新？
- 行为改动了 → CHANGELOG / commit message 说明？
- 注释里的 TODO / FIXME 是真有意义还是没清掉？
- import 顺序符合项目规范？
- 文件 / 目录命名一致？

## 评论给法

### A. 标分级

```
[blocker]  必须改才能合
[important] 强烈建议改
[suggestion] 个人偏好，可以讨论
[nit]      鸡蛋里挑骨头，可以不改
[question] 我没看懂，问问
[praise]   做得好的地方也夸一下！
```

例：
> [blocker] line 23 `JSON.parse(req.body)` 没 try/catch，畸形 JSON 会让整个进程 crash。
>
> [suggestion] line 45 这个函数有 80 行，建议拆出 validateInput 和 processOrder 两段。
>
> [praise] 这里用了策略模式而不是 if-else 链，扩展性好很多。

### B. 给可执行建议

❌ "这里可以更好"
❌ "考虑一下性能"
✅ "建议改成 `await Promise.all(items.map(...))` 并发处理，当前 for-await 串行 N 次每次 100ms = 100N ms"

### C. 引用具体位置

格式：`<文件>:<行号>` 或直接贴代码片段，不要"那个函数那里"。

## Review 输出模板

```markdown
## Code Review 总结

**总体评价**：[1-2 句]
**建议**：可合 / 大改后再合 / 不能合

## Blockers（必改）

1. **`auth.ts:45`** — JSON.parse 缺 try/catch，会 crash
   建议改为：
   ```ts
   try { return JSON.parse(s); } catch { return null; }
   ```

## Important（建议改）

1. **`api.ts:120`** — 函数 80 行职责混杂，建议拆 validateInput / processOrder

## Suggestions（讨论）

1. **`store.ts:30`** — 用 immer 比手动 spread 更可读，看你

## Praises

1. `parser.ts` 的 visitor pattern 设计很赞

## 整体改进方向

- 测试覆盖：4/10 个新函数有测试，建议补到 ≥ 8
- 命名：xxx 含义不清，建议 yyy
```

## 反模式

❌ 只看格式 / 缩进 / 分号——这是 lint 的事
❌ 笼统说"可以更好"不给具体建议
❌ 评论里只有挑刺没有夸奖——挫伤积极性
❌ 一次列 50 个 nit——抓主要矛盾
❌ 提"和我风格不一样"的偏好——除非项目有规范文件
❌ Review 别人代码却不读上下文——很多"问题"其实是上下文允许的

## 与其他技能的关系

- 用户希望被 review 之前可以先用 `requesting-code-review` 自查
- Review 发现严重 bug → `systematic-debugging` 找根因
- Review 通过后 → `finishing-a-development-branch` 收尾
