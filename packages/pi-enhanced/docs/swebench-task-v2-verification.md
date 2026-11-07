# SWE / Task V2 真实实验准入验收

基线：pi-agent / `0ba05f6418780dcb4e9cb3e696536c42cd8ae6ae`。本轮状态 **pending_remote_authorization**。用户已批准全新 $0.09 预算，但尚未执行付费模型调用、读取真实 Provider Key、创建宿主 grant 或执行 Git 远端操作。

## 本轮改动

复用现有 run-controlled、四阶段 Runner、Task Pair 一次性授权与预算网关，增加固定 `swe-task-v1` 三模式范围；没有新增 Runner、授权模块或依赖。旧两格和六格入口继续保留。无有效授权的真实 SWE 仍拒绝；校验在加载 .env 之前进行。授权绑定 Commit、配置、CI Run、独占输出、有效期与批次身份，整批/每格只消费一次，按 OFF→V1→V2 执行。每格保持 12 请求、80,000 Token、$0.03、180 秒，全批 $0.09，不重试。

沿用 Batch N 逐请求观测。首个上游请求前核对 Base/Tree、原始问题、系统输入、完整工具 Schema 与 wire 请求指纹；真实运行必须匹配受信任宿主 grant 中对应模式的指纹。三种 Task Schema 不同是实验变量，基础文件工具必须相同。Memory/Context 关闭，所有模式都不预置答案计划。未改 Task 算法、网关限额、文件权限、镜像挂载或 Native Guard；普通只读越界仍严格停止。

模型 JSONL、stderr、审计、网关、Telemetry、Patch、predictions、result/run.json 均位于本次独占运行目录，不再写历史 P5 报告。安全可导出的部分补丁也会保留，但 Agent 完成和审计状态仍按实际结果记录。导出安全异常停止整批。官方评测使用另一独占目录；--agent-result 校验实例/Patch SHA，保存调用与输入文件散列、原始官方报告、outcome.json、assessment.json。只有官方结果可置 resolved；未判分为 not_run/null，基础设施错误不记为 unresolved。

## 最终离线结果

最终完整 TypeScript：**270 passed / 0 failed / 3 skipped，共 273 项**。旧 268 项身份缺失 0。Python **15/15**。工程/类型检查 8/8，变更的 13 个 TS 文件 Biome 0 诊断，离线构建和原 npm pack 泄漏检查通过。完整原始日志与逐身份清单保存在 `.artifacts/swe-pilot-admission/`，没有合并旧统计冒充新结果。

原有五项 SWE Stub 实际通过；新三模式批次实际使用生产 Pi CLI、Stub、硬预算网关和 Docker。首次校准三格完成，合法指纹重放三格完成；篡改 V1 请求指纹后，只有 OFF 的两次请求被转发，V1 首次请求在转发前拒绝，V2 not_run，总计 14 次 Stub 转发。所有 Stub 补丁故意不修复问题，不构成官方判分或模型收益。Docker CI 沿用原 Job，并强制检查新准入用例实际执行，未增加 Workflow Job。

跳过：本机 Windows 不能执行 Linux 挂载目录身份替换；Serena、Context7 外部测试未开启。Linux 项目必须由新提交的 docker-isolation Job 实跑，不把跳过算通过。最初普通沙箱执行受临时文件 EPERM 阻断；随后使用正常子进程权限。首轮单测漏用正式入口的 30 秒限制导致两项 5 秒默认超时，原始失败保留；最终使用原 CI 的 30 秒入口，未放宽断言、预算或生产超时。

## CI、历史数据与剩余条件

基线 0ba05f641 的 CI Run **42356930905** 已实际通过 Windows/Linux/Docker，且五项 SWE Stub 有原始证据；这不代表本轮源码已通过远端 CI。新提交与推送尚待精确清单授权，当前远端状态 not_run_for_new_source。候选路径/SHA-256 见 `.artifacts/swe-pilot-admission/candidates.json`，仅含本轮必要源码、测试、原三份报告与 HANDOFF。原有 42 项文档删除、历史报告及运行目录不纳入，75 个保护文件散列保持不变。

既有 Gold 环境 astropy__astropy-12907 官方 resolved=true，F2P 2/2、P2P 13/13，原始证据未改，本轮未重跑。协议仍为 `swebench_verified_source_restricted_v1`，不是标准完整 SWE-bench；V1 无预建计划，只能评价本轮受限 V1 条件。官方控制容器共享 Docker socket，不能声称完全隔离宿主数据；历史首次第三方导入是否加载 .env 仍为 unknown。后续 evaluator 禁用 dotenv、不直接挂载 Provider 配置或 Agent 私有数据。

## 真实 Pilot 入口

只在新 Commit 三项 CI 通过、干净检出及真实宿主 Stub 指纹校准、合法一次性授权均满足后执行。无需再次批准已给出的 $0.09，但不能沿用旧授权文件或旧预算。

```text
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts --execute --comparison-profile swe-task-v1 --swebench-id astropy__astropy-13033 --swebench-mirror <ABS_PUBLIC_MIRROR> --batch-id swe_task_<NEW_ID> --task-pair-authorization <ABS_HOST_GRANT> --ci-evidence <ABS_CI_EVIDENCE> --output-dir <ABS_HOST_OUTPUT_BASE>
```

先在同一干净检出/宿主运行该命令的 Stub 版本：使用新 batch_id、--local-stub-url 及本地 Stub 环境授权，去掉真实 grant/CI 参数；提取每格 input-admission.json 的 input 为 modeInputs，核对共同输入及逐模式差异后创建宿主 grant。不能通过项目文件或模型文本开启真实运行。

独立官方判分入口（固定 Linux 评测宿主，每格新输出目录；Windows Python 缺 resource，既有 Gold 用可信 Linux 控制容器执行）：

```text
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/swebench.ts --instance astropy__astropy-13033 --execute --harness-checkout <ABS_OFFICIAL_726c546> --parquet <ABS_PINNED_PARQUET> --prediction <ABS_CELL_PREDICTIONS_JSONL> --agent-result <ABS_CELL_RESULT_JSON> --output-dir <ABS_FRESH_EVALUATOR_OUTPUT>
```

无合法 Patch 不运行 Harness，官方状态保留 not_run，不伪造 unresolved。每格独立展示 resolved、补丁、Agent 正常结束、审计完整、实际请求/Usage、按网关固定费率结算的费用、文件工具和计划/重规划事件；Provider 发票费用没有可靠接口，记 unknown。一次一题三模式仅作探索观察，不证明普遍效果。
