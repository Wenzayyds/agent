# P1 已知限制

## 保护范围

`mcp-policy` 只判断工具名以 `mcp__` 开头、并进入 Pi 工具管线的 MCP 调用。它不是 Pi 的全局权限系统，也不是操作系统沙箱。

以下路径不在 P1 的保证范围内：

- Pi 内置 `bash`、`powershell`、`read`、`write`、`edit` 等非 MCP 工具；
- 用户自行加载、但不通过 Pi 原生 MCP 注册的 Extension 工具；
- MCP Server 进程自身在启动期间执行的代码、读写的路径和网络访问；
- Server 在一次已允许调用内部继续执行的隐藏副作用；
- Pi 之外直接启动的 Serena、Context7 或其他 MCP Client；
- 操作系统级进程、文件、网络和凭据隔离。

因此仍应使用 Pi 的工具筛选、受限账户、容器或系统沙箱控制非 MCP 路径。MCP Server 本身也应锁定版本，并按不可信进程对待。

## 策略限制

- P1 根据 Server 和工具名匹配，不检查参数内容。它不能表达“只允许读取某个目录”或“只允许某个 Git 仓库”。
- MCP annotations 不作为授权依据，因为它们由 Server 自行声明，可能错误或带有误导性。
- `allow` 是对该工具整体放行。对可能同时读写的工具，不应配置 `allow`。
- 未知工具默认 `ask`；无对话界面、用户拒绝、审批取消、配置错误和策略计算错误都拒绝。
- 内存审计有固定容量，重载和退出会清空；P1 没有文件审计、跨会话审计和长期保留。
- 审计只记录工具身份、规则、时间、结果类别和父调用 ID，不保存参数或返回值，因此不能用于还原完整操作内容。
- 结果错误分类只信任机器可读的 `details.code`。只有自然语言错误信息时记为 `unknown`，避免靠字符串猜测。
- 工具已经发送、但没有产生 `tool_result` 时，审计项会暂存在内存中。待处理项数量受 `maxRecent` 限制；达到上限后最早一项以 `unknown` 结束，reload 或 `session_shutdown` 会全部清理。P1 不按时间自动过期。

## 外部组件限制

- Serena `2.1.0` 已通过官方 Docker 镜像完成真实符号与引用查询；Windows + Python 3.14 的直接安装仍受 `pyyaml==6.0.2` 构建条件限制，但不再阻塞 Docker 运行方式。
- Serena `2.1.0` 启动时，项目 `fixed_tools` 已把内部 active tools 收敛为两个查询工具，但 MCP 首次 `tools/list` 仍列出 `codex` context 的更多工具。实际接入不能只依赖 Serena 配置，仍须在 Pi `mcp.json` 中使用 `toolExposure`，并保留 MCP Policy 精确规则。
- Context7 `4.4.4` 已使用免费 API Key 完成协议握手、工具发现和成功文档检索。后续可用性仍受免费计划额度和外部服务状态影响。
- 外部服务断网或离线不会改变 Pi 内置工具，但相应 MCP 工具会不可用。P1 不提供离线文档镜像或 Serena 语言服务器安装器。

## 依赖审计边界

根工作区的 2 条 high 实际指向同一项 Zod 内存耗尽公告及其上游 `@anthropic-ai/sandbox-runtime` 依赖链。`pi-enhanced` 不导入 sandbox runtime；它只由 Pi 仓库的 sandbox 示例扩展使用，普通 P1 MCP Policy 路径不会加载该示例。

Zod `3.25.76` 同时被 Pi 的模型 SDK 依赖复用，因此不能宣称整个 Pi 运行时完全不可触达。P1 自身没有 Zod schema，也不把不受限的外部数组送入 Zod。当前固定基线下 npm 没有可用的无破坏修复，保留为宿主项目风险，不在 P1 中擅自升级 Pi 依赖。

P1 的固定范围和后续变更要求见 [P1 测试与安全基线](p1-security-baseline.md)。路径级权限、完整审计和非 MCP 工具保护均另立增强任务，不在后续阶段顺带修改。

