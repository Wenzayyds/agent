# SWE-bench Verified / Task V2 最终离线验收

当前分支 pi-agent，HEAD `7ceae806eb21a03e90e78981f6c7660cd89198ac`。本轮付费模型调用 0，费用 0，Git 暂存/提交/推送与远端 CI 均未执行。完成离线收口，真实 Pilot 仍受准入条件阻断。

## 实例来源与文件限制

原三个候选的 allowedPaths 是人工按题目指定的少量文件。没有足够的生成记录证明它们独立于已知答案，来源审计记为 unknown。本轮已从清单、运行时类型、加载及 Patch 导出中移除该字段。生产 Agent 只接收公开原始 problem_statement，身份固定到公开 repo/base_commit；不读取 patch、test_patch、隐藏测试列表或 Gold 计划。

三个实例共用源码安全规则，保留工作区/符号链接/元数据/凭据保护及补丁扩展名、修改方式、大小限制。没有放宽 Docker 挂载或文件工具权限。测试统一修改无关的 astropy/__init__.py，补丁明确是“不修复问题”的注释，只验证导出和隔离通路。

协议为 `swebench_verified_source_restricted_v1`。它禁止修改测试、未跟踪新文件、删除、重命名、权限与二进制变化，并限制源码扩展名，因此属于受限源码 Pilot。官方 Harness 格式和单实例判分结果可使用，但不能宣称标准完整 SWE-bench 成绩。

## 最终源码的整轮结果

最终一轮来自 `typescript-accepted.json`，共 268 项，**265 passed / 0 failed / 3 skipped**。没有拼接旧结果。旧完整 266 项和版本基线 243 项身份缺失均为 0，没有删除测试。Python 在本轮最终源码上重新运行 **15 passed / 0 failed / 0 skipped**。

三个跳过分别为 Windows 无法执行的 Linux 挂载身份替换，以及未开启的 Serena、Context7 外部 MCP 测试。五项 SWE Stub 全部实际通过，OFF/V1/V2、其他两个公开实例、V2 计划更新与有界重规划均运行。全量覆盖真实 Pi CLI、Stub、网关、六文件工具 Docker、预算/隔离拒绝、异常验证器、强杀审计恢复、Memory/Context/Task 生命周期、SQLite 迁移和真实安装包。

类型与工程检查 8/8，22 个变更 TS 文件 Biome 0 诊断，最终离线构建通过。独立候选快照 Docker smoke 的宿主文件/凭据隐藏、只读根、只读挂载、工作区可写与无网络六项通过。包扫描 159 项，禁入文件和密钥形态均为 0。smoke 在候选快照执行，输出复制到证据目录，没有覆盖原工作树历史报告。

中间失败单独保留。第一轮 Docker 未启动且使用包目录运行，215/2/51；恢复后收口期间整轮为 264/1/3，其中 Batch L 一次缺失输入审计，精确瞬时原因未确认。单独复跑当前源用例通过，调试命令还误匹配了未构建的归档候选副本并失败。最终整轮在代码和构建冻结后从仓库根运行，排除 `.artifacts`，Batch L 通过；未放宽断言、预算或超时。

## CI、基线与历史保护

现有 docker-isolation Job 新增固定公开 Astropy Git 镜像准备，只取三个 base SHA，不安装 Gold Harness、不拉大型官方评测镜像。基础工具 Docker 镜像仍为固定 node:20-alpine SHA。新增 SWE Stub 进入现有测试命令，原 require-docker-evidence 必须看到五个正确实例/模式且全部通过，缺失、重复、跳过都会失败；已有验证器缺失负向断言保留。

本机实际复现镜像准备，最终全量使用该新镜像。Docker CI 所选用例在本机实际为 **99 passed / 0 failed / 1 skipped，共 100 项**，其中 Linux 身份替换在 Windows 跳过，原准入检查正确拒绝通过。远端为 **configured_only**，不以本机结果冒充新提交的 Linux/Windows/Docker CI。

`82afedb54e1611e65643df46e970d358f52b8b14` 是当前 HEAD 的直接祖先，两者之间只有 6 行 HANDOFF 新增。12 个关键安全文件与 82af 逐字节一致，包含网关、原授权链、隐藏验证器、P1 Policy/Native Guard、Sandbox Broker/协议/审计/Worker。当前 Sandbox 差异是此前已实现的默认关闭 Task 计划能力及精确工具放行，没有宿主文件回退。上次 CI Run 41998332584 来自已保存报告和用户确认，本轮未重新获取远端证据。

