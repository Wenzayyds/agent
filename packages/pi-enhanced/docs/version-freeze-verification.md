# 版本收口与本地完整验收

最终状态：**pending_remote_authorization**。目标仓库分支为 `pi-agent`，重新核对的 HEAD 为 `774fa52d8fc39cb9125a99895938729b4ee815e5`。本轮没有目标仓库的 add、commit、push、dispatch、Tag、Release 或 publish，没有读取真实 Provider Key、调用付费模型或启动真实实验。远端验收尚未执行，不能引用旧提交的绿色 CI。

## 候选提交清单

精确候选为 **29 个文件**，不是目录通配符。原始状态、diff、暂存区与散列在 `.artifacts/version-freeze/`；暂存区起始为空。下表按真实引用关系整理，不能把同一文件上的 N/Cleanup/结构整理改动当作互不依赖的文件提交。

| 路径 | 归属 | 保留理由 |
| --- | --- | --- |
| `.github/workflows/pi-enhanced-ci.yml` | Batch N、版本收口 | Windows/Linux/Docker 离线入口、Telemetry E2E 与当前身份基线；排除历史 worktree 副本 |
| `HANDOFF.md` | Cleanup、版本收口 | 保留既有工作记录并注明报告仅本地归档；追加本轮授权边界和准入状态 |
| `packages/pi-enhanced/benchmarks/real-agent/budget-gateway.ts` | Batch N、Cleanup | 可选最终结算观测；保留原预留/拒绝/失败关闭逻辑，去除未用私有计数器 |
| `packages/pi-enhanced/benchmarks/real-agent/context-probe.ts` | Batch N | 受信任开关下的有界 Context 视图元数据，不改变裁剪输出 |
| `packages/pi-enhanced/benchmarks/real-agent/evaluation-policy.ts` | Cleanup | 复用一次 stdout 解析，保留历史状态字段与预算判定 |
| `packages/pi-enhanced/benchmarks/real-agent/evaluation-telemetry.ts` | Batch N、版本收口 | 有界请求/工具关联、Usage 对账及恢复读取；私有化内部常量 |
| `packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts` | Batch N、Cleanup | 批次观测开关、公平性及完整性验收，复用 peer 查询 |
| `packages/pi-enhanced/benchmarks/real-agent/run-real-agent.ts` | Batch N、Cleanup、核心结构整理、版本收口 | 命令行授权与阶段调度；新增直接执行保护，避免导入触发任务 |
| `packages/pi-enhanced/benchmarks/real-agent/runner-execution.ts` | 核心结构整理 | 隔离环境、Gateway/Pi 生命周期、停止清理与独立 Docker 验证 |
| `packages/pi-enhanced/benchmarks/real-agent/runner-preparation.ts` | 核心结构整理 | 合成失败夹具、模块配置及 Memory/Task 种子准备 |
| `packages/pi-enhanced/benchmarks/real-agent/runner-results.ts` | 核心结构整理 | 结果解释、独立状态、触达、审计保存及汇总 |
| `packages/pi-enhanced/docs/version-freeze-results.json` | 版本收口 | 本轮结构化验收和 CI 必需的完整测试身份基线 |
| `packages/pi-enhanced/docs/version-freeze-verification.md` | 版本收口 | 本轮唯一核心验收说明、候选/排除及授权边界 |
| `packages/pi-enhanced/scripts/ci/require-docker-evidence.ts` | Batch N | Linux Docker 必须实跑新增生产 Runner/Telemetry 用例，不接受 skip 代替 |
| `packages/pi-enhanced/src/context/extension.ts` | Batch N | 可选观测回调；异常不影响 Context 输出 |
| `packages/pi-enhanced/src/sandbox/extension.ts` | 核心结构整理 | 迁出仅测试使用的配置 helper；Sandbox 权限边界保持 |
| `packages/pi-enhanced/tests/e2e/batch-n-observability.test.ts` | Batch N | 生产六格 on/off、越界和请求九拒绝场景；不替代真实模型评测 |
| `packages/pi-enhanced/tests/e2e/docker-verifier.test.ts` | 核心结构整理 | 共享安全夹具和挂载断言，保留恶意补丁负向场景 |
| `packages/pi-enhanced/tests/e2e/gateway-sandbox-e2e.test.ts` | 核心结构整理 | 共享 Stub、SSE、Docker 探测；保留真实联合执行链 |
| `packages/pi-enhanced/tests/e2e/real-agent-runner-e2e.test.ts` | 核心结构整理 | 共享 Stub 与挂载断言，保留真实生产 Runner 和独立验证 |
| `packages/pi-enhanced/tests/e2e/sandbox-agent-session.test.ts` | 核心结构整理 | 迁移测试 helper/Docker 探测；保留六工具及安装包 E2E |
| `packages/pi-enhanced/tests/fixtures/runner-support.ts` | 核心结构整理 | 共享测试专用夹具、loopback Stub 和容器证据断言，无全局注册表 |
| `packages/pi-enhanced/tests/fixtures/sandbox-audit-child.ts` | 核心结构整理 | 强杀审计子进程改用测试目录配置 helper |
| `packages/pi-enhanced/tests/unit/batch-j-policy-audit.test.ts` | 核心结构整理 | 迁移共享工作区夹具；保留审计一致性和安全拒绝 |
| `packages/pi-enhanced/tests/unit/ci-workflow.test.ts` | 版本收口 | 离线与付费 Workflow 边界；固定当前基线引用与历史副本排除 |
| `packages/pi-enhanced/tests/unit/docker-ci-evidence.test.ts` | Batch N | 验证新增 Docker 必跑套件与缺失/跳过拒绝 |
| `packages/pi-enhanced/tests/unit/evaluation-telemetry.test.ts` | Batch N | 请求结算、关联未知、泄漏/上限、写入失败与中断持久化回归 |
| `packages/pi-enhanced/tests/unit/real-agent-policy.test.ts` | Cleanup、版本收口 | 一次解析一致性及四阶段导入不执行/不读 Key 的真实子进程回归 |
| `packages/pi-enhanced/tsconfig.evaluation.json` | Batch N | 评测源码和新增持久化测试的类型检查范围 |

