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

## 2026-11-02：Batch E，落地能力补齐

- 原生工具守卫接入 Pi 的执行前 `tool_call`：工作区读、写路径、`.git/.pi`、目录穿越和 junction 逃逸受控；write/edit 默认逐次确认，Shell 无 UI 时拒绝。它不是操作系统全局沙箱。
- 新增五类真实 Pi 模型任务 harness 和独立验证器；本轮没有授权模型、Key 或费用预算，5/5 均标记 `not_run`，费用 0，没有把 dry-run 当成功率。
- P4 新增恢复列表、显式确认后的重新绑定、受控文件哈希、容量诊断；Task→Memory 来源使用内容摘要，跨 MemoryService 重启保持 candidate ID 幂等，不会写 verified。
- Memory/Task 新增 SQLite online backup、manifest 完整性检查和停机恢复；恢复测试只使用临时项目。Task 256 MiB 上限在 80% 预警，不自动删除审计历史。
- 20 条人工非私密记录、8 个标注查询实测：FTS5 Recall@5 0.125，LSA/Hybrid 0.75；样本很小且 LSA 不是预训练 Embedding。
- 已添加 Windows/Linux 普通 CI 和显式审批的真实模型独立 workflow；本机 Docker Engine 未运行，Linux/CI/真实模型均不冒充已执行。
- 最终测试与打包结果以 `packages/pi-enhanced/docs/batch-e-verification.md` 和 `batch-e-test-manifest.json` 为准。

## 2026-11-02：Batch F，受控试用准备与 RC Gate

- 保留 Batch E 全部未提交修改，没有 reset/clean/切分支；HEAD 仍为 `d98a80e...`，固定 Pi Commit 仍是祖先。
- Docker Desktop 4.55.0 / Linux Engine 29.1.3 实际可用。固定本地 `node:20-alpine` 镜像 ID 完成无网、只读根、cap-drop、no-new-privileges、CPU/内存/PID 限制的真实 smoke；宿主哨兵 hash 不变。该 smoke 尚未与真实 Pi 工具执行链集成。
- 原有 real-agent runner 增加 runId、provider/model、Key 环境变量名、费用、任务、Token、调用、超时、并发和输出目录闸门。固定 Pi CLI 缺少原生硬预算参数，因此执行还必须由外部预算网关确认；preflight 不读 Key、不发请求。
- 真实模型调用 0、费用 0；五任务、十格消融、官方 SWE-bench 均为 not_run，没有把 dry-run 或确定性 8/8 写成模型成功率。
- 新增恶意 Memory/Task/tool-output 离线夹具；修复 text-only 工具输出在请求视图中未先脱敏的缺口，原始 Session 不改写。真实模型提示注入行为仍未测试。
- 最终 TypeScript 144 个身份：142 passed、0 failed、2 conditional skip，Batch E 137 个身份无缺失；Python 14/14；Serena Docker E2E 另行真实通过。
- 普通 CI 增加最小权限、版本输出、pack 泄漏扫描和 Docker job；远端 Windows/Linux 尚未实际运行。RC Gate 为 NO-GO，不打 Tag、不推送、不发布。

## 2026-11-02：Batch G，真实 Docker 文件工具执行闭环

- 完整读取 `PI_ENHANCED_BATCH_G_ISOLATED_TOOLS_REAL_MODEL_PILOT_CODEX.md`，保留已有脏工作树，没有 reset/clean、切分支、push、workflow_dispatch、Tag 或发布。
- 固定 Pi Commit 的 Extension 同名覆盖、`tool_call/tool_result`、CLI allowlist 和六文件工具接口已核对；相关 Pi Core 文件在固定祖先与当前 HEAD 间无差异，本轮没有修改 Pi Core。
- 新增默认关闭的第五个 `sandbox` Extension。启用时要求 trusted、系统临时工作区、runId 和固定镜像；read/grep/find/ls/write/edit 全部同名替换，Shell、PowerShell、codemode、tool_search、MCP 和未知工具拒绝。
- Broker 使用 Docker CLI 创建无网、只读根、非 root、cap-drop、no-new-privileges、资源受限容器，只挂 `/workspace`。固定 Worker 通过 JSON stdin 接收结构化操作，不执行模型拼接命令；协议绑定 runId/requestId/toolName，路径和大小双重检查。
- 发现原生 read 会在 operations 前使用宿主 access 探测文件，原生 grep 即使注入 operations 仍会启动宿主 rg，因此两者只复用公开 schema/renderer，执行体改为容器 Worker。edit 继续复用原生精确替换和 diff，但文件读取/写入只经过容器。
- 真实 Pi AgentSession E2E 覆盖六工具、中文/空格/CRLF、并行 read、串行 write/edit、路径逃逸、Windows drive/UNC、`.git`、junction、二进制、超大文件、重复请求、取消、容器退出、缺失镜像、无网、只读根和守卫先阻断；实际 pack/install 后加载沙箱入口也通过。专项 9/9，容器残留 0。
- real-agent 继续复用原 runner，已接入 Sandbox Extension 和固定镜像 gate；preflight 无 Key 成功，未授权 execute 返回 `EVAL_GATE_UNAUTHORIZED`，dry-run 5 个 fixture 全部 not_run。真实模型调用 0、费用 0。
- 普通 CI 增加身份清单和环境元数据，Docker job 跑真实 AgentSession E2E；付费 workflow 在 execute 前跑 sandbox 和 preflight。未获远端授权，状态仍 configured_only。
- 全量 TypeScript 最终清单为 155 个身份、153 passed、0 failed、2 conditional skipped，Batch F 144 个身份缺失 0；Python 14/14、确定性回放 8/8、offline build 和只读根检查通过。最终 pack 数字以 `batch-g-verification.md` 为准。
- G-ENG、G-SBX、G-SBX-INTEGRATED 和离线 G-SEC 通过；G-MODEL not_run、G-CI configured_only，G-RC 继续 NO-GO。本批完成后停止，不进入付费试用或消融。

## 2026-11-02：项目内本地模型密钥配置

- 根目录已有 `.env` 忽略规则；新增 `.env.example`，本机 `.env` 仅保留 `DEEPSEEK_API_KEY=` 占位，不记录真实密钥。
- real-agent runner 只在显式 `--execute` 时加载仓库根目录 `.env`；dry-run 和 `--preflight` 仍不读取密钥，保存密钥不会自动开启付费评测。
- TypeScript check 通过；真实模型 Policy 单测 4/4 通过；DeepSeek preflight 仍显示未授权且未调用模型。

## 2026-11-02：Batch G NO-GO 续验

- 用户明确授权后续 DeepSeek API 调用；项目 `.env` 中的 `DEEPSEEK_API_KEY` 通过官方 `/models` 非推理鉴权，HTTP 200，可用模型为 `deepseek-flash`、`deepseek-v4-pro`，未输出密钥。
- 新的 PILOT-G1 preflight 固定为 `deepseek/deepseek-flash`、1 个任务、20,000 Token、8 次调用、0.10 美元、180 秒和固定 Docker 镜像；preflight 通过。
- 项目没有已核实的外部费用硬限制网关，runner 参数只能事后检查，不能伪装成硬限制。因此 G-MODEL 从 `not_run` 更新为 `blocked_budget_gateway`，推理调用仍为 0、费用 0。
- `.env` 继续由 Git 忽略；pack 泄漏检查通过：139 entries、163758 bytes、forbidden 0、contentLeaks 0。远端 CI 仍没有 Run URL，且本机没有 `gh`，G-CI 保持 configured_only，G-RC 保持 NO-GO。

## 2026-11-03：Batch H 预算网关与首次试用准备

