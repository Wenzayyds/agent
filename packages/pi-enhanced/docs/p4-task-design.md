# P4 Task Manager V3 设计

## 权威边界

P4 是独立的 TypeScript 项目级任务状态机。它管理计划、事件、证据、checkpoint 和恢复建议，不复制 Pi Agent Loop，不执行或重放工具，也不把任务写入 Session 或 Memory 数据库。

存储路径为：

```text
<agentDir>/pi-enhanced/tasks/projects/<projectId>/tasks.sqlite3
```

projectId 复用现有规范工作区身份，模型和命令不能传入其他 projectId。disabled、untrusted 或配置错误时不会创建目录和数据库。

## 计划与状态

Task 使用 draft、queued、running、paused、blocked、verifying、completed、failed、cancelled、needs_reconciliation。Step 使用 pending、running、blocked、verifying、completed、failed、skipped、needs_reconciliation。

- 每步必须有 title、expectedOutcome 和显式依赖；计划拒绝自依赖、悬空依赖、重复 ID 和环。
- 计划修改只允许 draft，并使用 planRevision CAS。
- Step 进入 running/verifying/completed 前要求依赖已完成。
- Step completed 需要当前 `validated` 或 `manual_attested` 成功证据；旧 `user_attested` 只保留兼容，旧 `verified_by_runner` 不再通过完成门槛。
- Task completed 要求全部步骤完成、每步有可信证据，并由交互命令再次确认。
- `model_claim`、普通 observed 工具文本和 `agent_settled` 都不能通过完成门槛。

## 事件和执行证据

所有状态改变在 `BEGIN IMMEDIATE` 内同时更新快照并追加带 seq、payload hash 的事件。工具观察只在用户显式 binding 后生效：

- start 建立 attempt，保存 ID、工具名、风险类和哈希，不保存原始参数；
- end 只保存有限机器元数据摘要和哈希，不保存 stdout、文件内容或密钥；
- 结构化 exitCode=0 只形成 `observed`；只有预先保存的 command_exit 规则同时匹配工具名、输入摘要和预期退出码，才形成 `validated`；自然语言“tests passed”不行；
- 重复 start/end 通过 taskId + toolCallId 去重；乱序 end 不凭空创建证据；
- read_only、mutating、external_side_effect、unknown 风险只影响恢复提示，首版均不自动重放。

## Checkpoint 与恢复

Checkpoint 保存 task revision、Session/leaf、有限工作区指纹、待处理步骤和最后事件 seq。指纹只查看根路径、`.git/HEAD`、package.json、pyproject.toml 的有限元数据/小文件内容，不递归扫描工作区，也不能证明所有文件未变化。

重启时所有未结束 attempt 进入 needs_reconciliation。preflight 区分 completed、failed、pending 和 unknown，比较 Session、分支、revision 与工作区指纹，并固定返回 `automaticReplayAllowed=false`。

## 交互和跨模块

用户命令覆盖 create/list/inspect/plan/approve/step/checkpoint/recover/evidence/complete/cancel/memory-propose。模型只得到只读 `enhanced_task_get`，以及默认关闭的 `enhanced_task_propose_plan`；后者只能创建待审核 draft。

P4 提供 session/project 绑定的 `ScopedTaskReader`。P3 可选消费当前活动任务摘要，但配置默认关闭，并在注入前二次核对 branch 和 revision。Memory 联动默认只预览；用户追加 `save` 并确认后，可通过受限跨 Extension 桥写入 candidate，永远不直接写 verified。
