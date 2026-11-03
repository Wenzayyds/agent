# Batch J：异常审计与可恢复工具拒绝验收

日期：2026-11-03。仓库：`F:\项目代码\pi-agent`，分支 `pi-agent`，起始及结束 HEAD：`58dada178ee73ef03d9e5216d8d504bb09f89aff`。本轮修改保留在本地工作树，没有提交、推送、触发远端 Workflow 或调用付费模型。

## 结论

- 显式选择离线恢复策略后，普通 `ls("..")` 被 Guard 拒绝，Stub 收到拒绝结果，随后通过 Docker 读取、编辑项目文件，独立隐藏验证通过。被拒绝的操作没有进入 Broker。
- 默认严格策略保持停止行为。写入或编辑越界、符号链接逃逸、未知工具、容器故障和拒绝次数超限均停止，后续请求不能再转发到上游。
- 真实子进程的两项 SIGKILL 测试通过。已有工具事件可恢复，尚未完成结算的操作保留在 `pending`，没有正常退出标记的快照明确不完整。
- 全量 TypeScript：**209 项，206 passed / 0 failed / 3 skipped**。原有 181 个身份缺失 0；Python **15/15**。
- 仍有一项本机环境阻断：Windows 对活动 Pi 工作目录的重命名返回 `EBUSY`，无法注入目录身份替换。身份绑定单元测试通过；完整生产 Runner 用例保留给 Linux CI。本轮三个远端 CI job 均为 `configured_only`。
- **真实六格尚未达到重新执行的完整工程条件。** 当前修改尚未提交或通过本轮远端 CI，Linux 活动目录替换用例尚待实测。此外，既有隐藏验证器在宿主 Node 中导入补丁代码，其执行边界需要单独处理。离线恢复入口明确拒绝真实 Provider；默认严格模式也不会因此放行原先的越界请求。本轮不将状态写成 `ready_for_authorization`。

结构化结果、全部测试身份、各场景网关账目与审计完整性统计见 [batch-j-results.json](batch-j-results.json)。其中 Stub 的 usage 和费用是模拟 Provider 给出的数值及网关计算结果，不是真实模型账单或真实 Coding Agent 成功率。

## J0：基线与根因

开发前检查了 `git status`、`git diff`、分支和 HEAD，阅读了受控六格报告、最新 P5 结果、181 项测试清单，以及 Runner、Guard、Sandbox、Gateway、CI 的对应实现。起始工作树已有 HANDOFF 和最新 P5 报告改动，以及真实六格报告和原始运行目录。本轮没有清理或覆盖这些产物；对相关 12 个文件的 SHA-256 复核全部一致。

历史 `approved_six_20261103` 的首格确实只有 3 次上游请求，3 次均完成 usage 结算：输入 6,631、输出 378、合计 7,009 Token，0.0024429 美元；无补丁、隐藏验证未通过。后五格没有运行。此结论仅描述既有证据，未改写历史 JSON 或补跑实验。

原异常传播链如下：

1. `run-controlled.ts` 串行启动生产 `run-real-agent.ts`。
2. Runner 启动本地硬预算网关和真实 Pi CLI，配置 Native Guard 与六种 Docker 文件工具替换。
3. Native Guard 的 `classifyPath` 判断工作区外路径，返回阻止结果；文件工具不会执行。这个错误码也可能由符号链接逃逸产生，不能直接作为可恢复依据。
4. `controlled-stop.ts` 在 Pi 等待的 `tool_execution_end` 中，对任何包含 `SANDBOX_` 或 `Native tool guard blocked` 的错误，认证调用 `/__budget/stop-isolation`。
5. 网关进入 `failed_closed`，记录 `GATEWAY_ISOLATION_STOP`。Runner 同时有 stdout 正则杀进程和网关状态轮询；普通只读拒绝因此升级为整个批次停止。
6. `executionOutcome` 将网关失败关闭统一映射为旧字段 `runStatus: gateway_error`。该字段不能证明 DeepSeek Provider 故障。
7. Broker 的审计当时只在内存中，唯一文件写入位于 `session_shutdown`。强制结束 Pi 时没有执行完整的退出钩子，所以最终缺少 `sandbox-audit.json`。

根因说明及拟修改位置已在代码修改前给出。实际修改限定在评测停止链、拒绝观察事件、Sandbox 审计及相应测试/CI；没有改变 Pi Core 或 Agent Loop。

初次本地基线使用子包 `npm test` 入口，收集到 181 项：178 passed、1 failed、2 skipped。失败的旧 P4 测试通过仓库根目录解析夹具，从子包启动时路径不正确。最终采用 CI 的仓库根目录入口，该旧用例通过，没有修改或弱化它。

## J1：拒绝分级与信任边界

`src/mcp-policy/extension.ts` 只增加进程内的拒绝观察事件，按 toolCallId 和工具名查找真实 Guard 记录。P1 Policy 的规则、默认动作、审批要求及 Guard 的拒绝决策没有改变。

