---
name: typescript-strict-mode
description: 任何 TypeScript 项目改动，**必须调用此技能**遵守严格模式约定，避免 any 泛滥 / 类型断言滥用 / 隐式 undefined 等导致运行时崩溃的常见问题。
---

# TypeScript 严格模式实践

## 适用场景

任何 .ts / .tsx 文件改动：
- 新增函数 / 类 / 接口
- 引入第三方包
- 修复类型错误
- 提供给他人使用的公开 API

## tsconfig.json 推荐配置（严格模式全开）

```json
{
  "compilerOptions": {
    "strict": true,                              // 一键开启全部严格检查
    "noImplicitAny": true,                       // 不允许隐式 any
    "strictNullChecks": true,                    // null/undefined 必须显式
    "strictFunctionTypes": true,                 // 函数参数协变检查
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,        // class 字段必须初始化
    "noImplicitThis": true,
    "alwaysStrict": true,
    
    "noUnusedLocals": true,                      // 未用的局部变量报错
    "noUnusedParameters": true,
    "noImplicitReturns": true,                   // 函数所有路径都要 return
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,            // arr[i] 类型加 undefined
    "exactOptionalPropertyTypes": true,
    
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "moduleResolution": "Bundler"                // 或 "Node16"
  }
}
```

**最重要**的三个：`strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`。

## 9 条原则

### 1. **不写 any**，**不写 as 强转**

❌
```ts
function process(data: any) { ... }
const x = obj as any;
```

任何 `any` / `as` 都是放弃类型安全。**必要时用 unknown** + 类型守卫：

✅
```ts
function process(data: unknown) {
  if (typeof data === 'object' && data !== null && 'id' in data) {
    // 这里 data 有了 id 字段
  }
}
```

### 2. 优先用 type / interface 表达约束

❌
```ts
function getUser(id) { ... }
```

✅
```ts
interface User { id: number; name: string; }
function getUser(id: number): Promise<User | null> { ... }
```

### 3. Discriminated Union 处理多形态

```ts
type ApiResult<T> =
  | { status: 'success'; data: T }
  | { status: 'error'; code: string; message: string };

function handle<T>(r: ApiResult<T>) {
  if (r.status === 'success') {
    r.data;        // ✅ TS 自动收窄到 success 分支
  } else {
    r.code;        // ✅ 在这分支才能访问 code
  }
}
```

### 4. 不可变数据用 readonly + as const

```ts
// 字面量值锁定
const ROLES = ['admin', 'member', 'viewer'] as const;
type Role = typeof ROLES[number];  // 'admin' | 'member' | 'viewer'

// 接口字段不可变
interface User {
  readonly id: number;
  readonly email: string;
  name: string;  // 这个可变
}
```

### 5. 函数返回类型显式声明（公开 API）

❌
```ts
export function parseUser(s: string) {  // 返回类型推断
  return JSON.parse(s);  // 实际返回 any
}
```

✅
```ts
export function parseUser(s: string): User {
  const obj: unknown = JSON.parse(s);
  if (!isUser(obj)) throw new Error('invalid');
  return obj;
}
```

### 6. 用 zod / valibot 做运行时校验

TS 类型只在编译时存在。从外部接收的 JSON / 用户输入要**运行时校验**：

```ts
import { z } from 'zod';

const UserSchema = z.object({
  id: z.number(),
  email: z.string().email(),
  name: z.string().min(1).max(100),
});
type User = z.infer<typeof UserSchema>;  // 自动推 TS 类型

// 运行时校验
const user = UserSchema.parse(jsonData);  // 不合法抛错
```

### 7. 异步错误必须处理

❌ unhandled rejection：
```ts
async function init() {
  fetchData();  // ❌ 不 await 不 catch
}
```

✅
```ts
async function init() {
  try {
    await fetchData();
  } catch (e) {
    log.error('init failed', e);
    throw e;  // 或者优雅降级
  }
}
```

ESLint 启用 `@typescript-eslint/no-floating-promises`。

### 8. 用 satisfies 而不是 as

❌
```ts
const config = { port: 3000 } as Config;  // 不检查必填字段
```

✅
```ts
const config = { port: 3000 } satisfies Config;  
// 检查 config 兼容 Config，但**保留**字面量类型
```

### 9. enum 慎用，倾向用字面量 union

```ts
// ❌ 数值 enum 容易乱
enum Status { Pending, Active, Closed }

// ✅ 字面量 union
type Status = 'pending' | 'active' | 'closed';
```

或用 `as const`：

```ts
const Status = {
  Pending: 'pending',
  Active: 'active',
} as const;
type StatusValue = typeof Status[keyof typeof Status];
```

## 常用工具类型

```ts
Partial<T>          // 所有字段变可选
Required<T>         // 所有字段变必填
Readonly<T>         // 所有字段变只读
Pick<T, K>          // 选取部分字段
Omit<T, K>          // 排除部分字段
Record<K, V>        // 字典类型
NonNullable<T>      // 排除 null / undefined
ReturnType<F>       // 函数返回类型
Parameters<F>       // 函数参数类型 tuple
Awaited<T>          // Promise<T> 解包到 T
```

实战：

```ts
type CreateUserDTO = Omit<User, 'id' | 'createdAt'>;  // 创建时不需要 id
type UpdateUserDTO = Partial<Pick<User, 'name' | 'email'>>;  // 更新时部分可选
```

## 类型守卫

### A. typeof / instanceof

```ts
function fn(x: string | number) {
  if (typeof x === 'string') x.toUpperCase();  // 收窄到 string
}
```

### B. in 操作符

```ts
function fn(x: { a: 1 } | { b: 2 }) {
  if ('a' in x) x.a;  // 收窄
}
```

### C. 自定义 type predicate

```ts
function isUser(x: unknown): x is User {
  return (
    typeof x === 'object' &&
    x !== null &&
    'id' in x &&
    typeof (x as any).id === 'number'
  );
}

if (isUser(data)) {
  data.email;  // 这里 data 是 User
}
```

## 常见陷阱

### 1. JSON.parse 返回 any

每次 parse 后用 zod 校验或写守卫。

### 2. fetch().json() 返回 any

```ts
const data = await response.json();  // ❌ any
const data: unknown = await response.json();  // ✅
const user = UserSchema.parse(data);    // 校验
```

### 3. catch 里 e 是 unknown

```ts
try { ... }
catch (e) {  // e: unknown (TS 4.4+)
  if (e instanceof Error) {
    log.error(e.message);
  }
}
```

### 4. 数组下标可能 undefined（noUncheckedIndexedAccess）

```ts
const arr = [1, 2, 3];
const x = arr[0];  // x: number | undefined
const y = arr[0]!;  // 你确认非空时
```

### 5. Object.keys() 返回 string[] 不是 keyof T

```ts
const obj = { a: 1, b: 2 };
const keys = Object.keys(obj);  // string[]
// 想要 ('a' | 'b')[]：
const keys = Object.keys(obj) as Array<keyof typeof obj>;
```

## 命名 / 风格

- 接口 / 类型用 PascalCase：`User`, `ApiResult`
- 接口名**不**加 `I` 前缀（TS 社区惯例）
- 常量用 UPPER_SNAKE：`const MAX_SIZE = 100`
- 文件名 kebab-case 或 camelCase（看项目惯例）

## 与其他技能的关系

- 写新模块前先 `brainstorming` 明确接口
- 实现完用 `verification-before-completion`：跑 `tsc --noEmit`
- 重构 → 测试网保护，参考 `test-driven-development`
