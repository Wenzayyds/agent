# Pi Enhanced TypeScript / Python 架构边界

本文记录 `PI_ENHANCED_HYBRID_TS_PYTHON_DEVELOPMENT_PLAN.md` 确定的语言分工，并按 P2-8 的实际实现更新。

## 权威状态继续由 TypeScript 持有

以下模块与 Pi 生命周期、权限或真实数据直接关联，继续使用 TypeScript：

- Pi Extension 注册、runtime 和 Session 生命周期；
- MCP Policy、用户审批和审计；
- ProjectScope、项目可信门禁和跨项目隔离；
- MemoryService、candidate/verified 状态机和验证证据；
- SQLite 主数据库、migration、FTS5 基线与 Core Memory 文件；
- SessionManager 分支读取和模型可见投影；
- P3 Context 事件、消息结构和上下文预算；
- P4 Task 状态、checkpoint、工具证据和幂等恢复。

权威数据只有一份：原始对话属于 Pi SessionManager；可复用记忆属于 TypeScript MemoryService；Core Markdown 属于 CoreMemoryStore；任务状态属于后续 TypeScript Task Manager。

## Python 只处理可丢弃的派生能力

P2-8 已按以下范围引入 Python：

- Embedding、向量召回、重排和语义评分；
- 上下文候选片段评分；
- 离线数据集、指标、统计和可视化评测。

Python 不得写 `memory.sqlite3`、修改 Session JSONL、接受任意 projectId 作为授权、把 candidate 提升为 verified，或直接改变系统提示和任务完成状态。当前向量索引只在 Worker 内存中存在，可以随进程删除重建；最终结果由 TypeScript 按项目、状态、contentRevision 和 contentHash 复核。

## 当前阶段

- P2-1～P2-6：现有 TypeScript 实现保留，不迁移；P2-5 Recall 只读使用 Pi SessionManager 公开接口，P2-6 命令、工具和 Reader 接线继续由 TypeScript 持有。
- P2-7：已用 TypeScript 完成收尾，并通过同名 hidden 重注册撤回关闭后的模型工具。
- P2-8：已实现可选 Python Retrieval Worker、LSA 本地向量、FTS5 + 向量 RRF 和自动降级；默认仍为 lexical。
- P3：Context 请求视图继续由 TypeScript 管理；Python 只保留为未实现的可选评分方向。
- P4：已由 TypeScript 实现独立任务库、DAG、CAS、事件、证据、checkpoint 和恢复前检查；没有 Python Task Authority，也没有工具自动重放。
- P5：评测调度可以使用 TypeScript 或 Python，但必须保留结果类别、仓库 Commit、验证器和运行环境。Batch D 的首个底座使用 TypeScript 生成 8 个本地 Git 夹具，只验证确定性工具回放；真实模型任务和官方 SWE-bench 均未运行。
# P3 Context 补充边界

P3 Context 全部由 TypeScript 实现。它消费 Pi 已形成的模型可见消息，只生成单次请求视图，不持有 Session 权威状态。Token 估算复用 Pi 导出接口，工具调用配对检查、历史选择、Memory verified 复核和最终降级都留在 TypeScript。

本轮评估后没有扩展 Python Worker 的协议。现有 Python 进程继续只接收 verified Memory 的有界快照和检索查询，不接收完整会话历史。`pythonScoring` 配置只报告 `not-implemented`。这样 Python 缺失、启动失败或协议异常不会影响 Context 的结构安全，也不会扩大 Worker 的数据读取范围。

Context 与 Memory 的连接只通过 `ScopedMemoryReader`：

```text
Pi context event
  -> TypeScript Context selector
  -> optional ScopedMemoryReader request
  -> TypeScript verified / scope / revision check
  -> low-trust custom message (model-side user)
  -> model request
```

系统提示、工具定义、Session JSONL、SQLite 权威状态和原生 Compaction 都不经过 Python。

Context 与 Task Manager 同样只通过 `ScopedTaskReader` 连接。Reader 按 canonical project、session 和活动 binding 限定范围，P3 在异步返回后再次核对 revision、planRevision 和 branch。Task 摘要默认关闭、只读且低信任；Python 不参与任务状态判断。

Task → Memory 写入只允许用户命令经确认后请求 TypeScript candidate writer。MemoryService 仍是最终权限边界，保存结果固定为 candidate；Python Worker 不参与写入，也不能产生 verification。

