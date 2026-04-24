# tools/make-dmg

macOS DMG 构建工具，绕过 create-dmg 对中文 productName 的 bug，用 `hdiutil create` 直接生成。

## 使用

```
node tools/make-dmg/build.mjs <app-path> <dmg-output>
```
