# Memory V3 M6–M10 交接

开发工作树为 `F:/codex_worktrees/pi-memory-v3-adapters-9f44c107d`，分离基线 `9f44c107de607b73d4cd822455389c7e90b366cd`。开工时保留了全部 M1–M5 未提交改动和通用 Qdrant 客户端初稿。

## 开工审计

| 切片 | 现状 | 缺口与证据 |
| --- | --- | --- |
| M6 | 已有固定 E5 Worker 和 Memory 专用 Qdrant 包装器，`src/shared/vector/qdrant.ts` 已有通用客户端初稿。 | 包装器仍自带 HTTP 实现。公共 E5 的所有权与可导入契约缺失。用通用客户端测试与真实双 collection 测试验证。 |
| M7 | `service.ts`、`provider.ts` 实现提案、验证、证据检查、审计和修订。事务 outbox 和按修订写向量由 `memory-v3.test.ts` 覆盖。 | 继续核查证据源变化、任务会话身份、删除后对账和人工诊断入口。 |
| M8 | 五类在 SQLite 分流。检索路径在 `contracts.ts`、`service.ts`、`provider.ts`、`semantic-search-adapter.ts`；工具和 Context 使用 reader。 | 补查结构条件、冲突候选、范围过滤与排序。 |
| M9 | `memory/extension.ts` 和 `runtime.ts` 已管理独立开关。 | 本工作树用模拟 Knowledge 消费端证明双开关。真正联合验证依赖 V3.1、V3.2 和 Knowledge 的集成。 |
| M10 | `benchmarks/memory-v3/` 有 18 条记忆、14 个查询；`memory-v3-docker.test.ts` 有真实 Qdrant/E5 初步覆盖。 | 增加分层样例，记录过滤误命中、加载时延、资源和清理证据。 |

开工定向结果为 71 项 TypeScript 通过、1 项 Docker 用例按配置跳过，Python 18 项通过，TypeScript 检查通过。固定上游源代码及 LICENSE 以 `packages/pi-enhanced/docs/memory-v3.md` 的链接及下文核查为准。

## M6–M10 变更

| 阶段 | 结果 | 源码和用例 |
| --- | --- | --- |
| M6 | 公共 Qdrant 和 E5 接口已落地。Memory 包装器继续保存既有 Point ID、业务 payload 与操作签名。 | 根目录 `VECTOR_CONTRACT.md`、`src/shared/vector/qdrant.ts`、`src/shared/embedding/e5.ts` 和 `memory-vector-contract.test.ts`。 |
| M7 | 内容修订记录来源和理由。文件证据变更即时屏蔽。项目候选独立验证。任务写入验证任务归属及完成状态，重试沿用事件身份。 | `memory/service.ts`、`provider.ts`、`reader.ts`、`candidate-writer.ts`、`vector-sync.ts` 与新增生命周期和半批写入测试。 |
| M8 | Working 有 TTL 和会话内任务约束。Episodic 按事件时间和结果筛选。Procedural 附前置条件和步骤，由宿主环境缩限。Preference 优先最新有效人工确认。 | `memory/contracts.ts`、`semantic-search-adapter.ts`、`interaction.ts`、`context/memory-source.ts` 和五类型检索测试。 |
| M9 | Memory 与模拟 Knowledge 分别启停。独立进程所有权保障一个模块的关闭只回收自己的 Worker，并可共享预置缓存。 | `src/shared/embedding/python-worker-client.ts`、`memory-vector-ownership.test.ts`。真实 Knowledge 联合验收待集成。 |
| M10 | 固定 v2 分层语料和测试场景覆盖两种 payload、限流、真实向量重建、无网编码及导出诊断。 | `benchmarks/memory-v3/dataset-v2.ts`、`evaluate.ts`、`memory-v3-docker.test.ts` 及 `docs/memory-v3.md`。 |

### 逐文件清单

以下路径相对 `packages/pi-enhanced`。本目录之外的交付文件是根目录 `VECTOR_CONTRACT.md` 和本交接。

- `src/shared/embedding/e5.ts` 提供模型标识、批量编码和惰性所有者。该目录的 `python-worker-client.ts` 保留旧协议，增加进程换代隔离和并发关闭等待。
- `src/shared/vector/qdrant.ts` 处理本机 REST 请求、通用 payload、过滤、分页、错误和写入确认。
- `src/memory/embedding-provider.ts` 和 `python-worker-client.ts` 保留旧导入。`qdrant-vector-index.ts` 保留 Memory Point 映射，补事件元数据。`vector-sync.ts` 增加可控对账。
- `src/memory/contracts.ts`、`service.ts`、`provider.ts` 和 `governance.ts` 增加类型验证、排序、冲突提示、任务事件去重和操作审计。
- `src/memory/extension.ts`、`candidate-writer.ts`、`reader.ts`、`interaction.ts` 和 `semantic-search-adapter.ts` 接入宿主范围、命令、检索和回退。
- `src/context/memory-source.ts` 处理结构化低信任注入，读取失败时清除旧注入并返回可诊断状态。
- `tests/integration/memory-vector-contract.test.ts`、`memory-vector-ownership.test.ts` 为新增合约和所有权用例。`memory-v3.test.ts`、`memory-v3-docker.test.ts` 和 `task-memory-candidate.test.ts` 补生命周期、检索、重建和任务来源验收。
- `benchmarks/memory-v3/dataset-v2.ts` 冻结语料和标签，同目录 `evaluate.ts` 支持 `--stratified`，默认入口仍运行 v1。`docs/memory-v3.md` 更新运行说明。

