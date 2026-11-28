# 模型评测代码

## 当前入口

- `run-controlled.ts`：组织 OFF/V1/V2，按模式消费宿主授权，检查前一组清理和结算后再继续。
- `run-real-agent.ts`：单组入口，负责参数、授权、准备、执行、收集及最终清理。
- `swebench.ts`：独立官方 Harness 的命令行入口，并保留已有评测接口的导出。

三个入口保持原路径，沿用现有命令行参数和结果字段。`npm run evaluate:swe --workspace=@wz-agent/pi-enhanced -- ...` 选择 SWE profile；仍须提供原实例、镜像、批次和输出参数。真实执行还须有当前 Commit 的 CI 证据和新的一次性宿主授权。

## Requests-1142 的行为验证

冻结批次的 `test_basic_building` 只检查请求能否构造。它在未修复的基线上也会通过，工具会标注 `request_construction_only_issue_unverified`。独立复核时，令 `CANDIDATE` 指向已应用候选补丁的 Requests 检出目录，在本项目根目录运行下面的命令。检查只构造一个空 GET，发现 `Content-Length` 即以非零状态退出。官方成绩仍由 SWE-bench Harness 给出。

```bash
docker run --rm -i --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user 65534:65534 --cpus 0.5 --memory 128m --pids-limit 32 \
  --mount "type=bind,src=$CANDIDATE/requests,dst=/testbed/requests,readonly" -w /testbed \
  --entrypoint /opt/miniconda3/envs/testbed/bin/python \
  swebench/sweb.eval.x86_64.psf_1776_requests-1142@sha256:b2733e57feb4cfaeac24ab5ec496d4cb89a37db53bd0ca72eaededdb2ce19d1c \
  -B - < packages/pi-enhanced/benchmarks/real-agent/check-requests-1142.py
```

## 五题 Flash OFF

`swe-flash-off-v1` 固定按 `13033 → 13453 → 14365 → 14369 → 14508` 运行 Astropy 的五道 Verified 题。每题使用新的工作区和预算账本，最多 20 次请求、200,000 Token、600 秒、USD 0.08。批次按每题完整额度预留，总上限 USD 0.40，并发为 1。预览时只传本地镜像路径，题号由配置决定。

```bash
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts \
  --comparison-profile swe-flash-off-v1 --swebench-mirror "$MIRROR"
```

实际宿主授权沿用现有的 Commit、CI、配置散列、批次、输出和有效期绑定。该配置的授权文件用 `instanceInputs` 替代 `input` 与 `modeInputs`，键是完整的 SWE-bench `instance_id`，值是该题单独校准的 `TaskPairInput`。批次和每题各有独占消费记录。输入不匹配时 Gateway 拒绝该题首请求，并停止批次。

## 单题 Flash OFF

`swe-flash-off-single-v1` 要求显式提供 `--swebench-id astropy__astropy-13033`，只准备和执行这一题。单题和批次费用上限均为 USD 0.08，请求、Token 和时间上限沿用五题配置的单题上限。先预览并核对配置散列与唯一题号。

```bash
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts \
  --comparison-profile swe-flash-off-single-v1 \
  --swebench-id astropy__astropy-13033 --swebench-mirror "$MIRROR"
```

正式执行使用 `swe_flash_single_` 开头的唯一批次 ID，追加 `--execute --batch-id "$BATCH_ID" --output-dir "$OUTPUT_BASE" --ci-evidence "$CI_EVIDENCE" --task-pair-authorization "$GRANT"`，并由操作者设置 `PI_ENHANCED_REAL_MODEL_EVAL=1`。使用干净检出及该提交的 CI 证据。新授权的 `instanceInputs` 只包含 `astropy__astropy-13033` 的首请求指纹。该入口只有一次执行机会，停止后不会重试或改跑其他题目。官方 Harness 独立启动，只提交成功导出的非空补丁，由官方结果判定是否 resolved。

本地验证可把 `PI_ENHANCED_SWE_LOCAL_MIRROR` 指向包含五个基线提交的 Astropy 镜像，然后运行 `swebench-stub.test.ts`。若设置 `PI_ENHANCED_SWE_FLASH_OFF_EVIDENCE` 为现有的证据目录，测试会保留批次与预测。每题结果位于 `<batchId>/<batchId>_off_<issue>/swebench/`，其中的 `predictions.jsonl` 和 `result.json` 可交给现有 `swebench.ts` 在独立目录判分。

## 当前分层

