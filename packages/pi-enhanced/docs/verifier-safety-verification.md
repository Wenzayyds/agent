# 隐藏验证器执行隔离与 Linux CI 准备

日期：2026-11-03。分支 `pi-agent`，基线 HEAD `58dada178ee73ef03d9e5216d8d504bb09f89aff`。Batch J 已结束，其源码与测试不另行返工；本轮在现有 Runner 上接入独立验证容器。

## 当前结论

隐藏验证器的本地改动及回归已完成：模型修改后的 JavaScript 只在 Docker 中执行，宿主不再导入补丁代码。用户已单独授权提交并正常推送。首次远端 Linux 与 Docker job 通过，Windows 触及根测试入口默认 5 秒时限，正在验证配置修正。本轮没有付费模型调用或手动 Workflow 触发，未开始 Memory、Context、Task Manager 的真实效果评估。

本轮只新增这份验收文档和 [verifier-safety-results.json](verifier-safety-results.json)。测试原始结果、生产 Runner 的 Stub 证据和待提交差异保存在 `.artifacts/verifier-safety/`。

## 实现与执行边界

新增 `benchmarks/real-agent/docker-verifier.ts`，供生产 `run-real-agent.ts` 直接调用。保留现有六类夹具的输入和预期结果，预期值及最终断言留在宿主可信代码中；被修改的模块在容器中计算观测值。长报告的内容校验也在容器内读取、计算哈希，宿主不读取补丁模块。

验证容器复用文件工具的固定镜像和非 root 用户选择方式，只有临时项目的一处**只读**挂载：

| 限制 | 配置 |
| --- | --- |
| 镜像 | 复用现有 sha256 固定镜像，`--pull never`，缺失时失败 |
| 网络、根文件系统 | `network=none`、只读根 |
| 权限 | 非 root、cap-drop ALL、no-new-privileges |
| 项目 | 仅 `/workspace`，只读；不挂载运行根目录、审计、Agent 配置或 Docker socket |
| 资源 | 128 MiB、0.5 CPU、32 PIDs、16 MiB 临时文件系统 |
| 时间、输出 | 默认执行 5 秒，stdout/stderr 合计 16 KiB；超限删除容器 |
| 凭据 | 不传入宿主环境变量，不挂载 `.env` 或认证目录 |

执行前检查原工作区的设备号、inode 和规范路径；容器启动前核对真实镜像、用户、挂载和隔离属性。执行结束再次检查工作区身份和容器退出状态。所有正常或失败路径都尝试删除本次容器；清理失败不能报告通过。

Docker 不可用、镜像缺失、身份改变、协议损坏、超时、输出超限或容器执行故障均记录验证器错误，不执行宿主回退。报告保留 `verification` 的容器证据、退出码、状态、时间、输出字节数和清理结果，不保留原始 stdout/stderr 或文件正文。

容器的零退出码不直接代表通过。提前 `process.exit(0)` 没有产生合法观测结果，会记录 `protocol_error`；普通返回值不符合预期则为 `verification_failed`。验证器基础设施异常复用现有 `sandbox_runtime_error` 终止分类，和 Agent 正常结束、Provider 故障分开。

初始夹具的自检仍在宿主运行：它只发生在 Runner 写入固定源码、尚未启动 Agent 之前。后续所有补丁验证均使用 Docker。本轮没有把不可信项目测试或模型代码加进这条初始自检路径。

Docker 构成执行隔离边界；这些固定功能断言仍是现有合成任务的有限验证，不代表完整 SWE-bench 评测或恶意程序的语义证明。没有扩大镜像信任范围，也没有修改 Pi Core、Memory、Context、Task Manager、MCP Policy 或工具沙箱的权限规则。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| 完整 TypeScript unit/integration/E2E | **224：221 passed、0 failed、3 skipped** |
| Batch J 的 209 项身份 | 缺失 0 |
| 新增验证器 Docker 专项 | 10/10 passed |
| 生产 Runner 与原六格批次专项 | 8/8 passed，包含两项新增恶意补丁场景 |
| 新增 Linux CI 证据检查单元测试 | 3/3 passed |
| Python | 15/15 passed |
| 根 TypeScript/Biome 与依赖检查、评测链 TypeScript | passed |
| 新增文件单独 Biome 检查 | passed |
| npm pack 与内容泄漏检查 | forbidden 0、contentLeaks 0；实际安装包 E2E 包含在全量回归中 |

