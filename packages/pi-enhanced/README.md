# Pi Enhanced

Pi Enhanced 为 Pi 提供六个可独立启停的扩展，包括 MCP Policy、Memory、Context、Task Manager、Docker Sandbox 和 Knowledge。运行时实现位于 `src/`，模型实验位于 `benchmarks/real-agent/`。两者通过 Extension 接口连接。

Task Manager 的 SWE-bench 对照使用 `off`、`v1`、`v2` 三种模式。模型执行与官方判分分别启动，真实模型运行需要单独授权。

## V4 运行模式

普通 `pi` 默认运行 `single`。本地协作和 A2A 都通过显式加载 `/enhanced-multi` 启用，沿用原有扩展、SQLite Task Manager、Gateway 和 Docker。启动环境、角色权限、恢复规则与真实对照数据见 [V4 架构与运行手册](docs/v4-architecture.md)。

在可信用户的 `pi-enhanced.json` 中，可用 `multiAgent.code` 和 `multiAgent.test` 为同一个 OpenAI 兼容服务分别选择模型。两个角色共享父任务预算，恢复沿用任务创建时的配置。[配置示例](docs/v4-architecture.md#在任务开始前选择-code-和-test-模型)

V4 独立验收优先使用本地 Stub 和真实 Docker。候选清单、历史证据位置、无网依赖和回归命令见[最终冻结交接](../../HANDOFF.md#v4-最终源码冻结与独立验收)。

## V3 联合恢复 Demo

Pi 已提供模型接入、工具循环和可持久化会话。Pi Enhanced 通过扩展复用这些能力，把请求上下文、项目记忆和任务进度连到同一条修复链路。受控 Runner 用本机预算网关访问模型，文件操作和测试在无网 Docker 中执行。

### 一次真实修复

在 `memory-guided-regression` 中，DeepSeek Flash 先读取长诊断、检索已验证的记忆，运行基线测试并观察到 `PI` 与预期 `pi` 不符。第一进程只读退出，Runner 核对基线失败、结算和审计后保存检查点。

第二进程使用原会话、Task 和预算账本，恢复 **256 字符**的诊断分页，重新检索到同一条已验证记忆，只写入一次 `key.js`。模型收到复测退出码 `0`，确认通过并正常结束。独立的只读 Docker 验证也通过。

这一次真实运行共 **7 次请求、25,586 Token、25.022 秒**。Gateway 费率估算为 **$0.0090393**。这些是单次运行的观测值。

### 免费复现

在仓库根目录使用 Node.js 24、Git 和可用的 Docker。从干净检出开始执行下列命令。依赖、模型目录元数据和镜像可提前准备。

```bash
npm ci
npm run hydrate:model-data
npm run build:offline
docker pull node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
npm exec vitest -- --run packages/pi-enhanced/tests/e2e/real-agent-runner-e2e.test.ts --exclude '**/.artifacts/**' -t 'read-only joint recovery checkpoint'
```

预期选中的用例显示 `1 passed`。用例使用本地 Stub 作答，实际启动两个 Runner 进程与 Docker。它检查分页保留、恢复后重新检索、复测反馈、独立验证与共用预算，不需要真实模型密钥。

### 面试演示：一次失败的修改如何得到反馈

准备好上面的依赖和文件工具镜像后，从仓库根目录在 Linux 上运行：

```bash
cd packages/pi-enhanced
docker build -f scripts/pytest.Dockerfile -t pi-enhanced-pytest:demo scripts
export PI_TEST_PYTEST_IMAGE="$(docker image inspect pi-enhanced-pytest:demo --format '{{.Id}}')"
test -n "$PI_TEST_PYTEST_IMAGE" && npm exec vitest -- --run tests/e2e/pytest-tool.test.ts \
  -t 'uses real failure feedback and fresh code through the native Pi loop' --reporter=verbose
```

`clamp(x)` 应把负数归零、保留正数。第一次把 `return 0` 改成 `return x` 后，Docker pytest 返回 `1 failed, 1 passed`，Pi 会话收到 `assert -2 == 0`。第二次改为 `return max(0, x)`，对当前源码重新运行相同测试，两个用例都通过。终端里的一个 Vitest 用例覆盖这整个过程。工具调用顺序和修改内容由 Stub 预设，文件编辑、pytest 和断言反馈都实际执行。[演示用例](tests/e2e/pytest-tool.test.ts)

面试追问可以用 Requests-1142：原始代码就能通过请求构造测试，但空 GET 仍带有 `Content-Length: 0`。用独立检查对照这两个结果，可以说明测试究竟覆盖了什么行为。[复现步骤](benchmarks/real-agent/README.md#requests-1142-的行为验证)

### 源码导读

| 模块 | 入口、关键行为与验证 |
| --- | --- |
| Context | [`createContextExtension`](src/context/extension.ts) 在请求前的 `context` 事件调用 [`ContextRuntime.transform`](src/context/runtime.ts)。长工具结果在会话中保留原文，请求视图保留有界预览和引用，避免丢失未来复查所需的诊断。[分页读取](src/context/offload.ts) 核对工作区、会话与任务。[生命周期测试](tests/integration/context-lifecycle.test.ts) 覆盖工具调用配对和恢复。 |
| Memory | [`MemoryService.search`](src/memory/service.ts) 默认使用 SQLite FTS5。语义模式可选 TF-IDF+SVD 或本地 E5 + Qdrant。混合模式通过 [RRF 合并两路排序](src/memory/semantic-search-adapter.ts)，返回前在 SQLite 核验范围、有效期、文件证据及修订。[Memory V3](docs/memory-v3.md) |
| Knowledge | [`KnowledgeService`](src/knowledge/service.ts) 管理项目文档、分块、版本和外发权限。默认使用独立的 SQLite FTS5。语义和混合模式使用本地 E5 与独立的 Qdrant 集合。[联合集成](../../INTEGRATION_HANDOFF.md) |
| Task Manager | [`createCheckpoint`](src/task-manager/recovery.ts) 保存任务与计划修订、会话分支、工作区指纹、待办步骤和事件边界。`recoveryPreflight` 核对这些证据。写入结果未知时保留待核验，避免自动重放。[崩溃恢复测试](tests/e2e/task-crash-recovery.test.ts) |
| Gateway | [`startBudgetGateway`](benchmarks/real-agent/budget-gateway.ts) 在转发前预留输入、安全余量和输出额度，有效 usage 到达后结算并释放差额。已发出请求的 usage 无法确认时，[持久化账本](benchmarks/real-agent/budget-persistence.ts) 拒绝恢复仍有未知用量的运行。[跨进程预算测试](tests/e2e/budget-recovery.test.ts) |
| 联合执行 | [`saveSuspendedRun` / `beginResumedRun`](benchmarks/real-agent/runner-resume.ts) 绑定同一会话、Context 引用、Memory 项目库、Task 检查点、Sandbox 审计和原预算截止时间。第二进程读取这些持久化记录，从已核验边界继续。[端到端测试](tests/e2e/real-agent-runner-e2e.test.ts) |

当前真实联合恢复只开放给固定任务和 DeepSeek Flash，需要单独授权。自动接续要求可核验的暂停点，未知写入需要先核验。Gateway 的保守输入预留可能在实际用量达到上限前拒绝请求。Stub 验证工程链路，单次真实案例不代表跨任务成功率。

## V4 MA-1 本地协作

默认使用原有单 Agent 模式。用 `pi --extension <MA-1 入口的绝对路径>` 加载 [MA-1 扩展](src/multi-local/extension.ts)，然后在受信任的临时工作区使用 `/enhanced-multi start <JSON>`。命令会要求确认本次编辑和测试。宿主需配置现有 Sandbox 环境、固定镜像 ID、`PI_ENHANCED_PYTEST_CONFIG_JSON` 和 `PI_ENHANCED_MA1_LOCAL_URL`（`http://127.0.0.1:<端口>`）。`PI_ENHANCED_MA1_LOCAL_KEY` 用于本地服务认证，模型 ID 可通过 `PI_ENHANCED_MA1_LOCAL_MODEL` 设置。代理的工具和会话无法取得服务密钥。

```text
/enhanced-multi start {"goal":"修复 next_count 的返回值","target":"test_counter.py","editFiles":["counter.py"]}
/enhanced-multi resume <task-id>
```

[Coordinator](src/multi-local/coordinator.ts) 使用 Task Manager 原有 SQLite 保存父任务、两条步骤、委派和真实 pytest 收据。Code Agent 可以读取、编辑批准的文件，并按项目配置使用只读 Memory/Knowledge 检索。Test Agent 的独立模型会话只读，宿主用 Docker 测试批准的版本，模型只收到失败类型、目标、计数等有界诊断。真实测试日志留在本地审计。启用受保护的检索后，Code Agent 写入的文件无法可靠保留内容来源，后续两个角色都拒绝将这些文件正文读回模型。Docker 仍会验证实际补丁。用户可在启动时把 `diagnose` 设为 `false`，直接使用确定性反馈。

两个子会话共享父任务的 Gateway 账本。继续通过 `pi-enhanced.json` 的 `budget.tier` 选择 Economy 20K、Standard 25K（默认）或 Premium 30K。默认总计 8 次模型请求、180 秒、$0.03 和每次 512 输出 Token。模型诊断默认最多占 3 次，并计入同一账本。恢复沿用原档位、截止时间与已结算用量。阶段收据已落盘时继续下一步，执行结果不确定时进入待核验。达到硬上限会停止该任务，保留当前进度。

本地复现需先准备 Docker 文件工具镜像和含 pytest 的镜像。入口复用项目 Vitest 和 HTTP Stub，无需 API 密钥。

```bash
npm exec -w packages/pi-enhanced -- vitest run tests/e2e/multi-local.test.ts --no-file-parallelism
```

测试将断言首次 pytest 失败、诊断反馈、第二次修复、复测通过和独立工作区判分，并核对跨进程恢复、撤权和共享预算。

## V4 MA-2 A2A Test Agent

默认的 `single` 和手动加载的 `multi-local` 继续使用原来的入口。选择 `multi-a2a` 时，仍由同一 Coordinator 负责编辑、重试、预算和父任务收尾，由另一个本机进程执行批准的 Docker pytest。服务只在 `127.0.0.1` 提供 A2A 1.0 JSON-RPC，Agent Card 位于 `/.well-known/agent-card.json`。

从与 Coordinator 相同的受信任临时工作区启动服务，并为两个进程设置相同的 Sandbox 配置、`PI_ENHANCED_PYTEST_CONFIG_JSON`、Pi Agent 数据目录与 `PI_ENHANCED_A2A_PRINCIPAL`。使用宿主生成的独立 `PI_ENHANCED_A2A_TOKEN`，长度至少 32 字符。服务以 `PI_ENHANCED_A2A_PORT` 指定端口（默认 8765），Coordinator 的 `PI_ENHANCED_A2A_URL` 指向实际回环地址。单次连接超时可用 `PI_ENHANCED_A2A_TIMEOUT_MS` 配置，默认 5000 毫秒。

```text
node --experimental-strip-types <Pi Enhanced 绝对路径>/scripts/run-a2a-test-agent.ts
/enhanced-multi start-a2a {"goal":"修复 next_count 的返回值","target":"test_counter.py","editFiles":["counter.py"]}
/enhanced-multi resume-a2a <task-id>
```

远端服务从任务数据库核对已经保存的委派意图、调用身份、工作区和测试版本。Artifact 包含有界的结构化结果、诊断和 Docker 收据。任意测试 stdout、Memory/RAG 正文和模型凭据不进入 A2A 请求或响应。服务默认生成确定性诊断。显式设置 `diagnose: true` 时，由 Coordinator 的只读 Test Session 经父任务 Gateway 补充模型诊断。

一个操作 ID 的同负载重试复用原 A2A Task ID。Coordinator 可恢复远端任务映射和已持久化的收据。服务在未确认执行结果时保存失败状态和审计线索，恢复不会自动重跑该操作。停止服务可发送 SIGINT 或 SIGTERM。依赖和协议固定为官方 SDK `1.3.0` 与 A2A 规范 `v1.0.0`。

## 代码导航

| 目录 | 职责 |
|---|---|
| `extensions/` | 六个默认 Pi Extension 入口 |
| `src/multi-local/` | MA-1 本地协调、角色权限与手动加载入口 |
| `src/mcp-policy/`、`src/sandbox/` | 工具策略、原生工具保护和 Docker 文件工具 |
| `src/memory/`、`python/memory-intelligence/` | 项目记忆存储、检索和可选 Python 向量计算 |
| `src/knowledge/`、`python/knowledge-parser/` | 文档导入、权限管理和检索 |
| `src/context/`、`src/task-manager/` | 请求上下文选择、任务状态和计划更新 |
| `benchmarks/real-agent/` | 当前评测入口、Runner、预算网关、授权和 SWE-bench 判分，见[调用关系](benchmarks/real-agent/README.md) |
| `benchmarks/archive/` | 仅供复现旧实验的脚本和配置，日常命令、CI 和打包均不包含，见[归档说明](benchmarks/archive/README.md) |
| `tests/unit/`、`tests/integration/`、`tests/e2e/` | 策略单测、模块生命周期和生产链路回归 |
| `scripts/ci/` | CI 元数据、测试身份清单、Docker 证据与打包检查 |
| `docs/` | 评测设计、验收记录和 CI 使用的测试身份基线 `version-freeze-results.json` |
| `docs/history/` | 历史交接快照 |
| `evaluation-output/`、仓库根目录 `.artifacts/` | 历史运行数据和本地证据，包含真实实验、评分和授权记录 |

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

5. 构建 Pi CLI 后，从仓库根目录运行以下命令。启动时检查 CCR 地址、模型登记和客户端鉴权，并为普通与自动模式加载同一个预算扩展。客户端令牌只提供给 Gateway，Pi 模型目录使用隔离令牌。用 `/enhanced-budget` 查看或选择预算档位。预算配置读取可信 `PI_CCR_AGENT_DIR` 下的 `pi-enhanced.json`。Docker Sandbox 和 `run_tests` 仍通过既有宿主配置开启。

```powershell
node packages/pi-enhanced/scripts/ccr.mjs --check
node packages/pi-enhanced/scripts/ccr.mjs --profile search
node packages/pi-enhanced/scripts/ccr.mjs --profile complex
node packages/pi-enhanced/scripts/ccr.mjs --profile search --model pro
```

CCR 的模型标识（例如 `DeepSeek/deepseek-v4-pro`）用于普通会话。SWE-bench 的预算网关按原有 Provider 和模型 ID 校验，保留独立入口。把 Stub 地址换成真实 API 后会产生费用，演示前须单独授权。

CCR V2 通过 `--strategy` 显式启用。`--strategy manual --model flash` 固定 Flash，`--strategy strong` 直接选 Pro。`--strategy auto` 默认选 Flash，配合 `--profile complex` 可直接选 Pro。显式 `--model` 始终优先。省略 `--strategy` 时沿用 V1。

Flash 自动模式需要既有的可信 Docker Sandbox 和 pytest 配置。请让每次源码修改和 pytest 分别在独立工具回合执行。两次修改不同源码版本后，同一测试目标仍失败且还有测试余量，Pi 才会显示用量并询问是否切换到 Pro。`run_tests` 仍只有三次机会，初始基线测试也消耗一次。拒绝确认或缺少可交互界面时继续使用 Flash。

首条模型请求创建持久化预算。Flash 和 Pro 共用同一项目会话或绑定任务的 SQLite 账本，切换沿用累计 Token、费用、请求数和原截止时间。默认 Standard（25K）、8 次请求、180 秒、单次最多 512 个输出 Token、费用上限 $0.03。两种模型按各自的峰值费率保守计价。CCR 3.1.3 的流式回包使用裸模型 ID。Gateway 将每个路由名与对应的裸 ID 精确匹配，用量缺失时按预留上界结算。继续已有会话时使用原启动策略、模型白名单和 CCR 地址。关闭 CCR 路由回退和 Provider 通用重试。普通 CCR 的专属 Gateway 传输只在原预留已结清、Gateway 确认未送达时允许重试一次，每次发送前重新核对权限、预算和截止时间。

最终 `resume` 真实烟测从任务开始即使用 Premium 30K。Flash 完成修复，公开 pytest 和独立 Docker 判分通过，4 次请求共 9,341 Token，费用保守上界 $0.003030。有效 pytest 失败为 0，CCR 未发出升级确认，真实 Pro 切换尚未验证。30K 的 Flash→Pro 闭环只在 Stub 加真实 Docker 下通过。

## 模块入口

Package 提供以下独立 Extension。

| 模块 | 入口 | 状态命令 |
|---|---|---|
| MCP Policy | `extensions/mcp-policy.ts` | `/enhanced-mcp-policy-status` |
| Memory | `extensions/memory.ts` | `/enhanced-memory-status`，启用且受信任后开放下列交互命令 |
| Context | `extensions/context.ts` | `/enhanced-context-status`、`/enhanced-context-inspect` |
| Task Manager | `extensions/task-manager.ts` | `/enhanced-task-manager-status` |
| Docker Sandbox | `extensions/sandbox.ts` | 由受控 Runner 设置宿主配置 |
| Knowledge/RAG | `extensions/knowledge.ts` | `/enhanced-docs status` |

这些命令不会覆盖 Pi 内置的 `/mcp`、`codemode` 或 `tool_search`。

### Memory 交互

Memory 模块只有在配置启用且当前项目受信任时才打开项目存储，并动态注册以下入口：

- `/enhanced-memory-search <query>` 查询当前范围内已验证且有效的记忆。
- `/enhanced-memory-recall [raw|projection] <query>`：查询当前 Session 活动分支；
- `/enhanced-memory-save`、`/enhanced-memory-confirm`、`/enhanced-memory-review`：通过真实 UI 保存 candidate、确认和审查；
- `/enhanced-memory-core <get|create|update|delete> <project|architecture|decisions>`：管理三个固定 Core 文档；
- `/enhanced-memory-list`、`/enhanced-memory-inspect`、`/enhanced-memory-doctor`：查看治理元数据和只读诊断；
- `/enhanced-memory-maintain dry-run|show|apply`：生成/查看维护提案，apply 要求真实用户确认和 revision 复核；
- `/enhanced-memory-archive`、`/enhanced-memory-restore`、`/enhanced-memory-delete`：可逆归档、恢复和二次确认的单条删除；
- `enhanced_memory_search`：模型唯一可调用的 Memory 工具，只读 verified，不接受 projectId、状态或路径参数。

Memory 文本和 Session Recall 都按低信任数据处理，不会进入 system prompt。`ScopedMemoryReader` 随 Memory 模块的会话生命周期启停。Context 和 `memoryInjection` 均显式开启时，才将经过 verified 复核、限额和脱敏的 Episodic Memory 作为低信任资料加入本次请求。

Memory 默认使用 SQLite FTS5。已有 semantic 或 hybrid 配置继续使用 TF-IDF+SVD。将 `backend` 设为 `e5-qdrant` 后，Memory 使用本地 CPU E5 和 `pi_enhanced_memory_v3` 集合。启用 Knowledge 后，两者可共用本机 Qdrant 实例和预置权重缓存，各自管理 Worker。Worker 或 Qdrant 不可用时，检索回退到 SQLite FTS5。[运行配置](docs/memory-v3.md)

启用向量检索后，Python Worker 负责可重建的向量计算，TypeScript 按当前项目、记忆状态和版本复核命中。

- [Memory 检索消融与 Auto Dream](docs/memory-v3.md#检索消融与-auto-dream) 提供候选预览、人工审批和来源失效复核。Auto Dream 只整理当前会话内已完成任务的已验证文件证据，候选经单独审批后才能用于后续上下文。

### Knowledge/RAG

本地重排默认关闭。仅在可信配置中为 `modules.knowledge` 启用 `rerank: true` 且使用 `hybrid` 时启用。固定模型、资源限制、回退及留出集结果见[检索评测文档](docs/knowledge-retrieval-evaluation.md#可选本地重排)。

Knowledge 默认关闭。在全局或受信任项目的 `pi-enhanced.json` 启用并重新加载。默认检索模式为 `lexical`，使用本地 SQLite FTS5。

```json
{
  "modules": {
    "knowledge": {
      "enabled": true,
      "mode": "lexical"
    }
  }
}
```

在 Pi 中使用 `/enhanced-docs` 管理当前项目的文档。

| 命令 | 用途 |
|---|---|
| `add [--corpus=ID] <绝对路径>` | 导入单文件或目录。也接受绝对路径的 JSON 数组。目录默认仅扫描一层，`--recursive` 扩展到子目录。 |
| `add --allow-external <绝对路径>` | 导入并通过交互确认授权模型读取所选范围的正文和来源。 |
| `list [语料库或 *] [偏移]` | 查看文档、当前和待激活版本、导入告警与故障。 |
| `sync [文档 ID]` | 检查已授权来源的更新、文件删除并重试待处理版本。 |
| `sync --rebuild [文档 ID]` | 依据 SQLite 中已有的分块重建索引。 |
| `sync --maintain` | 重试待处理版本，清理退役版本并检查本项目的孤立向量。 |
| `remove <完整文档 ID>` | 交互确认后从知识库移除该文档，保留源文件。 |
| `status` | 查看运行模式、待处理任务、错误和退役版本数量。 |

Markdown 和 TXT 使用 UTF-8，单文件上限 8 MiB，单文档最多 800 个片段。超限的独立代码块、表格和列表会报错。HTML、DOCX 和 PDF 需要提前构建本地 Docling 镜像。

```sh
docker build --tag pi-enhanced-knowledge-parser:2.92.0 packages/pi-enhanced/python/knowledge-parser
```

转换容器无网络和宿主目录挂载。HTML 和 DOCX 保留可提取的标题与结构。PDF 返回文本和原始页码，复杂版面可能丢失；无文本层返回 `ocr-required`。

将 `mode` 设为 `semantic` 或 `hybrid` 后，需要配置本机 Qdrant 和本地 E5 权重。可用 `qdrantEndpoint` 指定回环地址，默认 `http://127.0.0.1:6333`。Knowledge 使用独立集合 `pi_enhanced_docs_v1` 和独立 SQLite。E5 复用预置权重缓存，Knowledge 自己管理 Worker 进程。环境变量、依赖和公共 API 见 [Memory V3 的共享接口](../../VECTOR_CONTRACT.md)。依赖不可用时，检索返回已有版本的词法结果，待写入版本保持待处理状态。曾用向量模式导入的知识库切换到词法模式后，Qdrant 的清理要等向量模式恢复。

Agent 可调用只读的 `enhanced_docs_search` 和 `enhanced_docs_read`。引用包含相对来源、标题、版本和可核实的行号或页码。默认 `local-only` 的文档只供宿主侧读取。两个 Agent 工具对所有模型统一只返回已获 `allow-external` 授权的文档，以覆盖会话中切换模型的情况。Sandbox 的许可检查继续适用。受信任的 Sandbox 需显式设置 `PI_ENHANCED_SANDBOX_READONLY_KNOWLEDGE_TOOLS=1` 才允许这两个只读查询。

会话只保存分块引用及检索状态。每次发送模型请求前，Knowledge 按当前项目、会话、外发权限和文档版本重新查 SQLite，再生成可见的工具结果。撤权或更新后，旧引用的正文、标题、路径和行号不会随历史重发。已有会话中的 Knowledge 工具结果也按相同规则复核。

`benchmarks/knowledge/evaluate.ts` 提供固定语料、人工标签及 FTS5、Dense、Hybrid 对照。从仓库运行时需要预置测试使用的 Qdrant 和 E5 镜像，命令和结果见 [工作交接](../../HANDOFF.md)。

## 配置

默认情况下普通模块全部关闭，Sandbox 另由宿主环境显式启用。用户级配置放在 `~/.pi/agent/pi-enhanced.json`：

```json
{
  "modules": {
    "mcp-policy": { "enabled": false },
    "memory": { "enabled": false },
    "context": { "enabled": false },
    "task-manager": { "enabled": false },
    "knowledge": { "enabled": false }
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

`mode` 支持 `lexical`、`semantic`、`hybrid`，默认是 `lexical`。配置不能指定脚本、数据库路径或 projectId。

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

Doctor 不写数据。`maintain dry-run` 只持久化可审查的 proposal 草稿，不改变 Memory 内容或状态；压缩/合并 apply 只生成新的 candidate，不继承 verified。维护命令由用户手动触发。

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
      "toolOutput": { "enabled": true, "maximumTextCharacters": 12000, "deduplicateReads": true },
	  "memoryInjection": { "enabled": false },
	  "taskInjection": { "enabled": false, "maximumTextCharacters": 2000, "readerTimeoutMs": 250 }
    }
  }
}
```

`observe` 只计算诊断，不改变消息；`select` 只改变本次模型请求视图，不写 Session。Memory 和当前 Task 摘要分别设开关并默认关闭。Task 摘要只读、低信任，并在注入前重新核对项目、会话、分支和 revision。Context 不使用 `context_with_system`，不会改系统提示或工具定义。

`toolOutput.deduplicateReads` 默认关闭。在受信任项目启用 `select` 和 `toolOutput` 后，可以单独启用它。OpenAI Chat Completions 流式请求中，参数和文本都相同的工作区只读工具输出只保留最近一份正文。历史工具调用和原始会话记录完整保留。Memory、Knowledge 和分页恢复继续按各自原有权限规则发送。

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

`nativeToolGuard` 独立保护 Pi 原生 read/write/edit 与 Shell 工具。默认写入和 Shell 需要逐次确认，无 UI 时拒绝；路径规范化后只允许工作区范围，并保护 `.git`、`.pi`。Docker 文件工具隔离由 Sandbox 扩展提供。

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

受控 DeepSeek 试用使用 `--budget-enforcement local_hard_gateway`。runner 为每个任务启动仅监听 `127.0.0.1` 的硬预算网关，通过临时 `models.json` 覆盖内置 DeepSeek 地址；真实 Key 不进入 Pi 子进程或 Docker。网关在转发前预留请求次数、输入上界、输出上限和费用，固定单并发并实施超时；usage 缺失、超限、断流或上游错误后失败关闭。默认受控评测使用 `deepseek/deepseek-flash`。`deepseek/deepseek-v4-pro` 仅用于单独配置的 SWE OFF 试跑或 V1/V2 对照。

首版不支持 Shell、PowerShell、用户 `!`、codemode、tool_search、MCP 写工具或未知第三方工具。排障时可先运行：

```bash
npm run smoke:docker --workspace=@wz-agent/pi-enhanced
npm run test:sandbox --workspace=@wz-agent/pi-enhanced
```

测试会创建并删除临时容器；异常退出后可按名称 `pi-enhanced-tools-*` 检查残留。不要使用宽泛的容器删除命令。

`run_tests` 可以省略 `targets`，由 Sandbox 执行宿主批准的目标。显式参数仍按文件或函数白名单校验。Task 的 pytest 验收继续要求当前工作区、策略和测试文件散列匹配，并核对该次工具调用的真实参数。

建立硬预算网关的宿主可在创建 `createContextExtension` 时传入 `requestBudget`，把同一网关的 `preview` 和 `status` 接入生产 AgentSession。宿主明确标记 `readOnly` 后，运行时会在预算紧张时优先保留批准的验证和文字答复，并继续经过既有的发送前来源复查。Memory 的生产检索工具在原查询及代码标识符均未命中时，可以尝试短语，继续应用原作用域和可见性条件。

### 任务预算档位

| 档位 | 总 Token 上限 | 用途 |
| --- | ---: | --- |
| Economy | 20,000 | 经济模式，适合范围明确的任务 |
| Standard | 25,000 | 生产默认，适合需要检索、修改和验证的任务 |
| Premium | 30,000 | 高配模式，由用户显式选择 |

加载 Pi Enhanced Context 扩展的普通 `pi --provider deepseek --model deepseek-flash` 会话，同时使用原有 DeepSeek 凭据和本地硬预算 Gateway。受控 Runner 使用同一档位定义，支持 `--budget-tier economy|standard|premium`。原有特定实验的授权和限制继续由各自入口校验。

在发送第一个任务提示之前，输入 `/enhanced-budget economy`、`/enhanced-budget standard` 或 `/enhanced-budget premium`。不带参数可查看当前档位及已用 Token。也可以在全局 `pi-enhanced.json` 中设置以下配置。受信任项目中的同名配置可覆盖普通 CLI 的全局设置。受控 Runner 读取全局配置或显式参数。

```json
{
  "budget": {
    "tier": "standard"
  }
}
```

档位只调整任务总 Token 上限。默认仍是每任务最多 8 次模型请求、180 秒、0.03 美元，每次输出最多 512 Token。宿主可显式设置 `maxRequests`、`timeoutMs`、`maxTotalCostUsd` 和 `maxOutputTokensPerRequest`。请求均由 Gateway 预留并按上游 Usage 结算，费用满足保守报价上界。

账本按项目及绑定的 Task 保存，普通无绑定任务按 Session 保存。开始后的改档须在空闲时通过终端确认，使用同一账本和原截止时间。已用 Token、费用与请求次数都会带入跨进程恢复。续用已有账本时，配置文件里的档位只影响新任务。预算不足不会自动升档。

E19 真实配对中，20K 完成 6/9，25K 完成 7/9。Premium 30K 通过离线限额和恢复验证，并有一次 CCR 下的真实 Flash 任务完成记录。两档之间的真实配对效果和 30K 下的真实 Pro 切换仍缺专项验证。

## 验证与当前状态

工程检查使用 `npm run check --workspace=@wz-agent/pi-enhanced` 和 `npm run check:evaluation --workspace=@wz-agent/pi-enhanced`。普通 CI 使用无密钥预检；Docker Job 必须实际运行沙箱、网关和 SWE 策略用例，跳过不算通过。

CI 使用 `docs/version-freeze-results.json` 核对测试身份。旧 Batch 用例仍覆盖路径隔离、预算结算、授权消费和审计恢复。

- [项目开发约定](../../AGENTS.md)和[交接记录](../../HANDOFF.md)。
- [SWE-bench 验收记录](docs/swebench-task-v2-verification.md)与[结果](docs/swebench-task-v2-results.json)，包含离线验收及当时真实运行的记录。
- [SWE-bench 协议与设计](docs/swebench-task-v2-design.md)，包含受限源码规则、模式差异和官方判分。
- Memory 与 Task 数据的备份和恢复由 `npm run data --workspace=@wz-agent/pi-enhanced -- ...` 提供，参数见[命令入口](scripts/data-management.ts)。
