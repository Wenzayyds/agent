# Batch D 开发验收报告

日期：2026-11-02

## 完成情况

- D0：建立起始与最终测试身份清单，解释 109/108 差异，确认起始 120 项无遗失。
- D1：完成真实子进程中断、权威重开、reconciliation、Git 工作区变化、busy、损坏和过新 schema 验证。
- D2：完成证据分级、输入/结果摘要绑定、显式 command/file 验证和人工对账；退出码 0 不再自动视为可信验收。
- D3：P3 可选只读 Task 摘要接入，默认关闭，最终边界二次核对并可降级。
- D4：完成用户确认后的 Task→Memory candidate 保存；没有自动 verified。
- D5：建立确定性工具回放评测底座，并明确真实模型和官方 SWE-bench 未运行。
- D6：完成测试、打包检查、结果数据和文档更新。

## 最终验证

- TypeScript unit/integration/E2E：26 个文件，127/127。
- Python：14/14。
- TypeScript：`npm run check --workspace=@wz-agent/pi-enhanced` 通过。
- Biome：`npx biome check packages/pi-enhanced` 通过。
- 根目录六项只读检查：pinned deps、runtime deps、TS imports、entry graphs、install lock、browser smoke 均通过；没有运行会调用 `biome-check --write` 的聚合命令。
- 打包：`npm pack --dry-run --workspace=@wz-agent/pi-enhanced` 通过；不包含 tests、fixture、SQLite、Session、工作区数据、venv、模型或索引。
- 安装包 E2E：从实际 tgz 安装并启动 Worker 的既有测试通过。
- P5 确定性回放：8/8；真实模型任务 `not_run`；官方 SWE-bench `not_run`。

Windows 应用沙箱禁止 Core Memory 测试使用硬链接，因此完整 TypeScript 回归在获准的沙箱外测试进程运行；这是测试所需文件系统能力，不是放宽产品权限。

## 边界核对

本批没有修改 Pi Core、P1 MCP Policy、Memory Schema v2、Session JSONL 或原生 Compaction；没有清理、重置或覆盖用户原有未提交改动；没有自动重放危险操作，没有开发新的自动执行引擎，也没有继续开发 P6。
