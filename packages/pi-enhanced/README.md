# Pi Enhanced

这是 Pi 增强模块的独立 Package。P0 建立可加载、可配置、可独立关闭的扩展骨架；P1 已实现 MCP 调用策略和脱敏内存审计；P2-1～P2-8 已完成项目级 Memory、Core Memory、当前 Session Recall、交互入口、跨 Extension Reader，以及可选的本地语义与混合检索；Memory V3 Batch A 又补充了分类、生命周期、关系、Doctor 和需要用户批准的维护提案。P3 已实现默认关闭的 Context 请求视图；Task Manager 尚未开发。

## 模块入口

Package 暴露四个独立 Extension：

| 模块 | 入口 | 状态命令 |
|---|---|---|
| MCP Policy | `extensions/mcp-policy.ts` | `/enhanced-mcp-policy-status`，P1 已实现 |
| Memory | `extensions/memory.ts` | `/enhanced-memory-status`；启用且受信任后开放 P2-6 交互命令 |
| Context | `extensions/context.ts` | `/enhanced-context-status`、`/enhanced-context-inspect` |
| Task Manager | `extensions/task-manager.ts` | `/enhanced-task-manager-status` |

这些命令不会覆盖 Pi 内置的 `/mcp`、`codemode` 或 `tool_search`。

### Memory 交互

Memory 模块只有在配置启用且当前项目受信任时才打开项目存储，并动态注册以下入口：

- `/enhanced-memory-search <query>`：查询 verified Episodic Memory；
- `/enhanced-memory-recall [raw|projection] <query>`：查询当前 Session 活动分支；
- `/enhanced-memory-save`、`/enhanced-memory-confirm`、`/enhanced-memory-review`：通过真实 UI 保存 candidate、确认和审查；
- `/enhanced-memory-core <get|create|update|delete> <project|architecture|decisions>`：管理三个固定 Core 文档；
- `/enhanced-memory-list`、`/enhanced-memory-inspect`、`/enhanced-memory-doctor`：查看治理元数据和只读诊断；
- `/enhanced-memory-maintain dry-run|show|apply`：生成/查看维护提案，apply 要求真实用户确认和 revision 复核；
- `/enhanced-memory-archive`、`/enhanced-memory-restore`、`/enhanced-memory-delete`：可逆归档、恢复和二次确认的单条删除；
- `enhanced_memory_search`：模型唯一可调用的 Memory 工具，只读 verified，不接受 projectId、状态或路径参数。

Memory 文本和 Session Recall 都按低信任数据处理，不会进入 system prompt。P2-6 同时提供生命周期受控的 `ScopedMemoryReader`；P3 只有在 Context 和 `memoryInjection` 均显式开启时，才把经过 verified 复核、限额和脱敏的 Episodic Memory 作为低信任 user 侧资料注入本次请求。

P2-8 默认继续使用 SQLite FTS5。用户显式启用 semantic 或 hybrid 后，TypeScript 才会按当前项目的 verified 快照懒启动本地 Python Worker；Python 只做可重建的向量计算，命中由 TypeScript 重新核对项目、状态和版本。Python 不可用时自动回到 FTS5。

## 配置

默认情况下四个模块全部关闭。用户级配置放在 `~/.pi/agent/pi-enhanced.json`：

```json
{
  "modules": {
    "mcp-policy": { "enabled": false },
    "memory": { "enabled": false },
    "context": { "enabled": false },
    "task-manager": { "enabled": false }
  }
}
```

受信任项目可以在 `.pi/pi-enhanced.json` 中覆盖普通模块。`mcp-policy` 使用更严格的分层合成：项目可以添加规则，但不能用 allow 覆盖用户级明确 deny，也不能关闭已经由用户启用的策略。未受信任项目的配置不会读取。

普通模块配置损坏时保持关闭。`mcp-policy` 已启用或存在错误配置时采用关闭执行策略，MCP 调用不会因为解析错误而放行。

Memory Intelligence 的可选配置示例：

