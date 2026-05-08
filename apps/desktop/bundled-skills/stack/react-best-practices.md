---
name: react-best-practices
description: 当用户要写 / 改 / 重构 React 组件时（包括 hooks、context、state 管理），**必须调用此技能**遵守最佳实践，避免常见陷阱（无效 useEffect / index 当 key / 状态可变更新 / 无意义重渲染）。
---

# React 最佳实践（18+/19）

## 适用场景

任何涉及 React 代码的任务：
- 新建组件
- 修改现有组件
- 加 hook / context
- 性能优化
- 把 class 组件改成 function

## 8 条铁律（不可违反）

### 1. 一律函数组件 + Hooks

❌ class 组件 + lifecycle methods
✅ function + useState / useEffect / useMemo

class 组件在新代码中**不应再写**（除非项目已有 class 组件大量存在且统一风格）。

### 2. 列表渲染 key 必须**稳定唯一**

❌ `items.map((item, i) => <Row key={i} ...>)` — 列表重排会让 React 误判
❌ `key={Math.random()}` — 每次渲染都不一样
✅ `key={item.id}` — 数据自带稳定 ID
✅ 极端情况无 ID：`key={`${item.type}-${item.timestamp}`}`

### 3. 状态更新必须 immutable

❌ `state.list.push(x); setList(state.list)` — React 不会触发重渲染
❌ `state.user.name = 'Alice'; setUser(state.user)` — 同上
✅ `setList([...state.list, x])`
✅ `setUser({ ...state.user, name: 'Alice' })`
✅ 复杂嵌套结构用 `immer` 的 `produce`

### 4. useEffect 依赖必须**显式列全**

❌ `useEffect(() => { fetch(url); }, [])` — `url` 没列入依赖，url 变了不会重 fetch
✅ `useEffect(() => { fetch(url); }, [url])`

如果你"故意只想跑一次"——99% 这是个 bug。如果真的故意，加注释说明：

```ts
// eslint-disable-next-line react-hooks/exhaustive-deps -- 故意只跑一次因为 ...
useEffect(() => { ... }, []);
```

### 5. 别在循环 / 条件 / 嵌套函数里调 hook

❌
```ts
if (cond) {
  const [s, setS] = useState();  // ❌
}
items.map(item => useState(item));  // ❌
```

✅ Hook 始终在组件函数顶层，按相同顺序调用。

### 6. 受控 vs 非受控 input 不要混用

❌ `<input value={undefined}>` 然后某次又 `value="x"` — React 会警告
✅ 受控：始终 `value={state}` + `onChange={setState}`
✅ 非受控：始终 `defaultValue` + `ref` 取值

### 7. Props 类型必须显式

```ts
// ❌ 没类型
function Button(props) { ... }

// ✅
interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}
function Button({ label, onClick, disabled = false }: ButtonProps) { ... }
```

### 8. 异步 effect 要清理 / 防止 set on unmounted

```ts
useEffect(() => {
  let cancelled = false;
  fetchUser(id).then(u => {
    if (!cancelled) setUser(u);
  });
  return () => { cancelled = true; };  // 关键：组件卸载或 id 变化时取消
}, [id]);
```

## 性能优化（**别过早优化**）

只有性能确实有问题才用这些：

### A. memo / useMemo / useCallback 三件套

- `React.memo(Component)` — 跳过 props 没变的子组件渲染
- `useMemo(() => expensiveCompute(deps), [deps])` — 缓存计算结果
- `useCallback(fn, [deps])` — 缓存函数引用

**不是越多越好**。每次 memo 都有比较成本。只在以下情况用：
- 子组件 render 很贵（有大列表 / 复杂 JSX）
- 引用比较确实能跳过渲染（depends 不是新对象）
- profiler 显示这里是瓶颈

### B. 大列表用虚拟滚动

`react-window` / `react-virtualized` / `@tanstack/react-virtual`

数据 > 1000 条时必须，<100 条不需要。

### C. 代码分割

```ts
const HeavyComponent = lazy(() => import('./HeavyComponent'));

<Suspense fallback={<Spinner />}>
  <HeavyComponent />
</Suspense>
```

### D. 状态尽量"下推"

把 state 放在**真正用到它的最低共同父组件**，避免顶层 state 触发整棵树渲染。

## 状态管理选型

| 场景 | 推荐 |
|---|---|
| 单组件局部 | `useState` |
| 同一子树共享 | `useContext` + `useReducer` |
| 跨页面 / 全局 | Zustand / Jotai（轻）/ Redux Toolkit（重） |
| 服务端数据 | TanStack Query / SWR |
| 表单 | React Hook Form + Zod |

**不推荐** Redux 经典版（Redux Toolkit 已经简化）。

## 常见陷阱

### 陷阱 1：useState 初始值是函数调用

```ts
// ❌ 每次渲染都跑 expensiveCompute
const [data, setData] = useState(expensiveCompute());

// ✅ 只在挂载时跑一次
const [data, setData] = useState(() => expensiveCompute());
```

### 陷阱 2：把 state 当成同步

```ts
setCount(count + 1);
console.log(count);  // 还是旧值！
```

state 更新是异步的。要立即用新值：

```ts
setCount(c => c + 1);  // 用 updater 函数
```

### 陷阱 3：context 让所有消费者都重渲染

context value 变化时，所有 `useContext` 的组件都会渲染。

如果是个频繁变化的 value，考虑：
- 拆成多个 context（按变化频率）
- 用 Zustand / Jotai 替代

## React Server Components（19+）

如果项目用 Next.js 13+ App Router：

- 默认是 Server Component（不能用 `useState` / `onClick`）
- 需要交互的组件加 `'use client'` 在文件顶部
- Server → Client 边界是性能关键，尽量小

## TypeScript 配合

```ts
// 子节点类型
type Props = {
  children: React.ReactNode;
};

// 事件
onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
onChange: (e: React.ChangeEvent<HTMLInputElement>) => void

// ref
const ref = useRef<HTMLInputElement>(null);

// forwardRef + 泛型
const Button = forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => ...);
```

## 何时**不**走这个 skill

- 改的不是 React 代码
- 只改 CSS / 静态文案
- 仅项目级配置（package.json / vite.config）

## 与其他技能的关系

- 写新组件前先 `brainstorming` 明确需求
- 实现完用 `verification-before-completion` 验证
- 提交前用 `requesting-code-review` 自查
