# Pi Enhanced

Pi Enhanced 为 Pi 提供五个可独立启停的扩展：MCP Policy、Memory、Context、Task Manager 和 Docker Sandbox。运行时实现位于 `src/`，模型实验位于 `benchmarks/real-agent/`；两者通过 Extension 接口连接，不修改 Pi Agent Loop。

当前 Task Manager 支持 `off`、`v1`、`v2`。SWE-bench 使用 OFF/V1/V2 三组受限源码对照，模型执行和官方判分分别启动。实验配置不代表费用授权。

## 代码导航

| 目录 | 职责 |
|---|---|
| `extensions/` | 五个 Pi Extension 入口 |
| `src/mcp-policy/`、`src/sandbox/` | 工具策略、原生工具保护和 Docker 文件工具 |
| `src/memory/`、`python/memory-intelligence/` | 项目记忆存储、检索和可选 Python 向量计算 |
| `src/context/`、`src/task-manager/` | 请求上下文选择、任务状态和计划更新 |
| `benchmarks/real-agent/` | 当前模型 Runner、预算、授权与 SWE-bench；见[调用关系](benchmarks/real-agent/README.md) |
| `benchmarks/archive/` | 旧 P5、消融和合成基准，已移出日常脚本和 CI；见[归档说明](benchmarks/archive/README.md) |
| `tests/unit/`、`tests/integration/`、`tests/e2e/` | 策略单测、模块生命周期和生产链路回归 |
| `scripts/ci/` | CI 元数据、测试身份清单、Docker 证据与打包检查 |
| `docs/` | 设计和验收资料；旧记录只用于追溯 |

## 普通开发会话接入 CCR

CCR 3.1.3 独立运行，Pi 使用原生的 OpenAI Chat Completions Provider。代码搜索、解释等任务选 `search`（Flash），复杂修改选 `complex`（Pro）。启动参数 `--model flash` 或 `--model pro` 优先于 Profile。选型在打开会话前完成，工具返回的内容不会参与选型。

1. 用 Node.js 22.19+ 安装官方 CLI（`npm install -g @musistudio/claude-code-router@3.1.3`）。在专用用户目录保存下面的 CCR `config.json`。CCR 3.1.3 会把配置迁移至本地 SQLite。Windows 下在 CCR 终端把 `CCR_INTERNAL_APP_DATA_DIR`、`CCR_INTERNAL_HOME_DIR` 指向同一专用父目录，配置放在其 `claude-code-router` 子目录。Linux 下用 `CCR_INTERNAL_HOME_DIR` 指向专用父目录，配置放在其 `.claude-code-router` 子目录。这些路径变量对应固定的 3.1.3 版本。
2. 把 `APIKEY` 换成独立的 CCR 客户端令牌，其值与 `PI_CCR_TOKEN` 一致。示例上游是本机 Stub。日后接真实 API 时，Provider Key 只录入 CCR 的专用用户配置，限制该目录访问权限。

```json
{
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "APIKEY": "local-client-placeholder",
  "gateway": { "host": "127.0.0.1", "port": 3456 },
  "Providers": [{
    "id": "deepseek",
    "name": "DeepSeek",
    "type": "openai_chat_completions",
    "api_base_url": "http://127.0.0.1:3460/v1",
    "api_key": "stub-key",
    "models": ["deepseek-flash", "deepseek-v4-pro"]
  }],
  "Router": {
    "builtInRules": { "claude-code": { "enabled": false }, "codex": { "enabled": false } },
    "rules": [],
    "fallback": { "mode": "off", "models": [], "retryCount": 0 }
  },
  "profile": { "enabled": false },
  "observability": { "requestLogs": false, "requestLogBodyCapture": "none" }
}
```