```json
{
  "modules": {
    "memory": {
      "enabled": true,
      "intelligence": {
        "enabled": true,
        "mode": "hybrid",
        "rerankerEnabled": false
      }
    }
  }
}
```

`mode` 支持 `lexical`、`semantic`、`hybrid`，默认是 `lexical`。配置不能指定脚本、数据库路径或 projectId。Python 环境、超时和快照上限见 [P2-8 验证](docs/p2-8-verification.md)。

Memory Governance 阈值是显式且有范围限制的配置：

```json
{
  "modules": {
    "memory": {
      "enabled": true,
      "governance": {
        "maximumScanRecords": 500,
        "nearDuplicatePercent": 82,
        "archiveAfterDays": 180,
        "coreWarningBytes": 49152
      }
    }
  }
}
```

Doctor 不写数据。`maintain dry-run` 只持久化可审查的 proposal 草稿，不改变 Memory 内容或状态；压缩/合并 apply 只生成新的 candidate，不继承 verified。Batch A 没有后台自动维护和批量删除。

Context 配置示例：

```json
{
  "modules": {
    "context": {
      "enabled": true,
      "mode": "select",
      "budget": {
        "maximumEstimatedTokens": 60000,
        "reserveEstimatedTokens": 12000,
        "recentMessagesToKeep": 8
      },
      "toolOutput": { "enabled": true, "maximumTextCharacters": 12000 },
	  "memoryInjection": { "enabled": false },
	  "taskInjection": { "enabled": false, "maximumTextCharacters": 2000, "readerTimeoutMs": 250 }
    }
  }
}
```

`observe` 只计算诊断，不改变消息；`select` 只改变本次模型请求视图，不写 Session。Memory 和当前 Task 摘要分别设开关并默认关闭。Task 摘要只读、低信任，并在注入前重新核对项目、会话、分支和 revision。Context 不使用 `context_with_system`，不会改系统提示或工具定义。详细设计见 [P3 Context 设计](docs/p3-context-design.md)。

Task Manager V3 也默认关闭，只在受信任项目中创建独立任务库：

```json
{
  "modules": {
    "task-manager": {
      "enabled": true,
      "modelPlanTool": false,
      "contextSummary": false,
      "maximumTasks": 200,
      "maximumSteps": 100,
      "maximumEvents": 10000
    }
  }
}
```

它保存 Task/Step DAG、事件、证据和 checkpoint，但不执行或重放工具。`/enhanced-task-recover` 只做恢复前检查；写入和外部副作用始终需要回到 Pi 原有执行与审批流程。退出码为 0 只算观察，必须匹配预先保存的验证规则或经过用户人工确认才能作为完成证据。模型默认只有只读 `enhanced_task_get`，计划提案工具需单独开启，且只能创建待审核 draft。已完成任务可由用户预览经验，并在再次确认后保存为 Memory candidate；不会自动写入 verified。

Pi Package 也允许在 `settings.json` 的 package 资源筛选中排除某个入口。配置开关控制模块运行状态，资源筛选控制 Extension 是否加载，两者用途不同。

### MCP Policy 配置

策略配置和 MCP Server 配置分开保存。`pi-enhanced.json` 不保存 Server 命令、URL、请求头或凭据：

```json
{
  "modules": {
    "mcp-policy": {
      "enabled": true,
      "defaultAction": "ask",
      "approvalTimeoutMs": 30000,
      "audit": { "enabled": true, "maxRecent": 200 },
        "rules": [
          { "id": "allow-serena-find-symbol", "server": "serena", "tool": "find_symbol", "action": "allow" },
          { "id": "allow-serena-references", "server": "serena", "tool": "find_referencing_symbols", "action": "allow" },
        { "id": "allow-context7-query", "server": "context7", "tool": "query-docs", "action": "allow" },
        { "id": "deny-serena-edits", "server": "serena", "toolPattern": "replace_*", "action": "deny" }
      ]
    }
  }
}
```

