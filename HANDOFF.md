# 工作记录

## 2026-10-29：P0 基线与扩展骨架

- 开发计划来源：`F:\Chrome Download\PI_AGENT_DEVELOPMENT_PLAN.md`。
- 新仓库位置：`F:\项目代码\pi-agent`。
- 已从 `earendil-works/pi` 重新克隆，并以 `842c73170a3658d4e3b39fcc84690211ed503e09` 为起始基线。
- 已核对 `@earendil-works/pi-mcp` 和 `@earendil-works/pi-coding-agent` 版本均为 `1.4.0`。
- 新增独立 Package：`packages/pi-enhanced`。
- Package 有 MCP、Memory、Context、Tasks 四个 Extension 入口。模块默认关闭，项目配置只在项目受信任后读取。
- 没有覆盖 Pi 内置 `/mcp`、`codemode` 或 `tool_search`。
- P0 测试包含固定基线检查、MCP 初始化实际协商版本、配置作用域和四入口加载检查。
- 已运行仓库要求的模型数据初始化；生成内容位于 Git 忽略的 `packages/ai/src/providers/data/`，只用于源码模式加载与测试。
- P0 定向测试：`packages/pi-enhanced` 共 10 项，通过 10 项。
- 包级类型检查：`npm run check --workspace=@wz-agent/pi-enhanced` 通过。
- 全仓检查：`npm run check` 通过，包含 Biome、依赖规则、导入规则、入口依赖图、安装锁、TypeScript 和浏览器冒烟检查。
- 安装时 npm 报告现有依赖树有 6 个审计项（2 个 moderate、4 个 high），P0 未执行可能改动锁定版本的自动修复。
- 当前只做 P0；P1 尚未开始。

## 2026-10-29：依赖审计与 npm 配置

- 已执行两轮不带 `--force` 的 `npm audit fix`。
- `packages/durable` 的 `@cloudflare/vitest-plugin` 从 `1.4.4` 升级到 `1.4.10`；连带升级 Wrangler、Miniflare、workerd、Undici 和插件内的 Zod。
- 审计项从 6 项降到 2 项。剩余两项属于同一依赖链：`@anthropic-ai/sandbox-runtime@0.0.26 -> zod@3.25.76`。npm 标记为 high，且 `fixAvailable: false`；sandbox-runtime 最新 `0.0.81` 仍依赖 Zod 3，因此暂时不能靠升级消除。
- `npm ls --all` 已无缺失、无效、对等冲突或多余依赖。
- 全局 npm 已从 `11.9.0` 升级到 `11.21.1`。项目 `.npmrc` 的 `min-release-age=2` 从 npm `11.10.0` 起受支持，升级后不再出现未知配置警告。
- P0 定向测试 10/10 通过；根目录 `npm run check` 通过。
- Cloudflare Worker 定向测试受 Windows 中文仓库路径问题阻塞，报错为 `No such module "cloudflare:test-internal"`。Cloudflare 上游已记录同类问题；测试未进入用例，不能据此判定业务代码失败。

## 2026-10-29：按 V2 修正 P0 偏差

- 对照文档：`F:\Chrome Download\PI_AGENT_DEVELOPMENT_PLAN_V2.md`。
- 四个模块的正式名称已统一为 `mcp-policy`、`memory`、`context`、`task-manager`。
- Package 入口已移到 `packages/pi-enhanced/extensions/`，分别为 `mcp-policy.ts`、`memory.ts`、`context.ts`、`task-manager.ts`；内部实现按对应模块放在 `src/` 下。
- 状态命令已统一为 `/enhanced-mcp-policy-status`、`/enhanced-memory-status`、`/enhanced-context-status`、`/enhanced-task-manager-status`。
- 新增 `packages/pi-enhanced/docs/verification.md`，记录固定基线、真实 Extension/MCP/上下文/压缩/SessionManager 接口、模块边界和验证结果。
- 新增 `packages/pi-enhanced/docs/dependency-compatibility.md`，记录依赖升级、剩余审计项、Worker 中文路径限制，以及 npm 11.21.1 中 `min-release-age=2` 代表 2 天。
- 临时测试按 unit/integration 分层，逐项验证：配置 7 项、固定基线与 MCP 握手 2 项、加载与故障隔离 2 项、真实 AgentSession 生命周期 5 项，共 16/16 通过。
- 生命周期验证覆盖四模块分别独立启用、全部关闭时 Pi 会话正常绑定、重复 `session_shutdown`、`reload()` 后重新读取配置。
- 加载验证覆盖单个 Extension 初始化失败时，其余四个入口仍正常加载。
- 按要求已删除 `packages/pi-enhanced` 的临时测试源码、旧 `test/` 目录内容和 `vitest.config.ts`，并移除该 Package 只用于临时测试的 `test` script、Vitest 和 MCP dev dependency；没有删除 Pi 上游自带测试。
- 删除临时测试并更新 lockfile 后，再次执行根目录 `npm run check`，全部通过。
- 当前仍未开始 P1。没有创建 Git commit；提交需要用户明确授权。