3. 在 CCR 终端设置独立的管理令牌 `CCR_WEB_AUTH_TOKEN`，并把 `CCR_RAW_TRACE_ENABLED=0` 写入该进程的环境，再执行 `ccr serve --host 127.0.0.1 --port 3458 --no-open *> $null`（PowerShell），或 `ccr serve --host 127.0.0.1 --port 3458 --no-open >/dev/null 2>&1`（Linux）。CCR 会在启动 URL 中附带管理令牌，因此直接丢弃输出。模型和管理端口均留在本机，勿做端口映射。完全离线时，可将 CCR 终端的 `CCR_MODEL_CATALOG_PATH` 指向官方安装包的 `dist/models.json`，关闭目录更新请求。
4. 在 Pi 终端设置 `PI_CCR_AGENT_DIR` 为工作区外的可信 Pi 用户目录绝对路径，从可信配置加载 `PI_CCR_TOKEN`。在该目录创建下面的 `models.json`，以及内容为 `{"retry":{"enabled":false,"provider":{"maxRetries":0}}}` 的 `settings.json`。文件使用 UTF-8。Pi 的用户级扩展与 `pi-enhanced.json` 可配置在这个独立目录。

```json
{
  "providers": {
    "local-ccr": {
      "baseUrl": "http://127.0.0.1:3456/v1",
      "api": "openai-completions",
      "apiKey": "$PI_CCR_TOKEN",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "maxTokensField": "max_tokens",
        "thinkingFormat": "deepseek"
      },
      "models": [
        { "id": "DeepSeek/deepseek-flash", "name": "DeepSeek Flash", "reasoning": true, "contextWindow": 64000, "maxTokens": 4096 },
        { "id": "DeepSeek/deepseek-v4-pro", "name": "DeepSeek Pro", "reasoning": true, "contextWindow": 64000, "maxTokens": 4096 }
      ]
    }
  }
}
```

5. 构建 Pi CLI 后，从仓库根目录运行以下命令。启动时显示通过检查的 CCR 地址和选定模型。用 Pi 的 `/session` 查看会话用量。本配置关闭 CCR 的原始追踪，用量以 Pi 收到的 SSE 数据为准。独立目录不采用工作区设置，防止项目覆盖模型和重试设置。Docker Sandbox 和 `run_tests` 仍通过既有宿主配置开启。

```powershell
node packages/pi-enhanced/scripts/ccr.mjs --check
node packages/pi-enhanced/scripts/ccr.mjs --profile search
node packages/pi-enhanced/scripts/ccr.mjs --profile complex
node packages/pi-enhanced/scripts/ccr.mjs --profile search --model pro
```

CCR 的模型标识（例如 `DeepSeek/deepseek-v4-pro`）用于普通会话。SWE-bench 的预算网关按原有 Provider 和模型 ID 校验，保留独立入口。把 Stub 地址换成真实 API 后会产生费用，演示前须单独授权。

## 模块入口

Package 暴露五个独立 Extension：

| 模块 | 入口 | 状态命令 |
|---|---|---|
| MCP Policy | `extensions/mcp-policy.ts` | `/enhanced-mcp-policy-status`，P1 已实现 |
| Memory | `extensions/memory.ts` | `/enhanced-memory-status`；启用且受信任后开放 P2-6 交互命令 |
| Context | `extensions/context.ts` | `/enhanced-context-status`、`/enhanced-context-inspect` |
| Task Manager | `extensions/task-manager.ts` | `/enhanced-task-manager-status` |
| Docker Sandbox | `extensions/sandbox.ts` | 由受控 Runner 设置宿主配置 |

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

默认情况下普通模块全部关闭，Sandbox 另由宿主环境显式启用。用户级配置放在 `~/.pi/agent/pi-enhanced.json`：

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

Task Manager 也默认关闭，只在受信任项目中创建独立任务库：

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
	  "nativeToolGuard": {
	    "enabled": true,
	    "workspaceMutationAction": "ask",
	    "protectProjectMetadata": true
	  },
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