- H0 确认 DeepSeek 请求由内置 `deepseekProvider` 经 `openai-completions` Adapter 发出，`models.json` 可以覆盖内置 baseUrl 与认证；没有修改 Pi Core。
- H1 新增回环硬预算网关：请求次数、保守输入 Token 上界、输出 `max_tokens`、总 Token、总费用、单并发、请求大小和超时均在转发前检查；usage 缺失、上游错误或超过预留时失败关闭。
- 真实 Key 只由 runner 网关持有。临时 Pi 子进程只收到一次性网关 Token，并移除 DeepSeek/OpenAI/Anthropic Key，设置 `PI_OFFLINE=1`。
- 模拟 Provider、Policy 和凭据隔离专项 10/10 通过；真实 Pi + 网关 + Docker 联合 E2E 1/1 通过，3 次模型回合全部经过网关，write/read 进入 Docker，模拟 usage 为 570 Token。
- H3 preflight 通过后，用户明确授权把固定合成 JavaScript 任务及 Docker 工具输出发给 DeepSeek，限 8 次调用、20,000 Token、0.10 美元、180 秒。真实试用执行了 3 次调用，输入 6444、输出 222、合计 6666 Token，网关实测费用 0.0021996 美元；随后 4 个请求被网关拒绝。
- H3 的 Sandbox Extension 因 runner 临时目录传递错误报 `SANDBOX_WORKSPACE_NOT_TEMPORARY`，没有执行文件工具，没有生成补丁，独立验证失败。本次授权已经消耗，没有自动重试。runner 随后改为以任务根目录作为 TEMP，并以网关 usage 作为权威调用量和费用来源；旧 stdout 统计仅留作追踪。
- H2 复测时发现根目录文件写入会先请求创建 `.`，Worker 原先将其误判为非法路径；现仅对 mkdir 允许工作区根 `.`，其他路径规则不变。真实 Pi + 模拟 Provider + 网关 + Docker 联合 E2E 再次通过，write/read 都进入容器。
- CI 已加入网关专项和联合 E2E，付费 workflow 改用 `local_hard_gateway`。远端 CI 未运行、H3 失败、未获发布批准，因此 Batch H 仍 NO-GO。
- 完整回归：TypeScript 162 个身份中 160 passed、0 failed、2 skipped，Batch G 155 身份缺失 0；Python 14/14；确定性回放 8/8；TypeScript check、offline build、pack 泄漏检查通过。pack 为 149 entries、175601 bytes、forbidden 0、contentLeaks 0。

## 2026-11-03：Batch I 真实 Runner 修复与离线 RC 复核

- 完整读取 Batch I 任务书和 Prompt；没有调用 DeepSeek、读取 `.env`、push、触发 Workflow、Tag 或发布。
- H3 根因已用代码与离线测试证实：旧 Runner 将 Pi 子进程 `TEMP/TMP` 设为 `<runRoot>/temp`，fixture 位于同级 `<runRoot>/<task>`，Sandbox 的 `relative(os.tmpdir(), workspace)` 因 `..` 拒绝。H2 未走生产 Runner，因此漏测。
- Runner 现在显式传递 `PI_ENHANCED_SANDBOX_RUN_ROOT`，与子进程 `TEMP/TMP` 使用同一受控根。Sandbox 要求 workspace 为该根的严格子目录并等于真实 cwd，记录设备号/文件编号；Broker 启动和每次请求前复核目录身份。
- Runner 在启动预算网关前先以相同配置完成 Docker 预检。缺失镜像 E2E 证明 Stub Provider 收到 0 次请求；没有宿主文件工具回退。
- 新增生产 `run-real-agent.ts` 本地 Stub 模式，只接受显式环境门禁和 `127.0.0.1`，不读取 `.env`、不覆盖真实模型报告。完整 Stub→网关→Pi CLI→Docker→Patch→隐藏验证器通过，补丁 hash `5fa0153b...bdd0`，外部哨兵不变，容器残留 0。
- Sandbox 审计只能写到 runRoot 直属位置且不能进入模型工作区；记录路径 hash、容器策略和工具元数据，不记录正文或凭据。
- 网关新增 `requestAttempts` 和有界 `denials`，记录稳定拒绝码、请求序号、未转发标志及预算快照。H3 旧产物没有逐次原因，只能标记 `historical_reason_unknown`；未将其猜测为 Token 或费用耗尽。
- TypeScript 最终清单为 166 个身份：164 passed、0 failed、2 条件跳过，Batch H 162 个身份缺失 0；Python 14/14；P5 确定性回放 8/8；离线构建 82 files/9.0 MiB；最终 pack 122 entries/165939 bytes、forbidden 0、contentLeaks 0。
- 最终核对时共享工作树中的旧报告发生并发变化：11 个已跟踪 Batch D/P3/P4/P5 文档显示删除，已从当前 HEAD 原样恢复；此前未跟踪的 Batch E～G 等报告没有 Git 或其它本地副本，未伪造重建。发布前需从外部备份恢复或重新审计这些历史报告。
- I0～I4 本地工程验收通过；I5 无新付费授权为 `not_run`，远端 CI 为 `configured_only`，发布结论 `engineering_passed / model_not_run / release_no_go`。

## 2026-11-03：Batch I 单次真实 DeepSeek 试跑与提交准备

- 用户授权且仅执行一次 `deepseek/deepseek-flash` 的 `single-file-off-by-one`：上限 8 请求、20,000 Token、0.03 美元、180 秒，并发 1，不自动重试。
- 模型经本地硬预算网关完成 3 次上游请求，输入 6516、输出 357、合计 6873 Token，费用 0.0023832 美元。后续序号 4～7 的请求均由网关以 `GATEWAY_TOKEN_BUDGET` 本地拒绝，`upstreamForwarded=false`。
- 生成补丁将 `n * (n - 1) / 2` 改为 `n * (n + 1) / 2`，补丁 SHA-256 为 `5fa0153b3fef99b46b88d914995710c3b2d57a70be13315c2abb8bd37c50bdd0`；隐藏验证器退出码 0。
- 原始 Runner 状态保留为 `budget_exceeded`，因为存在预算拒绝；功能结论为 `passed_with_budget_stop`。没有重试，没有增加预算。
- Sandbox 审计确认无网、只读根、非 root、仅临时 `/workspace` 可写；本次使用 find、ls、read、edit，没有 Shell、MCP 或宿主工具回退。
- 完整 TypeScript 回归从仓库根目录收集 166 个身份：164 passed、0 failed、2 条件跳过；Batch H 162 个身份缺失 0。包内目录启动会使既有崩溃恢复夹具解析到错误路径，不能作为正确运行方式。
- 共享工作树中的 `packages/pi-enhanced/docs` 再次发生未跟踪文件消失；Runner 清理根已核对为系统临时目录，源码没有删除 docs 的路径，无法复现为 Runner 清理错误。12 个已跟踪历史文档从 HEAD 原样恢复，Batch H/I 报告依据现存运行产物和测试重新生成；更早且无 Git 对象的旧报告不伪造恢复。
- 尚未推送。发布状态仍为 NO-GO，等待远端 Windows/Linux CI 证据。

## 2026-11-03：评测统计修订与 CI 审查

