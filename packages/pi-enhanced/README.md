# Pi Enhanced

这是 Pi 增强模块的独立 Package。P0 建立可加载、可配置、可独立关闭的扩展骨架；P1 已实现 MCP 调用策略和脱敏内存审计。长期记忆、上下文管理和任务管理仍保持关闭，留给后续阶段。

## 模块入口

Package 暴露四个独立 Extension：

| 模块 | 入口 | 状态命令 |
|---|---|---|
| MCP Policy | `extensions/mcp-policy.ts` | `/enhanced-mcp-policy-status`，P1 已实现 |
| Memory | `extensions/memory.ts` | `/enhanced-memory-status` |
| Context | `extensions/context.ts` | `/enhanced-context-status` |
| Task Manager | `extensions/task-manager.ts` | `/enhanced-task-manager-status` |

这些命令不会覆盖 Pi 内置的 `/mcp`、`codemode` 或 `tool_search`。

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
