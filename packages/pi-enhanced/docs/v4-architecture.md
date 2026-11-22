# Pi Enhanced V4 架构与运行手册

| 模式 | 启动 | 测试与反馈 |
| --- | --- | --- |
| `single`（默认） | 在项目内启动 `pi`，按原方式加载 Pi Enhanced | 同一会话调用已配置的 Sandbox 测试工具，并根据结果继续工作 |
| `multi-local` | 加载 `src/multi-local/extension.ts`，运行 `/enhanced-multi start …` | Coordinator 管理 Code/Test 会话，本机运行批准的 Docker pytest |
| `multi-a2a` | 加载相同扩展，启动独立 Test 服务，运行 `/enhanced-multi start-a2a …` | Coordinator 通过本机 A2A 委派同一个 pytest 执行逻辑，收回 Artifact 并核验 |

## 启动步骤

从仓库根目录安装依赖并执行 `npm run build:offline`。离线构建所需的模型目录数据可提前用 `npm run hydrate:model-data` 准备。真实任务前，先配置可用的 Docker 文件工具镜像和 pytest 镜像。项目已有 `packages/pi-enhanced/scripts/pytest.Dockerfile`，构建后用 `docker image inspect --format '{{.Id}}' <镜像>` 取得固定的本地镜像 ID。