| 层 | 入口与职责 |
| --- | --- |
| 批次与单组入口 | `run-controlled.ts` 按组编排、预留批次预算并判断能否续跑。单组入口 `run-real-agent.ts` 负责准入和阶段协调。 |
| SWE 配置与授权 | `swe-profile.ts` 统一选择模型、模式、预算和授权输入形式。`task-pair-authorization.ts` 校验配置指纹、CI 证据和一次性消费顺序。 |
| Pi 扩展与输入准入 | `swe-tools.ts` 注册受限写入策略。`input-audit.ts` 记录提示词和工具摘要，`input-admission.ts` 在网关转发前校验首请求并记录准入结果。 |
| 执行与回收 | `runner-preparation.ts` 准备输入和工作区。`runner-execution.ts` 启动 Pi 与网关，`runner-cleanup.ts` 分别尝试写入网关证据、关闭网关和回收容器。 |
| SWE 工作区与补丁 | `swe-workspace.ts` 从固定公开提交准备工作区。`swe-patch.ts` 校验写入目标并导出预测补丁。两者共用 `swe-git.ts` 的受控 Git 调用。 |
| 结果与独立评分 | `swe-results.ts` 收集运行结果、持久化的安全事件和预测补丁。`swe-evaluator.ts` 在独立目录调用官方 Harness 并记录评分状态。 |

`safetyEvents` 来自停止扩展落盘的安全事件，用于解释拒绝和停止。`toolFailures` 记录实际收到的 Pi CLI 工具错误。即使 CLI 在停止时来不及输出事件，也能用安全事件和 Docker 审计分别核对拒绝原因和执行情况。

## 调用关系

```text
run-controlled（批次、每组预算、继续条件）
  → run-real-agent（单组协调）
      → runner-preparation（临时工作区、扩展与输入）
      → runner-execution（Pi 子进程、网关、Docker 生命周期）
      → swe-results（SWE 审计、日志、补丁与结果）
        或 runner-results（合成任务验证与结果）
      → 写入 run.json，清理私有目录，写入 host-cleanup.json
  → 下一组或停止

合格 predictions.jsonl + result.json
  → swebench 命令行入口 → swe-evaluator 独立官方判分
```

`swe-profile.ts` 独立声明当前三模式、预算和配置指纹，不继承旧 Task Pair/Batch L 的预算。`evaluation-identity.ts` 只负责已有 SHA-256 编码规则。配置序列化顺序保持不变，迁移前后指纹一致。

`task-pair-authorization.ts` 保留宿主授权的 Commit、CI、配置、输入、输出身份和有效期绑定；`controlled-policy.ts` 保留严格停止规则和 SWE 的独立继续判定。`budget-gateway.ts` 负责转发前硬预留和 Usage 结算，不因归档实验而更改。

## 旧实验与仍在使用的代码

### E1–E5 本地开发任务

`agent-evaluation.ts` 在 I1–I4 候选源码上用同一个入口运行 8 道任务与 A/B/C/D 四组。需要离线构建产物、固定的本机 pytest 镜像。入口只连接本机 Stub，评测结果写入同一个 JSON。

```powershell
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/agent-evaluation.ts .artifacts/agent-evaluation/results.json
```

可附加 `resume:D` 重放指定任务与组合。`fault:qdrant` 和 `fault:e5` 使用现有离线向量夹具执行在途故障测试，`fault:post-edit` 重放编辑后的 pytest 失败与任务恢复。故障样本与四组消融分开记录。任务工作区、独立判分目录、会话、SQLite 与 Gateway 账本逐次创建。评分测试及预置参考材料不会出现在 Agent 可读的源文件清单中。

四组使用相同 Context、Task、系统提示模板与预算。Stub 依据实际收到的已授权线索选择预写编辑，结果用于验证链路和材料的可获得性。真实模型的开发质量与成本须另立实验并获得授权。

获单轮付费授权后，入口可用 `deepseek` 模式执行同一 32 单元。它从已配置的 `DEEPSEEK_API_KEY` 读取凭据，也可用 `PI_EVALUATION_ENV_FILE` 指向本机 env 文件。只读取该凭据字段，真实输出存放在 `deepseek-flash.json`，保留原 Stub 的 `results.json`。真实模式独占创建结果文件，已有批次时直接拒绝运行。每个新单元占用 0.03 美元预算配额，整批上限 0.96 美元。

```powershell
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/agent-evaluation.ts .artifacts/agent-evaluation/deepseek-flash.json deepseek
```

E6 离线验证共用同一个入口。完整矩阵使用 `e6`，项目边界与历史读取轨迹重放使用 `e6-scope`。两个模式均连接本机 Stub，写入同一个结果文件。

