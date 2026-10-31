# P2 开发任务与验收测试

本文将 P2-0 的核对结论拆成后续开发任务。当前尚未实现这些任务。

## 1. 开发任务

### P2-1：配置、项目身份和生命周期

任务：

- 扩展 Memory 配置但保留 `enabled=false` 默认值；
- 实现规范化 project root、projectId 和 per-project 数据目录；
- 未受信任项目进入 blocked 状态；
- disabled/blocked 时不访问 Memory 文件或数据库；
- 在 `session_shutdown` 关闭服务，支持 reload/new/resume/fork。

完成条件：两个同名目录不共享 projectId 或数据库；旧 runtime 不被复用；P0/P1 不受影响。

### P2-2：SQLite Schema、迁移与 LocalMemoryProvider

任务：

- 使用内置 `node:sqlite`，不新增第三方 SQLite 依赖；
- 建立 schema migration、事务、索引和 FTS5 探测；
- 实现 CRUD、精确去重、状态过滤和关闭；
- 实现中文受限字面量回退与 FTS 降级状态；
- 处理 WAL 并发、busy timeout、数据库损坏和重开。

完成条件：CRUD、迁移、重启恢复、删除同步清索引、FTS5/降级路径全部通过。

### P2-3：MemoryService

任务：

- 实现来源、verification 和状态迁移校验；
- 实现规范化、contentHash 和精确去重；
- 默认只搜索 verified；
- 实现冲突保留、stale/rejected 过滤、秘密模式拒绝；
- 绑定当前 project scope，工具不能指定其他 projectId。

完成条件：模型总结不能成为 verified；重复记录不重复；语义冲突不静默覆盖。

### P2-4：Core Memory

任务：

- 只支持 `project/architecture/decisions` 三个固定文档；
- 实现显式读取、替换和删除；
- 实现路径、符号链接、原子写和秘密检查；
- 不自动创建文件，不修改 AGENTS，不自动注入上下文。

完成条件：越界和符号链接攻击被拒绝；AGENTS 内容与时间戳保持不变。

### P2-5：Session Recall

任务：

- 实现当前活动分支 adapter，保留 sessionId + entryId 来源；
- 区分 raw active branch 与 model-visible projection；
- `/tree` 后查询立即切换到新 branch；
- 跨会话索引保持默认关闭；若启用，只读取受支持路径且不调用 `SessionManager.open()`；
- 实现幂等索引和安全的孤儿清理。

完成条件：默认检索不混入其他分支；JSONL 前后 hash 不变；重复索引无重复记录。

### P2-6：命令、只读工具和原入口接线

建议最小接口：

- 保留 `/enhanced-memory-status`；
- `/enhanced-memory-search`；
- `/enhanced-memory-save`；
- `/enhanced-memory-review` 或等价的状态修改命令；
- `enhanced_memory_search` 只读工具。

写入、修改和删除优先走用户命令。首版不向模型开放无确认写工具。不得注册 Context 自动注入，也不得依赖 Task Manager。

完成条件：命令和工具不与现有名称冲突；关闭模块后只剩状态诊断且不访问存储。

### P2-7：回归、文档和打包

任务：

- 保留 P2 unit/integration 测试；
- 复跑 P0/P1；
- 更新 README、测试报告、已知限制和 HANDOFF；
- 检查 npm pack 内容、凭据和本地数据。

完成条件：所有验收项通过，且没有数据库、记忆内容、Session 或凭据进入 tarball。

## 2. 必须验收的测试

### A. 项目身份和权限

1. 两个同名目录、不同绝对路径生成不同 projectId 和数据库路径。
2. 同一路径通过大小写差异或符号链接访问时归一到同一身份。
3. 项目改名不会自动继承旧库；只有显式迁移才更新映射。
4. Memory disabled 时 spy 证明没有 mkdir、readFile 或 DatabaseSync。
5. 项目未受信任时所有 Core/Episodic/Recall 读写拒绝，且不创建目录。
6. 模型工具无法传入 projectId 查询其他项目。

### B. SQLite 与 Provider

