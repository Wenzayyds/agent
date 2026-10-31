# P0 接口核对与验证记录

核对日期：2026-10-29。

这份文档记录 `pi-enhanced` 的 P0 基线、Pi 公开接口、模块边界和实际验证结果。P0 只建立四个可独立加载、可独立开关的空扩展，不包含 P1 及后续阶段的策略实现。

## 1. 固定基线

| 项目 | 核对结果 | 依据 |
|---|---|---|
| 上游仓库 | `https://github.com/earendil-works/pi` | Git remote 与开发计划 |
| 固定 commit | `842c73170a3658d4e3b39fcc84690211ed503e09` | 临时验证执行 `git rev-parse HEAD`，要求与该值完全相等 |
| `@earendil-works/pi-coding-agent` | `1.4.0` | `packages/coding-agent/package.json` |
| `@earendil-works/pi-mcp` | `1.4.0` | `packages/mcp/package.json` |
| MCP Client 首选协议 | `2025-11-25` | `packages/mcp/src/protocol/types.ts` 的 `LATEST_PROTOCOL_VERSION` |
| stdio 测试实际协商协议 | `2025-06-18` | 使用仓库自带 stdio fixture 完成初始化握手后读取响应 |

首选协议版本只是客户端发起握手时的候选值。最终协议版本必须使用服务端初始化响应中的 `protocolVersion`，不能把 `LATEST_PROTOCOL_VERSION` 当成协商结果。

## 2. Package 与模块边界

`packages/pi-enhanced/package.json` 通过 `pi.extensions` 暴露四个根目录入口：

| 模块名 | Package 入口 | 内部实现 | P0 状态命令 |
|---|---|---|---|
| `mcp-policy` | `extensions/mcp-policy.ts` | `src/mcp-policy/extension.ts` | `/enhanced-mcp-policy-status` |
| `memory` | `extensions/memory.ts` | `src/memory/extension.ts` | `/enhanced-memory-status` |
| `context` | `extensions/context.ts` | `src/context/extension.ts` | `/enhanced-context-status` |
| `task-manager` | `extensions/task-manager.ts` | `src/task-manager/extension.ts` | `/enhanced-task-manager-status` |

四个入口只复用 `src/shared/` 下的配置读取和生命周期骨架。它们没有注册工具，不覆盖 `/mcp`、`codemode` 或 `tool_search`，也不复制 Pi 的 MCP Client、SessionManager、Compaction 或 Agent Loop。

Package 对 `@earendil-works/pi-coding-agent` 使用 peer dependency，避免安装第二份宿主运行时。开发期版本固定为 `1.4.0`，便于在固定基线上做类型检查。

## 3. Extension 加载与生命周期

### 3.1 工厂与加载

- `packages/coding-agent/src/core/extensions/types.ts`
  - `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`。
  - `ExtensionAPI.on(...)` 注册事件处理器。
  - `registerTool(...)` 注册模型可调用工具。
  - `registerCommand(name, options)` 注册斜杠命令。
- `packages/coding-agent/src/core/extensions/loader.ts`
  - `discoverAndLoadExtensions(...)` 逐个加载入口。
  - 单个工厂初始化失败会写入 `errors`，不会阻止其他入口继续加载。
- `packages/coding-agent/src/core/extensions/runner.ts`
  - `ExtensionRunner.emit(...)` 按扩展和注册顺序派发事件。
  - 处理器异常会作为扩展错误上报，不直接中断其他扩展的事件处理。

### 3.2 会话开始、清理与重载

- `session_start` 的事件类型为 `SessionStartEvent`，扩展在这里读取当前用户级和项目级配置。
- `session_shutdown` 的原因包括 `quit / reload / new / resume / fork`。扩展必须把清理写成可重复执行，不能假定只收到一次。
- `AgentSession.reload()` 先向旧运行时发送 `session_shutdown: reload`，再装载新运行时并发送 `session_start: reload`。
- Pi 会使旧的 Extension runtime 失效；重载后不能继续使用旧的 `pi`、命令上下文或捕获的会话上下文。

P0 的四个模块只保存一份会话级配置状态。关闭会话时把该状态设为 `undefined`，重复清理不会报错；重载后由新的 `session_start` 重新读取配置。

### 3.3 名称冲突

Pi 在装载阶段汇总工具、命令和参数注册。自定义模块使用带 `enhanced-` 前缀的诊断命令，避免占用宿主内置名称。P0 没有注册任何工具，因此不会改变模型可见工具集合。

## 4. 配置合并和安全边界

配置文件名为 `pi-enhanced.json`：

1. 先读取 `getAgentDir()/pi-enhanced.json`。
2. 项目已受信任时，再读取 `<cwd>/.pi/pi-enhanced.json`。
3. 项目配置按模块覆盖用户配置；没有写出的模块保留用户值。
4. 未受信任项目不读取项目配置。
5. 四个模块默认均为关闭状态。
6. JSON 损坏、未知模块或 `enabled` 类型错误会形成可见诊断，不会自动启用模块，也不会阻止 Pi 启动。

配置开关和 Pi Package 的资源筛选是两层不同控制：资源筛选决定入口是否加载，`enabled` 决定已经加载的入口是否执行该模块逻辑。P0 即使关闭模块也保留状态命令，便于确认配置来源和错误。

## 5. MCP 接口与后续策略接入点

### 5.1 Server 配置和传输

