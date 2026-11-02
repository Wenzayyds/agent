# P4 Task Manager 加固验收

日期：2026-11-02

## 已实现

### 真实中断与恢复

- 新增独立子进程 E2E：子进程创建任务、完成前置步骤、写 checkpoint，启动有副作用的 attempt 并改动受 Git 跟踪文件；父进程在 attempt 提交结束前终止子进程。
- 新进程打开同一数据库后，把未结束 attempt 标为 `needs_reconciliation`，区分已完成步骤和结果不确定步骤。
- 两次重开均不自动重放工具，受控文件只被写入一次。
- recovery preflight 固定 `automaticReplayAllowed=false`，检查 task/plan revision、事件与快照一致性、Session binding、真实路径、Git HEAD、已跟踪工作区状态和有限文件指纹。
- schema 过新、busy、损坏会让 Task runtime 失败关闭，不会修改 Memory、Context 或 Session 数据。

### 证据可信度

证据分为 `observed`、`validated`、`manual_attested`、`unknown`、`failed` 和 `model_claim`。旧 `verified_by_runner` 仅保留兼容读取，不再满足完成条件。

工具退出码为 0 只生成 `observed`。只有步骤预先保存 `command_exit` 规则，而且 toolName、输入摘要和 expectedExitCode 全部匹配，才生成 `validated`。文件规则通过 `/enhanced-task-evidence <task> <step> validate` 在当前项目内重新读取有界普通文件并核对 SHA-256。

中断 attempt 必须由用户通过确认界面选择 `do_not_retry` 或 `external_success`。后者生成 `manual_attested`，明确表示人工确认外部结果，不冒充自动验证；前者把步骤标为失败并阻止静默重试。模型自述、`agent_settled`、单独退出码 0 都不能完成步骤。

### Task → Memory candidate

`/enhanced-task-memory-propose <taskId>` 只预览；追加 `save` 后还要经过 UI 确认。写入通过独立 EventBus 桥按 canonical project 和 session 双重绑定，只接受 8,000 字符以内的已完成任务经验。Memory 权威服务最终保存 `experience/candidate`，来源为 `user` 与 `task:<id>`，不创建 verification，也不写 verified。Memory 不可用时返回受控错误，Task 状态不受影响。

## 持久化与迁移

Task schema 当前为 v2。持久测试覆盖 v1→v2 数据保留、过新 schema 拒绝、busy、损坏、重开 reconciliation、事件/快照一致性和跨项目隔离。Memory Schema v2 未修改。

## 已知限制

- 工作区观察是有限检测：Git status 忽略未跟踪文件，只额外哈希 `.git/HEAD`、`package.json`、`pyproject.toml`；它不是完整文件系统审计。
- `external_success` 依赖用户判断，不等于可重复的机器验证。
- candidate 写入的进程内重复请求会返回同一结果；跨重启重复保存仍可能产生两个 candidate，后续由 Memory Governance 去重审核。
- 没有自动执行引擎、危险动作重试、自动 commit/push/PR 或部署。
