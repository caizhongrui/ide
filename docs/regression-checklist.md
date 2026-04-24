# 回归测试清单

> 每次核心重构（尤其 Platform 接口、HTTP 协议、SSE 事件、编辑工具链）变更后，必须手动跑完本清单。任意一项失败即 revert。

## 桌面端 (apps/desktop)

### 启动与生命周期
- [ ] `pnpm desktop:dev` 冷启动成功
- [ ] Sidecar 自动拉起、`GET /health` 返回正常
- [ ] 关闭窗口后 sidecar 被 kill（`ps aux | grep maxian-server` 无残留）
- [ ] 应用在 macOS / Windows / Linux 打包产物可双击启动

### 会话
- [ ] 新建会话、发送第一条消息
- [ ] 流式接收 AI 响应（文本 + reasoning 思考块）
- [ ] 切换会话保留上下文
- [ ] 删除会话清空历史

### 工具
- [ ] `read_file` 读取文件正常
- [ ] `list_files` 列出工作区文件
- [ ] `grep` / `glob` 搜索命中
- [ ] `edit` 小编辑应用成功 + FileTime 检测外部修改
- [ ] `write_to_file` 新建大文件 + stale-overwrite 检测（外部手动改后不覆盖）
- [ ] `multiedit` 多点编辑
- [ ] `bash` / `execute_command` 短命令执行
- [ ] `bash` 长时间 dev server 正确 idle-detach
- [ ] Windows 下 `taskkill /T /F` 能 kill 命令树

### 控制流
- [ ] 工具审批弹窗显示、Allow/Deny 按钮生效
- [ ] 任务取消 — `task_aborted` 广播 + 1500ms 事件丢弃
- [ ] 上下文压缩 — `context_compacting` / `context_compacted` 事件触发
- [ ] 撤销 — `POST /sessions/:id/revert` 恢复文件

### UI
- [ ] 消息列表虚拟化滚动顺畅
- [ ] Token 使用条颜色随用量变化（绿 / 橙 / 红）
- [ ] Slash 命令面板（`/`）弹出 + 键盘导航
- [ ] 文件变更树 A/M/D 标记正确

## 码弦IDE (third-party/tianhe-zhikai-ide)

按 `feature/solo-mode-editor-pane` 分支，在 IDE 中执行以下：

- [ ] Solo 模式面板开启
- [ ] Agent 对话正常（消息流 + 思考块）
- [ ] 文件读写工具正常（通过 VSCode fs API）
- [ ] Bash / 命令执行使用 VSCode 终端
- [ ] 工具审批弹窗生效
- [ ] 任务取消生效
- [ ] Skills 加载

## 通用

- [ ] `pnpm -r typecheck` 全包通过
- [ ] 手动打开 `apps/desktop/dist/` 产物无明显视觉变化
- [ ] 无控制台 `Uncaught` / `Error` 报错

---

## 执行建议

- 改动**仅限单个文件**或**单个工具** → 只跑对应分类（约 5 分钟）
- 改动**接口 / 协议 / 事件** → 完整跑全表（约 30 分钟）
- 改动**架构级**（如拆包、迁移） → 完整跑 + 打包验证（约 1 小时）
