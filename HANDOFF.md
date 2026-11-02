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

## 2026-10-31：远程仓库切换与推送

- 用户明确要求将当前仓库远程切换为私有仓库 `https://github.com/Wenzayyds/agent.git`，提交当前工作树并强制推送到远程默认分支。
- 推送前检查确认 Git 使用 Git Credential Manager；本机没有安装 GitHub CLI。
- 已排除 Git 忽略的 `packages/pi-enhanced/node_modules/` 和 Serena cache；凭据扫描未发现 GitHub Token、Context7 Key 或私钥文件内容。
- 已通过 Git Credential Manager 登录，将本地分支 `pi-agent` 强制推送到远程默认分支；远程提交为 `8b575946297edf50175e1b0b62750e6729d52f80`。

## 2026-10-31：P2-0.5 Memory 设计修订

- 依据 `F:\Chrome Download\P2_0_REVIEW_AND_NEXT_STEPS.md` 只修订 P2 设计与验收清单，没有开始 P2-1 业务代码。
- MemoryRecord 改为多来源、独立验证记录和 revision；来源不能充当验证证据，验证证据只对具体 revision 有效。
- 首版 verified 只允许用户明确确认和 MemoryService 实际文件核验；外部输入的 test/git/file verification 不能直接升级状态。
- 明确 saveCandidate、内容更新、人工确认、文件核验、审核和删除接口；修改和删除通过 expectedRevision 防止并发覆盖。
- 首个正式 SQLite schema 直接使用 `memory_sources`、`memory_verifications` 和 revision，空库按 `0 → 1` 事务迁移，不兼容尚未发布的文档草案表。
- 为 P3 预留按当前 ProjectScope 和 runtime 绑定的 ScopedMemoryReader；本阶段不注册 Context 事件、不自动注入模型请求。
- 补充工作区级隔离、Core 文件 Git 可见性、Session Recall 低信任处理和同步 SQLite 资源上限的验收项。

## 2026-10-31：P2-1～P2-3 Memory 基础实现

- 依据 `F:\Chrome Download\P2_0_5_REVIEW_FINAL.md` 完成 R5～R8 最后一轮设计收口，并连续实现 P2-1、P2-2、P2-3；没有进入 Core Memory、Session Recall、P3 Context 或 P4 Task Manager。
- P2-1 新增工作区 scope、projectId、数据路径和独立 runtime。disabled/untrusted 在 realpath 与存储打开前返回；单元测试 6 项和真实 Extension 生命周期测试 3 项通过。
- P2-2 使用内置 `node:sqlite` 建立核心 schema、来源/验证关系、双版本、乐观锁、独立 FTS5 初始化和 degraded 字面量搜索。Provider 集成测试 7 项通过，覆盖重开、忙锁和损坏库。
- P2-3 新增 MemoryService：candidate 保存、默认 verified 搜索、内容修改、人工确认、精确文件核验、状态审核、删除、秘密检测和 scope 绑定。服务单元测试 5 项通过。
- `revision` 只负责并发控制；`contentRevision` 只随规范化内容变化。验证记录绑定 contentRevision，状态变化不会错误作废同一内容证据。
- 人工确认仅由 `/enhanced-memory-confirm <id> <revision>` 调用 Pi 交互 UI；无 UI、取消或 UI 异常都不生成验证。模型侧没有 Memory 写工具。
- 核心 migration 与可选 FTS 事务分离；只有明确 FTS5 不可用才 degraded，其他初始化错误报告为 storage error。
- 最终 P0/P1/P2 unit 与 integration 总回归为 9 个文件、43 项通过；根目录 `npm run check` 通过。Biome 已格式化本轮文件，最终格式化后回归仍为 43/43 通过。
- 同步 SQLite 明确限制为：最大返回 50 条、字面量降级扫描当前项目最近 500 条、数据库连接最大 256 MiB、busy timeout 1.5 秒。
- `npm pack --dry-run --workspace=@wz-agent/pi-enhanced` 通过，40 个打包文件均为源码、入口和文档，没有 SQLite、WAL、SHM、Session、测试夹具或凭据。
- P1 外部 E2E 首次因门禁未开启跳过；显式设置两个既有测试门禁后，免费 Context7 文档检索和锁定摘要 Serena Docker 符号查询共 2/2 通过，输出未显示 API Key。