- 用户级配置：`~/.pi/agent/mcp.json`。
- 受信任项目配置：`.pi/mcp.json`。
- 本地 Server 使用 stdio；远程 Server 使用 Streamable HTTP。
- 旧式 `type: "sse"` 会被拒绝。Streamable HTTP 内部仍可按 MCP 协议读取 SSE 格式的响应流，这不等同于支持旧 SSE transport。
- Server 名称只能使用字母、数字、下划线和连字符。
- 工具名规范为 `mcp__<server>__<tool>`，非法字符会被规范化，碰撞时由宿主处理后缀。

### 5.2 暴露方式

`packages/coding-agent/src/core/mcp-servers.ts` 定义四种 `McpExposure`：

- `direct`：工具直接进入模型工具列表。
- `codemode`：由 codemode 间接调用。
- `deferred`：由工具搜索按需载入，也可由间接机制访问。
- `hidden`：默认不暴露；可用 `toolExposure` 对单个工具覆盖。

默认 exposure 是 `codemode`。`toolExposure` 的精确工具名优先于通配模式；通配模式按配置顺序取第一个匹配项。

### 5.3 Extension MCP API

`ExtensionAPI` 提供：

```ts
registerMcpServer(name: string, config: McpServerConfig): void;
unregisterMcpServer(name: string): void;
getMcpServers(): RegisteredMcpServer[];
```

扩展注册只对当前会话有效，重载后需要重新注册。`mcp.json` 中的同名配置优先于扩展注册。P0 的 `mcp-policy` 不连接 Server，也不重复实现这些 API；P1 应围绕宿主已有 API 和事件管线增加策略。

### 5.4 工具调用事件

- `tool_call` 在工具执行前触发，可阻止调用，也可原地修改输入；修改后不会再次做 schema 校验。
- `tool_result` 在工具执行后触发，可处理内容、结构化结果和错误状态。
- MCP 工具也经过同一套工具事件管线，因此后续权限和审计策略不需要另建一套 MCP 调用通道。
- codemode 等工具发起的嵌套调用会设置 `parentToolCallId`。嵌套调用仍会触发 `tool_call / tool_result`，策略实现必须同时覆盖直接调用和嵌套调用。

## 6. 上下文、压缩和会话记录接口

### 6.1 上下文事件

- `context`：每次调用模型前触发，收到不含 system message 的会话消息。Pi 在处理器返回后恢复自己的系统提示和工具状态，适合后续的记忆召回和普通上下文裁剪。
- `context_with_system`：在所有 `context` 处理器完成后触发，收到包括 system message、提示和工具声明在内的完整 transcript；返回值将原样发送。它权限更大，P0 不注册，后续阶段也应只在确有必要时使用。

### 6.2 压缩事件

- `session_before_compact`：压缩前触发，可提供自定义压缩结果或取消默认处理。
- `session_compact`：压缩成功后触发，包含 `compactionEntry`、触发原因和是否重试。
- `session_compact_failed`：失败或取消后触发，包含错误、取消状态和重试信息。

P0 不接管压缩流程。长期记忆若要吸收压缩摘要，应优先监听压缩结果，而不是复制 Pi 的 compaction 实现。

### 6.3 Agent 收尾

- `agent_before_settle` 在一次运行最终稳定前触发，可追加记录并要求再进行一次 provider 请求。
- `agent_settled` 只在自动重试、压缩恢复和排队续写都不会继续后触发，包含 `aborted` 状态。

任务管理后续若要判断一次工作是否真正结束，应使用 `agent_settled`，不能把单次 `agent_end` 当成整个任务结束。

### 6.4 SessionManager

- `SessionManager.getEntries()` 返回会话条目的副本。
- `appendCustomEntry(customType, data)` 写入不会直接投影成模型消息的自定义记录。
- `buildSessionProjection(...)` 和上下文构建逻辑负责从分支记录生成当前会话投影。

长期记忆和任务状态可以使用自定义 entry 保存可恢复状态，但不应绕开 SessionManager 直接改写 JSONL。

## 7. 逐项验证结果

临时测试按照 `unit / integration` 分层执行。全部通过后，根据项目要求删除了测试源码和 `vitest.config.ts`；下面保留实际结果，便于后续人工复查。

| 序号 | 验证内容 | 实际结果 |
|---|---|---|
| 1 | 四模块默认关闭、配置合并、项目信任、四模块分别单独启用、错误配置降级 | 7 项通过 |
| 2 | `git rev-parse HEAD` 与固定 commit 完全一致；MCP 包版本；真实 stdio 初始化握手 | 2 项通过 |
| 3 | 四个根入口由真实 Extension Loader 加载；无工具和内置命令冲突；单个扩展初始化失败隔离 | 2 项通过 |
| 4 | 四个模块分别在真实 `AgentSession` 中独立启用；全部关闭时会话可绑定并执行诊断命令；重复 `session_shutdown`；`reload()` 后重新读取配置 | 5 项通过 |
| 合计 | 临时 P0 测试 | 16 项通过 |

验证后还需执行根目录 `npm run check`。该命令覆盖格式、依赖固定规则、运行时依赖规则、TypeScript、入口图和浏览器 smoke check；最终结果记录在本次开发的 `HANDOFF.md`。

## 8. P0 结论与后续边界

P0 已建立四个名称和入口稳定、默认关闭、互不依赖、故障可隔离的 Extension 骨架。当前命令只用于显示配置状态，不代表相应业务功能已经实现。

- P1 才实现 MCP 权限、审计、错误分类和超时策略。
- P2 才实现长期记忆。
- P3 才实现上下文管理。
- P4 才实现任务管理。

没有在 P0 提前引入这些阶段的业务逻辑。
