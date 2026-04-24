# maxian-idea

IntelliJ IDEA 插件形态（占位）。

## 状态

🚧 **占位阶段**。

## 设计

- **sidecar 模式**（不走 JVM in-proc，跨语言代价高）
- Kotlin 启动 `@maxian/server` Bun 单文件二进制
- JCEF WebView 加载 `@maxian/ui` 打包产物
- 详见 `docs/architecture/overview.md` § 5.5

## 预期目录

```
apps/idea-plugin/
├── build.gradle.kts
├── src/main/kotlin/      Kotlin 插件代码
├── src/main/resources/
└── webview/              @maxian/ui 打包产物（构建时注入）
```