## 2026-11-01：混合语言边界与 P2-4 Core Memory

- 依据 `F:\Chrome Download\PI_ENHANCED_HYBRID_TS_PYTHON_DEVELOPMENT_PLAN.md` 确定后续边界：Pi 生命周期、权限、可信状态、SQLite 主库、Core、Session、Context 接线和任务状态继续由 TypeScript 持有；Python 以后仅用于可丢弃的检索、评分和离线评测派生能力。
- 本轮只实现 P2-4，没有重写 P2-1～P2-3，没有创建 Python Worker，也没有进入 P2-5/P2-6、P3 或 P4。
- 新增 `CoreMemoryStore`，固定映射 `.pi-enhanced/memory/project.md`、`architecture.md`、`decisions.md`，提供显式 get/create/update/delete。
- MemoryService 仅增加 Core 委托接口；P2-4 不注册新命令或模型工具。首次写入的 Git 可见性提醒由写结果返回，留给 P2-6 命令层展示。
- Core 写入使用同目录临时文件；create 通过硬链接避免并发覆盖，update 原子替换。限制 64 KiB UTF-8，拒绝凭据、非法路径、junction/symlink 和非普通文件。
- AGENTS 内容、hash 和 mtime 不变；不修改 `.gitignore`；Core 不自动注入 Context。
- 修改前 P0/P1/P2 unit/integration 基线为 9 个文件、43 项通过。P2-4 定向测试为 CoreMemoryStore 5/5、生命周期 3/3 通过；最终全量回归为 11 个文件、51/51 通过。
- 根目录 `npm run check` 通过；Biome 格式化 2 个新增文件后回归仍为 51/51。`npm pack --dry-run --workspace=@wz-agent/pi-enhanced` 通过，共 43 个源码、入口和文档文件，不含数据库、Core、Session、测试 fixture 或凭据。
- 显式重跑 P1 外部 E2E 时，Context7 免费文档检索通过；Serena 用例因本机 Docker Desktop Linux daemon 未运行而连接关闭，当前结果为 1 项通过、1 项环境失败，不记作 Serena 通过，也没有为此修改 P1 Policy 或 Pi 代码。

## 2026-11-01：P2-5 Session Recall

- 依据 `F:\Chrome Download\P2_5_CODEX_SESSION_RECALL_IMPLEMENTATION.md`，本轮只实现 P2-5；没有修改 Pi Core、P1 Policy 或 P2-1～P2-4，也没有进入 P2-6、Python Worker、P3 Context 或 P4 Task Manager。
- Recall 只使用固定 Pi Commit 已有的公开只读 SessionManager 接口：raw 模式读取当前活动分支 `getBranch()`，model-visible 模式读取 `buildSessionProjection().entries`，复用 Pi 对 compaction 和 context_edit 的投影结果并保留真实 `sourceEntry`。
- 每次查询重新读取 sessionId、leaf 和分支，不缓存活动分支；runtime 替换或关闭后旧 adapter 立即失效。Session cwd 的 realpath 必须与当前 ProjectScope 根目录一致，避免跨项目误标。
- 仅提取 user、assistant、toolResult 和可读 custom/summary/bash 文本；忽略图片、工具调用、thinking、system 和状态条目。返回前统一做路径、常见 Token/Key、Bearer、私钥和敏感环境变量脱敏。
- 查询采用 NFKC、大小写不敏感的字面量匹配，并限制 query、扫描条目、文本贡献、单份源文本、命中数、单条内容及返回总字节；达到限制时返回明确标记。Session 内容只作为数据，不执行、不写提示、不落 SQLite。
- 新增 7 项单元测试和 4 项集成测试，覆盖分支切换、压缩、上下文编辑、来源、非文本过滤、脱敏、各项预算、跨项目、关闭、disabled/untrusted、持久化只读和 runtime 替换。持久 Session 查询前后 JSONL 的 SHA-256、size、mtime 完全不变。
- 修改前基线为 11 个文件、51/51 通过；P2-5 定向测试为 11/11；最终 P0～P2-5 回归为 13 个文件、62/62 通过。根目录 `npm run check` 通过，Biome 最终格式化 1 个 P2-5 文件后回归仍为 62/62。
- `npm pack --dry-run --workspace=@wz-agent/pi-enhanced` 通过，共 45 个文件，不含测试、Session、SQLite/WAL/SHM、Core 数据、凭据或日志。
- P1 外部 E2E 未纳入 P2-5 验收。本轮只读核对时 Docker Desktop Linux daemon 仍不可连接，Serena 保持 `blocked_by_environment`；没有重复消耗 Context7 免费额度，也没有修改 P1 代码。
- 下一阶段是 P2-6，但本轮按要求已停止开发。

