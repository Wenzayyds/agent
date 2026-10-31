# P1 接口核对记录

核对基线为 Pi Commit `842c73170a3658d4e3b39fcc84690211ed503e09`，Package 版本为 `1.4.0`。P1 只使用现有 Extension 和 MCP 接口，没有修改 Agent Loop、MCP 实现或 Session 实现。

## 事件与阻断语义

| 事项 | 源码证据 | P1 用法 |
|---|---|---|
| 前置事件 | `packages/coding-agent/src/core/extensions/types.ts:1199-1271` | `tool_call` 提供工具名、调用 ID、参数和可选父调用 ID。策略只读参数，不原地修改。 |
| 阻断结果 | `packages/coding-agent/src/core/extensions/types.ts:1460-1468` | 返回 `{ block: true, reason }`，Pi 不执行工具。 |
| handler 顺序 | `packages/coding-agent/src/core/extensions/runner.ts:1249-1266` | 按 Extension 和注册顺序执行，遇到第一个 `block` 立即停止。handler 抛错会向上传播。 |
| 执行前错误 | `packages/coding-agent/src/core/agent-session.ts:657-680` | `tool_call` handler 抛错会阻止进入工具执行。P1 自身将配置、策略计算和审批错误转为明确拒绝。 |
| 结果事件 | `packages/coding-agent/src/core/agent-session.ts:683-702` | `tool_result` 用于结束内存审计。 |
| 结果 handler 错误 | `packages/coding-agent/src/core/extensions/runner.ts:1190-1237` | 结果 handler 错误会被 Pi 报告，但不会改写原工具结果。P1 的结果处理只做内存状态更新。 |
| 无界面判断 | `packages/coding-agent/src/core/extensions/types.ts:337` | `ctx.hasUI=false` 时不发起审批，`ask` 直接拒绝。 |
| 审批接口 | `packages/coding-agent/src/core/extensions/types.ts:155` | 使用 `ctx.ui.confirm()`，并传入超时和取消信号。 |

`event.input` 虽然可变，但 Pi 在 handler 修改后不会重新进行 schema 校验，证据见 `packages/coding-agent/src/core/extensions/types.ts:1256-1261`。因此 P1 明确不做参数重写。

## 三条 MCP 调用路径

Pi 原生 MCP 将 Server 工具注册为普通 Pi 工具，见 `packages/coding-agent/src/extensions/mcp/index.ts:387-445`。直接调用因此进入同一套 `beforeToolCall/afterToolCall` 管线。

- `direct`：模型直接调用 `mcp__<server>__<tool>`，进入 `tool_call`。
- `deferred`：`tool_search` 只负责发现并激活工具；之后的 MCP 调用仍进入 `tool_call`。
- `codemode`：内部通过 `ctx.executeTool()` 发起嵌套调用。`packages/coding-agent/src/core/agent-session.ts:725-763` 证明嵌套调用仍经过前后置 hook，并带 `parentToolCallId`。

测试 fixture 对三条路径都使用真实 stdio MCP 握手。被拒绝的写操作不会到达 Server，目标文件也不会创建。

## MCP 名称、annotations 与超时

策略优先使用 Pi 工具定义中的 MCP namespace 和原始工具名；缺少元数据时才解析规范名。Server 返回的 annotations 只显示在审批提示中，不参与授权。测试中的 `write_file` 故意谎报 `readOnlyHint: true`，仍被策略拒绝。

MCP 请求超时继续使用 Pi 原生 `mcp.json` 的 `timeout`，单位是秒，见 `packages/coding-agent/src/core/mcp-servers.ts:76-77`。P1 没有再包一层工具执行计时器；`approvalTimeoutMs` 只限制用户审批等待。

## 重载与状态

`session_start` 重新读取用户级和受信任项目级策略；`session_shutdown` 清空审计并丢弃运行态。`/reload` 后不会沿用旧审批或旧审计。`/enhanced-mcp-policy-status` 只显示开关、配置来源、规则数量、审计数量和最近配置错误，不显示参数、返回值或凭据。