`single` 沿用已有的 Pi Enhanced 扩展加载和 `pi-enhanced.json` 配置。在启用 Docker 文件工具时使用 [README 的 Sandbox 配置](../README.md#docker-文件工具沙箱)。要使用受控本机 Stub 验证三种模式，可从仓库根目录运行以下回归，无需真实模型凭据。

```sh
npm exec -w packages/pi-enhanced -- vitest run tests/e2e/multi-local.test.ts tests/e2e/gateway-sandbox-e2e.test.ts --no-file-parallelism
```

两个多 Agent 模式要求受信任的交互会话、临时工作区和宿主确认。把待测文件放入系统临时目录的子目录，并从该子目录启动 Pi。`PI_ENHANCED_SANDBOX_RUN_ROOT` 指向实际系统临时目录根，`PI_ENHANCED_SANDBOX_WORKSPACE` 指向工作区规范路径。配置 `PI_ENHANCED_SANDBOX_ENABLED=1`、`PI_ENHANCED_SANDBOX_TRUSTED=1`、唯一的 `PI_ENHANCED_SANDBOX_RUN_ID`、`PI_ENHANCED_SANDBOX_IMAGE` 和 `PI_ENHANCED_PYTEST_CONFIG_JSON`。pytest 配置示例中的文件、目标与镜像 ID 应替换为宿主允许的值。

```json
{
  "image": "sha256:<固定 pytest 镜像 ID>",
  "files": ["counter.py", "test_counter.py"],
  "tests": ["test_counter.py"]
}
```

设置 `PI_ENHANCED_MA1_LOCAL_URL=http://127.0.0.1:<端口>` 指向受信的 OpenAI Chat Completions 兼容服务，配置该服务的 `PI_ENHANCED_MA1_LOCAL_KEY`，并通过 `PI_ENHANCED_MA1_LOCAL_MODEL` 选择服务公开的模型 ID。Code/Test 会话通过父 Gateway 使用模型，凭据由宿主管理。

```sh
pi --extension /absolute/path/to/packages/pi-enhanced/src/multi-local/extension.ts
```

```text
/enhanced-multi start {"goal":"修复 next_count 的返回值","target":"test_counter.py","editFiles":["counter.py"]}
/enhanced-multi resume <task-id>
```

采用 `multi-a2a` 时，在另一个终端从同一工作区启动服务。两个进程须使用同一 `PI_CODING_AGENT_DIR`、Sandbox 配置、pytest 配置及 `PI_ENHANCED_A2A_PRINCIPAL`。为双方配置同一个独立的 `PI_ENHANCED_A2A_TOKEN`，长度至少 32 字符。服务默认端口为 8765，由 `PI_ENHANCED_A2A_PORT` 指定，Coordinator 使用 `PI_ENHANCED_A2A_URL=http://127.0.0.1:8765` 连接。Test 服务无需模型凭据。

```sh
node --experimental-strip-types /absolute/path/to/packages/pi-enhanced/scripts/run-a2a-test-agent.ts
```

```text
/enhanced-multi start-a2a {"goal":"修复 next_count 的返回值","target":"test_counter.py","editFiles":["counter.py"],"diagnose":true}
/enhanced-multi resume-a2a <task-id>
```

## 权限、预算与恢复

- Coordinator 保存父任务、步骤、编辑范围、委派、工作区修订及测试收据。Code 会话只能编辑指定文件，可按配置启用项目范围内的只读 Memory/RAG。Test 模型会话只能读取允许的文件。真实 pytest 由宿主运行于无网 Docker，使用受批准的镜像、文件、目标与工作区快照。
- A2A 使用固定的官方 SDK `1.3.0` 和协议 `v1.0.0`，仅提供回环 HTTP JSON-RPC。Agent Card 在 `/.well-known/agent-card.json`。执行、查询和取消核对身份、任务归属和已落盘的委派意图。Artifact 只含有界诊断、快照与 Docker 收据。原始测试日志留在本地。
- `pi-enhanced.json` 的 `budget.tier` 支持 `economy`（20K）、`standard`（25K，默认）和 `premium`（30K）。默认每个父任务合计 8 次模型请求、180 秒、$0.03，每次最多 512 输出 Token。Code 与可选的只读模型诊断使用同一 Gateway 账本。A2A Test 服务执行确定性 pytest，无独立模型配额。`diagnose: true` 由 Coordinator 内的 Test Session 通过父账本补充诊断。
- Memory/RAG、Context 和请求边界沿用来源校验及发送前撤权复查。启用受保护检索后，源码补丁正文缺少可复查的细粒度来源时，Code/Test 会话禁止读回其正文，宿主仍可运行测试核验补丁。
- 恢复保留原 Task、角色会话、预算用量、档位和截止时间。A2A 重试使用持久化的操作 ID 和原远端任务 ID。相同操作和负载复用原记录，同一 ID 改负载会被拒绝。测试收据必须匹配当前工作区修订。结果未知的副作用会进入待核验，已确认的写入不重放。
- 当前服务仅限本机回环，支持提交、查询和取消。A2A 服务退出可用 SIGINT 或 SIGTERM。部署范围、工作区权限或认证变化需重新核验。

### 在任务开始前选择 Code 和 Test 模型

在可信 Pi 用户目录（例如 `PI_CODING_AGENT_DIR` 指定的目录）的 `pi-enhanced.json` 加入 `multiAgent.code` 和 `multiAgent.test`。两者仍通过 `PI_ENHANCED_MA1_LOCAL_URL` 连接同一个 OpenAI Chat Completions 服务。以下是本地 Stub 的完整示例，费率为验收夹具数值。连接其他服务前，按该服务的模型 ID、上下文和受信费率填写。费率单位为美元／百万 Token，应覆盖输入和输出的实际收费上界。

```json
{
  "multiAgent": {
    "code": {
      "modelId": "stub-pro",
      "contextWindow": 128000,
      "maxOutputTokens": 512,
      "supportsTools": true,
      "pricing": { "inputUsdPerMillion": 2, "outputUsdPerMillion": 4 }
    },
    "test": {
      "modelId": "stub-flash",
      "contextWindow": 64000,
      "maxOutputTokens": 512,
      "supportsTools": true,
      "pricing": { "inputUsdPerMillion": 0.5, "outputUsdPerMillion": 1.5 }
    }
  }
}
```

省略 `multiAgent` 时继续用 `PI_ENHANCED_MA1_LOCAL_MODEL` 及原单模型结算。选用角色配置时，省略的角色继承旧配置。若交互入口使用自定义统一模型 ID 并希望开启角色配置，请为两个角色各提供能力与费率，确保继承模型的费用有明确口径。同一模型 ID 的能力与费率须一致。每个角色都需要支持文本工具调用。启用角色配置后，上游的 SSE 响应须能确认请求的模型 ID，缺失或不一致时 Gateway 会保守结算并停止该账本。

`start` 和 `start-a2a` 创建任务时会保存模型配置、费率和上游地址。后续 `resume` 或 `resume-a2a` 沿用原配置及原预算，用户配置的修改用于下一任务。Gateway 为两个角色累计同一个父任务的 Token、请求、时间和费用，并在每次发送前按该角色的模型费率预留；单次输出同时受模型能力上限和父任务上限约束。关闭 `diagnose` 时 Test 模型不参与调用。A2A Test 进程继续只执行 pytest，模型凭据留在 Coordinator 一侧。

## MA-3 真实评测记录

冻结矩阵为六个任务、三种模式。11 个有效 DeepSeek Flash 单元全部成功，另外 7 个请求在上游被鉴权拒绝并与模型质量分开统计。有效样本为 S0 4/4、S1 4/4、S2 3/3。S0/S1 四个有效配对合计少 2 次请求、14,606 Token，S1 平均少 1.97 秒。S1/S2 三个有效配对请求数均为 16，S2 合计多 210 Token、平均多 1.74 秒。两道留出任务在三组均成功。全部有效请求按用量估算 $0.009636786，含历史未知费用的累计保守上界 $0.247299301。

这些数据来自固定的小样本，默认仍为 `single`。历史冻结评测入口位于 `benchmarks/real-agent/agent-evaluation.ts`，MA-3 模式要求原候选和原授权证据，集成回归走上面的 Stub 与 Docker 命令。评测时的原始记录位于独立 MA-3 工作树。最终交接记录其当前归档可用性及完整性状态。运行本手册的回归使用本地 Stub 与 Docker。