`nativeToolGuard` 独立保护 Pi 原生 read/write/edit 与 Shell 工具。默认写入和 Shell 需要逐次确认，无 UI 时拒绝；路径规范化后只允许工作区范围，并保护 `.git`、`.pi`。这不是操作系统沙箱，完整覆盖范围和限制见 Batch E 安全文档。

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

## Docker 文件工具沙箱

Sandbox Extension 默认关闭。它只供受控临时项目使用，把 Pi 的 `read/grep/find/ls/write/edit` 同名工具替换为无网 Docker Worker；模型和 Agent Loop 仍在宿主运行。不要把真实仓库、HOME、SSH、凭据目录或 Docker Socket 挂入容器。

使用前需要 Docker Desktop/WSL2 或 Linux Docker Engine，并提前准备固定镜像：

```bash
docker pull node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
```

当前沙箱只接受系统临时目录中的项目，并要求显式设置 enabled、trusted、runId、精确工作区和镜像 SHA。正式受控试用应通过 `benchmarks/real-agent/run-real-agent.ts` 启动，不要在不可信项目配置中自行放宽这些变量。Docker、镜像、协议或路径检查失败时工具会直接报错，不回退宿主读写。

真实模型密钥可以保存在仓库根目录 `.env` 中，例如 `DEEPSEEK_API_KEY=...`。该文件已被 Git 忽略，只有带 `--execute` 的真实评测路径会读取它；dry-run 和 `--preflight` 不读取 `.env`。保存密钥本身不会开启真实评测，授权开关、预算网关确认以及调用、Token、金额和超时上限仍需在获准运行时显式提供。

受控 DeepSeek 试用使用 `--budget-enforcement local_hard_gateway`。runner 为每个任务启动仅监听 `127.0.0.1` 的硬预算网关，通过临时 `models.json` 覆盖内置 DeepSeek 地址；真实 Key 不进入 Pi 子进程或 Docker。网关在转发前预留请求次数、输入上界、输出上限和费用，固定单并发并实施超时；usage 缺失、超限、断流或上游错误后失败关闭。当前只允许 `deepseek/deepseek-flash`。

首版不支持 Shell、PowerShell、用户 `!`、codemode、tool_search、MCP 写工具或未知第三方工具。排障时可先运行：

```bash
npm run smoke:docker --workspace=@wz-agent/pi-enhanced
npm run test:sandbox --workspace=@wz-agent/pi-enhanced
```

测试会创建并删除临时容器；异常退出后可按名称 `pi-enhanced-tools-*` 检查残留。不要使用宽泛的容器删除命令。

## 验证与当前状态

工程检查使用 `npm run check --workspace=@wz-agent/pi-enhanced` 和 `npm run check:evaluation --workspace=@wz-agent/pi-enhanced`。普通 CI 使用无密钥预检；Docker Job 必须实际运行沙箱、网关和 SWE 策略用例，跳过不算通过。

测试中的 Batch 字样是历史测试身份，不表示用例已经废弃。仍覆盖路径隔离、预算结算、授权消费、审计恢复及模块生命周期的用例继续保留，避免把结构清理变成覆盖率删减。

- [当前交接](../../HANDOFF.md)：当前任务、权限范围和未解决问题。
- [SWE-bench 验收记录](docs/swebench-task-v2-verification.md)与[结果](docs/swebench-task-v2-results.json)：整理前离线验收和真实尝试的原始结论。
- [SWE-bench 协议与设计](docs/swebench-task-v2-design.md)：受限源码规则、模式差异和官方判分。
- [数据备份恢复](docs/data-backup-restore.md)：Memory 与 Task 数据管理。
- [完整历史交接](docs/history/HANDOFF-before-structure-cleanup.md)：旧阶段、授权、实验和 CI 记录，不作为当前执行指令。

历史报告和 `evaluation-output/` 保留原路径；`.artifacts/` 保存本地原始证据。整理前的 26 文件候选清单仅描述当时版本，结构整理后的提交范围须重新核对。