### 上游逻辑核对

- LangGraph Store `84ced603` 的 `SearchOp` 与 `InMemoryStore._filter_items` 按 namespace 段和过滤条件匹配。LangMem `4beb9c3` 的 `create_search_memory_tool` 传运行时 namespace 和 filter。本地用独立的类型字段、精确 ID 和宿主 TaskReader，无需上游 Store 作为事实库。两者均为 MIT。[LangGraph](https://github.com/langchain-ai/langgraph/blob/84ced603d3a201ab0f9379936bb35868e243f3f3/libs/checkpoint/langgraph/store/memory/__init__.py) · [LangMem](https://github.com/langchain-ai/langmem/blob/4beb9c36a40953f09357e5b2dd62ecc726f22d13/src/langmem/knowledge/tools.py)
- Mem0 `fff8a64` 的 `_update_memory` 与 `_delete_memory` 更新向量并记历史，`search` 受实体过滤。这里沿用 SQLite 审计和双修订号，派生索引经事务 outbox 异步同步。Apache-2.0。[Mem0](https://github.com/mem0ai/mem0/blob/fff8a6472512d1bc1a4bccab8c645b65a1df7fe5/mem0/memory/main.py)
- Letta `f793a1f` 的 `Memory.compile` 将小块上下文直接渲染，归档检索单独分页。这里保留有界的 Core 文档与低信任检索注入。Apache-2.0。[Letta](https://github.com/letta-ai/letta/blob/f793a1fd449db8c4407f167119a2bb8f0ec24ba7/letta/schemas/memory.py)
- Qdrant Client `1b5bb85` 的 `query_points`、`upsert`、`scroll` 提供通用 Point、payload、Filter 和等待语义。这里用 Node 原生 HTTP 及固定 collection 的泛型适配器，在 Memory 层复核 SQLite。Apache-2.0。[Qdrant Client](https://github.com/qdrant/qdrant-client/blob/1b5bb8589e5a8c124bcf80164736c7c92370c871/qdrant_client/qdrant_client.py)
- Sentence Transformers `ea66116` 的 `encode_query`、`encode_document` 与模型加载路径支持批量、缓存、revision 和归一化。这里沿用固定离线 E5 Worker，由宿主明确选择 query/passage。框架 Apache-2.0，E5 权重 MIT。[Sentence Transformers](https://github.com/huggingface/sentence-transformers/blob/ea66116aeea5e827963bedaa0c38ed4a4681229a/sentence_transformers/sentence_transformer/model.py)

### 联合集成边界

1. Knowledge 窗口先按 `VECTOR_CONTRACT.md` 引用公共层，使用独立 collection、payload schema version 和应用级权限。K0–K2 留在 Knowledge 工作树。合并时检查配置加载与打包范围是否保留两个独立模块。
2. V3.1 的集成窗口对照 TaskReader 的 `get/getActive`、项目和会话 ID、分支锚点、任务状态。用真实完成任务验证候选往返，并覆盖暂停恢复、切换项目和过期读句柄。
3. V3.2 的集成窗口保留 Memory 对 `memory-source.ts` 的范围与证据复核，接入 `MemoryInjectionResult.errorCode` 到 Context 诊断。联合验证低信任注入、独立预算和会话分支切换。
4. 同维度索引的旧 Episodic Point 会在对账时补齐事件字段。不同维度的模型升级需显式重建对应 collection。大型索引需要多次有界对账。
5. Preference 按本地 Pi 用户数据目录和项目隔离。以多个 OS 用户共享同一 agentDir 的部署需要独立用户身份绑定。固定评测结果只衡量检索。

### 验收矩阵

| 场景 | 复现入口 | 已观测行为 |
| --- | --- | --- |
| v1/v2 迁移和重开 | `memory-governance.test.ts`、`memory-provider.test.ts`、`data-backup-restore.test.ts` | 原记录、来源和文件验证可读，未绑定的旧范围保持隔离。 |
| 事件、增删与重复同步 | `task-memory-candidate.test.ts`、`memory-v3.test.ts` | 重放原任务事件仍指向同一 ID，正文更新后仍然幂等。显式删除后重放失败。半批成功可按原修订重试。 |
| 修订竞争和失效 | `memory-v3.test.ts`、`context-memory-source.test.ts`、`memory-intelligence.test.ts` | 新修订可读，迟到向量、删除残留、旧 Context 和读取期间归档均被拒绝。 |
| 文件证据 | `memory-governance.test.ts`、`memory-v3.test.ts` | 文件字节 SHA-256 变化即屏蔽已验证事实，即使正文摘录还在。诊断与反思保留状态和审计。 |
| 权限与类型 | `task-memory-candidate.test.ts`、`memory-v3.test.ts`、v2 评测 | 前缀相同的任务和会话保持隔离。伪造 Task ID 和工具条件均未扩大可见性。五类采用相应排序、字段和有效期。 |
| 故障回退 | `memory-v3-docker.test.ts`、`memory-vector-contract.test.ts`、`memory-vector-ownership.test.ts` | 真实 Qdrant 停机、重启、集合遗失后重建及 429 分类。离线 Worker 缺模型时回退 FTS5，进程退出后重新启动。 |
| 双开关和回收 | `memory-vector-ownership.test.ts`、`memory-vector-contract.test.ts` | 四种组合均执行。关闭 Memory 后模拟知识消费者继续编码。真实模拟文档使用独立集合。 |

在工作树根目录执行定向验证和完整回归，使用此入口解析 Runner 的子进程夹具：

```powershell
$env:PI_MEMORY_V3_DOCKER = '1'
npm exec vitest -- --run packages/pi-enhanced/tests/unit packages/pi-enhanced/tests/integration packages/pi-enhanced/tests/e2e --exclude '**/.artifacts/**' --maxWorkers=1 --testTimeout=30000
npm run check --workspace @wz-agent/pi-enhanced
npm run build:offline
npm run check:pack --workspace @wz-agent/pi-enhanced
git diff --check
node packages/pi-enhanced/benchmarks/memory-v3/evaluate.ts --stratified
```

定向复测通过 55 项 Memory、Context、Task 候选与治理测试。另一组串行复测通过 26 项，包含真实 Qdrant、真实 E5、两种 payload、四开关组合和两个原有子进程夹具。Python 容器在 `--network none` 下通过 18 项。包目录执行的完整回归暴露出两个从仓库根目录解析子进程路径的夹具，根目录串行复测这两个用例均通过。先前并行运行出现的 Batch J 限额组和真实 Runner Memory 全功能组也在单独串行复测通过。

最终根目录串行回归统计为 61 个文件、409 项测试，其中 **368 通过、0 失败、41 跳过**。跳过由原有条件控制，包括 Batch J 1 项、Batch N 3 项、MCP 组件 2 项、pytest 工具 12 项、SWE-bench policy 17 项和 stub 6 项。Memory Docker、公共合约与所有权测试共 9 项，均实际执行。日志位于 `.artifacts/memory-v3/next-ci-final.log`，机器可读结果为同目录 `next-ci-final.json`。根 TypeScript、夹具 TypeScript、改动源码 Biome、离线构建、包泄漏检查和 Git 空白检查通过。

Qdrant 测试使用每次运行独立的 loopback 端口、Compose project、collection 和数据卷。每组测试关闭 Worker 后用自己的项目名执行 `docker compose down -v`。预置 E5 镜像供离线复现。

回收核对发现本轮遗留容器、网络、卷和匹配前缀的临时目录均为 0。既有 `pi-memory-v3-adapters-9f44c107d_index` 卷保留。Git 相对分离基线累计有 21 个已跟踪文件修改和 22 个新文件，包含既有 M1–M5。已暂存文件为 0。原仓库状态和已有文件散列与基线快照一致，42 项历史删除保留。跨模块源码的本轮修改限于约定归属的 `src/context/memory-source.ts` 和公共技术层。

### v2 分层评测

固定语料包含 30 条记忆、24 个查询，其中 21 个有相关结果、3 个应为空。每个查询重复 3 次。Recall@5 和 MRR@5 只计有相关结果的查询。四种模式在 72 次查询中均为 0 次禁止命中、0 次负例误返回。分层标签和各层命中见 `dataset-v2.ts` 和 `.artifacts/memory-v3/retrieval-stratified-v2-final.json`。

| 检索 | Recall@5 | MRR@5 | P50 / P95 |
| --- | ---: | ---: | ---: |
| FTS5 | 52.4% | 0.524 | 3.2 / 6.3 ms |
| TF-IDF+SVD | 76.2% | 0.762 | 23.8 / 40.6 ms |
| E5 + Qdrant | 95.2% | 0.843 | 44.8 / 53.0 ms |
| FTS5 + E5 + Qdrant | 95.2% | 0.843 | 28.4 / 49.1 ms |

E5 首次文档批次约 4.56–5.17 秒，包含进程和模型启动。预热查询编码中位数为 11.8–13.4 ms。端到端冷启动含容器访问和建索引，约 9.57–10.44 秒。Docker 单点采样显示 E5 Worker 约 608–609 MiB，Qdrant 约 141–163 MiB。Docker 测试及评测使用 8 秒 Qdrant 请求时限。最终延迟单独采样，避免与全量测试共享负载。结果来自单台宿主和小样本；每层查询数有限，单次延迟排序不用于判断两种模式的普遍快慢。