29 项清单是未来申请暂存的范围，当前没有执行暂存。最终逐文件 SHA-256 保存在外部 `candidates.json`；结果 JSON 不嵌入自己的散列，避免自引用。后续授权后仍须对照清单检查 staged diff、敏感内容、意外删除和 HEAD 是否漂移，再正常提交和推送。

## 排除项和已有工作树

- **42 项用户已有历史文档删除**：逐路径列入结果 JSON，保留原状，不计入本轮工程提交；没有恢复或清理。
- **6 份旧报告**：Batch N、Cleanup、核心结构整理各一对 MD/JSON，原件留在本地，未删除或改写。本轮报告已涵盖收口结论，CI 改用本轮 JSON 的 `typescript.identities`，不再为了测试基线提交整份旧 N 观测报告。HANDOFF 中对应路径按本地归档证据理解。
- `evaluation-output/**` 的原始真实实验逐文件排除；数据库、Session、密钥、日志、模型缓存与 `.artifacts/**` 均不在候选范围。
- 原有跟踪报告仍属于 HEAD 的内容，未纳入新的删除。候选快照以 `git archive HEAD` 加精确清单覆盖产生，所以它与当前保留 42 项删除的工作树文件集合不同；两个集合不会混同。

没有靠 reset、clean、stash、覆盖用户文件或修改 Git index 整理工作树。既有合成测试会在新建临时夹具仓库中创建固定提交，与用户目标分支的提交操作区分。

## 审查发现和本轮修改

1. **CLI 导入副作用**：原入口在导入时会读取参数并进入默认流程。新增子进程测试先以无真实 Key、带 execute/profile 的合成参数复现失败（`BATCH_N_SEPARATE_AUTHORIZATION_REQUIRED`），再将原启动代码放入私有 main，并仅在直接运行该文件时调用。四个阶段可静态导入，工作目录不产生文件；直接 CLI 的授权、预检和流程保持。
2. **CI 基线引用过时**：Workflow 由 N 完整报告改读本轮结果 JSON；Vitest 显式排除历史 `.artifacts` 副本，保留原超时、worker 数和全部测试场景。对应 CI 边界测试已有持久化断言。
3. **内部导出**：Telemetry 的版本及字节上限常量无外部导入，改为私有，行为不变。`ModuleSwitches` 导出保留：尝试私有化时 TS4058 证明导出的结果类型需要这个可命名类型，已恢复并通过类型检查。
4. **候选排版**：只整理明确清单中的 24 个 TS 文件，未增加生产模块、抽象层或依赖。既有 CI 测试的模板占位字面量改为等价正则断言，消除 Biome 诊断。

复现失败、恢复前的类型诊断和最终修复检查分别保留，不混入最终 passed 统计。生产修改集中于 CLI 导入保护；没有修改 Pi Core、Native Guard、MCP Policy、Memory/Task Schema、Session JSONL、Compaction 或权限阈值。

## 四阶段与安全审查