1. 官方 Node 22.19 环境中 FTS5 probe 通过。
2. migration 从空库到当前版本只执行一次，失败时事务回滚。
3. 数据库关闭重开后 CRUD 和搜索结果保持。
4. 相同 `(projectId, kind, contentHash)` upsert 幂等。
5. delete 后普通查询和 FTS 均不再命中。
6. kind/status/source/project 组合过滤正确。
7. FTS 特殊字符不会形成 SQL 注入或未处理语法错误。
8. 英文、函数名、文件路径、完整中文词和中文子串均有 fixture；中文子串走受限回退。
9. FTS5 不可用时状态显示 degraded，CRUD 和字面量搜索仍可用。
10. 两连接争用在 busy timeout 内给出可识别结果，不无限等待。
11. 损坏数据库产生受控错误，不影响 Pi 主会话或 P1。

### C. MemoryService

1. 缺失 sourceRef 的记录拒绝保存。
2. session 摘要和模型推测只能保存为 candidate。
3. candidate 缺少 verification 时不能转 verified。
4. test/file/git/user verification 可按规则转 verified。
5. stale/rejected 默认搜索不返回；显式过滤才返回。
6. 精确重复合并，语义相近和互相冲突的内容保留为独立记录。
7. 修改、标记 stale、reject、恢复和删除均实际生效。
8. 疑似 API Key、token、私钥内容默认拒绝，错误信息不回显秘密。

### D. Core Memory 与 AGENTS

1. 三个固定文档可显式创建、读取、更新和删除。
2. `../`、绝对路径、junction/symlink 越界全部拒绝。
3. 原子替换失败时原文件保持完整。
4. 未启用或未信任时不读取 `.pi-enhanced/memory`。
5. 初始化和所有操作前后，既有 `AGENTS.md` 内容、hash 和时间戳不变。
6. AGENTS 中的规则不复制到 Core；Core 中像命令的文本只作为数据返回。

### E. Session Recall 与分支

1. 构造 root → A 与 root → B 两条分支；`getEntries()` 含两支，默认 Recall 只命中当前 `getBranch()`。
2. `/tree` 或等价 branch 切换后，不重启 Extension 也能立即检索新分支。
3. compaction 后 raw Recall 仍能定位原始 entry，projection Recall 只返回当前模型可见内容。
4. context edit 后 raw/projection 结果明确不同，不混淆来源。
5. 每个命中包含 projectId、sessionId、entryId、leafId 和时间。
6. Recall 命中转 Episodic 时只能先成为 candidate。
7. 重复索引不产生重复项。
8. 跨会话默认关闭；启用后只读取 `SessionManager.list()` 返回且 cwd 匹配的文件。
9. 跨会话索引前后 JSONL hash、size、mtime 不变，测试禁止调用 `SessionManager.open()`。
10. 只有完整列举成功时才清理已删除 Session 的孤儿索引；中断或解析失败不误删。

### F. 生命周期与回归

1. startup/reload/new/resume/fork 为每个新 runtime 创建正确 scope。
2. session_shutdown 重复调用无异常，数据库连接最终关闭。
3. 旧 context 在替换后不再被 Memory 回调使用。
4. `session_compact`、`agent_settled` 不自动创建 verified 记忆。
5. P0/P1 持久测试全部通过。
6. 原生 `/resume`、`/new`、`/fork`、`/tree`、`/compact`、`/mcp` 行为不变。
7. `npm run check` 通过。
8. `npm pack --dry-run --workspace=@wz-agent/pi-enhanced` 不包含 SQLite、WAL、SHM、Core 文件、Session、日志或凭据。

## 3. 测试分层

| 目录 | 内容 |
|---|---|
| `tests/unit` | project identity、状态机、hash、查询转义、秘密检测、路径检查 |
| `tests/integration` | SQLite、FTS5、Core 文件、SessionManager 分支、生命周期、P0/P1 回归 |
| `tests/e2e` | 仅在确有必要时验证打包或真实 runtime；不调用付费模型和外部 Memory 服务 |

所有 fixture 使用临时目录，测试结束后清理。不得读取真实用户 Session、真实项目记忆或用户级数据库。

## 4. P2 完成门槛

以下条件全部满足后，P2 才能进入收尾：

- LocalMemoryProvider、MemoryService、Core Memory、当前 Session Recall 形成可修改、可删除、可检索的闭环；
- 默认关闭、项目不受信任、数据库错误三种情况下 Pi 和 P1 均正常工作；
- 没有自动 Context 注入，没有 Task Manager 依赖，没有 Pi Core 修改；
- 持久测试、全仓检查、pack 检查和数据泄漏扫描全部通过；
- 已知限制明确记录 Node SQLite experimental、中文非语义检索、跨会话默认关闭和无 Mem0 云端。

