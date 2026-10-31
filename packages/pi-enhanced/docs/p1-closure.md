# P1 收尾记录

收尾日期：2026-10-30。依据 `P1_REVIEW_AND_CLOSURE.md` 对源码、测试和工作树重新核查。本轮只处理 P1，没有开始 P2。

## 结论

P1 权限主链路通过收尾复核。Serena 与 Context7 的真实数据查询也已分别通过固定版本 E2E；外部组件可用性不扩大 MCP Policy 的保护范围。

| 项目 | 状态 | 证据 |
|---|---|---|
| P1 源码与持久测试仍在 | `passed` | `src/mcp-policy/`、`tests/unit/`、`tests/integration/`、`tests/e2e/` 均存在 |
| direct/deferred/codemode 阻断 | `passed` | mock stdio MCP 集成测试覆盖三条路径和嵌套父调用 ID |
| Serena 2.1.0 Docker E2E | `passed` | 官方固定镜像完成握手、工具发现、符号查询和引用查询 |
| Context7 4.4.4 成功取文档 | `passed` | 用户级环境变量提供免费 Key，两个查询工具均返回非错误且非空内容 |
| 安全边界补测 | `passed` | 新增缺失 `tool_result` 的定长审计测试，完成规则、依赖和敏感信息检查 |

## C1：Serena

固定 `serena-agent==2.1.0`、Commit `5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc` 和官方镜像摘要保持不变。2026-10-31 已在受控只读 fixture 完成 stdio 握手、`tools/list`、`find_symbol` 和 `find_referencing_symbols`。Windows + Python 3.14 的直接安装限制继续记录，但不再阻塞 Docker 方案。

Serena 项目 `fixed_tools` 不能替代 Pi 的工具暴露和策略控制：2.1.0 的 MCP 首次工具列表仍包含更多 context 工具。接入时继续使用 `hidden + toolExposure` 和精确 MCP Policy。

## C2：Context7

固定 `@upstash/context7-mcp@4.4.4` 保持不变。2026-10-31 使用 Windows 用户级 `CONTEXT7_API_KEY` 运行保留的 E2E：stdio 握手、`tools/list`、`resolve-library-id` 和 `query-docs` 全部成功，两个查询结果均为非错误且非空内容。测试进程只从用户环境读取 Key，没有输出值，也没有把凭据写入仓库、日志或测试报告。

## C3：安全边界

### 策略规则

仓库没有生成真实 `pi-enhanced.json` 或 `mcp.json`。集成 fixture 的实际放行规则均使用精确工具名；README 已去掉 Serena 的 `find_*` 宽泛 allow 示例，改为 `find_symbol` 和 `find_referencing_symbols` 两条精确规则。工具暴露仍不代替策略权限。

### 缺失结果的审计

工具执行后异常中止、没有 `tool_result` 时，调用保留为 pending。pending 数量最多为 `maxRecent`；新调用超过上限时，最早 pending 以 `unknown` 结束。reload 和 `session_shutdown` 调用 `clear()`，清空 pending 与 recent。该策略避免无界增长，但不提供按时间过期，已列入已知限制。

### npm audit

2 条 high 是同一 Zod 公告及 `@anthropic-ai/sandbox-runtime` 上游条目。sandbox runtime 只在 Pi 的示例 sandbox Extension 中导入，P1 不加载或调用它。Zod `3.25.76` 还被 Pi 模型 SDK 共享，因此宿主运行时风险不能写成完全不可达。P1 不使用 Zod，不处理该公告中的无界数组验证；固定 Pi 基线下 npm 无自动修复，本轮没有升级或覆盖依赖。

### 敏感信息与产物

扫描没有发现 API Key、私钥或明文凭据。`packages/pi-enhanced` 中没有外部 MCP 日志、真实会话、私有仓库内容或本地记忆数据。根目录 `HANDOFF.md` 按项目约定保留本机工作路径，仅作为开发交接记录；发布 Package 文档不再写入本机绝对仓库路径。

## P2 准入

P1 权限主链路可以作为 P2 Memory 的前置基线。C1、C2 均已通过；后续不得绕过 P1 权限语义，也不得顺带实现 P3 Context 或 P4 Task Manager。

P1 的保证范围和变更要求已单列在 `p1-security-baseline.md`。路径级权限、完整审计和非 MCP 工具保护作为独立增强任务，不修改当前 P1 策略边界。