## 2026-11-01：P2-4 Serena 外部 E2E 独立补测

- 只补测 P2-4 报告中因 Docker Engine 未运行而失败的 Serena 外部 E2E；没有修改或重构 P1 实现、MCP Policy、测试代码和核心测试。
- 在受限环境外启动 Docker Desktop Linux Engine，确认 Server 版本为 29.1.3。
- 首次补跑在 MCP 初始化阶段 30 秒超时。核对发现锁定镜像尚未下载；没有调整测试超时，而是先独立拉取原测试指定的官方摘要。
- 镜像核对为 Serena `2.1.0`、digest `sha256:eb52535ff1c292add25c2b2d37b2db4e2e20c60cda7d8e25f9d11490ce0e1bdf`、revision `5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc`。
- 只设置 `PI_ENHANCED_RUN_SERENA_DOCKER=1` 原样重跑 `tests/e2e/mcp-components.test.ts`：Serena 1 项通过，Context7 1 项按门禁跳过，耗时 12.72 秒；真实符号查询和引用查询均成功。
- `p2-4-verification.md` 已保留首次环境失败，并新增独立补测记录将该环境项关闭。

## 2026-11-01：P2-6 Memory 交互与 Scoped Reader

- 依据 `F:\Chrome Download\P2_6_CODEX_MEMORY_INTEGRATION.md` 只实现 P2-6；没有重写 MemoryService、SessionRecallAdapter、CoreMemoryStore、SQLite Provider/schema，没有修改 Pi Core 或 P1，也没有进入 P2-7、Python Worker、P3 Context 或 P4 Task Manager。
- 修正 P2-5 文档细节：`SessionManager.getBranch()` 公开返回 root → leaf；既有分支测试已增加明确顺序断言。
- Memory Extension 初始只注册 status；首次 enabled+trusted+ready 后动态注册 search、recall、save、confirm、review、core 六个用户命令和唯一模型工具 `enhanced_memory_search`。
- 用户写操作全部复用现有 Service/Core/Recall。save 只能产生 candidate；confirm 保留真实 UI 确认；review 要求 expectedRevision、说明和二次确认；Core 只接受三个固定名称并显示首次 Git 可见性提醒。
- 模型工具只搜索当前 scope 的 verified Episodic Memory，参数只有 query/limit/kind，不接受 projectId/status/verification/SQL/路径；最多 10 条、24,000 字符，结果标记为低信任数据并脱敏。没有模型写工具或 Session Recall 工具。
- 新增 `ScopedMemoryReaderAdapter`，search/get 只返回 verified，getCore 复用 Core Store 并再次脱敏；不暴露 Service、Provider、SQLite 或写能力。runtime 关闭后旧 Reader 稳定返回 `MEMORY_RUNTIME_CLOSED`。
- 跨 Extension 使用 Pi 原生 EventBus 请求/响应 channel，按 requestId、sessionId 和规范 cwd 路由；disabled/untrusted 不注册 broker，shutdown 取消订阅。EventBus 明确不是恶意 Extension 的安全隔离边界。
- Pi 没有 unregisterCommand/unregisterTool：首次 disabled/untrusted 只保留 status；同一实例 ready 后再关闭时名称仍可见，但所有处理器受当前 runtime 门控并拒绝访问；reload 使用新 registry。没有为此修改 Pi Core。
- P2-6 新增集成测试 1 个文件、7 项通过，包含 Reader 乱序加载和同 cwd 不同 sessionId 拒绝；最终 P0～P2-6 unit/integration 为 14 个文件、69/69 通过。Biome 完成最终格式化后回归仍为 69/69；根目录 `npm run check` 通过。
- `npm pack --dry-run --workspace=@wz-agent/pi-enhanced` 通过，共 49 个文件；最终预检为 74.6 kB，不含测试、数据库、Core、Session、凭据、日志或临时文件，也没有生成 tgz。
- Windows 受限文件沙箱会阻止既有 Core 硬链接/junction 测试并返回 EPERM；在正常文件权限下原样测试通过，没有修改 Core 实现绕过限制。
- P2-6 已完成并停止；下一阶段 P2-7 尚未开始。