## 2026-10-29：P1 MCP Policy 与外部 MCP 兼容验证

- 开发依据：`F:\Chrome Download\PI_AGENT_DEVELOPMENT_PLAN_V2_1.md` 和 `F:\Chrome Download\P1_CODEX_IMPLEMENTATION.md`；只实施 P1，没有进入 Memory、Context 或 Task Manager。
- 在 `packages/pi-enhanced/src/mcp-policy/` 实现纯策略判断、严格分层配置、MCP 工具身份解析、对话审批、定长脱敏内存审计和结果错误分类。
- 明确 deny 永远优先；工具级规则优先于 Server 级规则；未知工具默认 ask；没有对话界面、用户拒绝、审批失败、配置错误和策略计算错误都拒绝执行。
- 用户级明确 deny 不能被项目 allow 覆盖；项目策略只在项目受信任时读取。MCP annotations 只显示风险，不参与授权；策略不修改 `event.input`。
- `tool_call` 在 Server 执行前拦截，`tool_result` 只关联审计结果；审计不保存参数、返回内容、请求头或凭据。`session_shutdown`/reload 清空运行态。
- 恢复并保留 `vitest.config.ts`、P0 回归和 P1 测试。mock stdio Server 覆盖 direct、tool_search deferred、codemode 嵌套、动态工具新增、无 UI、用户拒绝、错误配置和重复 shutdown。
- 本地持久测试最终为 5 个文件、21 项，全部通过；Context7 外部测试 1 项通过；`npm run check` 通过。
- Context7 锁定 `@upstash/context7-mcp@4.4.4`，已完成真实握手和工具发现，工具为 `resolve-library-id`、`query-docs`。匿名查询返回月额度耗尽；有用户 API Key 后仍需验证成功文档内容。
- Serena 锁定 `serena-agent==2.1.0` / Commit `5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc`。当前 Windows + Python 3.14 安装时，固定依赖 `pyyaml==6.0.2` 因无 wheel 且缺少 C++ Build Tools 失败，尚未完成 MCP 握手。建议使用独立 Python 3.13 环境重试，不升级锁定版本。
- 没有修改真实用户 `mcp.json`。示例、接口证据、测试报告和限制说明位于 `packages/pi-enhanced/docs/p1-*.md`。
- npm 审计仍有现有依赖链 `@anthropic-ai/sandbox-runtime@0.0.26 -> zod@3.25.76` 的 2 个 high，npm 标记无可用修复。
- P2 边界：下一阶段只做长期记忆 Provider 与项目隔离，不把 Serena 的 memory 工具混入 P2，也不修改 Pi Agent Loop。开始前应先决定是否安装 Python 3.13 并补完 Serena 实机验证。
- 未创建 Git commit；仓库规则要求用户明确授权后才能提交。

## 2026-10-30：P1 验收收尾

- 收尾依据：`F:\Chrome Download\P1_REVIEW_AND_CLOSURE.md`。本轮只处理 P1，没有开始 P2。
- 重新确认 P1 源码、四份报告、unit/integration/e2e 测试和 fixture 均仍在工作树中。
- Serena `2.1.0` 状态记为 `blocked_by_environment`：`py -0p` 仍只有 Python 3.14，没有擅自安装 Python 3.13 或 C++ Build Tools。
- Context7 `4.4.4` 状态记为 `blocked_by_quota`：环境中没有 `CONTEXT7_API_KEY`，重新执行匿名查询仍返回月额度耗尽。保留 E2E 已补充有 Key 时同时验证 `resolve-library-id` 和 `query-docs`。
- 新增审计回归：工具调用异常中止且缺失 `tool_result` 时，pending 数量受 `maxRecent` 限制；超限后最早项以 `unknown` 结束；reload/shutdown 清空全部内存审计。
- README 中 Serena 的 `find_*` 宽泛 allow 示例已改为 `find_symbol`、`find_referencing_symbols` 精确规则。仓库没有生成真实 `mcp.json` 或 `pi-enhanced.json`。
- 重新执行凭据和产物扫描：未发现 API Key、私钥、外部 MCP 日志、真实会话或本地记忆数据。Package 文档中的本机绝对仓库路径已去除；HANDOFF 按项目要求继续保留本机交接路径。
- npm 两条 high 是同一 Zod 内存耗尽公告及 `@anthropic-ai/sandbox-runtime` 上游条目。P1 不导入 sandbox runtime 或 Zod；sandbox runtime 只由 Pi 示例扩展使用。Zod 仍被 Pi 模型 SDK 共享，因此保留为宿主风险，不称为完全不可达，也没有更改固定基线依赖。
- P1 持久化测试最终为 5 个文件、22 项全部通过；Context7 外部测试 1 项通过并确认配额阻断；根目录 `npm run check` 通过。
- 新增 `packages/pi-enhanced/docs/p1-closure.md`，集中记录 C1/C2/C3 状态与 P2 准入边界。
- 仍未创建 Git commit；需要用户明确授权。

