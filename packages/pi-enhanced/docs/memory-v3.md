# Memory V3 实现与验证

开发工作树为 `F:/codex_worktrees/pi-memory-v3-adapters-9f44c107d`，从 `9f44c107de607b73d4cd822455389c7e90b366cd` 分离检出。Memory、Context 的记忆注入入口和本轮夹具都在该工作树。测试从基线独立安装依赖，SQLite 使用临时目录，Docker 测试和评测各用自己的 Compose 项目、Collection、回环端口和数据卷。

## 固定上游源码

| 上游及许可证 | 阅读的固定版本和实现 | 本项目采用 |
| --- | --- | --- |
| LangGraph，MIT | `84ced603d3a201ab0f9379936bb35868e243f3f3`，`SearchOp`、`BaseStore.search` 和 `InMemoryStore._filter_items` 按 namespace 前缀与元数据限缩检索。[接口](https://github.com/langchain-ai/langgraph/blob/84ced603d3a201ab0f9379936bb35868e243f3f3/libs/checkpoint/langgraph/store/base/__init__.py) · [实现](https://github.com/langchain-ai/langgraph/blob/84ced603d3a201ab0f9379936bb35868e243f3f3/libs/checkpoint/langgraph/store/memory/__init__.py) | 项目隔离独立于类型。会话和任务范围用宿主给出的 ID 过滤。 |
| LangMem，MIT | `4beb9c36a40953f09357e5b2dd62ecc726f22d13`，管理和检索工具用运行时 namespace，事实、经历、流程示例使用各自的数据结构。[工具](https://github.com/langchain-ai/langmem/blob/4beb9c36a40953f09357e5b2dd62ecc726f22d13/src/langmem/knowledge/tools.py) · [分类设计](https://github.com/langchain-ai/langmem/blob/4beb9c36a40953f09357e5b2dd62ecc726f22d13/docs/docs/concepts/conceptual_guide.md) | 保留 `kind` 和 `category`，新增 `type`、`scope` 和类型相关结构化内容。 |
| Mem0，Apache-2.0 | `fff8a6472512d1bc1a4bccab8c645b65a1df7fe5`，`add`、`search`、`update`、`delete`、`history`、实体过滤和过期屏蔽。[Memory 实现](https://github.com/mem0ai/mem0/blob/fff8a6472512d1bc1a4bccab8c645b65a1df7fe5/mem0/memory/main.py) · [SQLite 历史](https://github.com/mem0ai/mem0/blob/fff8a6472512d1bc1a4bccab8c645b65a1df7fe5/mem0/memory/storage.py) | 复用 SQLite 记忆记录和审计。SQLite 事务登记索引同步，由重试和对账补齐 Qdrant。 |
| Letta，Apache-2.0 | `f793a1fd449db8c4407f167119a2bb8f0ec24ba7`，`Memory.compile` 把受控块放入上下文，`archival_memory_search` 按需检索并分页。[核心记忆](https://github.com/letta-ai/letta/blob/f793a1fd449db8c4407f167119a2bb8f0ec24ba7/letta/schemas/memory.py) · [归档检索](https://github.com/letta-ai/letta/blob/f793a1fd449db8c4407f167119a2bb8f0ec24ba7/letta/functions/function_sets/base.py) | 继续使用 Core Memory 文档。会话记录和长期资料通过同一个可见性规则进入检索或上下文。 |
| Qdrant 和 Qdrant Client，Apache-2.0 | 服务端 `23065a0bf6857c3e5da45f6c8939cc746cc0580e` 的 Point 操作、Filter、HNSW。客户端 `1b5bb8589e5a8c124bcf80164736c7c92370c871` 的 `query_points`、`upsert`、`delete`、`scroll`、Payload 索引。[Point 操作](https://github.com/qdrant/qdrant/blob/23065a0bf6857c3e5da45f6c8939cc746cc0580e/lib/collection/src/operations/point_ops.rs) · [HNSW](https://github.com/qdrant/qdrant/blob/23065a0bf6857c3e5da45f6c8939cc746cc0580e/lib/segment/src/index/hnsw_index/hnsw.rs) · [客户端](https://github.com/qdrant/qdrant-client/blob/1b5bb8589e5a8c124bcf80164736c7c92370c871/qdrant_client/qdrant_client.py) | 通过可替换的 `MemoryVectorIndex` 接口按批写入和对账。实际 REST 验证用 Qdrant v1.15.5。 |
| Sentence Transformers，Apache-2.0。E5 权重，MIT | `ea66116aeea5e827963bedaa0c38ed4a4681229a` 的 CPU、缓存、revision、批量编码、query/document 与向量归一化。E5 固定 `614241f622f53c4eeff9890bdc4f31cfecc418b3`。[模型代码](https://github.com/huggingface/sentence-transformers/blob/ea66116aeea5e827963bedaa0c38ed4a4681229a/sentence_transformers/sentence_transformer/model.py) · [E5 模型卡](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3) | 现有 Python Worker 增加 `encode_e5`，同一进程复用 CPU 模型，使用 `query:` 和 `passage:` 前缀，返回 384 维归一化向量。 |

## 实施阶段

| 阶段 | 主要文件与数据变化 | 兼容性与验证 |
| --- | --- | --- |
| M1 类型与作用域 | `contracts.ts`、`provider.ts`、`service.ts`、`candidate-writer.ts`。SQLite schema v3 在现有 metadata 表加 `memory_type`、`scope_kind`、`scope_id`、`data_json`。 | 保留 ID、旧分类、正文散列、修订、来源和验证证据。按旧分类及任务来源迁移。没有可靠会话或任务归属的旧临时记录留在人工管理视图。覆盖五类写读、重复与作用域隔离、v1 和 v2 升级。 |
| M2 生命周期 | 现有 CRUD、`governance.ts`、`vector-outbox.ts`。新增与写入同事务的索引任务表，保存 Memory ID、修订、重试时间和确认令牌。删除事件保留审计与散列，SQLite 正文及关联数据按原有方式删除。 | 既有验证、提案、归档和恢复入口继续工作。冲突候选保留供审查。覆盖修订冲突、删除、审计、文件证据消失、过期和数据库重开后的队列状态。 |
| M3 本地 Embedding 与 Qdrant | `embedding-provider.ts`、Python `e5_embedder.py`、Worker 协议、`qdrant-vector-index.ts` 和 `vector-sync.ts`。Collection 默认 `pi_enhanced_memory_v3`。每个 Point ID 由项目、Memory ID、内容所在修订和模型标识确定性生成。Payload 保存 ID、修订、散列、类型、范围、有效期和流程适用条件。 | `tfidf-svd` 继续作为已有配置的默认后端，`e5-qdrant` 显式启用。真实 Qdrant 验证维度、模型隔离、Payload 过滤和向量删除。真实 E5 在无网容器编码。 |
| M4 类型化检索 | `semantic-search-adapter.ts`、`reader.ts`、`interaction.ts`、`context/memory-source.ts`。沿用 RRF，常量为 60，同分按 ID 稳定排序。 | `lexical`、`semantic`、`hybrid` 继续可用。Working 按会话和时间查询，结构化 Preference 精确匹配主题字段。Semantic、Episodic、Procedural 可索引，后两类支持任务范围、结果或时间排序及适用条件。两个读取出口均回查 SQLite，验证当前作用域、状态、有效期和修订。 |
| M5 故障与回归 | `fixtures/memory-v3`、`memory-v3.test.ts`、`memory-v3-docker.test.ts`、`test_e5_embedder.py`、`benchmarks/memory-v3`。 | 注入同步中断与迟到写入，验证删除后残留向量、对账修复、停机重启、模型不可用回退及无网容器访问限制。回归在本工作树基线上运行。 |

SQLite 保存正文、结构化数据、来源、证据、状态和审计。项目级已验证内容在同一项目内共享。会话和任务内容只在各自范围内可见。索引任务提交后按批读取当前记录，先写入当前修订的 Point，再清理较早修订。失败按上限为 60 秒的退避重试。确认令牌使过期任务无法清除新任务，按修订生成的 Point ID 使迟到写入无法覆盖新向量。后台对账按页核对两端，发现孤立、过期、证据失效或缺失的向量时清理或重新排队。检索和上下文使用 SQLite 的当前记录核验派生索引。未配置 Qdrant、模型缺失或服务停机时可继续使用 FTS5。

## 运行与接口

`EmbeddingProvider` 提供 `model` 和批量 `encode(texts, "query" | "passage")`。`MemoryVectorIndex` 提供 `ensure`、`upsert`、`remove`、`search`、`list` 和 `get`。测试通过注入这些接口控制故障和写入时序。

在可信项目的 `.pi/pi-enhanced.json` 或 Pi 全局配置中启用本地神经网络检索。启动前预置固定 revision 的权重和 CPU 依赖。宿主可用 `PI_ENHANCED_MEMORY_PYTHON` 指向 Python 可执行文件的绝对路径，用 `PI_ENHANCED_MEMORY_MODEL_CACHE` 指向 Hugging Face hub 缓存的绝对路径。Worker 运行时启用离线模式。

```json
{
  "modules": {
    "memory": {
      "enabled": true,
      "intelligence": {
        "enabled": true,
        "backend": "e5-qdrant",
        "mode": "hybrid",
        "qdrantEndpoint": "http://127.0.0.1:6333",
        "requestTimeoutMs": 20000
      }
    }
  }
}
```

```powershell
docker compose -p pi-memory-v3-local -f packages/pi-enhanced/fixtures/memory-v3/compose.yaml up -d --wait
docker build -t pi-memory-v3-e5:local -f packages/pi-enhanced/fixtures/memory-v3/Dockerfile.e5 packages/pi-enhanced/fixtures/memory-v3
$env:PI_MEMORY_V3_DOCKER = '1'
npm run test --workspace @wz-agent/pi-enhanced -- tests/integration/memory-v3-docker.test.ts
node packages/pi-enhanced/benchmarks/memory-v3/evaluate.ts
```

Docker 构建阶段下载公开依赖和固定权重。集成测试与评测运行各自创建资源，E5 Worker 使用 `--network none`。Qdrant 健康检查使用 `/readyz`，宿主监听 `127.0.0.1`，容器数据位于该 Compose 项目的命名卷。

## 隔离验证结果

Windows 宿主的 TypeScript 定向回归通过 26 个文件、141 项测试。其中真实 Docker 用例验证 Qdrant 停机和重启、删除事件补偿、无网访问约束和缺少本地权重时的 FTS5 回退。Python 在无网容器通过 18 项测试。类型检查、改动源码的 Biome 检查、离线构建和包泄漏检查通过。

固定评测使用 18 条记忆、14 个查询，每个查询重复 3 次。语料含关键词命中、同义改写和跨语言查询。所有方法使用同一份 SQLite 数据，Embedding 与 Qdrant 运行在本地 Docker。

| 方法 | Recall@5 | MRR@5 | 预热后 P50 / P95 | Worker 内存采样 |
| --- | ---: | ---: | ---: | ---: |
| FTS5 | 35.7% | 0.357 | 1.2 / 3.4 ms | — |
| TF-IDF+SVD | 64.3% | 0.643 | 30.1 / 38.8 ms | 16.9 MiB |
| E5 + Qdrant | 92.9% | 0.764 | 29.5 / 32.4 ms | 608.3 MiB |
| FTS5 + E5 + Qdrant，RRF | 92.9% | 0.764 | 33.3 / 60.8 ms | 608.5 MiB |

E5 的预热后查询编码中位数为 11.1–13.1 ms，后续文档批次约 16–17 ms。首次文档编码请求含 Worker 启动及模型加载，耗时约 5 秒。Qdrant 内存采样约 144–156 MiB。内存来自 Docker Stats 单点采样，原始结果同时记录宿主进程 CPU 时间和峰值 RSS。此次固定集上的 Hybrid 与纯向量排序命中指标相同。

## 边界与联合验证

- 当前对账每轮按页执行，`doctor` 扫描首批并报告是否截断。很大的旧索引需要经过多轮后台同步。索引故障期间使用词法结果。
- 同维度的模型版本通过 Payload 和 Point ID 隔离。更换为不同维度时需要规划 Collection 重建，本轮未自动删除旧模型的 Point。
- 文件证据可实时校验。人工确认和已有测试、Git 证据保留来源和版本，未来分支上的证据复验另行验证。
- 当前隔离验证使用基线 Task/Context。V3.1、V3.2 完成后需联合验证活跃任务切换、分支恢复、任务候选写入和无网沙箱完整链路。
- 固定评测衡量检索命中、排序、耗时和占用。Agent 修复任务结果需要单独的受控实验。

## M6–M10 运维与兼容

向量传输和离线编码公共接口见仓库根目录的 `VECTOR_CONTRACT.md`。Memory 继续通过自己的适配器维护 SQLite 权威记录与 `pi_enhanced_memory_v3`，Knowledge 选择独立的 `pi_enhanced_docs_v1`。两个消费者按需启动各自的 Worker，并可使用同一预置模型缓存。从旧版升级时继续走现有 SQLite v1–v3 迁移，新增类型字段存储在已有的 `data_json` 中。模型或向量服务不可用时保留 FTS5。

| 场景 | 入口与行为 |
| --- | --- |
| 修改内容 | `/enhanced-memory-update <id> <revision> <操作说明>`。修改写入宿主会话来源和理由，创建新内容修订，等待重新验证。现有调用方可为 `updateContent` 传入 `MemoryChange`。 |
| 任务经验转为项目候选 | `/enhanced-memory-promote <id> <revision> <操作说明>`。现有任务记录保留原作用域，项目候选保留派生关系，需独立验证才会进入跨任务检索。 |
| 证据失效 | 检索以已验证修订的文件散列为准。文件变化或无法读取时立即屏蔽相关记忆，可用 `/enhanced-memory-reflect` 记录状态变化。 |
| 诊断和恢复 | `/enhanced-memory-doctor` 显示 SQLite 总数、待同步和失败，以及有界向量检查结果。`/enhanced-memory-reconcile` 每次推进一批对账，适合重建遗失的派生索引。 |
| 类型化读取 | Working 默认 24 小时 TTL，可绑定会话内任务，并按优先级和最近使用排序。Episodic 支持事件时间、结果和因果引用。Procedural 支持前置条件和步骤，检索及注入先检查运行环境。Preference 精确匹配主题键，优先最新有效人工确认。 |

自动注入使用宿主提供的平台、Node 版本、项目和工具能力标签。工具参数可以收窄条件和范围。已有 Context 的字符预算与 Core Memory 的 64 KiB 文档上限分别配置和管理。所有返回内容按低信任数据呈现。

```powershell
node packages/pi-enhanced/benchmarks/memory-v3/evaluate.ts --stratified
```

v2 增加任务前缀隔离、会话和 TTL、证据撤销、平台与工具适用性、偏好冲突和负例。评测不会修改原 v1 语料或标签。

## 新增文件

- `src/memory/` 下的 `embedding-provider.ts`、`qdrant-vector-index.ts`、`vector-outbox.ts`、`vector-sync.ts`。
- `python/memory-intelligence/` 下的 `src/memory_intelligence/e5_embedder.py`、`tests/test_e5_embedder.py`。
- `fixtures/memory-v3/` 下的 `compose.yaml`、`Dockerfile.e5`、`lab.ts`。
- `tests/integration/` 下的 `memory-v3.test.ts`、`memory-v3-docker.test.ts`。
- `benchmarks/memory-v3/` 下的 `dataset.ts`、`evaluate.ts`，以及 `docs/memory-v3.md`。
