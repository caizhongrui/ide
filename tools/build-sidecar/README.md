# tools/build-sidecar

`@maxian/server` Bun `--compile` 四平台单文件二进制构建工具。产物被 Desktop / IDEA / (可选) VSCode 插件共享。

## 使用

```
node tools/build-sidecar/compile.mjs darwin-arm64
node tools/build-sidecar/compile.mjs darwin-x64
node tools/build-sidecar/compile.mjs win32-x64
node tools/build-sidecar/compile.mjs linux-x64
```

## 迁移

现有脚本在 `packages/server/scripts/build-bin.mjs`，P2 完成后将迁移到这里，统一入口。