## 2026-11-01：P2-7 整体验收与 P2-8 Memory Intelligence

- 依据 `F:\Chrome Download\PI_ENHANCED_NEXT_BATCH_P2_7_P2_8_CODEX.md` 在同一轮完成 B1～B5；没有修改 Pi Core、P1 MCP Policy、Memory SQLite schema、既有 Memory 状态机、Session Recall、P3 Context 或 P4 Task Manager。
- P2-7 修复同一 Extension 实例关闭后的工具暴露：`enhanced_memory_search` 在 runtime 不 ready 时同名重注册为 `exposure: "hidden"`，ready 后恢复 `direct`；旧 handler 仍按 runtime 拒绝。Pi 没有命令注销接口，因此用户命令关闭后名称仍保留但不能访问数据。
- 新增独立 `python/memory-intelligence` 工程。Worker 通过带 requestId 的 JSONL 长期子进程协议工作，限制操作、1 MiB 帧、16 个 pending、2,000 条快照、50 条结果、启动/调用超时和清理；不读取 SQLite、Session 或项目文件，不写权威状态。
- 本地真实向量采用 NumPy 2.5.2 的 corpus-local TF-IDF + SVD，模型标识 `lsa-tfidf-svd-v1`。它不是 FakeEmbedding，也不是预训练神经模型，不联网和不下载权重；词面无交集 fixture 已证明 FTS5 不命中时可由向量 Top 3 找回。
- TypeScript 新增 Memory 检索配置、verified 有界快照、Python Worker client 和 SemanticSearchAdapter。默认仍为 lexical；semantic/hybrid 需显式启用。Hybrid 使用固定 `k=60` 的 RRF。Python 返回 ID/分数/版本后，TS 重新核对当前 scope、verified、contentRevision 和 contentHash。
- Python/NumPy 缺失、启动失败、超时、退出、非法 stdout、异常候选或快照超限都会自动降级现有 FTS5，并保留错误类别。reranker 没有可用的额外本地模型，保持 disabled/unavailable，没有自动下载。
- Python pytest 14/14 通过；P0～P2-8 unit/integration 16 个文件、80/80 通过；根目录 `npm run check` 通过。
- 离线评估使用 12 条自造非私密记录、5 个词面无交集查询、Top 3、25 次：FTS5/semantic/hybrid Recall@3 为 0/1/1，MRR@3 为 0/0.4667/0.4667。完整指标在 `docs/p2-8-benchmark.json`；小样本不能外推为真实项目普遍质量。
- `npm pack --dry-run --workspace=@wz-agent/pi-enhanced` 最终为 64 个文件、94.6 kB。第一次预检发现 pyc、`__pycache__` 和 Python 测试会被 `files: ["python"]` 纳入，已通过 package files 排除规则修正；最终包不含测试 fixture、venv、模型、派生索引、数据库、Session、凭据或日志。
- 根目录完整 `npm run build` 的 `pi-ai` 联网 models.dev 刷新因网络受限失败；改用仓库已有 `build:offline` 验证本地模型数据并完成测试所需构建。Memory Worker 全程没有联网下载。
- 报告：`docs/p2-7-verification.md`、`docs/p2-8-verification.md`、`docs/p2-8-benchmark.json`、`docs/p2-known-limitations.md`。本轮完成后停止，不进入 P3/P4。未创建 Git commit。

