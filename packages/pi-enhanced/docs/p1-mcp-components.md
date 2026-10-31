# P1 外部 MCP 组件兼容记录

本文记录 Windows、Node.js `22.22.2` 环境的实际结果，并于 2026-10-31 补充 Docker 验证。没有修改真实的 `~/.pi/agent/mcp.json`。

## Serena

- 锁定版本：`serena-agent==2.1.0`
- Git tag：`v2.1.0`
- Commit：`5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc`
- 官方镜像：`ghcr.io/oraios/serena:2.1.0`
- 镜像摘要：`sha256:eb52535ff1c292add25c2b2d37b2db4e2e20c60cda7d8e25f9d11490ce0e1bdf`
- 运行方式：stdio MCP，`serena start-mcp-server --context=codex --agent-interface=tools --project=/workspaces/project`

固定版本源码中的 `codex` context 会排除通用文件读写、shell 和 `replace_content`。P1 建议再由 Pi `toolExposure` 只暴露实际需要的符号查询工具：

- `get_symbols_overview`
- `find_symbol`
- `find_referencing_symbols`
- `find_implementations`
- `find_declaration`
- `get_diagnostics_for_file`
- `search_for_pattern`

记忆写入、符号编辑、文件编辑、shell、项目移除等工具在 P1 不暴露。这样不会提前引入 P2 的长期记忆，也不会让 Serena 编辑能力绕过当前阶段的最小边界。

### Docker 验证结果

官方镜像的 OCI label 确认为版本 `2.1.0`、revision `5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc`。受控 Python fixture 以只读方式挂载，`.serena/cache` 使用 tmpfs，不允许容器修改项目源码。

真实 E2E 已完成：

- stdio 初始化协商；
- `tools/list` 发现 `find_symbol` 和 `find_referencing_symbols`；
- `find_symbol` 返回 `src/catalog.py` 中的 `SymbolTarget`；
- `find_referencing_symbols` 返回 `build_target` 与 `consume_target` 两处引用。

测试命令：

```powershell
$env:PI_ENHANCED_RUN_SERENA_DOCKER='1'
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run tests/e2e/mcp-components.test.ts
```

结果：1 项 Serena 测试通过，Context7 测试因未启用对应环境变量而跳过。状态：`passed`。

Serena `2.1.0` 有一个需要保留的接入边界：项目 `fixed_tools` 已把内部 active tools 设为两个查询工具，但 MCP 首次列表仍包含 `codex` context 中的其他工具。因此 Pi 侧仍必须使用 `toolExposure` 和精确 MCP Policy，不能把 Serena 的项目配置当作唯一权限层。

### Windows 直接安装结果

执行固定版本安装时，Serena 的固定依赖 `pyyaml==6.0.2` 在本机 CPython 3.14/Windows 上没有可用 wheel，pip 转为源码构建后又因缺少 Microsoft Visual C++ 14.0 失败。因此本机尚未完成 Serena MCP 握手和符号查询，不能把它记为“已兼容”。

该限制只影响 Windows 直接安装，不影响已经通过的 Docker 方案。没有安装系统级 Python 3.13 或 C++ Build Tools。

若以后需要脱离 Docker，再使用 Python 3.13 独立虚拟环境，不修改 Serena 锁定依赖：

```powershell
py -3.13 -m venv .venv-serena-2.1.0
.\.venv-serena-2.1.0\Scripts\python.exe -m pip install serena-agent==2.1.0
.\.venv-serena-2.1.0\Scripts\serena.exe start-mcp-server --context=codex --project-from-cwd
```

Python 3.13 或 C++ Build Tools 当前都未自动安装，因为这属于机器级环境变更。

## Context7

- 锁定 npm 版本：`@upstash/context7-mcp@4.4.4`
- 运行方式：stdio MCP，`npx -y @upstash/context7-mcp@4.4.4`
- 实际发现工具：`resolve-library-id`、`query-docs`
- API Key：只从 `CONTEXT7_API_KEY` 环境变量读取，不写进仓库配置

真实测试已经完成 MCP 初始化协商和 `tools/list`，固定版本与 Pi MCP Client `1.4.0` 可以握手，两个工具名与上面一致。2026-10-31 从 Windows 用户级环境读取免费 API Key 后，`resolve-library-id` 成功解析 TypeScript 文档库，`query-docs` 成功返回 Next.js 文档内容；两次调用均为非错误且非空结果。

收尾状态：`passed`。API Key 没有出现在命令输出、仓库配置、日志或测试报告中。匿名额度耗尽仍是无 Key 运行时的外部限制，不再是 P1 验收阻塞项。

## 建议的 Pi MCP 配置

以下只是模板，不会自动写入用户配置。`SERENA_EXECUTABLE` 应替换成 Python 3.13 虚拟环境中的实际路径。

```json
{
  "mcpServers": {
    "serena": {
      "command": "SERENA_EXECUTABLE",
      "args": ["start-mcp-server", "--context=codex", "--project-from-cwd"],
      "exposure": "hidden",
      "toolExposure": {
        "get_symbols_overview": "deferred",
        "find_symbol": "deferred",
        "find_referencing_symbols": "deferred",
        "find_implementations": "deferred",
        "find_declaration": "deferred",
        "get_diagnostics_for_file": "deferred",
        "search_for_pattern": "deferred"
      },
      "timeout": 60
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@4.4.4"],
      "env": { "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}" },
      "exposure": "deferred",
      "toolExposure": {
        "resolve-library-id": "deferred",
        "query-docs": "deferred"
      },
      "timeout": 60
    }
  }
}
```

启用前先运行 `pi mcp list`，确认实际工具名。Serena 工具会受语言服务器和项目类型影响；配置中不存在的工具不能视为已经受保护或已经启用。