- stdout 只统计 `message_end` 的最终 assistant usage，排除 update、turn_end、agent_end 重复消息和 error/aborted。用量仍以网关为权威，stdout 仅作诊断。
- 新增独立 `patchStatus` 和 `runStatus`：隐藏测试通过可以与 budget_stopped/timeout 同时存在；汇总增加 patchPassed、normallyCompleted、budgetStopped。历史原始报告不覆盖。
- 全仓 `npm run check` 通过。专项 6 passed；Docker 当前不可用，生产 Runner 两项 E2E skipped，新增 stdout 610 Token 断言尚待实测。
- 普通 CI 将 offline build 移到测试前，Docker job 也先构建 CLI，避免真实 Runner E2E 因 CLI 缺失被跳过；Python 测试显式设置 PYTHONPATH。
- 现有真实消融条件不足：六文件工具白名单排除了 Memory/Task 模型工具，预置记忆又是通用经验，不能仅凭开启模块宣称其有效。P2 应先验证模块实际触达，再比较同任务、同预算的结果和成本。
- 此轮没有调用真实模型，未推送；之前的一次付费授权已经消耗。等待推送确认和新实验预算。
- 随后用户授权正常推送，be90a62ea 已推送；远端 run 41619421795 实际启动。Docker job 在 build:offline 因干净 checkout 缺失被忽略的 Provider 数据失败；CI 补用原有 hydrate:model-data 步骤。恢复的 H/I 清单哈希改为真实换行算法，H 清单明确标注重建来源。
- 第二轮 run 41619641040 暴露 Linux clean checkout 类型检查依赖构建，以及 runner UID 1001 与容器 UID 1000 不匹配导致挂载写入失败。CI 调整为 hydrate→build→check；容器使用宿主非 root UID/GID（root/Windows 回退 1000:1000），检查值同步匹配，未修改挂载权限或容器能力。
- 第三轮 Linux TS 与身份清单通过，Python 暴露 SVD 截断重复奇异值块的跨 LAPACK 不确定性。改为完整奇异值块截断，新增旋转子空间回归；Python 15/15 通过。原有语义召回断言保留。
- P2 用户授权 2 任务×baseline/full，共 4 次独立运行，总 32 请求、80,000 Token、0.12 美元，每次 180 秒、不重试；前置模块触达审查和 CI 尚未完成，未消耗此授权。
- 用户随后明确授权只读 enhanced_memory_search/enhanced_task_get。默认关闭的白名单、模块配置、任务选择及模块查询事件已接入现有 Runner；模拟 Provider E2E 已实测两个模块工具成功，未允许写记忆、提计划、Shell 或 MCP。
- 4 次真实对比已经全部执行，没有重试：baseline 两项补丁通过但预算停止；full 两项没有通过隐藏测试，上游流发生 GATEWAY_UPSTREAM_TIMEOUT_OR_ABORT 后网关失败关闭。真实模块查询中 Task 成功，Memory 一次返回 0 条；Context 只证明启用，没有独立效果证据。
- 合计上游请求 9 次，已确认 16,369 Token、0.005673 美元；两个上游流没有完整 usage，费用未知部分保留预留，累计费用上界 0.019032 美元。不能把 usage 未返回记作免费或已完成计费核对。原始产物保留，派生报告 controlled-comparison-20261103.json 将 full 标为 gateway_error。
- P2 结论为 inconclusive，没有证明任何单模块收益；禁止从 2 个合成任务推导总体成功率。此次授权的 4 次运行已经用完，不继续自动试跑。
- 远端 run 41620874749 的 Linux/Docker 通过，Windows 暴露 rootPath 与临时路径大小写不同导致 PROJECT_PATH 标签不一致；Windows 盘符路径改用大小写不敏感替换，保留 Linux 大小写语义及通用脱敏，新增回归通过。
- run 41622273550 Linux/Docker 通过，Windows 同一标签断言仍失败，说明并非仅大小写。夹具使用 TEMP 别名而 scope 为规范路径（Windows 可有 8.3 短路径）；测试拆为规范 scope 必须 PROJECT_PATH、别名必须脱敏且原路径不泄漏。保留原 Reader 安全断言，未将安全失败改成跳过。
- 最终源码/测试提交 8204fa14e44d9dbf854a9eb20ab840feda0d4334 的远端 CI 41623230736 全部 success：https://github.com/Wenzayyds/agent/actions/runs/41623230736 。Linux 158 passed/11 skipped，Windows 156 passed/13 skipped；均收集 169 身份、基线缺失 0；Docker 专项 22/22。Windows/Linux Python 均 15/15、确定性回放均 8/8，pack 敏感命中均 0。跳过项是外部 MCP 或未装镜像等环境条件，真实容器执行由独立 Docker job 实测覆盖。
- 本地完整 TS 为 167 passed/2 skipped（169），全仓 check 通过。P0 统计与 P1 远端工程验证完成；P2 已执行 4 次获准真实试验但结论不足，未知 usage/费用和 gateway_error 见 controlled-comparison-20261103.json，不再重试。此次追加仅记录证据，不修改已验收源码。

## 2026-11-03：full 网关、Memory、Context 离线修复

- 本轮按用户要求仅离线排查修复，没有付费调用、提交或推送。历史真实试验原始数据没有改写。
- 两次 full 均不足 20 秒，网关超时为 120 秒；旧控制器只有超时或客户端关闭可 abort，结合 SDK 收到 DONE 即退出读取，定位客户端正常结束与网关等待 HTTP EOF 的结算竞态。离线 Provider 发完 usage/DONE 后延迟 EOF，旧代码稳定失败并丢弃 usage；现在转发 DONE 前结算一次。真正超时、提前断开、无效/缺失 usage 仍失败关闭并保留预留，requestOutcomes 记录明确原因和阶段。
- Memory 复现为长提示的 AND/literal 查询零命中；历史真实模型 query 未记录，不能还原原词。新增仅零命中时的有界代码标识符参考检索，复用原项目/verified/生命周期过滤，不改 SQLite Schema/MemoryService；候选和归档负向测试通过。Runner 新增种子搜索预检、脱敏工具入参和检索策略记录。
- Context 原诊断只供用户命令读取，Runner 没接入。新增可选诊断回调和评测专用 probe，保存实际配置、每轮估算 Token、注入 ID、删选/截断计数。原 fixture 的 draft/setup-session 任务被正确跳过；toolOutput 默认关闭、短任务未触发预算压力，不把配置开关当成收益证据。
- 最终模拟链路 4/4 请求 completed_done、网关 ready；种子预检 1 条、Memory 标识符降级命中 1 条、Context 4 轮诊断含实际注入 ID，Patch 与独立验证器通过。证据明确标注 local_stub_only，不是真实模型成绩。
- 本地完整回归 173 身份：171 passed/0 failed/2 外部 MCP 条件跳过，Batch I 166 身份缺失 0；Python 15/15，全仓 npm run check 通过，最终专项 Runner 3/3，pack 泄漏命中 0。
- 报告：packages/pi-enhanced/docs/full-offline-root-cause-and-fix.md；清单 full-offline-fix-test-manifest.json；持久化模拟证据 full-offline-module-evidence.json。当前修改未被远端 CI 验证；本轮不重新规划真实对比、不重用已消耗授权。

## 2026-11-03：离线修复提交审查

- 用户授权审查、提交并推送上轮离线修复，要求 Windows/Linux/Docker CI 全部通过后再提出真实对比方案，方案确认前禁止付费调用。
- 复审补上最终 usage 覆盖校验：先有效后无效不能保留旧计费值，负数或不一致 total_tokens 失败关闭；预算超限的 requestOutcomes 使用实际错误码。
- 本地 Pi Enhanced 174 身份：172 passed/0 failed/2 条件跳过，基线身份缺失 0，全仓 npm run check 通过。本轮付费调用 0。
- 离线修复 15 个文件已审查、提交并正常推送：f8b6017f3054ce72172a7421f97b3c900e3a3d59。无删除文件，未包含 .env、真实密钥、数据库、Session 或运行日志。
- 该源码远端 CI 41628243079 全部 success：https://github.com/Wenzayyds/agent/actions/runs/41628243079 。Linux 163 passed/11 skipped，Windows 161 passed/13 skipped（均 174 身份、基线缺失 0）；Docker 专项 26/26，两个系统 Python 均 15/15、包泄漏命中 0。
- CI 通过后新增本地待确认方案 packages/pi-enhanced/docs/next-controlled-comparison-plan.md：Memory 同信息直给/搜索、Context 长输出关闭/开启、Task 同计划直给/只读查询，3 任务×2 格，共 6 次。建议每格 8 请求/40,000 Token/0.03 美元/180 秒，全批 48 请求/240,000 Token/0.18 美元，不重试。预算未授权，夹具与 task-only 等准备尚未实现；方案确认后仍需先完成离线验收。
- 本轮真实模型调用 0。源码与远端同步；本次 CI 证据和待确认方案仅保存在本地文档，未另行推送以改变已验收源码提交。

## 2026-11-03：已授权六格真实对比的离线准备

- 用户批准三任务×两组共六次真实对比，每次 8 请求/40,000 Token/0.03 美元/180 秒，整批最多 0.18 美元，不重试、不加预算。必须先完成本地离线与 Windows/Linux/Docker CI，网关或隔离异常停止后续格。
- 新增固定 controlled-cases、task-only、内联规则/计划与 12,000 字符报告，仍复用原 run-real-agent。Memory 的两组用户目标不泄漏规则；规则或计划原文 hash 相同，Context 两组文件 hash 相同。
- run-controlled 固定六格串行，开始前逐格预占 0.03 美元运行额度，独占创建批次目录、拒绝恢复/重复运行；费用和 Token 都经原硬预算网关。真实执行核对当前提交的三平台成功证据，受控实验禁用 Pi 与 Provider 重试。
- 六格本地 Stub 全部经过真实 Pi/Docker并通过隐藏验证；Memory 命中、Task 查询和 Context 截断实际触达。网关/隔离负向测试各只发出一次请求，后五格 not_run，容器残留 0；异常时保留 gateway-final 账目与失败证据。
- 本地完整回归 180 身份：178 passed/0 failed/2 条件跳过，174 基线缺失 0；Python 15/15、全仓 check 和 pack 泄漏检查通过。真实调用仍为 0，待推送当前实现并核对 CI 后再执行已获授权批次。
- 首轮实现 27261ee10 的 CI 41631120068 暴露 Linux 隔离停止时序：父进程从 stdout 收到错误之前，Pi 已发下一次请求（实测 2 次）；没有付费执行。修复为受控专用 Extension 在 awaited tool_execution_end 中先认证通知回环网关进入 GATEWAY_ISOLATION_STOP，再结束进程。通道只能关闭网关，不能恢复或提高预算。P1 Policy 和 Pi Core 未修改。
- 修复后的完整本地回归为 181 身份：179 passed/0 failed/2 条件跳过；隔离失败仍严格断言上游 1 次、后五格 not_run、容器残留 0，未降低验收条件。继续等待新提交的三平台 CI。
- 最终源码 58dada178ee73ef03d9e5216d8d504bb09f89aff 的 CI 41632059204 三 job 全部 success：Windows 165 passed/16 skipped、Linux 167 passed/14 skipped（均 181 身份、基线缺失 0）；Docker 33/33，Python 均 15/15，包泄漏 0。
- 同一干净提交通过 CI 后启动唯一真实批次 approved_six_20261103。首格 m_inline 在修改前请求 ls(..)/ls(../..)，Native tool guard 返回 path-outside-workspace；同步停止通道置 GATEWAY_ISOLATION_STOP，父进程结束当前格，后五格均 not_run。没有重试、加预算或补跑。
- 实际 3 次请求且 3 次 completed_done，输入 6,631/输出 378/总 7,009 Token，网关计费及上界均 0.0024429 美元；运行约 6.645 秒，usage 完整。第一格没有补丁；Memory/Context/Task 均关闭，因此不能评价模块收益。
- 停止后容器残留 0。强制结束未完整触发 session_shutdown，容器审计标 EVAL_SANDBOX_AUDIT_MISSING；保留工具边界错误、调用参数、gateway-final 与逐请求记录，不伪造完整审计。未来继续前先离线改进异常退出审计；本轮不继续调用或开发。
- 报告 controlled-six-verification.md、结构化 controlled-six-real-results.json；原始产物 packages/pi-enhanced/evaluation-output/approved_six_20261103/。真实结果和最新记录仅保存在本地，未再次推送。

