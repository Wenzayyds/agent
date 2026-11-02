# P3 Context 与 Task 状态兼容验收

日期：2026-11-02

## 实现

P3 新增可选 `taskInjection` 配置，默认关闭。只有 Context 为 `select`、项目受信任、Task Manager 已启用且当前会话显式绑定活动任务时，才会通过 `ScopedTaskReader` 读取摘要。

注入内容是低信任 `custom` 消息，放在最新 user 消息之前；不会修改 system prompt、工具定义、原始 Session JSONL 或 Pi 原生 Compaction。摘要只含 task/plan revision、状态、checkpoint、待处理步骤、依赖和 reconciliation 数量，不含工具参数、stdout 或文件内容。

读取采用两次核对：先取活动任务，再按 taskId 权威重读；最终边界重新比较 project、session、branch、revision、planRevision 和非终态。异步期间归档式变化、任务完成、取消、换分支、解绑或 revision 变化都会放弃注入。预算不足、Task Extension 未启用或 Reader 超时只跳过 Task 摘要，不影响原始 Context 流程。

## 验证

- 单元测试覆盖低信任标记、敏感信息脱敏、旧异步结果、错误 session/branch、终态和重复注入。
- 真实 Extension 生命周期测试覆盖显式创建、批准、绑定、注入，以及 `session_tree` 后解绑并停止注入。
- Context 默认关闭或 `taskInjection.enabled=false` 时，原行为不变。
- Memory 与 Task Reader 相互独立；任一不可用都只降级对应来源。

## 限制

Task 运行态绑定不跨进程自动恢复。重启后必须由用户重新显式绑定，P3 才会注入任务摘要。这避免把旧会话任务误当成当前执行上下文。