## 2026-11-01：P2 发布收尾与 P3 Context

- 依据 `F:\Chrome Download\PI_ENHANCED_NEXT_BATCH_P2_CLOSEOUT_P3_CODEX.md` 连续完成 B0～B6，没有进入 P4。
- P2 新增真实发布包 E2E：npm 生成 tgz、安装到含空格路径、从安装后的 Package 启动 Python Worker 并完成 health/sync/search/shutdown；包内没有测试、缓存、venv、模型、索引、数据库或 Session。
- Worker 启动解析现在导出 `resolvePythonWorkerLaunch`，只接受绝对 Python override；新增进程 PID 只读诊断用于离线 RSS 测量。
- 100 条 verified 记录实测：冷启动+同步+首次 Hybrid 189.695 ms，热查询 P50 6.319 ms、P95 7.919 ms，Worker RSS 9,420,800 bytes；缺失 Python 命令时 16.609 ms 内回退 FTS5。小样本 Recall@5=0.6，不能外推生产质量。
- 固定 Commit `842c73170a3658d4e3b39fcc84690211ed503e09` 的 Context/Session/Compaction/消息结构已重新核对；本轮没有修改 `packages/coding-agent`、`packages/agent`、Pi Core、P1 Policy 或 SQLite schema。
- P3 新增严格配置、runtime、Pi token 估算、历史选择、长工具输出请求视图、ScopedMemoryReader 接入和诊断。模块及 Memory 注入分别默认关闭；observe 不改消息，select 不写 Session。
- 选择器始终保留最新 user、summary、最近消息和不完整工具组；只处理完整配对且 text-only 的 toolResult，保留 ID、role、details/nestedCalls。持久 Session 测试确认 JSONL hash 和长度不变。
- Memory 注入只取当前 scope verified Episodic，二次复核、限额、去重和脱敏后作为 custom 注入；Pi 模型侧转换为 user。candidate、Core 和 Session Recall 不自动注入；Reader 不可用时退回 TS-only。
- `session_tree`、compact、compact_failed 清除诊断，shutdown/resume 重建 runtime。不注册 `context_with_system`，不替换原生 Compaction。
- Python Context 评分评估后暂不实现，配置状态明确为 `not-implemented`；避免把完整会话扩散到现有 Memory Worker。
- Python 回归 14/14 通过。TypeScript 首轮全量发现 P0 命令清单未纳入新增 inspect 命令，测试期望已按正式接口更新；最终结果记录在 `packages/pi-enhanced/docs/p3-verification.md`。
- P0～P3 定向回归最终为 20 个文件、100/100；`npm run check` 和 `npm run build:offline` 通过，coding-agent bundle 为 82 个文件、9.0 MiB；实际 tgz 安装 E2E 1/1 通过。
- 额外根仓库 `npm test` 没有全绿：scripts 48/49，失败为 Windows `spawnSync("npm")` ENOENT；workspace 测试中 agent-core 93/93、codemode 223 通过，ai 有 Vitest worker 异常，chord 有 Windows 路径分隔符误判，coding-agent 主要因 WSL/bash、symlink、路径和 fd 环境失败。均发生在未修改的上游 Package，作为环境阻断记录，没有改 Pi Core 或上游测试绕过。
- 新增报告：`p2-final-closure.md`、`p3-interface-check.md`、`p3-context-design.md`、`p3-verification.md`、`p3-benchmark.json`；README、混合架构和验收清单已更新。

## 2026-11-01：Memory V3 Batch A Governance

