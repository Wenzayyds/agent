# Batch I 真实模型试跑

2026-11-03 按用户授权执行一次 `deepseek/deepseek-flash` 的 `single-file-off-by-one`，未自动重试。

- 限制：8 次请求、20,000 Token、0.03 美元、180 秒、并发 1。
- 实际：3 次上游请求，输入 6516、输出 357、合计 6873 Token，费用 0.0023832 美元。
- 结果：模型生成正确补丁，独立隐藏验证器退出码 0。
- 停止原因：后续 4 次请求的保守 Token 预留会越过 20,000 上限，网关本地拒绝。
- Sandbox：无网、只读根、非 root，仅临时项目挂载可写；审计记录 find、ls、read、edit，未使用宿主工具、Shell 或 MCP。

因此原始 Runner 状态保留为 `budget_exceeded`，功能结果记为 `passed_with_budget_stop`。