## 2026-11-03：Batch J 离线异常审计与工具拒绝恢复

- 仅本地开发与离线验证，没有调用付费 API、提交、推送或触发 Workflow。起止 HEAD 58dada178ee73ef03d9e5216d8d504bb09f89aff；原六格历史 12 个文件哈希未变，起始用户改动保留。
- 根因是 controlled-stop 与 Runner stdout 将所有 Guard 拒绝升级成隔离停止，旧审计只在 session_shutdown 写盘。新增真实拒绝观察事件和明确的宿主 --offline-denial-policy 配置，仅 Stub 可选恢复、默认严格不变；符号链接、身份变化、write/edit、未知工具、容器异常和拒绝超限继续失败关闭。
- Broker 配置权威路径后，操作 intent/结果即时写有界原子快照；异常保留 running/pending 和 unseenEventsPossible。两种真实子进程 SIGKILL 均恢复已有 Docker read，进行中 write 保留未知结果，未伪造成功。未配置 auditReportPath 的手工 Broker 仍只有旧内存接口。
- 最终 TS 209 身份：206 passed/0 failed/3 skipped；原 181 身份缺失 0，Python 15/15。新增 Windows 活动目录替换 E2E 被 EBUSY 阻断并保留 Linux CI 用例；另外两项为原有外部 MCP 条件跳过。首次从子包启动导致旧 P4 夹具路径失败，最终使用 CI 的仓库根入口通过，未修改旧测试。
- 恢复六格 Stub 24 请求、6 格独立验证通过；严重拒绝只启动首格一次请求、后五格 not_run。结果新增终止分类、工具拒绝和审计完整性；旧原始 status/runStatus 保留兼容。
- 根 check、额外评测 TS/Biome、离线 build、真实 pack/安装 E2E 和包泄漏检查通过。远端 Windows/Linux/Docker CI 均 configured_only；真实六格尚待当前修改 CI 与 Linux 身份替换实测，不能自动重跑或把新离线策略用于 DeepSeek。
- 交付仅新增 docs/batch-j-verification.md、docs/batch-j-results.json；原始机器证据在 .artifacts/batch-j/。后续真实模型与 Git 远端操作等待单独授权。
- 额外源码边界记录：既有 verify() 在宿主 Node 导入补丁 JS，独立隐藏验证不等于验证代码也已被 Docker 隔离。本轮仅固定 Stub 补丁；真实模型重跑前需单独处理这段执行边界，未在 Batch J 重写验证器。

## 2026-11-03：隐藏验证器隔离与 Linux CI 准备

- 用户要求按顺序处理隐藏验证器安全，再完成 Linux CI，之后才转向模块效果评估。Batch J 保持结束状态，历史报告不改写；本轮交付仅 verifier-safety-verification.md 和 verifier-safety-results.json，机器证据在 .artifacts/verifier-safety/。
- 生产 run-real-agent 改为通过独立 Docker 容器执行补丁验证：同固定镜像、非 root、无网络、只读根、只读项目挂载，无宿主环境变量；128 MiB/0.5 CPU/32 PIDs，默认 5 秒、16 KiB 输出上限，失败无宿主回退。宿主固定断言校验观测结果，零退出不等于通过。初始宿主自检仅运行启动 Agent 前刚写入的固定夹具。
- 验证器 10 项、生产 Runner/原六格专项 8 项通过；提前零退出判协议错误、隔离攻击补丁未改动宿主哨兵。全量最终 224：221 passed/0 failed/3 skipped，原 209 身份缺失 0；Python 15/15，root check、评测 TS/Biome、pack 泄漏检查通过。
- 初次并发全量旧 J pending 观察用例失败；未修改 J 源码或测试。串行全量通过，CI 同步 maxWorkers=1，保留失败日志，不声称彻底消除旧时序波动。
- Linux CI 加入验证器用例和严格证据检查，禁止 Docker job 以跳过关键用例判成功；真实 Linux CI 尚未运行，Windows 活动目录替换仍 EBUSY 阻断。等待单独授权审查后提交并正常推送 origin/pi-agent，再完成远端 CI；未调用付费模型、提交或推送，不进入效果评估。
- 用户随后已明确授权所审查 29 个文件的提交及正常推送，并检查 Windows/Linux/Docker CI。历史真实实验原始产物和敏感数据继续排除；不涉及模型调用授权。
- 已提交并正常推送 5c066bb406484f1d1303c8abf16aa95be70e5272，CI 41657433565 的 Linux 与 Docker 通过（Docker 73/73，含真实目录身份替换），Windows 181 passed/1 failed/42 skipped。失败为 256 次真实 fsync 的旧审计容量测试触及根入口默认 5 秒；CI 显式采用子包原有 30 秒 testTimeout，不修改该测试、容量上限或验证器 5 秒执行限制。同步允许上传 Docker 隐藏 JSON 报告，继续验证下一提交。
- 配置修正 b32ead240fb38c0ce19df628367e761b715e111c 已正常推送，CI 41658808077 全部 success：https://github.com/Wenzayyds/agent/actions/runs/41658808077 。Linux 184/0/40、Windows 182/0/42（passed/failed/skipped，均 224 身份，209 基线缺失 0）；Docker 73/73、0 skipped，真实身份替换及新验证器负向用例通过。跨 job 去重 222/224 passed，仅两项外部 MCP 条件未执行；Python/pack 检查通过。
- 本轮两关完成，模型调用 0。最终 CI 证据只补记到同一对本地报告和 HANDOFF，未再推送文档触发重复流水线。原始日志/ZIP/计数在 .artifacts/verifier-safety/remote-ci/；后续可转入模块效果评估的规划与单独授权，不复用旧六格预算。

## 2026-11-03：Batch L 公平对比与授权准备

- 按用户要求转向模块收益评估，未新增业务模块。新 batch-l-v1 仍复用生产六格执行器与 run-real-agent；每对同任务、初始 Prompt/文件/工具定义，Memory 和 Task 两组都拥有同样参考资料，仅切换服务可用性；Context 比较长输出管理。固定顺序 M off/on、C on/off、T on/off，thinking=off，无重试。
- Memory/Task 关闭组保留相同只读工具 schema，查询返回不可用，不启动对应 Runtime；开启组复用公开 Memory 搜索与 TaskService 查询，current 映射真实任务 ID。记录配对 hash、规则真实命中、Context 每轮诊断、Task 前后状态及费用估算口径。Task 只读计划保持 draft，不能声称验证了任务自动执行或恢复收益。
- 新真实入口必须提供仓库外、绑定 commit/批次/模型/预算/有效期的显式宿主授权，并独占消费批次与每格记录。拟供单独授权的普通只读拒绝恢复每格上限 2 次，复用 J 的保守分类，未放宽访问权限；真实授权尚未创建，默认严格策略保留。
- 新预算仅为待批准提案：每格 8 请求/80,000 Token/0.03 美元/180 秒，六格 48 请求/480,000 Token/0.18 美元，0 重试。Token 从旧 40,000 提高是为请求字节保守预留留出空间；不沿用历史授权。真实模型调用、付费、提交、推送均 0。
- 本地 TS 225：222 passed/0 failed/3 skipped，旧 224 身份缺失 0；Python 15/15。仅新增 1 项六格 Stub E2E，真实 Pi+Docker+隐藏验证全部通过且配对输入一致。Stub 命中/截短/计划读取只证明观测可用，不是效果证据。root check、评测 TS、新文件 Biome 和 pack 泄漏检查通过。
- 新源码 CI configured_only；上轮 b32ead240fb38c0ce19df628367e761b715e111c 三平台 CI 通过不算本轮证据。交付 docs/batch-l-verification.md、docs/batch-l-results.json，机器证据 .artifacts/batch-l/。待用户分别确认新预算、真实恢复和本轮 Git 远端操作；当前真实六格全部 not_run。既有 p5 结果、上轮验收文档和历史运行目录不纳入本轮提交清单。
- 用户已单独批准本轮最多 2 次普通只读拒绝恢复；新预算与提交/推送仍待回答，不据此启动模型或远端操作。

