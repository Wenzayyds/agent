# P4 已知限制

- Task Manager 不是执行引擎、权限沙箱或事务协调器；它不会自动继续模型流，也不会重放任何工具。
- P1 MCP Policy 不覆盖 Pi 原生工具。P4 的风险分类只是恢复辅助，不能阻止所有危险命令。
- shell runner 的结构化退出码只属于观察信息；即使匹配显式验证规则，也只证明该规则通过，不证明软件绝对正确。外部副作用仍需人工核对。
- 工作区指纹是有限快照，不递归读取全部文件；变化能提示复核，不变也不能证明整个工作区完全相同。
- EventBus/Extension 不是恶意插件之间的安全隔离边界。
- Pi 没有 unregisterCommand；曾经 ready 后关闭，业务命令名称可能仍可见，但 runtime 检查会拒绝访问，模型工具重注册为 hidden。
- `ScopedTaskReader` 已接入 P3，但摘要注入默认关闭；重启后不会自动恢复活动 binding，需要用户重新显式绑定。
- Memory 经验可在用户确认后保存为 candidate；跨重启重复保存仍可能形成多个 candidate，需要 Memory Governance 审核去重。
- schema v2 没有自动压缩事件或在线备份调度；数据库有 256 MiB 硬上限，达到后需人工归档。
- Benchmark 是虚构任务和事件，不能解释为 SWE-bench 成功率、真实崩溃无损恢复率或生产性能承诺。