`controlled-stop.ts` 不再仅凭工具输出文本决定允许恢复。必须同时满足：真实 Guard 已阻止该调用；工具是 read/grep/find/ls；风险为 read_only；原因为 path-outside-workspace；原始相对路径确实越出根目录；路径各组成部分不存在符号链接，且规范路径一致；绑定的工作区身份仍然有效；权威审计可读且 Docker 容器仍在运行、镜像和隔离设置符合要求；本次运行未超过拒绝上限。

路径判断仅检查必要的路径元数据，不读取目标文件正文、不列出父目录内容。路径不存在、解析不明确、绝对路径、符号链接逃逸等情况均不能恢复。Guard 已拒绝的操作不会交给容器或 Broker 执行。

新策略通过宿主命令行 `--offline-denial-policy <绝对路径>` 显式选择。配置文件必须位于仓库外，拒绝符号链接、过大文件和未知配置项；Runner 将验证后的配置复制到模型挂载范围外的运行根目录。配置示例：

```json
{"schemaVersion":1,"mode":"recover_readonly_denials","maxDenials":1}
```

上限仅允许 1～3 次，每个独立运行重新计数。只有 `--local-stub-url` 和既有离线 Stub 授权检查成立、且使用受控格子时，才能选择这一入口。默认加载的严格 Extension 不读取此恢复配置。项目文件、提示词、工具输出或环境变量不能选择恢复入口；严格回归专门设置了类似恢复开关的环境变量，仍然只转发一次请求后停止。真实 Provider 携带该选项会在模型调用前被拒绝。

| 事件 | 本轮处理 | 结构化分类 |
| --- | --- | --- |
| 可确认未执行的普通只读越界拒绝 | 仅显式离线策略、次数以内可继续；保留原工具错误反馈 | `tool_denied_recoverable`，记录为事件；运行最终可为 `completed` |
| 严格模式下的只读拒绝、写入/编辑拒绝、未知工具、拒绝超限 | 关闭网关，停止当前格和剩余格 | `isolation_boundary_stop` |
| 符号链接逃逸、工作区身份改变、跨运行/工具协议身份不匹配 | 不可恢复，失败关闭 | `isolation_boundary_stop`，保留具体原因 |
| 容器不可用、无效响应、审计写入或完整性故障 | 不执行宿主工具，不继续转发 | `sandbox_runtime_error` |
| 请求/Token/费用限制、缺失 usage 或结算不一致 | 沿用原硬预算机制，保留预留和拒绝原因 | `gateway_budget_stop` |
| 上游 HTTP、连接或 Provider 故障 | 单独记录；不解释成工具隔离错误 | `gateway_provider_error` |
| 超时、客户端断开或 Agent 进程异常 | 保留退出码、超时及网关证据 | `agent_execution_error` |
| Agent 正常结束但隐藏验证失败 | 运行正常、补丁失败，分别记录 | `verification_failed` |
| Agent 正常结束、隐藏验证通过且审计完整 | 记录各项独立结果 | `completed` |

严重事件继续通过原有只能关闭网关的认证通道执行停止。父进程保留网关状态轮询，移除了与可信分级冲突的 stdout 文本杀进程判断。现有严格负向用例仍断言上游仅收到一次请求，未放宽为“最终停下即可”。

## J2：异常退出审计

新增 `src/sandbox/audit.ts`，Broker 在启动时写运行快照，容器启动后保存实际容器证据。每次文件操作执行前先持久化 intent，操作返回后立即持久化成功或错误。持久化失败时返回 `SANDBOX_AUDIT_WRITE_FAILED`，不启动尚未持久化 intent 的操作，也不能再写正常完成标记。

文件采用私有临时文件写入、`fsync`、原子重命名替换。每份快照带 SHA-256，读取时检查大小、校验和、运行标识、请求重复及 pending/完成状态一致性。没有原地修补损坏日志。成功结果落盘错误也不会再次被误记为 Worker 错误，避免覆盖真正的审计故障。

每条操作记录包含 runId、稳定哈希化 requestId、工具、操作类型、容器 ID、镜像、状态、开始/结束时间和耗时；错误仅保留错误码。没有文件路径正文、Prompt、文件正文、完整工具输出或认证信息。工具拒绝另有有界的 `tool-safety.json`，同样原子写入，不保存原始入参和输出。单份操作快照最多 256 条完成/待确认记录、512 KiB，Broker 的请求跟踪也有数量上限；安全事件最多保留 16 条。

权威快照在模型可写工作区之外、Docker 挂载之外。真实 Runner 一直明确指定 `auditReportPath`；其 Docker 预检显式不创建正式运行审计，避免提前占用文件。Runner 结束后将原始、可再次校验的快照复制到运行证据目录，结果 JSON 另保留读取诊断。

- 正常退出：仅在 `session_shutdown` 写 `state: completed`，读取结果 `complete: true`。
- 强制结束：最后快照保持 running，读取结果为 `complete: false`、`interrupted_or_unfinished`。
- 已写 intent、尚无结果：保留 pending requestId，列入 missingOperationResults，不能认定操作未发生，也不能认定成功。
- 在 intent 落盘前被杀：无法枚举未看到的事件，因此所有未完成快照均有 `unseenEventsPossible: true`。不会补造事件或自动重放。