## Batch L 提交前复审

- 用户要求先审查，再单独授权提交/推送；新 commit 的 Windows/Linux/Docker CI 全通过后，再授权六格真实实验。当前没有预算或 Git 授权，不调用模型。
- 复审发现工作树 42 个历史文档删除、两份未提交 Batch L 报告消失。用户确认删除有意，继续排除；不恢复。实际候选从 13 个调整为 11 个（原清单除去两份报告），历史删除和 evaluation-output 均不提交，暂存区为空。
- 发现并最小修复 Runner 在 Batch L 中覆盖旧 p5-real-model-results.json 的问题；该配置现在只保留独立运行目录结果。原六格 E2E 增加 dry-run 历史报告不变断言，1/1 passed，六格 Stub 通过；根检查、评测 TS、pack 和 diff 检查通过，敏感格式/禁止路径命中 0。
- 上轮全量仍为 225/222 passed/0 failed/3 skipped，本次修复后只跑受影响用例，未冒充新的全量结果。审查交付保存在 .artifacts/batch-l/review-verification.md 和 review-results.json，不恢复已删除报告；待授权 11 文件正常提交/推送后取得本轮远端 CI。
- 用户已授权仅这 11 个文件正常提交、推送并检查 Windows/Linux/Docker CI；真实模型仍需 CI 通过后单独授权，不沿用历史预算。
- 已核对实际暂存清单及 staged diff：11 文件、文件删除 0、敏感格式命中 0；提交 774fa52d8fc39cb9125a99895938729b4ee815e5 已正常推送 origin/pi-agent。42 项文档删除和历史运行目录未纳入，用户删除状态保留。
- 当前提交 CI 41670552429 全部 success：https://github.com/Wenzayyds/agent/actions/runs/41670552429 。Linux 184/0/41、Windows 182/0/43（passed/failed/skipped，225 身份，224 基线缺失 0）；Docker 74/74、0 skipped。合并去重 223/225 passed，仅两项外部 MCP 条件未运行；Python 均 15/15，pack 泄漏 0。Artifact commit/runId 已核对，Docker 新六格 Stub 全部通过、输入配对一致，实际触达规则/截短/计划；不代表真实收益。
- 本轮实际 DeepSeek 请求 0。最终证据更新到 .artifacts/batch-l/review-verification.md、review-results.json 和 remote-ci/；此补记仅本地，不再推送制造新 SHA。状态 ready_for_authorization，待 CI 通过后的全新六格预算确认；不得沿用历史授权启动模型。
- CI 通过后用户明确批准全新六格预算，每格 8 请求/80,000 Token/0.03 美元/180 秒，全批 0.18 美元，不重试。独立干净工作树 774fa52d8 上执行 batch_l_20261104_01；准备期目录联接和构建复制问题均在零真实调用时解决，独立工作树 Stub 通过后才创建一次性真实授权。运行产物 hash 已记录，不修改主工作树删除。
- 真实批次已结束且停止，不再调用模型：Memory off/on、Context on/off 四格均正常结束且隐藏验证通过；Task on 第 9 次请求被 GATEWAY_REQUEST_LIMIT 拒绝（实际转发 8），补丁独立验证通过但 Agent 非正常结束、审计未完成；Task off not_run，没有补跑。总计实际转发 25 请求，输入 87,379/输出 3,316/总 90,695 Token，保守费用 0.0301929 美元，实际 Provider 扣费未知，usage 完整。
- Memory on 命中真实规则但仍读 reference.md，请求 4→4、工具 6→6，Token 少 2.29% 不足以归因稳定收益；Context on 实际截短，总 Token 少 10.23%、估算费用少 6.03%，但请求 4→5、工具 5→7、端到端慢约 1.96 秒。Task 真实计划读取成立、状态 draft→draft，缺少关闭组，不能评估收益。
- 5 份审计快照均校验有效，4 完整；Task 审计 running/35 条已持久化事件/pending 0，明确 unseenEventsPossible=true，未伪造结束状态。真实只读拒绝 0，恢复未触发；工具容器残留 0，新原始结果中真实 API Key 扫描命中 0。历史数据未覆盖，所有结果保留在 evaluation-output/batch_l_20261104_01/；现有同一对审查 MD/JSON 已补真实结果，不新增重复报告、不提交实验数据、不自动使用剩余额度。本轮停止。

## Batch M：仅分析既有真实轨迹

- 用户要求不调用 DeepSeek、不补跑、不直接重构。本轮只读 Batch L 原件及相关源码，36 个原始证据文件在分析前后均通过原清单 SHA256 核对；真实调用、实验补跑、业务代码修改、提交和推送均 0。
- 重要证据缺口：Runner 未落盘完整 Pi stdout，工具记录无 turn/request 对应，网关只保留逐请求完成状态/耗时与整格 usage；没有逐请求 Token、请求消息和中间 Patch。因此只能分别还原真实请求序列与工具顺序，不能定位 Token 差异具体在哪一轮，不能把工具次数当模型轮数。
- Memory 两组 Patch SHA256 完全相同，均读 reference.md/key.js/package.json，均 6 工具/4 请求、grep/find 0。命中 verified 规则成立，使用来源归因与搜索/质量收益未证实；不换 Embedding。
- Context 两组 Patch SHA256 相同。额外工具为 diagnostics.txt 的 201 起分页（首次限 200，关闭组限 2000，无区间重叠），以及 edit 后重读短 validate.js。不能断言这两次是裁剪导致的重复读取，也不能把全部耗时增加归因于 Context。暂不调整阈值，未来先控制分页并补裁剪关联记录。
- Task 第 7 个工具 edit 已形成最终主修复，后续工具 8～13 是写验证脚本、ls 两次、读脚本/formatter/index；不是模型请求 7。隐藏验证只在运行后执行。计划查询 1 次且还读计划文件，是否增加模型轮次未知。第 9 次请求因 GATEWAY_REQUEST_LIMIT 未转发，没有生成回复，无法断定原本仅为最终回答。保留 patchPassed=true/agentCompleted=false/auditComplete=false/overallAccepted=false；关闭组未运行，不能评价 Task 收益。
- 交付同一对 .artifacts/batch-m/batch-m-verification.md 与 batch-m-results.json，包含全部可见逐请求状态、工具序列、诊断与收益证据等级；最小建议仅列出，未实施。后续由用户决定观测记录、统一分页/退出提示或精简计划展示；本轮停止，不复用旧授权调用模型。


## Batch N：评测观测离线验收（2026-11-04）