以上专项包含在总数中，不能重复相加。三项跳过是原有 Context7、Serena 外部 MCP 条件测试，以及 Windows 对活动 Pi cwd 重命名返回 EBUSY 的用例。Linux 内核中的验证容器已实测，但**这不等于 Linux 宿主 CI 已实测**。

专项覆盖：正确及错误返回值、提前零退出、非法 JSON、异常、死循环、输出洪泛、宿主哨兵文件不可读写、宿主测试环境变量不可见、项目及根目录不可写、无外网、身份替换和缺失镜像。

生产 `run-real-agent.ts` 的两项新增测试使用 Stub Provider、本地硬预算网关、真实 Pi CLI 和原文件工具容器。Stub 写入补丁后，实际走新验证器：

- 提前零退出：Agent 正常结束、上游两次请求均正常结算，但补丁验证失败，分类为 sandbox_runtime_error，而非 Provider 错误。
- 尝试写宿主哨兵和只读挂载的补丁：两个写入均被限制；哨兵不变，正常函数结果通过固定断言，验证容器已清理。

所有账目为 Stub 的模拟 usage，付费请求和实际费用均为 0。未重跑历史 DeepSeek 六格实验。

第一次两 worker 全量回归为 220 passed、1 failed、3 skipped；失败是已有 Batch J 强制中断测试没有观察到短暂 pending 状态。没有改写该测试或降低断言。将共享 Docker Engine 的测试串行执行后，全量 221 passed。CI 同步设置 `--maxWorkers=1`。这记录了本次观察与执行配置调整，不据此声称已经证明旧用例完全不存在时序波动。

## Linux CI 与待执行动作

现有 Windows/Linux 和 Docker workflow 已复用，未新建第二套流水线。主要调整：

1. 209 项 Batch J 清单作为后续回归身份基线，兼容旧清单输入。
2. Docker job 加入验证器专项及生产 Runner 恶意补丁测试。
3. 新增 `require-docker-evidence.ts`，要求 Docker job 不得跳过测试，且活动目录身份替换、提前退出与隔离攻击用例必须实际通过；只配置而未执行不能作为成功证据。
4. 将真实容器和 Runner 证据随原 job artifact 上传。

提交前远端 job 状态均为 `configured_only`，没有新 run URL、Commit ID 或远端成功记录。用户已单独授权将审查后的 29 个必要文件提交并正常推送 `pi-agent` 到 `origin/pi-agent`，继续检查 Windows/Linux/Docker CI。历史 P5 真实结果、controlled-six 原始报告和运行目录不纳入提交；`.env`、密钥、数据库、Session、日志和缓存不纳入提交。后续远端结果在本轮同一对报告中更新。

首个提交 `5c066bb406484f1d1303c8abf16aa95be70e5272` 的 [CI 41657433565](https://github.com/Wenzayyds/agent/actions/runs/41657433565)：Linux 184 passed/0 failed/40 skipped；Docker 73/73，真实活动目录身份替换和验证器隔离用例均通过。Windows 181 passed/1 failed/42 skipped，失败为 256 次真实 fsync 的容量测试超过根入口默认 5 秒。CI 现显式采用子包原有的 30 秒 testTimeout，验证器自身 5 秒上限及全部安全断言未变；Docker 同时启用隐藏 JSON 报告上传。等待该配置修正提交的全套 CI。

只有当前修改的完整 CI 真正通过后，才进入 Memory、Context、Task Manager 效果评估的方案与授权阶段。真实模型调用仍需另行授权，不能沿用旧六格预算。