- 依据 `F:\Chrome Download\PI_ENHANCED_CODEX_PROMPT_MEMORY_V3_BATCH_A.md` 和 `PI_ENHANCED_MEMORY_CONTEXT_TASK_ARCHITECTURE_V3.md` 只完成 Memory Governance，没有继续开发 V3 后续 P3/P4。
- 修改前真实基线为 TypeScript 20 个文件 100/100、Python 14/14；固定 Commit `842c73170a3658d4e3b39fcc84690211ed503e09` 仍是 HEAD 祖先；用户原有工作树全部保留。
- 一手核对 Letta Stateful Memory、Mem0 add/update/delete 和 Serena Memories；采纳 metadata、expiration、人工检查、引用和归档思想，不引入托管服务、全局记忆、后台 Agent 或 system 注入。
- SQLite schema 从 v1 增量到 v2；v1 memories/source/verification/FTS 不改，新增 metadata、usage、relations、proposals、audit 五张表。旧数据迁移为 `other/active/importance=1/useCount=0`。
- 新增 category、subjectKey、tags、importance、validFrom/validUntil、active/archived。使用统计独立更新，不增加主 revision；默认检索、Reader 和 Python snapshot 排除 archived/expired。
- 新增确定性 Doctor/Planner。冲突 subjectKey 组不会进入 merge/compress；词面近重复只形成 proposal；阈值来自有界配置，没有后台触发。
- maintain dry-run 只保存 proposal 草稿；apply 需 UI 确认和全部 revision CAS。compress/merge 新建无 verification 的 candidate，并用 derived_from 回溯源记录；源 verified 不自动归档或删除。
- 新增 list/inspect/doctor/maintain/archive/restore/delete 用户命令。模型仍只有只读 search；单条 delete 二次确认，无 UI 拒绝；批量 delete proposal 禁止 apply，未实现 purge。
- 持久测试覆盖 v1→v2→rollback→再次升级、旧数据、归档/过期检索、usage revision、冲突阻断、candidate 不继承 verified、关系、CAS、跨项目、删除与旧 Python 响应，以及批量删除只预览不可 apply。修改后 TypeScript 21 个文件 109/109、Python 14/14。
- 小型 benchmark 为 8 条虚构记录：2.503 ms，四类关键词分类 Macro-F1=1，一个预设冲突组 Precision/Recall=1，近重复组 1，自动 verified=0；只证明规则可重复，不代表真实任务质量。
- `npm run check` 通过；最终 pack dry-run 为 70 个文件、105,008 bytes，不含测试、本地数据库、Session、Core 实例或 Python 派生产物；敏感标记扫描只命中检测/脱敏正则，没有实际凭据。
- 交付：`architecture-reference-matrix.md`、`p2-memory-v3-design-delta.md`、`p2-memory-v3-migration.md`、`p2-memory-v3-verification.md`、`memory-governance-benchmark.json` 和基准脚本。

## 2026-11-02：Batch C，P3/Memory V3 兼容与 P4 Task Manager V3