- 完整任务书已读取：F:/Chrome Download/CODEX_PROMPT_BATCH_N_EVALUATION_OBSERVABILITY.md。本轮未调用模型、未读真实 Key、未提交/推送/触发远端操作；不使用 subagent。保留用户 42 项历史文档删除与既有未提交修改。
- 新增可选 evaluation-telemetry，宿主 --evaluation-telemetry 显式开启；Gateway 最终结算逐请求采集，响应 ID→Pi 回复→工具 ID→确定性 Broker 操作关联。未改预算策略、Pi Core、P1 Policy、Memory/Task/SQLite。Context 仅增加可选元数据诊断回调。
- 生产 Runner+真实 Pi+硬网关+Docker 工具+独立隐藏验证器的四组 Stub 批次通过：观测 on/off 各六格补丁及 Usage 一致；严格越界停止；请求九拒绝后其余五格 not_run。26 请求 Usage 对账一致、26/26 工具与 34/34 Broker 操作关联；turnId 26/26 unknown，Context 消费请求 ID unknown，不用时间猜测。
- 全量 TypeScript 242 身份：239 passed/0 failed/3 skipped，旧 225 缺失 0；Python 15/15。最终受影响用例 17/17（与全量重叠，不累加）。只读静态/evaluation TS/离线构建/包安装回归/最终 pack 扫描通过；pack 107 entries，禁止路径和敏感格式命中均 0。首轮发现旧 worktree 重复身份、Python 发现路径错误、格式差异等均在核心报告如实说明，未删用例或扩大超时。
- 新 batch-n-v1 共享 Prompt，仅待批准配置，真实 execute 在读取 Key 前硬阻断。新 CI 配置已更新，但当前源码未提交，远端状态 configured_only；不能用旧 commit CI 背书。Memory/Task 仅记录触达；Context 只能区分请求行区间、编辑后读取，不能证明裁剪导致重读。
- 核心交付仅 packages/pi-enhanced/docs/batch-n-verification.md 和 batch-n-results.json；详细日志、身份清单及机器证据 .artifacts/batch-n/。Batch L/M 38 文件 SHA256 全部保持。状态 offline_verified_pending_review；停止开发，下一轮真实调用或 Git 远端操作须另行授权。


## Cleanup Batch（2026-11-04）

- 完整阅读 F:/Chrome Download/PI_ENHANCED_CLEANUP_BATCH_PROMPT.md。以当前未提交源码建立 .artifacts/cleanup/baseline.json、145 个 TS 快照和112个保护文件散列；未重置用户工作树，42项原有文档删除保持原状，历史证据112/112散列未变。
- 实质清理：Runner stdout解析5遍→1遍；telemetry先构造后覆盖的两个代码块合并为最终一次构造，复用模块事件及Task状态；成功工具结果改用ID集合；删除内部无人读取的Reservation.id/nextId、重复gateway快照赋值和peer查找。不改Pi Core、P1 Policy、Schema、授权与预算/隔离边界。
- 4个生产源码净减少2671字节/2348个非空白字符/4行；1个现有测试增加284字节/3行，总计净减2387字节/2082个非空白字符/1行。没有删除源码文件或测试身份；相近用例的边界不同，未找到可安全替代的删除对象。
- 全量TS242：239 passed/0 failed/3 skipped；Python15/15；生产Runner六格及越界/请求九停止前后Patch、审计、Usage、费用、模块触达一致。真实tgz安装、Docker六工具、安全负向均通过。强杀恢复与Verifier在两个worker下重复两轮，每轮12/12通过；过滤出的12项不计环境缺口。
- 根只读静态、evaluation TS、离线构建和pack扫描通过；补充扫描旧评测5文件仍有8条既存Biome诊断，清理前后相同，不冒充全绿。Linux挂载目录替换、两项外部MCP未实测；当前源码远端CI configured_only。
- 交付仅 packages/pi-enhanced/docs/cleanup-verification.md、cleanup-results.json；详细证据、逐身份kept映射、清理专属diff在.artifacts/cleanup/。未读真实密钥、未调用付费模型、未暂存/提交/推送/dispatch；停止。


## 核心代码结构整理（2026-11-04）

- 本轮按用户要求实质拆分Runner，不调用模型、不读真实密钥、不暂存/提交/推送。基线与145个TS副本在.artifacts/structure/；用户42项文档删除、N/Cleanup既有改动保持，114个历史保护文件散列不变。
- 只新增3个生产文件：runner-preparation.ts准备合成工作区、配置与种子；runner-execution.ts控制网关/Pi/工具容器及独立Docker验证器；runner-results.ts解释证据、保存与汇总。run-real-agent.ts只保留命令行/授权/阶段调度，从36579字节389行变8561字节204行。因类型/导入/排版，总代码量增加，不声称净减行数。
- 只新增1个测试辅助文件tests/fixtures/runner-support.ts，共享两套Stub HTTP/SSE、四处镜像探测、临时工作区及挂载断言；测试专用sandboxConfigForTesting迁出生产Extension。场景和242身份均保留。共享Stub断言失败由真实子进程确认退出1，不吞错。
- 新结果删除无读取方的hiddenTestExitCode、costClass、agentReportedUsageSource；保留仍由测试、ablation命令和.artifacts/batch-l/collect-real.mjs读取的referenceHash、usageSource、observations和monetaryAccounting。旧JSON/真实原件不修改。
- 最终完整TS242：239 passed/0 failed/3 skipped；Python15/15；生产Runner、六工具Docker、只读Verifier、预算安全负向、强杀恢复、真实tgz安装均通过。四组最终Stub与Cleanup原件在Patch、Usage/费用、审计、模块触达/关联方面一致。根只读静态/evaluation TS、本轮12文件Biome0诊断、离线构建、pack扫描通过。Linux挂载身份与外部MCP未运行；远端CI configured_only。
- .artifacts/structure/ownership.json逐路径区分原有42项删除、N、Cleanup、本轮、真实运行数据；同文件叠加标签，不按文件机械拆提交。当前CI需要N身份基线JSON；建议整体审查工程差异，42项文档删除另列，evaluation-output/密钥/数据库/session/log/cache排除。暂存区仍空，没有擅自清理工作树。
- 交付packages/pi-enhanced/docs/core-structure-verification.md与core-structure-results.json；机器证据.artifacts/structure/。停止开发，待审查。


## 版本收口与本地完整验收（2026-11-04）

- 重新核对分支pi-agent与HEAD 774fa52d8fc39cb9125a99895938729b4ee815e5，暂存区为空。精确候选29文件，清单/逐项归属/保留理由/最终散列在.artifacts/version-freeze/candidates.json；42项用户文档删除、6份N/Cleanup/结构整理旧报告和真实evaluation-output逐项排除，原件保留。前面工作记录所列旧报告按本地归档证据理解，不要求重复提交；CI已改用本轮version-freeze-results.json身份基线。
- 修复CLI导入即执行：私有main加直接入口判断；真实子进程测试先复现BATCH_N_SEPARATE_AUTHORIZATION_REQUIRED，再验证四阶段静态导入不执行/不读真实Key/不创建文件。仅私有化2个内部常量；ModuleSwitches因TS4058所示公共返回类型需要保留导出。候选24个TS只作范围明确的排版，Gateway与执行模块规范化可执行JS和冻结前一致。
- 最终TS243：240 passed/0 failed/3 skipped，旧242缺失0，新增导入回归1项；Python15/15。首轮Docker未启动为201/0/42，保留证据；官方desktop start恢复Engine29.1.3并复用原固定镜像后完整重跑。Linux挂载身份与两项外部MCP仍未在本机执行，Linux身份必须由docker-isolation实际覆盖。
- 生产Runner/Gateway/Docker六工具/Verifier/预算拒绝/隔离拒绝/强杀审计/模块生命周期实跑；最终四组Stub和Cleanup基线在Patch、费用/Usage、审计、触达与状态一致。根只读检查、evaluation TS、候选Biome0诊断、离线构建、正式test-manifest均通过。
- HEAD归档+29项覆盖的独立候选快照打包扫描通过，152项/禁止路径0/密钥形态0；候选tgz安装Sandbox与PythonWorker E2E 6/6，npm强制离线。既有离线回放8/8、Agent dry-run 5项not_run、LSA质量检查仅在候选副本运行，不覆盖用户历史报告，不算真实Agent效果。116个历史保护文件SHA不变。
- 新交付仅packages/pi-enhanced/docs/version-freeze-verification.md、version-freeze-results.json；详细机器证据.artifacts/version-freeze/。本地具备申请远端CI授权条件，最终状态pending_remote_authorization；当前源码Windows/Linux/Docker远端Job均not_run，不借旧CI背书。未对目标仓库add/commit/push/dispatch，未读真实ProviderKey，未调用任何付费模型。停止，等待用户另行授权精确清单后的暂存/提交/推送。

## 2026-11-07 本地清理

- Batch N、Cleanup、核心结构整理的 6 份本地报告移至 `.artifacts/local-archive-20261107/docs/`。上文中的原路径为归档前位置。
- 8 份旧测试输出移至 `.artifacts/local-archive-20261107/test-evidence/`。归档前后逐文件 SHA-256 一致。清除了 3 个可再生的 Python 测试缓存目录和 4 个空目录。
- 正式测试、CI 使用的版本基线、最近两格真实实验报告与现存历史实验目录保留。清理前，最近两格实验报告所引用的 `.artifacts/task-real-paired/` 已不在本仓库原路径。

## 2026-11-07 SWE-bench Verified / Task V2

