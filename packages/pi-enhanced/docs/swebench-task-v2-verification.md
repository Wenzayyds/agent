# SWE / Task V2 真实实验准入验收

基线 `0ba05f6418780dcb4e9cb3e696536c42cd8ae6ae`，本轮源码已作为 **`106d6e190bd516e1fb6b718b979040db7f5c6d43`** 提交并正常推送。三项新 CI 及原始证据已核对通过；执行过已批准的 $0.09 一次性真实批次，因 OFF 的预算预检拒绝而停止。V1/V2 未运行，不能形成收益对照。当前状态 **real_pilot_stopped_comparison_not_available**。
## 本轮改动

复用现有 run-controlled、四阶段 Runner、Task Pair 一次性授权与预算网关，增加固定 `swe-task-v1` 三模式范围；没有新增 Runner、授权模块或依赖。旧两格和六格入口继续保留。无有效授权的真实 SWE 仍拒绝；校验在加载 .env 之前进行。授权绑定 Commit、配置、CI Run、独占输出、有效期与批次身份，整批/每格只消费一次，按 OFF→V1→V2 执行。每格保持 12 请求、80,000 Token、$0.03、180 秒，全批 $0.09，不重试。

沿用 Batch N 逐请求观测。首个上游请求前核对 Base/Tree、原始问题、系统输入、完整工具 Schema 与 wire 请求指纹；真实运行必须匹配受信任宿主 grant 中对应模式的指纹。三种 Task Schema 不同是实验变量，基础文件工具必须相同。Memory/Context 关闭，所有模式都不预置答案计划。未改 Task 算法、网关限额、文件权限、镜像挂载或 Native Guard；普通只读越界仍严格停止。

模型 JSONL、stderr、审计、网关、Telemetry、Patch、predictions、result/run.json 均位于本次独占运行目录，不再写历史 P5 报告。安全可导出的部分补丁也会保留，但 Agent 完成和审计状态仍按实际结果记录。导出安全异常停止整批。官方评测使用另一独占目录；--agent-result 校验实例/Patch SHA，保存调用与输入文件散列、原始官方报告、outcome.json、assessment.json。只有官方结果可置 resolved；未判分为 not_run/null，基础设施错误不记为 unresolved。

## 最终离线结果

最终完整 TypeScript：**270 passed / 0 failed / 3 skipped，共 273 项**。旧 268 项身份缺失 0。Python **15/15**。工程/类型检查 8/8，变更的 13 个 TS 文件 Biome 0 诊断，离线构建和原 npm pack 泄漏检查通过。完整原始日志与逐身份清单保存在 `.artifacts/swe-pilot-admission/`，没有合并旧统计冒充新结果。

原有五项 SWE Stub 实际通过；新三模式批次实际使用生产 Pi CLI、Stub、硬预算网关和 Docker。首次校准三格完成，合法指纹重放三格完成；篡改 V1 请求指纹后，只有 OFF 的两次请求被转发，V1 首次请求在转发前拒绝，V2 not_run，总计 14 次 Stub 转发。所有 Stub 补丁故意不修复问题，不构成官方判分或模型收益。Docker CI 沿用原 Job，并强制检查新准入用例实际执行，未增加 Workflow Job。

跳过：本机 Windows 不能执行 Linux 挂载目录身份替换；Serena、Context7 外部测试未开启。Linux 项目必须由新提交的 docker-isolation Job 实跑，不把跳过算通过。最初普通沙箱执行受临时文件 EPERM 阻断；随后使用正常子进程权限。首轮单测漏用正式入口的 30 秒限制导致两项 5 秒默认超时，原始失败保留；最终使用原 CI 的 30 秒入口，未放宽断言、预算或生产超时。

## CI、历史数据与剩余条件

基线 0ba05f641 的 CI Run **42356930905** 已实际通过 Windows/Linux/Docker，且五项 SWE Stub 有原始证据；这不代表本轮源码已通过远端 CI。17 文件已获明确授权并提交推送；当前新源码远端 CI 已实际通过，详见下方追加记录。候选路径/SHA-256 见 `.artifacts/swe-pilot-admission/candidates.json`，仅含本轮必要源码、测试、原三份报告与 HANDOFF。原有 42 项文档删除、历史报告及运行目录不纳入，75 个保护文件散列保持不变。