- 完整读取 `PI_ENHANCED_NEXT_BATCH_P3_V3_COMPAT_P4_TASK_MANAGER_CODEX.md`、Batch C Prompt 和 V3 架构第 5 章；保留全部未提交工作树，没有 reset/clean/切分支。
- 修改前真实测试收集为 TypeScript 20 个文件 108/108、Python 14/14；此前报告的 109 与当前收集器相差 1，本批未删除旧测试。
- P3 修复异步旧 Reader 快照窗口：搜索后在注入边界按 ID 权威重读，并校验 status、lifecycle、有效期、revision、contentRevision 和 contentHash。真实 Extension 测试证明 archived/expired/stale/deleted/candidate 不注入，restore 后有效 verified 可恢复注入。
- P4 在现有 `task-manager` 入口内实现独立项目级 `tasks.sqlite3`：Task/Step DAG、状态机、revision/planRevision CAS、append-only events、证据、attempt、checkpoint、Session binding 和恢复 preflight。没有修改 Memory schema。
- 只有用户显式绑定的 task/step 才观察工具；按真实 toolCallId/parentToolCallId 关联。原始 args/stdout/文件内容不入库；真实 shell exitCode 可形成 runner 证据，模型自述和 agent_settled 不能完成任务。
- 重启时未结束 attempt 进入 `needs_reconciliation`。恢复固定 `automaticReplayAllowed=false`；write/edit/push/deploy 等不会自动重放。
- 新增 14 个用户命令、只读 `enhanced_task_get` 和默认关闭的 draft plan 工具。P4→P2 只生成 candidate 预览；已提供 `ScopedTaskReader`，P3 Task 摘要自动注入本批保持关闭。
- 最终 unit/integration 为 22 文件 119/119；含真实 tgz 安装和安装后 task-manager 入口加载为 23 文件 120/120；Python 14/14；TypeScript check 通过。
- pack dry-run 为 87 文件、约 127 KB，未包含测试、本地 Task/Memory DB、Session、任务内容、凭据或 Python 派生产物。
- 合成 Benchmark：8 个虚构任务、5 次受控中断，危险动作重复 0、错误完成 0、reconciliation 5、重开一致率 1。仅证明 fixture，不代表真实 coding task 成功率。
- 报告：`p3-memory-v3-compat-verification.md`、`p4-interface-check.md`、`p4-task-design.md`、`p4-schema-migration.md`、`p4-verification.md`、`p4-benchmark.json`、`p4-known-limitations.md`。本轮已停止，没有开发 P5。

## 2026-11-02：Batch D，P4 加固与 P5 评测底座

- 依据 `F:\Chrome Download\PI_ENHANCED_BATCH_D_P4_HARDENING_P5_EVAL_CODEX.md` 和 `CODEX_PROMPT_BATCH_D_P4_HARDENING_P5_EVAL.md` 连续完成 D0～D6；没有修改 Pi Core、P1 Policy、Memory Schema v2、Session JSONL 或原生 Compaction。
- 109/108 差异已定位为测试收集范围：108 是 unit/integration，109 额外包含已有安装包 E2E。Batch D 起始统一基线为 120；稳定身份清单确认没有遗失旧测试。
- Task schema 升到 v2，新增步骤验证规则、attempt 输入摘要、证据 attempt/input/result 关联、checkpoint 工作区观察和 planRevision；v1→v2 数据保留测试通过。
- 工具退出码 0 只产生 `observed`。只有预先保存的 command_exit 规则同时匹配 toolName、输入摘要和退出码，或文件 SHA-256 明确复核，才产生 `validated`。模型自述和旧 `verified_by_runner` 不能完成步骤。
- 新增人工 reconciliation：中断操作只能由用户确认 `do_not_retry` 或 `external_success`，不会自动重放。后者记为 `manual_attested`，不冒充机器验证。
- 真实子进程 E2E 在有副作用 attempt 未结束时终止子进程；重开后正确标为 `needs_reconciliation`，检测 Git worktree drift，两次恢复均未重复写文件。
- P3 新增默认关闭的只读 Task 摘要注入。ScopedTaskReader 和最终二次读取共同校验 project/session/branch/revision/planRevision；预算不足、Reader 不可用或 session_tree 解绑时安全跳过。
- 已完成 Task→Memory candidate 桥：只接受同项目、同会话请求，命令预览后还需 UI 确认；MemoryService 固定保存 experience/candidate，不生成 verified 或 verification。
- P5 新增 8 个本地 mini Git 仓库的确定性工具回放。实测 8/8 只证明评测链路正常；真实模型 coding task 与官方 SWE-bench 明确为 not_run。
- 最终完整回归为 TypeScript 26 文件 127/127、Python 14/14；TypeScript check、Biome、pack dry-run 和实际安装包 E2E 通过。Windows 沙箱禁止硬链接，完整 TS 回归在获准的沙箱外测试进程完成。
- 交付文档：`batch-d-baseline-audit.md`、`batch-d-test-manifest-final.json`、`p3-task-compat-verification.md`、`p4-hardening-verification.md`、`p5-evaluation-design.md`、`p5-evaluation-results.json`、`batch-d-verification.md`。本批完成后停止，不继续开发新的执行引擎或 P6。