75 个现存历史文件散列一致，42 项用户文档删除保持。真实实验原件、task-real-paired 两份报告、数据库、Session、密钥、日志和运行目录全部排除候选。暂存区为空。

## 三模式公平性与状态

实际 Stub 断言核对三组原始问题逐字相同、base_commit/文件树相同、六文件工具定义相同、provider/model、thinking 与预算相同。三组均关闭 Memory/Context，taskSeeded=false。共同指纹和逐组完整工具散列见 final-evidence.json；实际 wire 的基础工具和输出上限相等由 Stub 首次请求断言，未单独落盘的原始 wire 指纹不伪造数值。

| 模式 | 实际 Task 工具 | 初始 Task 计划 |
| --- | --- | --- |
| OFF | 无 | 无 |
| V1 | enhanced_task_get | 无 |
| V2 | enhanced_task_get、enhanced_task_plan_update | 无，后续由模型创建 |

Task 工具定义及后续进度消息属于实验变量。V1 在这个实验里只读且没有预建任务，不能将其结果解释为完整人工预建计划流程的收益。Stub V2 的两次更新/一次重规划只证明机制触达，不证明真实模型收益。

修复了 SWE 官方尚未判分时，通用汇总将已执行 Agent 错计 not_run 的问题。保留原 status 兼容字段，新增 agentAttempted、patchExportStatus、officialHarnessStatus；Agent 正常结束、审计完成和官方 resolved 分开记录。SWE 另存有界脱敏 sandbox-audit.json。没有官方报告时 resolved 为 null、passed 为 0。

## 评测器信任边界

既有 Gold 实例 astropy__astropy-12907 官方 resolved=true，FAIL_TO_PASS 2/2、PASS_TO_PASS 13/13、退出码 0 的原件保持，本轮未重跑。Harness 固定官方 v4.1.0 / 726c5461e2ef52d83cf1ea2107870a8bb3328d57，数据 revision 和 Parquet 散列保持。资源检查现有约 147 GB 可用空间，数据盘位于 F:/DockerDesktopWSL/disk。

Gold 控制容器没有直接 Provider 凭据环境变量，没有宿主 .env 或 Agent 私有目录挂载，并设置 PYTHON_DOTENV_DISABLED=1。但共享 Docker socket 可操作 daemon，因而不能保证对宿主数据完全隔离。若要求该强边界，需要无凭据的专用评测宿主/daemon。Agent 的文件工具容器不挂 socket，仍保持无网络、只读根、临时项目挂载。

历史首次 v5 兼容性导入是否通过上游 load_dotenv 加载宿主凭据仍记 unknown。本轮不读取凭据值来补证，不把 unknown 改成“从未加载”。

## 最小真实 Pilot 方案及准确入口

仅选 astropy__astropy-13033，base `298ccb478e6bf092953bca67a3d29dc6c35f6752`。新版本三项 CI 通过并得到新的明确授权后，顺序 OFF → V1 → V2，每组一次、不重试。建议沿用当前离线验证配置，每组 12 请求、80,000 Token、$0.03 网关上限、180 秒；三组提案总上限 36 请求、240,000 Token、$0.09。**这是待批准提案，没有沿用旧预算，也没有执行。**

现有生产入口如下。模式分别取 off、v1、v2，各自新 run_id 和独占输出目录。**当前真实执行会在最前方返回 SWE_STUB_ONLY，尚无可合法运行这三组的真实入口。** 旧 Task Pair grant 仅支持两格合成任务。需复用现有授权链补齐 SWE 的实例、Commit、共同输入和逐模式工具绑定，先经新版本 CI，再单独授权；本轮未新增授权框架。

```text
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/run-real-agent.ts --execute --run-id <NEW_RUN_ID> --swebench-id astropy__astropy-13033 --swebench-mirror <ABS_PUBLIC_MIRROR> --task-mode off --provider deepseek --model deepseek-flash --api-key-env DEEPSEEK_API_KEY --max-total-cost-usd 0.03 --max-tasks 1 --max-tokens-per-task 80000 --max-calls-per-task 12 --timeout-ms 180000 --concurrency 1 --budget-enforcement local_hard_gateway --output-dir <ABS_HOST_OUTPUT> --sandbox-image sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
```

开通前还需复核真实标签和输出边界。现有 SWE collector 的 model_name_or_path 标为 stub；通用真实非 comparison writer 会写历史 P5 报告，真实 SWE 必须限定独占运行目录。当前异常结束或审计不完整时不导出补丁，这类格子应保留 Agent/网关失败及 Patch=null、Harness=not_run，不能记为已获官方 unresolved。这些分支当前被 Stub-only 闸门封闭，未伪造可用入口。

