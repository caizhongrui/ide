---
name: vue3-composition-api
description: 任何涉及 Vue 3 / Vite 项目的代码（组件、composable、状态、路由），**必须调用此技能**遵守 Composition API 最佳实践，避免 Options API 混用、ref/reactive 误用、生命周期错位等常见问题。
---

# Vue 3 + Composition API 最佳实践

## 适用场景

任何 .vue / .ts 涉及 Vue 3 的代码：
- 写新组件 / 改现有组件
- 写 composable（自定义 hook）
- 状态管理（Pinia）
- Vue Router 路由
- 性能优化

## 8 条铁律

### 1. 一律 `<script setup>` + Composition API

❌ Options API（data/methods/computed）：老代码风格，新代码不要写
❌ defineComponent + setup() 函数：冗余
✅ `<script setup lang="ts">`：最简洁

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'

interface Props {
  title: string
  count?: number
}
const props = withDefaults(defineProps<Props>(), { count: 0 })
const emit = defineEmits<{
  (e: 'update:count', val: number): void
}>()

const local = ref(0)
const doubled = computed(() => local.value * 2)
</script>
```

### 2. ref vs reactive — 默认用 ref

| 场景 | 用 |
|---|---|
| 单值（数字、字符串、布尔、单对象） | `ref()` |
| 复杂状态对象树（少见） | `reactive()` |

**为什么默认 ref**：
- 解构友好（reactive 解构会丢失响应式）
- TypeScript 类型推断更稳
- 在 composable 返回时不需要包 toRefs

```ts
// ❌ reactive 解构破坏响应式
const state = reactive({ count: 0 })
const { count } = state  // count 不再响应式
count.value = 1  // 报错，没有 .value

// ✅ ref 始终安全
const count = ref(0)
const localCount = count  // 还是同一个 ref
count.value = 1  // OK
```

### 3. computed 不要放副作用

```ts
// ❌
const data = computed(() => {
  fetch('/api/x').then(r => ...)  // 副作用
  return processedValue
})

// ✅ 用 watchEffect / watch
watchEffect(() => {
  if (someRef.value) fetchData(someRef.value)
})
```

### 4. watch / watchEffect 区别

```ts
// watchEffect：自动收集依赖，立即执行一次
watchEffect(() => {
  console.log(count.value)  // count 变就重跑
})

// watch：明确指定依赖，**默认不立即执行**
watch(count, (newVal, oldVal) => {
  // count 变才跑（除非加 immediate: true）
})

// watch 多源
watch([count, name], ([c, n], [oc, on]) => { ... })
```

**坑**：watch 一个 reactive 对象需要 deep:true 或包 getter：
```ts
const obj = reactive({ a: 1 })

// ❌ 不会触发
watch(obj, () => {})

// ✅
watch(() => obj.a, () => {})
// 或
watch(obj, () => {}, { deep: true })
```

### 5. v-for 必须用稳定 key

```vue
<!-- ❌ 用 index：列表重排会引发错位 -->
<div v-for="(item, i) in list" :key="i">

<!-- ✅ 用数据 ID -->
<div v-for="item in list" :key="item.id">
```

### 6. v-if 和 v-for 不要同时用

```vue
<!-- ❌ 性能差，警告 -->
<div v-for="user in users" v-if="user.active" :key="user.id">

<!-- ✅ 先 computed 过滤 -->
<script setup>
const activeUsers = computed(() => users.value.filter(u => u.active))
</script>
<div v-for="user in activeUsers" :key="user.id">
```

### 7. 双向绑定（v-model）规范

子组件：
```vue
<script setup>
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', val: string): void }>()
</script>

<template>
  <input :value="modelValue" @input="emit('update:modelValue', $event.target.value)" />
</template>
```

父组件：`<Child v-model="text" />`

多 v-model（Vue 3 支持）：`<Child v-model:foo="a" v-model:bar="b" />`

### 8. defineExpose 只暴露必要的

```vue
<script setup>
const internal = ref(0)
const publicMethod = () => { ... }

// 父组件 ref 只能访问这里 expose 的
defineExpose({ publicMethod })
</script>
```

## Composable 写法

模式：`useXxx()` 函数返回 `{ state, actions }`：

```ts
// composables/useCounter.ts
import { ref, computed } from 'vue'