| 要求 | 证据与结论 |
| --- | --- |
| 单向依赖 | 使用已有 esbuild 编译而不执行，提取 Pi Enhanced 本地 runtime import 图：29 个模块，循环 0。类型边、Pi Core/第三方内部图不伪装成本轮无环证明 |
| 导入不执行 | 真实 Node 子进程静态导入入口与三个阶段，环境无 Provider Key；只输出导入标记、临时目录为空。CLI 仍是唯一实验命令入口 |
| 预算保持 | 本轮前后 Budget Gateway 与执行模块经 TS 擦除、规范化的可执行 JS 相同；请求、Token、费用、预留和失败关闭策略未改。预算负向测试实跑 |
| 无宿主回退 | 真实 Pi CLI + Docker 六工具及只读验证容器实跑；越界、符号链接、未知工具、容器丢失、恶意 verifier、强杀审计等负向保留 |
| 独立状态 | 继续分别记录 runStatus、patchStatus、auditComplete、evaluationAccepted；补丁通过不代表 Agent 正常结束或审计完整 |
| Telemetry | 默认关闭；关闭组不产生新 telemetry/views，原有诊断保留。on/off 补丁、Usage、业务结果一致；权威 ID 缺失仍 unknown，不推测 Context 因果 |
| 测试共享状态 | 共享文件只定义函数；每个 server、工作区及调用方 registry 单独创建，没有全局可变注册表。断言失败继续抛出，不吞错 |
| 有效入口与类型 | 阶段导出均有调用或公共类型需要；测试专用 helper 已迁出生产目录；原有公开 ablation/历史读取仍有调用方，未误删 |

## 实际回归

| 项目 | 本轮结果 |
| --- | --- |
| 首轮（Docker 未启动） | 243 项：201 passed / 0 failed / 42 skipped；保留原始报告，不作为 Docker 通过证据 |
| 最终全量 TypeScript | **243 项：240 passed / 0 failed / 3 skipped**；原 242 身份全部保留，新增 1 项 CLI 导入回归 |
| Python | **15/15** |
| 修复专项 | 7/7；包括导入与 CI 引用边界，和全量重叠，不累加计数 |
| Docker 生产路径 | 原固定镜像、本地 Stub、Gateway、Pi CLI、六文件工具、独立只读 verifier；含拒绝、强杀恢复、异常验证器及 Memory/Context/Task 生命周期 |
| 与 Cleanup 基线对照 | 最终四组 Stub 的 Patch SHA、隐藏验证、终止状态、审计操作/完整度、Usage/费用、模块触达/关联一致；计时不作逐值相等要求 |
| 类型 / 依赖 / 入口 | 根只读等价检查及 evaluation TS 通过；固定依赖、运行时依赖、相对导入、入口图、安装锁、browser smoke 均检查 |
| Biome | 根配置只读检查及候选 24 文件检查通过；没有执行根含 --write 的聚合命令 |
| 离线构建 | 现有 build:offline 通过，不执行在线模型数据下载 |
| npm pack/install | 工作树已有 tgz 安装 E2E 已执行；另对候选快照打包/安装、泄漏扫描及官方离线评估入口取证，最终状态看 JSON，不以旧报告代替 |

Docker 最初确实未运行。启动官方本地 Desktop CLI 后 Engine 恢复到 29.1.3，复用原固定镜像再跑完整测试；没有拉取新模型或增加预算。第一次静态图分析把 Pi Core/第三方内部循环也算入，已明确收窄到本任务要求的 Pi Enhanced 本地依赖，外部代码未改。

三个最终 skip 为：Windows 无法执行的 Linux 已挂载目录替换，以及两个外部 MCP 场景（Context7、Serena）。Linux 身份用例必须在 `docker-isolation` 的 ubuntu-latest 真正执行，现有 gate 拒绝它被跳过；两个外部 MCP 不在无密钥离线 CI 的通过声明内，需另行配置外部集成环境。没有把 skipped 计为 passed。

## 候选版本复现及远端准入

候选快照不是新 Git worktree 或提交，只是 HEAD 归档加本次精确覆盖；所有覆盖文件与工作树按散列核对。依赖与既有构建产物引用本地文件，候选安装使用离线 npm，不访问模型。会写旧报告的已有 evaluate 入口只在这个新快照内运行，避免覆盖用户原件或恢复工作树中的文档删除。

最终本地准入状态由 JSON 的 `admission` 字段给出：须满足全量无失败、预期环境 skip 有明确 CI 去向、候选打包/安装与敏感扫描通过、旧 Stub 对照一致、历史证据未变。受保护历史文件共 116 个，散列核对未变；密钥、日志、数据不进入候选清单。

**远端状态仍为 pending_remote_authorization。** Windows、Linux、Docker 三个当前源码 CI Job 均尚未运行；本轮没有 Git add/commit/push 或 dispatch 权限。获得针对精确清单的新授权后，才能检查暂存差异、正常提交/推送，再下载核对同一 Commit 的三 Job 证据。远端若失败，保留失败证据并报告，不未经追加授权继续推送修复。
