# P5 可复现评测底座

日期：2026-11-02

## 三类结果必须分开

1. `deterministic_tool_replay`：固定本地仓库、固定修改、固定验证器，用于检查评测脚本、Git diff 和测试采集是否可重复。
2. `real_model_coding_agent_task`：真实模型在明确仓库、模型版本、提示、预算和工具策略下完成编程任务。Batch D 未运行。
3. `official_swe_bench`：使用官方数据、容器与评分 harness 得到的结果。Batch D 未运行。

任何第一类结果都不能写成 Agent 成功率，也不能写成 SWE-bench 分数。

## 当前实现

`benchmarks/p5-evaluation.ts` 每次生成 8 个无私密信息的本地 mini Git 仓库，固定提交时间，记录仓库 Commit。脚本执行确定性单行修复，再运行 `git diff --check` 和本地测试。输出 `p5-evaluation-results.json`，逐任务记录 executionClass、commit、patchValid、testPassed、status 和耗时。

当前实测 8/8 只说明评测链路与验证器正常。真实模型任务和官方 SWE-bench 字段均明确为 `not_run`。

## 后续真实模型评测最低要求

- 固定公开或获授权的仓库 Commit、任务文本和容器镜像摘要；
- 记录模型供应方、模型版本、推理参数、最大 token、时间和费用上限；
- 保存工具事件、最终 patch、测试命令和退出状态，但不保存凭据；
- 至少报告任务级结果和失败分类，不只报告平均值；
- 多次运行时报告样本数与方差；
- 与确定性回放、官方 SWE-bench 分开存储和展示。

本批没有调用付费 API，没有下载模型，也没有运行或伪造 SWE-bench。