获得合格 predictions.jsonl 后，在上述专用 Linux 评测环境调用既有官方适配入口，每格使用新输出目录，不把 Gold 数据交给 Agent。

```text
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/swebench.ts --instance astropy__astropy-13033 --execute --harness-checkout <ABS_OFFICIAL_AT_726c546> --parquet <ABS_PINNED_PARQUET> --prediction <ABS_PREDICTIONS_JSONL> --output-dir <ABS_FRESH_EVALUATOR_OUTPUT>
```

每格保存官方 resolved/unresolved/error/timeout/not_run、Patch/SHA、agentCompleted、auditComplete、逐请求转发/拒绝、Provider 实报 Usage、网关配置费率下的费用、文件工具调用、计划更新和重规划。Provider 发票费用无可靠接口时记 unknown。总体成功须同时满足官方 resolved、Agent 正常结束、审计完成；三者分别展示。一次一题三组只能形成探索性配对观察，不能证明总体成功率或 Task 普遍收益。

## 复现离线检查与候选文件

从仓库根运行，按现有 Workflow 准备固定镜像。完整入口必须排除 .artifacts，以免把未构建候选副本当项目测试。

```powershell
$env:PI_ENHANCED_SWE_LOCAL_MIRROR = (Resolve-Path '.artifacts/swebench-task-v2/final-acceptance-20261107/ci-astropy.git').Path
npm exec vitest -- --run packages/pi-enhanced/tests/unit packages/pi-enhanced/tests/integration packages/pi-enhanced/tests/e2e --exclude '**/.artifacts/**' --maxWorkers=1 --testTimeout=30000 --reporter=default --reporter=json --outputFile=<NEW_REPORT_JSON>
$env:PYTHONPATH = 'packages/pi-enhanced/python/memory-intelligence/src'
python -m pytest packages/pi-enhanced/python/memory-intelligence/tests -q
npm run check --workspace=@wz-agent/pi-enhanced
npm run check:evaluation --workspace=@wz-agent/pi-enhanced
npm run build:offline
```

精确候选为 29 个文件，包含此前未提交实现和本轮收口。逐文件 SHA-256、理由和排除项见 `.artifacts/swebench-task-v2/final-acceptance-20261107/candidates.json`。本轮没有修改 Task 功能或建立新 Runner。所有机器证据在该目录。

| 候选文件 |
| --- |
| `.github/workflows/pi-enhanced-ci.yml` |
| `HANDOFF.md` |
| `packages/pi-enhanced/benchmarks/real-agent/batch-l-tools.ts` |
| `packages/pi-enhanced/benchmarks/real-agent/evaluation-telemetry.ts` |
| `packages/pi-enhanced/benchmarks/real-agent/run-real-agent.ts` |
| `packages/pi-enhanced/benchmarks/real-agent/runner-execution.ts` |
| `packages/pi-enhanced/benchmarks/real-agent/runner-preparation.ts` |
| `packages/pi-enhanced/benchmarks/real-agent/runner-results.ts` |
| `packages/pi-enhanced/benchmarks/real-agent/swebench-verified.json` |
| `packages/pi-enhanced/benchmarks/real-agent/swebench.ts` |
| `packages/pi-enhanced/docs/swebench-task-v2-design.md` |
| `packages/pi-enhanced/docs/swebench-task-v2-results.json` |
| `packages/pi-enhanced/docs/swebench-task-v2-verification.md` |
| `packages/pi-enhanced/scripts/ci/require-docker-evidence.ts` |
| `packages/pi-enhanced/src/sandbox/config.ts` |
| `packages/pi-enhanced/src/sandbox/extension.ts` |
| `packages/pi-enhanced/src/shared/config.ts` |
| `packages/pi-enhanced/src/task-manager/config.ts` |
| `packages/pi-enhanced/src/task-manager/extension.ts` |
| `packages/pi-enhanced/src/task-manager/provider.ts` |
| `packages/pi-enhanced/src/task-manager/runtime.ts` |
| `packages/pi-enhanced/src/task-manager/v2.ts` |
| `packages/pi-enhanced/tests/e2e/swebench-stub.test.ts` |
| `packages/pi-enhanced/tests/e2e/task-crash-recovery.test.ts` |
| `packages/pi-enhanced/tests/fixtures/task-crash-child.ts` |
| `packages/pi-enhanced/tests/unit/docker-ci-evidence.test.ts` |
| `packages/pi-enhanced/tests/unit/swebench.test.ts` |
| `packages/pi-enhanced/tests/unit/task-v2.test.ts` |
| `packages/pi-enhanced/tsconfig.evaluation.json` |