## 2026-10-31：Serena Docker 补验与 P1 基线固化

- 启动 Docker Desktop，拉取官方 `ghcr.io/oraios/serena:2.1.0`；OCI label 确认为版本 `2.1.0`、revision `5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc`，镜像摘要为 `sha256:eb52535ff1c292add25c2b2d37b2db4e2e20c60cda7d8e25f9d11490ce0e1bdf`。
- 新增受控 Python fixture 与 Docker-gated E2E。项目源码只读挂载，Serena cache 使用 tmpfs；完成 stdio 握手、工具发现、`find_symbol(SymbolTarget)` 和 `find_referencing_symbols`，测试 1/1 通过。
- 发现 Serena 2.1.0 的项目 `fixed_tools` 虽将内部 active tools 收敛为两个查询工具，但 MCP 首次 `tools/list` 仍列出更多 context 工具。实际接入必须继续依赖 Pi `toolExposure` 和精确 MCP Policy。
- 新增 `packages/pi-enhanced/docs/p1-security-baseline.md`。本轮没有修改 `src/mcp-policy/`；路径级权限、完整审计和非 MCP 工具保护明确另立增强任务。
- Context7 Key 由用户写入 Windows 用户级 `CONTEXT7_API_KEY`；Key 不得写入仓库或日志。
- 本轮最终复跑：P1 unit/integration 5 个文件、22 项通过；锁定镜像摘要后的 Serena E2E 1 项通过；根目录 `npm run check` 通过且 Biome 无修正项。
- Context7 固定 `@upstash/context7-mcp@4.4.4` 的 E2E 已从用户环境读取免费 Key，成功完成 `resolve-library-id` 和 `query-docs`；1 项通过，Serena 分支跳过。测试和命令输出均未显示 Key。

## 2026-10-31：P2-0 Memory 技术核对

- 依据 `F:\Chrome Download\P2_MEMORY_CODEX_PLAN.md` 只完成技术核对，没有修改 Memory、P1 或 Pi Core 业务代码，也没有进入 P3/P4。
- 固定 Commit 再次确认是 `842c73170a3658d4e3b39fcc84690211ed503e09`。
- 确认 `ExtensionContext.sessionManager` 是 `ReadonlySessionManager`：`getEntries()` 返回所有分支条目，`getBranch()` 返回当前活动分支，`buildSessionProjection()` 返回压缩和 context edit 后的模型可见投影。
- 确认 new/resume/fork/reload 会销毁旧 Extension runtime；MemoryService 必须按 session_start 创建、按 session_shutdown 关闭，不能复用旧 context。
- 确认 AGENTS/CLAUDE context 文件不受项目 trust 控制并进入系统提示；项目 Memory 必须单独要求 trust，且不得复制或改写 AGENTS。
- 官方 Node 22.19.0 Docker 实测内置 SQLite 3.50.4 启用 FTS5。选定 `node:sqlite`，不新增第三方 SQLite 依赖；中文完整词可命中，单字子串不能命中，后续采用 FTS5 加受限字面量回退。
- 确定 per-project 物理数据库目录、projectId、MemoryRecord/verification、Core Memory、Session Recall 和跨会话只读索引边界。
- 新增 `docs/p2-interface-check.md`、`docs/p2-memory-design.md`、`docs/p2-development-tasks-and-acceptance.md`。
- 技术核对测试：SessionManager tree/projection 2 个文件、49 项通过；P0/P1 unit/integration 5 个文件、22 项通过。测试临时目录已删除。

## 2026-10-31：远程仓库切换准备

- 用户明确要求将当前仓库远程切换为私有仓库 `https://github.com/Wenzayyds/agent.git`，提交当前工作树并强制推送到远程默认分支。
- 推送前检查确认 Git 使用 Git Credential Manager；本机没有安装 GitHub CLI。
- 已排除 Git 忽略的 `packages/pi-enhanced/node_modules/` 和 Serena cache；凭据扫描未发现 GitHub Token、Context7 Key或私钥文件内容。