规则匹配顺序为：任意明确 deny、工具级规则、Server 级规则、默认动作；同层按 `priority` 从高到低，再按声明顺序。`defaultAction` 只能是 `ask` 或 `deny`。

需要审批时，没有对话界面的 print/RPC 流程会拒绝执行。MCP annotations 只用于提示风险，不作为授权依据。对 Serena 这类工具较多的 Server，还应在原生 `mcp.json` 中用 `exposure: "hidden"` 只开放所需查询工具。

## 本地加载

在 Pi 设置中加入本地 Package：

```json
{
  "packages": [
    {
      "source": "./packages/pi-enhanced"
    }
  ]
}
```

也可以只加载一个入口进行调试：

```bash
pi --extension ./packages/pi-enhanced/extensions/mcp-policy.ts
```

## 验证记录

P0 接口和基线见 [P0 验证](docs/verification.md)，依赖升级影响见 [依赖兼容记录](docs/dependency-compatibility.md)。

P1 已恢复并保留可重复测试。详细记录如下：

- [P1 接口核对](docs/p1-interface-check.md)
- [Serena / Context7 兼容记录](docs/p1-mcp-components.md)
- [P1 测试报告](docs/p1-test-report.md)
- [P1 已知限制](docs/p1-known-limitations.md)
- [P1 测试与安全基线](docs/p1-security-baseline.md)
- [P2-0 Memory 接口核对](docs/p2-interface-check.md)
- [P2 Memory 数据与隔离设计](docs/p2-memory-design.md)
- [P2 开发任务与验收测试](docs/p2-development-tasks-and-acceptance.md)
- [P2-1 验证记录](docs/p2-1-verification.md)
- [P2-2 验证记录](docs/p2-2-verification.md)
- [P2-3 验证记录](docs/p2-3-verification.md)
- [P2-4 Core Memory 验证记录](docs/p2-4-verification.md)
- [P2-5 Session Recall 验证记录](docs/p2-5-verification.md)
- [P2-6 Memory 交互与 Reader 验证记录](docs/p2-6-verification.md)
- [P2-7 Memory 整体验收](docs/p2-7-verification.md)
- [P2-8 Worker、语义与混合检索验证](docs/p2-8-verification.md)
- [P2-8 离线实验结果](docs/p2-8-benchmark.json)
- [P2 已知限制](docs/p2-known-limitations.md)
- [P2 发布级收尾](docs/p2-final-closure.md)
- [TypeScript / Python 架构边界](docs/hybrid-architecture.md)
- [P3 接口核对](docs/p3-interface-check.md)
- [P3 Context 设计](docs/p3-context-design.md)
- [P3 验证报告](docs/p3-verification.md)
- [P3 离线基准](docs/p3-benchmark.json)
- [Memory Governance 一手资料对标](docs/architecture-reference-matrix.md)
- [Memory V3 设计增量](docs/p2-memory-v3-design-delta.md)
- [Memory V3 migration 与回滚](docs/p2-memory-v3-migration.md)
- [Memory V3 Batch A 验证](docs/p2-memory-v3-verification.md)
- [Memory Governance 小型基准](docs/memory-governance-benchmark.json)
- [P3 与 Memory V3 兼容验收](docs/p3-memory-v3-compat-verification.md)
- [P4 固定接口核对](docs/p4-interface-check.md)
- [P4 Task Manager 设计](docs/p4-task-design.md)
- [P4 schema 与迁移](docs/p4-schema-migration.md)
- [P4 验收报告](docs/p4-verification.md)
- [P4 合成 Benchmark](docs/p4-benchmark.json)
- [P4 已知限制](docs/p4-known-limitations.md)
- [Batch D 基线与测试身份核对](docs/batch-d-baseline-audit.md)
- [P3 Task 兼容验收](docs/p3-task-compat-verification.md)
- [P4 加固验收](docs/p4-hardening-verification.md)
- [P5 评测设计](docs/p5-evaluation-design.md)
- [P5 评测数据](docs/p5-evaluation-results.json)
- [Batch D 总体验收](docs/batch-d-verification.md)