真实子进程分别在一次 Docker read 完成后、下一次 Docker write 已落盘 intent 尚未结束时被 SIGKILL；新 Node 进程重新读取校验均通过。前者恢复 1 条 read；后者恢复 1 条 read 和 1 条未知结果的 pending write，没有成功 write 记录。

该保证针对配置了权威审计路径的运行。手工创建 Broker 而不设置 `auditReportPath` 的旧调用仍保持内存接口，不具有持久化保证。SHA-256 用于检测损坏，不抵御已控制宿主账户的攻击者；权威性依赖文件位于模型写入范围外。running 快照也不能单独证明进程已经死亡，只能证明正常完成标记尚未持久化。

## J3：结果口径

保留旧 `status`、`runStatus`、`patchStatus` 和原始网关账目，新增 `terminationClassification`、`agentTermination`、`patchGenerated`、`toolSafety`、`auditComplete`。旧的 `gateway_error` 或 `budget_exceeded` 仍可能出现在兼容字段中，新统计应使用结构化分类，不能据旧字段认定真实费用超限或 Provider 故障。

六格保留原 status，并新增 `resultStatus`：开始为 run，结束为 passed/failed/stopped，未开始为 not_run。补丁验证失败与安全停止分开；不会补跑失败格。顶层批次对 Runner 非零退出也保留独立的终止分类。

默认的 TypeScript/Biome 配置不覆盖 `benchmarks` 和复数 `tests` 目录。本轮新增 `tsconfig.evaluation.json` 和 `check:evaluation`，在本地及 CI 显式检查真实评测链与新增测试；同时修正网关一个既有的 `Promise<void>` 返回类型问题，行为未变。新增文件另做了 Biome 检查。

## J4～J5：验证结果

| 验证 | 结果 |
| --- | --- |
| TypeScript unit/integration/E2E 全量，含安装包测试 | 209：206 passed、0 failed、3 skipped |
| 原 181 项身份核对 | 缺失 0；清单 SHA-256 为 `768a74c128ff2ebe614c365e6ae8685210a5aa8114f939238ceadd8fba6f0b30` |
| Python | 15 passed |
| Docker 六工具、协议和安装包链路子集 | 13/13 passed |
| 生产 Runner 与批次子集 | 20：19 passed、0 failed、1 blocked/skipped |
| 新增审计/策略单元测试 | 14/14 passed |
| 预算网关负向单元测试 | 9/9 passed |
| 根 TypeScript/Biome/依赖检查、评测链 TypeScript | passed |
| 离线构建 | passed，使用本地依赖与已存在的模型目录数据 |
| 实际 npm pack、安装后的 Extension 执行 | passed，包含在全量 E2E 中 |
| 包路径和敏感内容检查 | forbidden 0、contentLeaks 0 |

子集包含在 209 项之内，不能重复相加。两项旧跳过为外部 MCP 条件测试；新增跳过是 Windows EBUSY 阻断的活动目录替换测试。没有删除或放宽原安全用例。

恢复六格 Stub 共 24 次上游请求，每格 4 次，六格均通过隐藏验证；每格第一次只读拒绝都反馈给 Stub，拒绝操作未进入 Broker。严重写入拒绝六格测试只执行首格一次上游请求，首格 stopped、后五格 not_run。每格仍为最多 8 请求、40,000 Token、0.03 美元、180 秒，批次预占上限仍为 0.18 美元，没有重试或扩大预算。

单格覆盖默认严格模式、write/edit 越界、次数超限、符号链接逃逸、未知工具、容器移除导致无效协议响应，以及容器已移除但当前请求先被 Guard 拒绝的组合情况。最后一种情况证明“只读拒绝可恢复”不会掩盖已有容器故障。

本轮固定证据集中，9 个单格、7 个已执行批次格、2 个强制中断子进程共 18 份快照：7 份完整、11 份明确不完整。具体网关请求、usage、拒绝和原因保留在结构化结果中；原始机器证据位于仓库 `.artifacts/batch-j/`。

CI 已加入新用例、评测链类型检查、181 项基线身份核对和 Docker 产物收集。没有执行远端操作，不能把历史提交的成功 CI 当成本轮修改的验证。后续先单独授权提交/远端 CI，补齐 Linux 身份替换 E2E，再审查真实试跑所需策略和预算；本轮在此停止。

源码审查还确认了一个既有边界：`verify()` 通过宿主 `spawnSync(process.execPath, ...)` 导入被修改的 JavaScript。它确实独立于 Agent 判断测试结果，但这段代码执行没有包含在六种文件工具的 Docker 隔离中。本轮 Stub 使用固定无副作用补丁，没有执行来自真实模型的新代码；没有另行重写验证器。后续真实模型试跑前，应把验证器执行边界纳入隔离审查，不能把“六种工具已进 Docker”解释为整条评测链都已隔离。