- 基线 7ceae806e。在原 Runner 中增加固定 Verified Issue、独立浅提交工作区、受限 Patch 导出和官方 Harness 调用/结果解析。Gold 资源闸门实际返回 environment_blocked：Docker 数据盘可用约 90 GB，低于 120 GB；官方 Harness 未运行。
- Task 增加默认关闭的 V2 计划维护、基于真实 attempt 的停滞摘要、最多两次追加式重规划，复用原 SQLite/DAG/CAS/Checkpoint；模型自述只能进入 verifying。OFF/V1 保留，未知写入不重放。
- 完整回归 TypeScript 263 passed/0 failed/3 skipped（266 项）、Python 15/15，五条真实公开 Issue 的 Stub 通路通过；原 243 项测试身份缺失 0。交付仅 docs/swebench-task-v2-design.md、swebench-task-v2-verification.md、swebench-task-v2-results.json；详细证据 .artifacts/swebench-task-v2/。
- 现有 CI 尚不准备新 SWE 本地镜像，需后续配置并确认五项实际运行。真实 SWE 模型入口仍拒绝；后续需 Gold 通过、新提交三平台 CI 和独立实例/模式/预算授权。本轮无付费调用、无 commit/push/远端 CI，保留 42 项旧文档删除与 75 个现存历史文件散列。

## 2026-11-07 Docker 迁移后 Gold 补验

- 用户已将 Docker 数据盘迁至 F:/DockerDesktopWSL。修复资源检查只查 C 盘默认 VHD 的问题，改读 Docker Desktop 的 CustomWslDistroDir；配置磁盘缺失时拒绝回退。实际可用约 151.5 GB，120 GB 闸门通过，原 Agent node:20-alpine 镜像身份一致。
- 原选 Harness 5.x 与固定 Verified 快照实际不兼容，报 KeyError: image。已固定官方发布版 v4.1.0 / 726c5461e2ef52d83cf1ea2107870a8bb3328d57，并匹配其官方报告路径。官方 v4 在 Windows Python 导入缺少 resource；通过独立原生 Linux/amd64 评测容器直接运行官方 CLI，参数复用现有 harnessCommand，没有新增 Agent Runner 或评分器。
- 唯一正式 Gold 实例 astropy__astropy-12907 官方 resolved=true，退出码 0，无超时；FAIL_TO_PASS 2/2，PASS_TO_PASS 13/13。run_id pi_a45b1fe4e2f0_15f4ce12782c42bc8a75b417e61eeded。证据 .artifacts/swebench-task-v2/gold-linux-amd64/，镜像摘要及官方清理证据保留，两个本轮评测控制容器已移除。ARM64 准备阶段在 Harness 启动前停止，未记为第二次正式评测。
- 最终适配专项 12/12（7 单元 + 5 生产 Pi/Stub/Gateway/Docker 通路），类型与 Biome 通过；完整 TS 263/0/3、Python 15/15 仍指迁移前快照，本次未重复全仓。75 个现存历史文件散列不变。
- 官方依赖导入会 load_dotenv。初次 v5 兼容性探测尚未禁用，无法确认该子进程是否加载凭据，报告记 unknown；后续探测与实际 Gold 入口设置 PYTHON_DOTENV_DISABLED=1，没有输出密钥或调用模型。实际 Gold 控制容器不挂载宿主 .env、Agent 工作区或 Provider 配置。
- 更新原有三份 swebench-task-v2 报告，无新说明报告。真实 SWE Agent 成绩仍为 null，真实入口保持 Stub-only，新源码 CI 和独立宿主授权仍待完成。无付费模型调用、无 Git 暂存/提交/推送或远端 CI。

## 2026-11-07 SWE / Task V2 最终离线验收

- 移除实例级 allowedPaths。原先人工路径没有足够的可审计来源记录，无法证明完全独立于已知答案。所有实例统一使用原有源码扩展名、测试/元数据/凭据路径、文件类型、修改方式与补丁大小限制，标为 swebench_verified_source_restricted_v1；不作为标准完整 SWE-bench 条件。历史 Stub 原件保留。
- 在现有 Docker CI Job 内加入三条固定 Astropy base SHA 的公开 Git 镜像准备，加入五项 SWE Stub，并在原 require-docker-evidence 强制检查五个实例/模式身份与数量，拒绝缺失、重复和跳过。未增加 Job，未加入 Gold。本机实际按该步骤准备新镜像，最终全量使用该镜像；远端为 configured_only。
- 三种模式实际比较原始 Issue、base commit/tree、六文件工具定义、模型、thinking 和预算一致，Memory/Context 关闭，taskSeeded=false。Task 工具分别为无、get、get+plan_update。V1 无预置任务且仅有读取工具，结果只能解释为该受限 V1 条件，不能代表完整人工预建任务流程。
- 修复 SWE Agent 已完成但汇总按官方 not_run 误计未运行的问题，保留原字段并独立记录 Agent 尝试、补丁导出和官方状态；额外持久化有界沙箱审计快照。未新增 Task 功能、Runner 或授权框架。
- 最终源码整轮 TS 268 项：265 passed/0 failed/3 skipped，Python 新跑15/15。五项 SWE 实际运行；旧266和版本基线243的测试身份均无丢失。类型/工程检查8项、22文件Biome、离线构建、候选Docker smoke通过。证据 .artifacts/swebench-task-v2/final-acceptance-20261107/。首轮 Docker 未启动/包目录启动的失败、代码收口期间的中间回归及额外候选副本调试失败均单独保留，不拼接为最终统计。
- 7ceae806 直接继承上次用户确认通过 CI 的 82afedb54，两提交之间只有6行 HANDOFF；12个关键安全文件在工作树与82af逐字节一致。现有42项用户文档删除及75个历史保护文件保持。候选29文件含此前未提交实现、本轮必要修正和3份核心报告，排除历史报告/数据/密钥/数据库/session/运行产物，暂存区为空。
- Gold 控制容器无直接凭据环境变量或私有挂载，但共享 Docker socket 具有宿主数据访问能力，不能声称完全隔离；更强隔离需要无凭据的专用评测宿主/daemon。历史第三方导入是否加载凭据仍为unknown。真实 SWE入口仍SWE_STUB_ONLY，旧两格授权不适用，未来需在原授权链补齐SWE范围及真实输出边界。三组Pilot仅提出每组12请求/80,000Token/$0.03/180秒、总$0.09的新待审方案，没有授权或执行。

## 2026-11-07 SWE 三模式真实准入适配

- 基线0ba05f641（CI Run42356930905三项通过）；在现有 Task Pair 授权协议/批次执行器中补齐 swe-task-v1，不新增 Runner/授权框架。固定13033、Commit/配置/CI/模式输入、输出身份、24h有效期及wx一次性消费；每格首个上游请求前匹配指纹，严格停止不放宽。
- 用户本轮已明确批准新$0.09：OFF→V1→V2各一次、每格12请求/80kToken/$0.03/180s、不重试。当前未读真实Key、未调用模型、未创建grant；必须先取得新源码提交/推送授权及新Commit三项CI。
- 实际修复真实SWE标签、独占输出与历史P5 writer隔离；保存脱敏Agent JSONL、审计和安全部分Patch。官方入口增加--agent-result，按实例/Patch SHA绑定独立assessment，不把Agent完成或Stub当resolved。
- 最终全量TS 270/0/3（总273，旧268身份无丢失），Python15/15；类型/工程8、Biome13文件0诊断、离线build/pack扫描通过。新生产三模式Stub校准/匹配/失配拒绝实跑，旧五项SWE和安全回归保留。详细证据.artifacts/swe-pilot-admission/；三份原swebench-task-v2报告更新，不新增核心报告。
- 原42项文档删除及75个历史保护文件不变。新源码CI未运行，状态pending_remote_authorization。官方可信控制容器共享Docker socket的限制及历史dotenv未知事实保持；停止等待精确清单Git授权。

## 2026-11-07 SWE 三模式提交、CI 与真实停止记录