```powershell
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/agent-evaluation.ts .artifacts/agent-evaluation/e6-results.json e6-scope
node --experimental-strip-types packages/pi-enhanced/benchmarks/real-agent/agent-evaluation.ts .artifacts/agent-evaluation/e6-results.json e6
```

E9 模式 `e9` 复用同一套 32 单元，由子进程重新打开原 Task、Session 和持久预算账本。`e9-budget` 对照重放烟测的 B/D 工具轨迹，`e9-retry` 注入一次连接建立超时。三者使用本机 Stub 和同一个结果文件 `.artifacts/agent-evaluation/e6-2-e9/results.json`。请求观测记录工具声明及各消息角色的字节数。

E12 沿用同一入口。`e12-baseline` 和 `e12` 使用相同的 32 个离线单元，分别关闭和启用预算感知投影。`e12-budget` 重放 E9 真实轨迹，`e12-context-probe` 验证重复检索，`e12-retry-edited` 验证编辑后遇到连接超时的重试。各模式写入 `.artifacts/agent-evaluation/e10-e12/results.json`。

E12 在送入 Gateway 前，以同一预留规则做只读估算。投影保留工具调用关系，并将完全相同的旧只读结果缩短为引用。仅当完整请求超出 Token 或费用余量、最新的单独公开 pytest 通过且缩短后的请求可获准时，才发送无工具的文字总结请求。编辑和恢复前检查是否还有下一次模型请求的最低余量。编辑时若只剩一个槽会记录预警，并保留同批测试的机会。本地 pytest 仍可留下失败诊断。请求日志只记录各分项序列化字节数，输出预算沿用 Gateway 记录。最终由 Gateway 独立决定是否放行，独立判分仍在 Agent 工作区之外执行。

单独获得授权后，先用 `deepseek-e12-pilot` 跑 `invoice:D` 和 `export-api:C`，批次上限 0.06 美元，独占创建 `.artifacts/agent-evaluation/e10-e12/deepseek-pilot.json`。完整模式 `deepseek-e12` 执行同一 32 单元并独占创建同目录下的 `deepseek-full.json`，批次上限 0.96 美元。两种模式的单元上限均为 8 请求、20,000 Token、180 秒和 0.03 美元。

单独获得授权后，`deepseek-smoke` 可对 `clamp` 的 A/B/C/D 四个单元执行一轮，独占创建 `.artifacts/agent-evaluation/e6-2-e9/deepseek-smoke.json`，批次上限 0.12 美元。它沿用 8 请求、20,000 Token、180 秒及每单元 0.03 美元的硬上限。明确未连到上游的 DNS 错误和连接建立超时可由 Agent 重试一次。在发出重试前，原授权检查会再次执行。首次失败占用请求计数。

独立 P5/消融/合成基准已移到 `../archive/`。`batch-l-*`、`controlled-cases.ts`、`offline-*` 等仍被旧协议复现和生产安全回归引用，因此保留在此处；它们不是可直接删除的死代码。SWE 的预算、模式和结果收集已独立，不再继续向 Batch L 配置堆叠逻辑。

测试文件路径和断言身份保持稳定；CI 历史身份检查仍然有效。历史运行产物不参与源码整理，也不复用已经消费的 grant。

## 结构整理验收（2026-11-08）

本次对比使用三份状态：HEAD `106d6e190bd516e1fb6b718b979040db7f5c6d43`、`.artifacts/structure-cleanup/before/` 保存的整理前工作树、当前工作树。HEAD 到整理前的 26 项 SWE 继续执行、预算结算和安全修复已经存在；不能把它们算成结构整理。整理前到当前的候选清单是 `.artifacts/structure-cleanup/candidates.json`，当前 55 项（47 写入、8 个旧路径删除），其中本轮仅新增一处测试夹具修复；原有 42 项历史文档删除不在候选范围。

| 位置 | 整理前 | 当前 |
|---|---|---|
| `benchmarks/` 根目录 | 5 个独立实验脚本及 `test-manifest.ts` | 无脚本 |
| `benchmarks/archive/` | 不存在 | 6 个旧实验脚本、消融配置及说明；相对导入和输出路径已调整 |
| `benchmarks/real-agent/` | 24 个 TS 文件，含消融入口 | 26 个 TS 文件；SWE 配置、散列规则、结果收集各有独立文件 |
| `scripts/ci/` | 无测试身份清单脚本 | `test-manifest.ts`，显式接收测试报告、基线、输出路径 |
| 根 `HANDOFF.md` | 569 行历史交接 | 40 行当前导航；原文字节保存在 `docs/history/` |

