# P1 测试与安全基线

基线日期：2026-10-31。P1 的 MCP Policy 已收尾，后续阶段默认不得顺带修改 `src/mcp-policy/` 的规则语义、配置合成、审批或审计实现。

## 已固化的保证

- 只拦截进入 Pi 工具管线且名称为 `mcp__<server>__<tool>` 的调用。
- 明确 `deny` 始终优先；工具级规则优先于 Server 级规则；最后使用 `ask` 或 `deny` 默认动作。
- 项目级 `allow` 不能覆盖用户级明确 `deny`；未受信任项目的策略不读取。
- 未知工具、非法 MCP 工具名、无对话界面的审批、用户拒绝、配置错误和策略计算错误均拒绝执行。
- MCP annotations 不参与授权；策略不修改工具参数。
- direct、deferred 和 codemode 嵌套调用经过同一阻断链路，拒绝发生在 Server 收到调用之前。
- 审计不保存参数、返回正文、请求头或凭据；内存记录有固定容量，并在 reload 或 shutdown 时清空。

这些保证由 `tests/unit/` 与 `tests/integration/` 中 5 个文件、22 项持久测试覆盖。外部组件另由 `tests/e2e/mcp-components.test.ts` 按环境变量选择运行。

## 外部组件基线

Serena 使用官方 `2.1.0` 镜像，测试锁定镜像摘要：

```text
ghcr.io/oraios/serena@sha256:eb52535ff1c292add25c2b2d37b2db4e2e20c60cda7d8e25f9d11490ce0e1bdf
```

Serena fixture 以只读 bind mount 挂载，语言服务器缓存使用容器内 tmpfs。测试只调用 `find_symbol` 和 `find_referencing_symbols`，不修改 fixture，也不修改 Pi 源码。

Context7 固定 `@upstash/context7-mcp@4.4.4`。API Key 只允许通过 `CONTEXT7_API_KEY` 环境变量传入，不写入仓库、测试结果或 MCP 配置示例中的明文值。

2026-10-31 已使用免费 Key 完成 `resolve-library-id` 和 `query-docs` 成功检索；保留 E2E 继续要求两项均返回非错误且非空内容。

## 不属于 P1 的增强项

以下内容不应以“补 P1 小问题”的方式加入现有策略，应分别建立增强任务、重新定义威胁模型和验收标准：

- 根据工具参数实施路径级或仓库级权限；
- 落盘、跨会话、可检索的完整审计；
- 对 Pi 内置 shell、文件读写及其他非 MCP 工具的统一保护；
- MCP Server 进程启动阶段、内部网络访问和隐藏副作用的系统级隔离。

## 变更要求

如果以后确实需要修改 MCP Policy，应作为独立任务处理，并同时完成：

1. 说明要改变的安全边界和不变量；
2. 增加或更新对应 unit/integration 回归测试；
3. 复跑 5 个持久测试文件、相关外部 E2E 和根目录 `npm run check`；
4. 同步更新本基线、已知限制和测试报告。

单纯接入 Memory、Context、Task Manager 或新的 MCP Server，不构成修改现有 MCP Policy 的理由。

