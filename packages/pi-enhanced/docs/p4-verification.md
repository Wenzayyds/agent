# P4 Task Manager V3 验收报告

日期：2026-11-02

本报告记录 Batch C 基线。Batch D 的证据规则、schema v2、真实进程中断、P3 Task 接入和 candidate 保存结果见 `p4-hardening-verification.md` 与 `batch-d-verification.md`；以下 120/120 数字不代表 Batch D 最终测试数。

## 已实现

- 默认关闭、trust 门控、独立 project-scoped SQLite 和 manifest；
- schema v1 事务迁移、WAL、CAS、append-only events、快照、证据、attempt、checkpoint 和 Session binding；
- Task/Step 状态机、DAG、依赖和可信完成门槛；
- Pi tool execution 观察、并行/嵌套 ID 保留、重复和乱序事件处理、有限审计；
- 重启时未结束 attempt 的 reconciliation 和只读 recovery preflight；
- 14 个用户命令（含暂停与安全恢复）、只读模型工具、默认关闭的 draft plan 工具；
- Memory candidate 预览和 `ScopedTaskReader`；P3 Task 自动注入保持关闭。

## 自动化结果

- 修改前真实工作树：20 个 TypeScript 文件、108/108。上批报告写 109，但当前收集器实际只有 108，本批没有删除旧测试。
- 最终 unit/integration：22 个文件、119/119。
- 加上真实 package/install E2E：23 个文件、120/120。
- Python：14/14。
- `npm run check --workspace=@wz-agent/pi-enhanced`：通过。
- `npm pack --dry-run --json --workspace=@wz-agent/pi-enhanced`：通过，87 个文件，压缩包约 130 KB；未包含测试和本地数据。
- 安装包 E2E 在含空格临时路径完成 tgz 打包和安装，加载安装后的 task-manager 入口，并重验 Python Worker；包中不含 tests、SQLite、Session、任务数据、venv、模型或索引。

持久测试覆盖 disabled/untrusted 不建库、同名目录隔离、未知高版本拒绝、DAG/CAS、模型自述不能完成、真实退出码证据、并行 sibling、嵌套 parent ID、阻断、乱序、重复和缺失 end、agent_settled 不完成、checkpoint、恢复分类和危险动作不重放。

## Benchmark

`p4-benchmark.json` 使用 8 个虚构任务和 5 个受控中断：安全 preflight 比例 1，需 reconciliation 操作 5，重复危险动作 0，错误完成 0，事件/快照重开一致率 1；write P50/P95 为 0.375/1.239 ms，recovery P50/P95 为 0.108/0.420 ms，SQLite 106,496 bytes。

这些数据只证明本地固定 fixture 可重复，不代表真实仓库任务成功率。

## 边界核对

没有修改 Pi Core、P1 Policy、Memory schema v2、MemoryService、Session JSONL、原生 Compaction 或 AGENTS.md；没有自动 commit/push/PR/部署，没有付费 API 或模型下载，没有开发 P5。