`run-real-agent.ts` 从 539 行降至 378 行。`swe-results.ts` 接收原有 SWE 结果收集，`swe-profile.ts` 保存 0.24 美元批次上限及 OFF/V1/V2 配置，`evaluation-identity.ts` 保存既有散列规则。配置对象及序列化 SHA-256 与整理前一致（`0294866cce47fe49d9bed7994980d3b5e9e8f03877b08f98883b0aad0116501d`）。`budget-gateway.ts`、`controlled-policy.ts`、`controlled-stop.ts` 与整理前备份逐字节一致；`controlled-stop.ts` 不是本轮新增文件。

入口变化有实际影响：日常 npm 命令不再列 P5、质量和消融实验，新增 SWE 命令；普通 CI 不再执行 P5/质量实验，改为只运行单组 Runner 的 `--preflight`；测试身份清单要求显式路径，生成时间改为当前 ISO 时间；Vitest 只发现包内 `tests/**/*.test.ts`；发布包排除归档实验和历史交接。CI 仍对 54 个测试文件运行测试，根目录调用须带 `--exclude '**/.artifacts/**'`。历史报告保留当时路径，没有批量改写。

HEAD 到整理前已有这些行为变化，相关源码和测试的 26 项散列均与 `before.json` 对应：

| 范围 | 整理前已完成的行为 |
|---|---|
| 预算网关 | 请求转发前按输入上界和输出上限预留 token/费用；读取 SSE Usage 后结算，异常或未完成请求保留保守占用。 |
| 一次性授权 | 真实批次按 Commit、CI、配置、输入和输出身份校验，逐组消费；旧 grant 不可重放。 |
| Docker 与宿主清理 | 每组检查工作区身份、子进程关闭、容器移除、网关关闭及零活动/零预留，并写入绑定结果散列的宿主清理证据。 |
| OFF/V1/V2 继续条件 | 只有审计、网关结算和宿主清理证据成立才继续下一组；预算或超时等可分类停止与隔离/证据失败分开。 |
| 结果分类 | 单组记录运行状态、终止分类、补丁导出状态和诊断；官方 Harness 未运行时 `resolved` 仍为 `null`。 |

本次另有一处单独的行为修复：Linux 子进程在超时前若被 `SIGSTOP` 暂停，Runner 先发 `SIGCONT`，再按原流程发 `SIGTERM`。隔离 Linux 进程对照显示，单发 `SIGTERM` 后 300 毫秒未退出，先恢复再终止则在一秒内退出；这还不是 Linux 中实际 Pi Runner 加 Docker 的完整实测。

历史验收日志保留在 `.artifacts/structure-cleanup/final/`。Batch J 的 `recovers operation-in-flight durable Docker events after SIGKILL in a fresh process` 曾因夹具先发送“就绪”、后注册消息监听而两次失败；本轮仅对调这两步，对应测试文件专项 13 通过、1 项原有跳过。当前完整 Windows TypeScript 回归见 `current-vitest.json`：288 通过、0 失败、3 项原有跳过；`current-manifest.json` 的 291 项身份与基线一致。Python 15/15、预检、9 项工程/类型/打包检查和归档路径检查沿用未改代码的既有结果；本轮包内 TypeScript 类型检查通过。

Linux Node 从只读当前工作树成功加载实际 Runner 模块；unit/integration 共 213 通过、6 项 10 秒子进程超时失败、1 跳过，不能视为 Linux 全绿。同一挂载环境中，Runner 的无执行入口正常退出耗时约 10.9 秒，拒绝执行入口耗时约 18.3 秒，已超过单测的 10 秒等待时间；没有据此改业务代码或超时阈值。自动权限审查拒绝将宿主 Docker socket 与可写仓库一起挂载到 Linux 容器，因此 Linux Runner 的 Docker 强制用例和 `require-docker-evidence.ts` 门槛未完成；Windows Runner 调用 Linux Docker 的结果不能代替它们。

整理降低了单组入口阅读负担，但没有完全解耦。`run-controlled.ts` 仍有 418 行、`runner-execution.ts` 438 行，后者同时处理网关、Pi 子进程和 Docker 生命周期。SWE 执行仍调用 `batch-l-tools.ts`，旧 Batch/离线协议仍被安全回归引用。新增普通实验通常仍要检查批次选择、单组参数、准备阶段、执行扩展、结果收集和对应测试/CI；本轮不继续拆分。当前不具备提交条件，主要阻断是 Linux Docker 中真实 Runner、强制用例及证据门槛尚未完成。
