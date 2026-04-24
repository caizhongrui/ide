# ADR-002: Desktop / IDEA 采用 sidecar 模式，避免 in-proc

- 状态：Accepted
- 日期：2026-04-24

## 背景

`@maxian/core` 是 Node/TS 生态。消费方有多种：
- Desktop (Tauri + SolidJS，Rust 壳 + TS/JS 前端)
- 码弦IDE (VS Code fork，Node extension host)
- VS Code 官方插件 (Node extension host)
- IDEA 插件 (JVM，Kotlin)
- Web (浏览器)
- 云端

in-proc 要求运行时与 core 是相同的 Node/TS 环境。JVM 和浏览器不满足。

## 决策

- **Desktop**、**IDEA 插件**、**Web**：**sidecar 模式** — 启动独立 `@maxian/server` Bun 单文件二进制，通过 HTTP + SSE 通信
- **码弦IDE**、**VS Code 官方插件**：允许 **in-proc**，直接在 extension host 内使用 `@maxian/core`
- **云端 worker**：独立进程，走 NodePlatform

## 考虑过的替代

- **IDEA in-proc (Kotlin/JS)**：需要上 Kotlin → JS 桥或 GraalVM polyglot，兼容性差、调试困难、Node 原生模块（better-sqlite3、node-pty）编译麻烦
- **Desktop in-proc**：Tauri 虽是 Rust 壳，但 Rust ↔ TS core 的 FFI 代价远大于收益
- **全部 sidecar**：码弦IDE 没必要付多进程代价

## 理由

- Bun `--compile` 产出 58MB 单文件，启动 < 200ms，无 Node.js 依赖
- 同一二进制 4 平台通用 (mac-arm64 / mac-x64 / win-x64 / linux-x64)
- HTTP + SSE 协议是现成的跨语言契约
- 便于独立升级 sidecar 而不重装宿主

## 影响

- `tools/build-sidecar/` 产物是 Desktop / IDEA / (可选) Web 的共享物
- VS Code 官方插件可选 in-proc 或 sidecar（用户安装体积 vs 启动速度权衡）
- sidecar 生命周期由宿主管理（启动、健康检查、关闭 kill）
