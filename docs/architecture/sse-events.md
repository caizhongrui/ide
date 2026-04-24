# SSE 事件规格

`GET /sessions/:id/events` 返回的 `text/event-stream`。

## 1. 帧格式

```
event: <type>
id: <monotonic-number>
data: <JSON payload>

```

## 2. 心跳

每 15 秒发一次：
```
event: heartbeat
data: { "t": <timestamp> }

```

## 3. 断线重连

客户端用 `Last-Event-ID` header 从指定事件 id 之后续传。Server 维护最近 500 条事件的环形缓冲区。

## 4. 事件清单（19 种）

### 4.1 AI 响应

| 事件 | 描述 | 核心字段 |
|---|---|---|
| `assistant_message` | AI 文本流 | `content, isPartial` |
| `reasoning_delta` | 思考块增量 | `content` |
| `convert_reasoning_to_assistant` | 思考块转正式消息 | `toolUseId` |
| `followup_suggestions` | AI 追问建议 | `suggestions[]` |

### 4.2 工具

| 事件 | 描述 | 核心字段 |
|---|---|---|
| `tool_call_start` | 工具开始执行 | `toolUseId, toolName` |
| `tool_input_delta` | 参数流式构建 | `toolUseId, partialArgs` |
| `tool_call_result` | 工具结果 | `toolUseId, success, result, errorMessage?` |
| `tool_approval_request` | 需用户审批 | `toolUseId, toolName, params` |
| `todos_updated` | TODO 列表更新 | `todos[]` |

### 4.3 任务状态

| 事件 | 描述 | 核心字段 |
|---|---|---|
| `task_status` | 任务状态变化 | `status: pending/processing/completed/error/aborted` |
| `task_aborted` | 明确的取消信号 | `reason` |
| `completion` | 任务完成 | `resultSummary?` |
| `error` | 错误 | `message, code?` |

### 4.4 上下文

| 事件 | 描述 | 核心字段 |
|---|---|---|
| `token_usage` | Token 用量 | `inputTokens, outputTokens, contextTokens, limit` |
| `context_compacting` | 压缩开始 | `beforeTokens` |
| `context_compacted` | 压缩完成 | `beforeTokens, afterTokens, tokensFreed` |

### 4.5 文件 / 限流

| 事件 | 描述 | 核心字段 |
|---|---|---|
| `file_changed` | 文件变更 | `path, action: created/modified/deleted, linesAdded?, linesRemoved?` |
| `rate_limit` | 触发限流 | `retryAfterMs` |
| `rate_limit_cleared` | 限流解除 | — |

## 5. 客户端处理约定

- **静默丢弃**未知事件类型（前向兼容）
- `task_aborted` 后 1500ms 内收到的工具事件应**忽略**（清理缓冲）
- `error` + `task_status: error` 通常成对出现，UI 只需展示一次

## 6. 对应 Core 端类型

`packages/core/src/interfaces/IMessageBus.ts` 中的 `MaxianEvent` discriminated union。**当前缺失的 8 种事件（需 N 期补齐）**：

- [ ] `tool_approval_request`
- [ ] `tool_input_delta`
- [ ] `context_compacting`
- [ ] `context_compacted`
- [ ] `convert_reasoning_to_assistant`
- [ ] `followup_suggestions`
- [ ] `rate_limit`
- [ ] `rate_limit_cleared`
