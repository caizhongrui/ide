# tools/version-check

Desktop 版本号 4 处一致性校验脚本。

## 检查项

| 文件 | 字段 | 强制 |
|---|---|---|
| `apps/desktop/package.json` | `version` | ✅ 基线 |
| `apps/desktop/src-tauri/tauri.conf.json` | `version` | ✅ 必须等于基线 |
| `apps/desktop/src-tauri/Cargo.toml` | `[package].version` | ✅ 必须等于基线 |
| `apps/desktop/src/App.tsx` | `CHANGELOG[0].version` | ⚠️ 不一致仅警告 |

## 用法

```bash
node tools/version-check/check.mjs
```

退出码：
- `0` 全部一致
- `1` 关键字段不一致（CI 触发失败）

## 集成到 CI

`.github/workflows/ci.yml` 已加 `Version consistency` job 自动跑。
