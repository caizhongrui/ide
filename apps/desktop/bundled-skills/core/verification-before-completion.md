---
name: verification-before-completion
description: 在你（AI）准备说"我已完成 / 修好了 / 已实现"之前，**必须调用此技能**做一遍完整的验证清单，避免出现"声称完成但实际编译失败 / 测试不过 / 功能未跑通"的常见翻车场景。
---

# 完成前验证 — 防止"假声称完成"

## 适用场景

任何时候你打算输出**完成结论**之前都要走一遍：
- "我已经实现了 ..."
- "Bug 修复完成"
- "功能已上线"
- "代码已提交"

## 核心原则

**90% 的"假完成"事故来自 AI 没真正验证**。

LLM 倾向于"输出完成结论"显得高效，但用户拿到的代码可能：
- 编译都不过
- 类型错误一片
- 跑起来直接 crash
- 改了 A 文件，但没改 import A 的 B 文件
- 测试根本没跑

**调用本技能就是给自己一次"刹车"，强制走完检查清单**。

## 检查清单（**全部 ✅ 才能宣布完成**）

### A. 编译 / 类型检查

| 项目类型 | 命令 | 必须 |
|---|---|---|
| TypeScript | `pnpm typecheck` 或 `tsc --noEmit` | ✅ 0 错误 |

> **码弦工程注意**:码弦是 pnpm workspace 多包结构,根目录跑 `pnpm typecheck` 不会递归到所有子包;用 `pnpm --filter @maxian/<包名> run typecheck`(如 `@maxian/core` / `@maxian/server` / `@maxian/desktop`)按包运行,部分子包可能未配置 typecheck 脚本。

| Rust | `cargo check` | ✅ 0 错误（warning 可接受） |
| Java | `mvn compile` 或 `mvn test-compile` | ✅ 0 错误 |
| Python (有类型) | `mypy .` 或 `pyright` | ✅ 0 错误 |
| Go | `go build ./...` | ✅ 0 错误 |

**只通过 typecheck 不够**——代码逻辑可能完全错。

### B. 测试

| 类型 | 命令 |
|---|---|
| 单元测试 | `pnpm test`(码弦用 vitest)/ `mvn test` / `pytest` |
| 集成测试 | 如果项目有 |
| Lint | `pnpm lint` 如果项目有 |

至少**新加的功能 / 修过的 bug 有测试覆盖**。

> **码弦工程注意**:测试框架是 **vitest**(不是 bun:test);pnpm workspace 中**部分包未安装 vitest**,跑测试前先 `cat package.json` 确认 `scripts.test` 存在;或用 `pnpm --filter` 按包跑。

### C. 手动 smoke test

跑一遍**最关键的用户路径**：

- Web：启动 dev server，浏览器访问，点核心按钮看效果
- CLI：跑核心命令看输出
- 库：用一个最小用例 import 进来调一次

### D. 需求对照

回到原始需求，**逐条 check**：

```markdown
原始需求：
1. 用户能用 X 登录   ← ✅ 跑了一遍 OK
2. 错误消息中文显示   ← ✅ 故意输错密码看到中文报错
3. 不能影响 Y 功能   ← ✅ Y 的测试还是绿色
```

### E. 改动范围对照

回顾你改了哪些文件，**确认每个改动都是必要的**：
- 没有顺手改了无关的代码
- 没有留 debug log（`console.log("HERE")` 这种）
- 没有留临时变量 / 死代码
- 没有引入新依赖（除非用户同意）

### F. 文档 / 配置

- 新增了导出？→ 更新 `index.ts` 的 re-export
- 新增了配置？→ 更新文档 / `.env.example`
- 改了 API？→ 更新 `API.md` 或 README
- 涉及版本号？→ `package.json` / `Cargo.toml` 一起改

### G. Git 状态（如果会被提交）

- `git status` 看一遍，没有意外文件
- 没有提交 secrets / `.env` / 大二进制
- diff 自己看一遍，没有 typo / 注释里的 TODO 没清掉

> **码弦工程注意**：码弦是单一 git 仓库的 pnpm monorepo（根目录即仓库根）。在仓库根目录检查 git 状态即可；改动可能跨多个包，统一 commit。

## 输出格式

走完清单后给用户：

```markdown
## 完成验证

✅ TypeScript：`pnpm typecheck` 通过（0 错误）
✅ 单元测试：`pnpm test` 通过（37 passed, 0 failed）
✅ 手动验证：[关键场景的实际操作和观察结果]
✅ 需求对照：3 条全部满足
✅ 改动范围：5 个文件，全部必要
✅ 没有 debug 代码 / 无关改动

## 改动摘要
- `src/foo.ts` — 新增 parseX 函数
- `src/bar.ts` — 调用 parseX 替代 inline
- `tests/foo.test.ts` — 5 个新测试

## 风险点 / 后续注意
- xxx
```

## 反模式（绝对不要）

❌ 跳过 typecheck / 测试，直接说"应该好了"
❌ "我觉得没问题"——感觉≠验证
❌ 跑了 typecheck 通过就说完成（没跑测试）
❌ 跑了测试通过就说完成（没手动 smoke test）
❌ 改了 A 文件但没改 import A 的 B 文件——B 文件是什么编译状态？
❌ 把 "TODO" 留在代码里然后说完成

## 如果某项**故意不做**

明确告诉用户：

> ⚠️ 我跳过了端到端测试，因为：[理由]。建议你手动验证 [具体场景]。

不要假装做了。

## 与其他技能的关系

- 这是**所有任务的最后一步**，所有其他技能完成后都要走这个
- 如果发现验证不通过 → 回到 `systematic-debugging` 找根因
- 如果验证通过 → 才能给用户看完成报告 / 调用 attempt_completion