export function useCounter(initial = 0) {
  const count = ref(initial)
  const doubled = computed(() => count.value * 2)
  const inc = () => count.value++
  const reset = () => { count.value = initial }
  
  return { count, doubled, inc, reset }
}
```

使用：
```vue
<script setup>
import { useCounter } from '@/composables/useCounter'
const { count, doubled, inc } = useCounter(10)
</script>
```

**生命周期**：composable 里用 `onMounted/onUnmounted` 必须在**同步上下文**调用，否则失效：
```ts
export function useEvent() {
  // ❌ 在 await 之后调用 onMounted 会失败
  await someAsync()
  onMounted(...)
  
  // ✅ 同步先注册，await 在内部
  onMounted(async () => {
    await someAsync()
  })
}
```

## Pinia（状态管理）

```ts
// stores/user.ts
import { defineStore } from 'pinia'

export const useUserStore = defineStore('user', () => {
  // state
  const user = ref<User | null>(null)
  // getter
  const isLoggedIn = computed(() => user.value !== null)
  // action
  async function login(email: string, pwd: string) {
    user.value = await api.login(email, pwd)
  }
  return { user, isLoggedIn, login }
})
```

使用：
```vue
<script setup>
import { storeToRefs } from 'pinia'
const userStore = useUserStore()
const { user, isLoggedIn } = storeToRefs(userStore)  // 保持响应式
const { login } = userStore  // action 可以直接解构
</script>
```

## 性能优化

### shallowRef / shallowReactive

大对象只关心顶层引用变化：
```ts
const big = shallowRef({ huge: 'tree' })  // 只追踪 .value 替换
big.value = newObj  // 触发更新
big.value.huge = 'x'  // ❌ 不触发
```

### v-memo

跳过列表项重渲染：
```vue
<div v-for="item in list" :key="item.id" v-memo="[item.id, item.updated]">
  <!-- 只在 id 或 updated 变化时重新渲染 -->
</div>
```

### KeepAlive

缓存路由组件状态：
```vue
<router-view v-slot="{ Component }">
  <KeepAlive :include="['UserList']">
    <component :is="Component" />
  </KeepAlive>
</router-view>
```

## TypeScript 配合

```ts
// 模板 ref 类型
const inputRef = ref<HTMLInputElement | null>(null)

// 组件 ref 类型
import type { ComponentPublicInstance } from 'vue'
const childRef = ref<ComponentPublicInstance | null>(null)

// emits 类型
const emit = defineEmits<{
  (e: 'submit', data: { name: string; age: number }): void
  (e: 'cancel'): void
}>()

// provide/inject 类型安全
import { provide, inject, type InjectionKey } from 'vue'
const KEY = Symbol() as InjectionKey<string>
provide(KEY, 'value')
const v = inject(KEY)  // string | undefined
```

## 常见陷阱

### 陷阱 1：ref 在模板里自动解包，但脚本里要 .value

```vue
<script setup>
const count = ref(0)
console.log(count.value)  // ✅ 脚本里要 .value
</script>
<template>
  {{ count }}  <!-- ✅ 模板里自动解包 -->
</template>
```

### 陷阱 2：响应式丢失

```ts
const state = reactive({ a: 1 })
const a = state.a  // ❌ 解构出基本类型，响应式丢失
const a = toRef(state, 'a')  // ✅ 保持响应式
```

### 陷阱 3：异步 setup 阻塞渲染

```ts
// ❌ <script setup> 顶层 await 会让组件成为 async component
const data = await fetchData()

// ✅ 用 onMounted 或 Suspense
onMounted(async () => {
  data.value = await fetchData()
})
```

### 陷阱 4：watch 数组引用变化才触发

```ts
const arr = ref([1, 2, 3])

watch(arr, () => console.log('changed'))
arr.value.push(4)  // ❌ push 不变 ref 引用，不触发
arr.value = [...arr.value, 4]  // ✅
```

## 与其他技能的关系

- 写 Vue 组件前先 brainstorming 明确需求
- 用 TypeScript 时叠加 typescript-strict-mode skill
- 性能问题用 web-performance-optimization
- 测试组件用 e2e-testing-playwright
