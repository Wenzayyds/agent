# P5 真实模型验证

真实 Coding Agent 任务采用固定合成仓库和独立隐藏验证器，不以确定性回放代替模型成功率。

Batch I 的单次 DeepSeek 试跑已产生正确补丁并通过隐藏测试。权威用量来自本地硬预算网关：3 次上游请求、6873 Token、0.0023832 美元；4 次后续请求因 Token 预留超限被本地拒绝。详情见 `batch-i-real-model-pilot.md`、`batch-i-real-model-results.json` 和原始 `evaluation-output/pilot_i5_deepseek_20261103/`。

该结果只证明一个固定小任务成功，不代表 SWE-bench 成绩或总体 Coding Agent 成功率。