- 用户单独批准17文件提交/正常推送，提交106d6e190bd516e1fb6b718b979040db7f5c6d43；CI Run42382223747三项成功。下载3份artifact摘要匹配、72份日志；Linux221/0/52、Windows219/0/54、Docker101/0/0，五项SWE和新三模式准入实际通过。主工作树42项文档删除保持，75个历史散列不变。
- 独立干净worktree在.artifacts/swe-pilot-admission/checkout，原构建/固定依赖复用。真实宿主三模式Stub校准6次，生成逐模式指纹；新一次性grant按已批准$0.09绑定该Commit/CI/配置/输出/有效期。通过后才加载宿主Key，只交给原网关，不进入Pi/Docker。
- 真实批次swe_task_real_20261107a已消费并停止，绝不能复用剩余预算或补跑。OFF仅转发7次，input41126/output1874/total43000，网关固定费率结算$0.0145866（Provider发票unknown）；第8次GATEWAY_TOKEN_BUDGET转发前拒绝。V1/V2未运行；官方Harness三格均not_run，无Benchmark成功率或Task收益结论。
- 已观察10个成功文件工具调用（grep2/read4/edit4），编辑core.py和tests/test_sampled.py。共用source-only导出拒绝测试路径，SWE_PATCH_PATH_DENIED，无合格predictions或权威Git Patch。编辑事件原文保留，未过滤测试后冒充原Patch；拒绝Patch未单独留快照是诊断缺口。
- 原始runStatus=budget_stopped，但本轮collector的导出错误优先级把raw termination标成isolation_boundary_stop。已保存记录无实际越界/容器错误；不改原始证据，在最新报告分列原因。18个审计事件ok且integrity valid，session未关闭所以auditComplete=false、unseenEventsPossible=true；Telemetry complete不替代完整审计。
- 已更新原三份SWE报告，最新实验结果与HANDOFF更新未再提交。未改生产源码、未追加commit/push、未增加模型调用或预算；下轮需先审查统一补丁条件说明、拒绝Patch诊断保留及终止分类，不能直接重试。所有机器证据.artifacts/swe-pilot-admission/。

## SWE 三项离线修复进行中（最终源码已冻结）

- 用户本轮仅授权协议/预算诊断/分类修复及离线测试，禁止任何付费模型、主仓库Git提交/推送、远端CI和正式重跑；旧$0.09已消费不可复用。无subagent。
- 基线106d6e190；先保存4项原未提交记录至.artifacts/swe-pilot-repair/prior，baseline.json保护124个历史/host-output文件及42项删除。未读.env或真实Key。
- 已完成：swePrompt追加三模式共同规则，safePatchPath共用写入guard/导出，允许读测试、tracked源码写入，拒绝测试（含__tests__/__specs__）；配置新增共同Prompt指纹，原授权链不重写。预算仅加ReservationDiagnostics，保留原byte+4096、费率/额度/拒绝顺序；移除Patch错误覆盖终止分类，父批次另按导出错误停止，元数据诊断不含正文/凭据、不生成拒绝预测。
- 持久化新增tests/e2e/swebench-policy.test.ts九场景；原5项SWE及3模式顺序测试保留。初期budget夹具重复toolCallId，改唯一ID后预算拒绝通过；9项E2E全部通过过两轮。中间全量因CI YAML CRLF失败（278/1/3），已修复LF；补充命名时旧测试进程缓存模块导致另一中间轮不采用，最新独立SWE单元9/9通过。禁止把中间统计拼成最终结果。
- 当前20项源码/配置SHA已冻结在.artifacts/swe-pilot-repair/source-hashes.json，invariants.json证明预留决策函数（剔除诊断）与基线一致，Harness后半段、Sandbox/P1关键8文件不变、124历史SHA和42删除不变。18TS+1JSON Biome0诊断。正在重新执行checks.py（8检查）及build-final.log；随后需在完全冻结代码上再完整跑accepted JSON，不再改源码。Python15/15已通过。
- 最终汇总脚本.artifacts/swe-pilot-repair/finish.py尚未执行；它要求typescript-accepted.json（282项、零fail）、accepted-stub九场景、source SHA不变，更新原3份SWE报告/HANDOFF并生成changed-files.json。日志/证据只放.artifacts/swe-pilot-repair。不调用旧host-pilot.mjs、不生成真实grant。最终新源码CI只能configured_only，需日后新Git授权、CI、宿主校准和全新付费授权。

## SWE 三项问题离线修复收口

- 基线106d6e190，原4项未提交记录及42项删除保留，先备份至.artifacts/swe-pilot-repair/prior。旧真实目录、grant消费标记和历史共124文件SHA不变；无真实Key读取、付费API、主仓库add/commit/push或远端CI。
- 同一swePrompt追加统一协议说明，safePatchPath共用到SWE tool_call和导出，允许读测试，写入测试/未跟踪文件在Broker前拒绝，覆盖__tests__/__specs__等常见命名，无答案路径白名单；配置摘要和userPrompt指纹同步更新。
- Token/费用拒绝增加纯metadata预留诊断，原公式/额度/费率/顺序不变。旧第8次缺失输入保持unknown。移除导出错误覆盖终止分类，分别保存gatewayRejections/patchExportError/patchDiagnostic/auditStatus；拒绝候选只留有界路径/hash/字节，不留正文或伪造predictions。
- 最终冻结源码整轮TS279/0/3（282），旧273无丢失，新9项真实Pi/Stub/Docker；Python15/15、检查8、Biome19文件0诊断、离线build/pack通过。初期重复Stub ID、CI YAML CRLF和中间轮次均保留原始证据，不拼统计。
- 官方Harness与关键Sandbox/P1未变，无Task功能/Runner架构重写。仅更新原三份报告，精确清单和机器证据.artifacts/swe-pilot-repair/。当前源码未提交，旧106绿色CI不代表新改动；下一步需新Commit/新CI/新宿主指纹及全新预算与grant，绝不复用已消费$0.09。停止等待审查。

## 2026-11-08 三模式独立继续：当前离线验收进度

- 新任务书为粘贴附件，已完整阅读；禁止新增Batch/Runner/Task功能、Git和真实调用。旧$0.09不可复用。当前基线106d6e190未变，原24候选先备份在.artifacts/swe-continuation/prior。
- 已在现有run-controlled/runner-execution/run-real-agent增加宿主清理收据和SWE专用继续核对，原严格六格/两格不改；新提案20请求/200k/$0.08/600秒，整批60/600k/$0.24只是配置，无付费授权或真实grant。
- 22项源码/配置已冻结，.artifacts/swe-continuation/source-hashes.json；最终类型/工程8项、Biome21、build:offline、Python15均过。整轮TS运行中，session93965，日志typescript-final.log，JSONtypescript-final.json；17项SWE生产策略/继续E2E已全部通过，旧回归继续。
- 需要等待整轮结束，再运行.artifacts/swe-continuation/finish.py（要求291总、零fail、旧282身份无丢失、历史124 SHA/42删除不变），它只更新原三报告/HANDOFF并生成26候选SHA及机器汇总；随后check:pack和最终完整性复核。
- 不要调用历史host-pilot.mjs或旧grant，不要修改已冻结源码，不要运行旧repair目录的finish/invariants脚本覆盖旧证据。新证据均在.artifacts/swe-continuation。当前Workflow与Gateway相对上轮未修改。

## 2026-11-08 SWE 三组独立资源停止准备收口

- 用户粘贴任务书要求离线完成三组继续策略、新预算待审方案和公平/评分链路验收；不新增Batch/Runner/Task功能，不授权Git或真实调用。旧$0.09已消费，绝不复用。
- 基线106d6e190未变，先备份24个既有改动到.artifacts/swe-continuation/prior，保护历史124文件与42删除；新增候选仅run-controlled/runner-execution，合计26。
- SWE专用host-cleanup原子收据绑定真实退出/PID、网关零在途/预留/Usage、容器清理、工作区身份、私有root真正移除、result/run SHA。父批次核对后才继续资源停止/空补丁，任何未知写入/审计/账本/安全/授权/指纹不明仍停批。前序continueReady和grant有效期/wx消费须通过；其他Profile仍严格。
- 待批准Profile每格20请求/200kToken/$0.08/600秒，输出2048/thinking off/并发1/0重试，全批60/600k/$0.24；配置摘要失效旧grant。网关、Workflow本轮均未改。Stub限额只能缩小且仅回环，真实禁用。
- 最终TS288/0/3共291，原282无丢失，新8 E2E+1单测；五SWE、17策略/继续、旧强杀/隔离/验证器/模块回归均保留实跑。Python15/15，8检查、Biome21、build/pack通过。超时测试暂停实际Pi而非容器/状态mock；早期失败夹具证据保留。
- 原三份SWE报告追加/更新，所有原真实/Gold/授权/CI证据124 SHA保持；完整机器证据及26候选SHA在.artifacts/swe-continuation。旧request8精确尺寸仍unknown，新额度只能缓解不保证。官方评分入口未改，本轮无Harness新成绩/付费/真实Key/新grant/Git/远端。
- 后续等待审查、Git明确授权、新Commit三项CI、干净检出和实际宿主校准，再另批$0.24和新一次性宿主grant；不运行历史绑定旧Commit的host-pilot，不自动重跑。
