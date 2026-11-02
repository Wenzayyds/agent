# P4 SQLite Schema、迁移与恢复

## Schema v2

独立 `tasks.sqlite3` 包含：`tasks`、`task_steps`、`task_events`、`task_snapshots`、`task_evidence`、`task_attempts`、`task_checkpoints`、`task_session_bindings` 和 `schema_migrations`。

- `tasks` 是当前任务快照；revision 与 planRevision 分开。
- `task_steps.depends_on_json` 只保存已通过 DAG 校验的有限字符串数组；v2 新增 `validation_json`，保存明确的命令退出或文件 SHA-256 验证规则。
- `task_events` 只追加，taskId+seq 唯一，正文限制 8,000 字符并保存 SHA-256。
- `task_snapshots` 按 task revision 保存规范 JSON、事件序号和 SHA-256；重开后核对事件连续性、事件正文哈希及最新快照与权威表的一致性。
- attempt 的 taskId+toolCallId 唯一，用于重复事件幂等；v2 新增 `input_digest`，证据可关联 attempt、输入摘要和结果摘要。
- v2 checkpoint 新增 `workspace_json` 和 `plan_revision`，用于恢复前比较真实路径、Git HEAD、工作区状态和计划版本。
- evidence、checkpoint 和 binding 均以外键绑定任务，SQLite foreign_keys 开启。

## 初始化和升级

只有 `enabled + trusted` 的活动 runtime 才创建 manifest 和数据库。初始化、索引和 migration 在 `BEGIN IMMEDIATE` 中完成；WAL、foreign keys、1.5 秒 busy timeout 和 256 MiB max_page_count 在打开时设置。v1→v2 只追加列和 migration 记录，持久测试确认原任务不丢失。发现高于支持版本的 migration 会拒绝启动，不尝试降级写入。

## 备份与回滚

发布前备份应在 Pi 关闭、WAL 已正常 checkpoint 后复制 `tasks.sqlite3` 及仍存在的 `-wal/-shm`，或使用 SQLite 在线备份工具。旧代码不认识 v2，不能直接打开升级后的数据库。需要回滚时应先恢复整库备份；不要手工删除 v2 列，不要把删除数据库当成迁移回滚。

事务失败会回滚事件和快照。任务取消不会删除数据库或项目文件。数据库损坏、busy 或未知 schema 会使 Task runtime 进入 error，不影响 P2/P3 和原始 Session。