既有 Gold 环境 astropy__astropy-12907 官方 resolved=true，F2P 2/2、P2P 13/13，原始证据未改，本轮未重跑。协议仍为 `swebench_verified_source_restricted_v1`，不是标准完整 SWE-bench；V1 无预建计划，只能评价本轮受限 V1 条件。官方控制容器共享 Docker socket，不能声称完全隔离宿主数据；历史首次第三方导入是否加载 .env 仍为 unknown。后续 evaluator 禁用 dotenv、不直接挂载 Provider 配置或 Agent 私有数据。

## 真实 Pilot 入口

以下是本轮已使用的入口说明，不是可再次执行的授权。本次 grant 已消费；已发生预算停止，不得复用剩余预算重试或补跑。

```text
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts --execute --comparison-profile swe-task-v1 --swebench-id astropy__astropy-13033 --swebench-mirror <ABS_PUBLIC_MIRROR> --batch-id swe_task_<NEW_ID> --task-pair-authorization <ABS_HOST_GRANT> --ci-evidence <ABS_CI_EVIDENCE> --output-dir <ABS_HOST_OUTPUT_BASE>
```

先在同一干净检出/宿主运行该命令的 Stub 版本：使用新 batch_id、--local-stub-url 及本地 Stub 环境授权，去掉真实 grant/CI 参数；提取每格 input-admission.json 的 input 为 modeInputs，核对共同输入及逐模式差异后创建宿主 grant。不能通过项目文件或模型文本开启真实运行。

独立官方判分入口（固定 Linux 评测宿主，每格新输出目录；Windows Python 缺 resource，既有 Gold 用可信 Linux 控制容器执行）：

```text
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/swebench.ts --instance astropy__astropy-13033 --execute --harness-checkout <ABS_OFFICIAL_726c546> --parquet <ABS_PINNED_PARQUET> --prediction <ABS_CELL_PREDICTIONS_JSONL> --agent-result <ABS_CELL_RESULT_JSON> --output-dir <ABS_FRESH_EVALUATOR_OUTPUT>
```

无合法 Patch 不运行 Harness，官方状态保留 not_run，不伪造 unresolved。每格独立展示 resolved、补丁、Agent 正常结束、审计完整、实际请求/Usage、按网关固定费率结算的费用、文件工具和计划/重规划事件；Provider 发票费用没有可靠接口，记 unknown。一次一题三模式仅作探索观察，不证明普遍效果。

## 本轮实际提交、CI 与真实尝试

源码提交 `106d6e190bd516e1fb6b718b979040db7f5c6d43`，仅提交已审查的 17 文件，正常推送 origin/pi-agent。提交前原文件 SHA-256、Git 规范化后暂存内容、敏感扫描和 75 项历史散列均通过。42 项文档删除未提交。提交后的报告更新没有再次提交或推送。

CI Run [42382223747](https://github.com/Wenzayyds/agent/actions/runs/42382223747)：Linux Job 128432059566 成功（221 passed / 0 failed / 52 skipped）；Windows Job 128432059890 成功（219 / 0 / 54）；Docker Job 128432059807 成功（101 / 0 / 0）。三个 artifact ZIP 的 SHA-256 与 GitHub 摘要一致，metadata 的 Commit/Run 匹配；五项 SWE Stub 和新准入用例均实际通过。普通 Job 未准备 Docker/公开镜像等条件而跳过的用例不计通过，由专门 Docker Job 提供实际证据；Windows 的两个 Python worker 探测仍与既有环境条件有关。72 份原始 Job 日志、原 ZIP 和映射保存在机器证据目录。

在该 Commit 的独立干净检出上复用已验收构建及固定依赖，三种模式宿主 Stub 共转发 6 次，校验共同 Issue/Base/Tree/系统输入和基础工具、逐模式完整 Schema/wire 指纹。随后创建绑定 CI/Commit/配置/指纹/批次/输出/有效期的一次性 grant，经原生产 loader 校验后才加载宿主已配置 Key。Key 未传入 Pi 或 Docker，只有网关持有真实 Provider Key。原生工具仍走 Docker，无 Shell/MCP/宿主回退。

| 模式 | 实际请求 | 实报 Token | 网关费用 USD | Agent 正常结束 | 审计完整 | 官方判分 |
| --- | ---: | ---: | ---: | --- | --- | --- |
| OFF | 7 | 43,000 | 0.0145866 | false | false | not_run，resolved=null |
| V1 | 0 | 0 | 0 | 未运行 | 未运行 | not_run，resolved=null |
| V2 | 0 | 0 | 0 | 未运行 | 未运行 | not_run，resolved=null |

OFF 的 Provider 实报 input=41,126、output=1,874，共 43,000 Token；7 个上游响应均完成 Usage 结算。费用为原网关固定费率 input=$0.3/M、output=$1.2/M 的结算值，Provider 发票费用 unknown。第 8 次请求的 `GATEWAY_TOKEN_BUDGET` 是转发前拒绝，Usage=null，不能重复计费或算成上游请求。原保守算法按 UTF-8 body 字节+4096+最大输出预留；剩余预算不足以覆盖下一次预留即拒绝，所以实际 Token 小于 80,000 也可能停止。第 8 次具体预留值没有落盘，记 unknown，不补造数值。没有超时、提高预算或自动重试。

模型实际调用 grep 2 次、read 4 次、edit 4 次，均有正常工具结果。修改涉及 `astropy/timeseries/core.py` 和 `astropy/timeseries/tests/test_sampled.py`。既有共用源码补丁规则不允许测试路径，导出返回 `SWE_PATCH_PATH_DENIED`，没有 predictions.jsonl 或权威 Git Patch。没有裁掉测试修改、重构补丁或伪造官方结果；4 次编辑事件的原文保存在脱敏 Agent JSONL。失败导出未保存独立拒绝补丁快照，是当前诊断缺口。

必须区分两项事实：Agent 因网关预算拒绝终止，`runStatus=budget_stopped`；随后结果收集器又因补丁路径拒绝，把 `terminationClassification` 优先记成 `isolation_boundary_stop`。这项优先级是本轮新增归类逻辑的问题。原始 run/batch/result 文件保持原样，在报告中分列，不将其写成 Provider 故障或真正的路径逃逸。已保存证据中 10 次工具调用均无错误，18 条 Broker 审计均 ok、integrity=valid、pending=[]；但 session 未正常关闭，state=running、recoveryState=interrupted_or_unfinished、unseenEventsPossible=true，因此 auditComplete=false，不能宣称完整审计通过。Telemetry complete=true 也不替代 Sandbox complete。

三格官方状态均为 not_run：OFF 无合格 Patch，后两格因前格停止而未运行；没有启动官方 Harness。`.artifacts/swe-pilot-admission/official/<mode>/outcome.json` 明确标记 `not_run_no_official_invocation`，这些不是官方评分报告。官方 resolved=0、unresolved=0、not_run=3；成功率与 Task 收益均 unknown，不能写成 0% 成功率或 Task 无效。

本轮模型调用已经停止，grant 根消费标记及 OFF 标记存在，V1/V2 标记不存在，不复用剩余授权。没有在试跑后修改生产源码、追加提交或自动补跑。后续最小问题是统一向模型说明现有受限补丁条件、保留被拒补丁的安全诊断快照、分开预算终止与补丁导出分类；需另行审查，不在本轮擅自改安全限制或预算算法。

## 本轮三个问题的离线修复验收

本节是最新状态：基于 `106d6e190bd516e1fb6b718b979040db7f5c6d43` 的修改已完成离线验收，尚未提交；本轮付费模型调用0、真实Key读取0、主仓库Git暂存/提交/推送0、远端CI运行0。先前真实OFF试跑及$0.09已消费事实不变，未补跑、未回填旧证据。当前状态 offline_repairs_verified_pending_review。

1. **协议一致。** 三组使用同一段普通用户消息说明，不改原Issue、不添加答案文件定位。测试允许读，write/edit 使用共用 safePatchPath 和 tracked 检查，在 Broker 前拒绝；导出器同一规则，不删除或过滤测试修改。六个真实Pi/Stub/Docker场景覆盖三模式各自的 write/edit 拒绝，先成功读测试再拒绝写，审计只见 read，后续Provider不再调用。现有五项正常SWE和三模式顺序/指纹失配停止均实际通过。
2. **预留诊断。** 固定80,000 Token/$0.03/12请求的生产批次真实触发转发前Token拒绝，新增字段与实际body字节和原公式吻合；被拒Usage仍为null。该Stub中已用Token=223，候选预留=123579，剩余预留空间=79777。这些是Stub证据，不是真实模型成绩。旧真实第8次的bodyBytes、请求输出及精确预留仍unknown；未根据43,000实报Token反推。对决策方法去掉纯诊断代码后与基线规范化内容逐字一致。
3. **分类与证据。** 正常结束但导出拒绝的生产批次记录 agentCompleted=true、auditComplete=true、terminationClassification=completed、patchExportError=SWE_PATCH_UNSAFE，后两格not_run；没有伪造predictions。单元回归另外覆盖SWE_PATCH_PATH_DENIED与预算停止同时存在，保持gateway_budget_stop。拒绝候选仅存安全路径/路径散列、完整候选散列/大小和拒绝码，不存正文或凭据。强杀的是实际Pi子进程，原Runner继续收集有效已落盘审计，agentCompleted/auditComplete均false，运行分类为agent_execution_error。

最终**单独一轮**全量TypeScript：279 passed / 0 failed / 3 skipped，共282；旧273身份缺失0，新增9项持久化E2E。Python15/15；8项类型/工程检查通过，18个TS和1个JSON的Biome0诊断，离线构建与打包泄漏扫描通过。三个环境跳过仍是本机Windows不能执行的Linux挂载身份替换，以及未启用的Serena/Context7；不计通过。Linux分支需要下一新Commit的Docker CI实跑。

原有预算拒绝、Docker六工具、隔离逃逸/容器故障、强杀审计、异常验证器、Memory/Context/Task生命周期和包安装测试保留。初次新预算夹具重复toolCallId，被旧Sandbox正确拒绝，已改成唯一ID，没有放宽限制。一次整轮278/1/3因本地CI YAML误写CRLF而失败，修复LF，原断言不变，失败日志保留。最终结果不拼接任何旧统计。常见__tests__/__specs__命名补充后又在冻结源码上重新完成全量。

精确文件和SHA见 `.artifacts/swe-pilot-repair/changed-files.json`。124个旧保护文件（含原真实试跑和消费标记）散列不变，42项删除路径不变，原有未提交报告已先完整备份并在原文后追加本节。官方Harness适配后半段及关键Sandbox/P1文件与基线一致；没有改Task功能或重构Runner。既有Docker Job已增加9项用例及数量检查，没有新增Job；本轮没有远端授权，其状态仅 configured_only。

重新对照前依次需要：审查本轮精确改动并另行授权提交/正常推送；新Commit三项CI通过且强制SWE用例实际执行；从该Commit干净检出，在真实执行宿主重新校准三模式输入（共同Prompt已变）；获得全新的明确费用预算并创建绑定该Commit/CI/配置/指纹/运行身份/有效期的一次性宿主授权；重新做评测资源预检，只有合格预测才交官方Harness。旧$0.09、旧grant和旧指纹不得复用。本轮没有真实重跑，仍不能宣称Task收益或官方成功率。

## 2026-11-08 三模式独立尝试与预算提案验收（最新状态）

HEAD仍为`106d6e190bd516e1fb6b718b979040db7f5c6d43`，当前改动未提交。此轮付费调用0、真实Key读取0、真实授权创建0、Git暂存/提交/推送0、远端操作0。最新状态`offline_verified_pending_review`。旧$0.09授权已消费，不能复用。原始真实实验、旧CI和Gold记录保持原样；旧绿色CI不代表当前源码。

源码审查确认上轮统一规则继续生效：原Issue不改，测试可读不可写，共同tracked源码规则在Broker之前与导出时一致；无按答案生成的路径名单，不过滤违规Diff。预算网关本轮与此前修复版本字节相同，byte+4096、费率、输出2048及硬预留/Usage结算均未改。运行、Patch、审计、官方成绩分列；损坏/缺失审计的汇总为invalid_or_missing，不记正常结束。

最终冻结源码整轮TypeScript：**288 passed / 0 failed / 3 skipped，共291**；原282项身份缺失0。Python15/15；8项工程/类型检查、21文件Biome、离线构建与npm pack泄漏检查通过。原五项SWE、现有生产准入和17项SWE策略/继续测试均实际执行。跳过仍为Windows上的Linux挂载身份替换及未启用的Serena/Context7；不计passed。详细日志、失败中间轮及身份清单都在`.artifacts/swe-continuation/`。根check的全仓自动写格式步骤未执行，以限定变更文件的同等Biome和全部只读检查替代，保留用户其他改动。

| 生产Pi + Stub + Gateway + Docker场景 | 整批决定 | OFF / V1 / V2 |
|---|---|---|
| audit_corrupt | swe_host_cleanup_unconfirmed | stopped / not_run / not_run |
| batch_cap | batch_budget_reservation | failed / not_run / not_run |
| container_failure | swe_gateway_settlement_unconfirmed | stopped / not_run / not_run |
| cost | 继续三组 | stopped / stopped / stopped |
| no_patch | 继续三组 | failed / failed / failed |
| requests | 继续三组 | stopped / stopped / stopped |
| timeout | 继续三组 | stopped / stopped / stopped |
| usage_failure | swe_gateway_settlement_unconfirmed | stopped / not_run / not_run |

此外，新200,000 Token真实Stub链路中每格4次转发后第5次预留拒绝，三格均保留budget_stopped且继续核对通过，总12次Stub转发；不是模型成绩。原生产准入先校准三格，再按逐模式指纹运行三格；改V1指纹后在转发前停止，V2 not_run。每个新增批次都再次尝试启动同一身份并实际被排他目录拒绝，转发数不增加；原wx消费及新过期/前序继续状态检查单测通过。

超时测试最终暂停的是实际Pi进程（Windows仅对身份核对后的线程，Linux SIGSTOP），Provider响应已结算，原Runner期限杀死子进程，确认容器/工作区/私有数据清理再继续。它不是模拟timeout对象。初期暂停容器和一次100并发读分别触发真实Sandbox协议拒绝，正确停批；没有为夹具关闭安全检查，失败证据保留。初次单测使用默认5秒导致超时，最终沿用原CI的30秒；未加生产或断言宽限。审计损坏夹具实际将自身临时审计路径换成目录，持久化/读取失败，停止整批。

预算提案离线结论：200,000能缓解保守预留空间不足，但不能保证完成。旧前7次保存的预留和结算均可放入新额度；旧第8次精确请求尺寸/输出/预留仍unknown，不能反推。已结算43,000且单次输出上限2048时，下一请求体的公式容量从30,856增至150,856字节；这是配置容量计算，不是旧请求测量。已保存旧Stub第3次请求在新额度下可通过数学核对；新链路继续增长到229,891候选预留时仍正确拒绝。独立$0.08费用限额也可能先于200,000 Token耗尽。机器计算见budget-feasibility.json。

124个历史保护文件散列不变，42项删除路径不变，原24项未提交文件已先备份并保留归属。本轮只增加run-controlled/runner-execution两项候选路径，合计26项，精确SHA与逐项理由见candidates.json。没有新增Runner、模块、依赖、Task功能或修改Core/MCP/Memory/Context算法，Workflow本轮未修改；原Docker Job已调用该SWE测试文件，证据门槛要求全部17项实际通过。

后续须依次取得：精确清单的提交/正常推送授权；新Commit Windows/Linux/Docker实际CI；该Commit干净检出及真实宿主新三模式校准；全新USD0.24独立费用批准；绑定新Commit/CI/提案配置/逐模式指纹/唯一输出身份/有效期的一次性grant。真实命令沿用前文run-controlled入口，无--swe-stub-limits；不要运行绑定旧Commit/旧batchId/旧grant的历史host-pilot脚本。

合规预测生成后，在无Key的可信Linux评测控制环境使用原入口（下列路径须为该控制环境的绝对路径）：
```text
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/swebench.ts --execute --instance astropy__astropy-13033 --prediction <NEW_CELL_PREDICTIONS> --agent-result <SAME_CELL_RESULT> --harness-checkout <FIXED_V4_1_0_CHECKOUT> --parquet <FIXED_VERIFIED_PARQUET> --output-dir <NEW_INDEPENDENT_EVALUATOR_DIR>
```
每模式独立目录/随机run_id，收集原官方报告、outcome和assessment；Agent预算停止但合规部分Patch仍可评分，不能改写agentCompleted/auditComplete。Windows原Python导入仍受resource模块限制；上述包装入口需要Linux环境同时具备Node和原Python依赖，旧Gold的Python控制镜像不能直接当成具备Node的环境。正式评分前应复用原Linux部署方法完成这项依赖与资源预检，不创建第二个评分器。专用无凭据daemon仍是更强隔离条件。官方本轮未运行，尚无新的resolved或Task收益结论。离线工作到此停止。
