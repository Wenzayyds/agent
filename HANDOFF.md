# 当前工作交接

## 当前任务与授权

- 项目：`F:\项目代码\pi-agent` 的 `packages/pi-enhanced`。当前聊天默认目录 `wzAgent` 不是本项目仓库。
- 用户已将任务从“只读提交审查”调整为“整理项目结构”，并明确选择：旧实验移出日常入口、归档仍需复现的代码、仅删除确认无引用的代码。
- 不使用 subagent；不提交、不推送、不运行付费模型。真实实验数据、已消费授权和原有 42 项文档删除必须保留。
- 当前 HEAD：`106d6e190bd516e1fb6b718b979040db7f5c6d43`。旧 Commit 的绿色 CI 不代表当前工作树。

## 从哪里读代码

- [Package README](packages/pi-enhanced/README.md)：五个扩展、配置与目录导航。
- [评测调用关系](packages/pi-enhanced/benchmarks/real-agent/README.md)：批次 → 单组 → 准备/执行/结果 → 官方判分。
- [归档实验](packages/pi-enhanced/benchmarks/archive/README.md)：独立 P5、消融和合成基准。
- [完整历史交接](packages/pi-enhanced/docs/history/HANDOFF-before-structure-cleanup.md)：本轮开始前的 HANDOFF 原始字节副本。旧阶段要求和授权只作历史证据，不自动成为新任务。

## 本轮整理

- 归档 6 个独立实验脚本和 1 个消融配置；移除对应日常 npm 命令、普通 CI 中的 P5/质量实验，发布包排除归档与历史交接。
- 普通 CI 改用已有 `--preflight`，不再通过默认 Runner 入口重写 P5 历史报告。
- 测试身份清单脚本迁到 `scripts/ci/test-manifest.ts`，要求显式输入基线和输出路径，不再默认使用已删除的 Batch D 报告。
- `swe-profile.ts` 独立声明 SWE 配置；`evaluation-identity.ts` 保存既有散列规则；`swe-results.ts` 收集 SWE 结果。Runner 的预算、授权、工具限制和结果格式不变。
- 未按旧 Batch 名称删除测试。仍在被 CI 和安全回归使用的历史协议代码继续保留。
- 整理前文件备份与源码散列位于 `.artifacts/structure-cleanup/before/` 和 `before.json`，不是新实验批次。

## 最终验收现状

- 三份状态分开看：HEAD 旧 CI；整理前 26 项 SWE 修复（`.artifacts/swe-continuation/candidates.json` 与 `.artifacts/structure-cleanup/before/`）；当前结构整理后源码。不能把 HEAD 到当前的差异都算成结构整理。
- Linux 中已复现暂停进程收不到 `SIGTERM` 的超时问题；`runner-execution.ts` 仅在 Linux 超时分支先发 `SIGCONT`，再发原有终止信号。实际 Linux Pi Runner 加 Docker 链路尚未实测。
- 当前 Windows 完整离线 TypeScript 为 288 通过、0 失败、3 跳过。Batch J 夹具改为先注册消息监听、再发送就绪通知；对应文件专项 13 通过、1 跳过，随后整轮也通过。旧失败日志保留在 `.artifacts/structure-cleanup/final/`，本轮测试工具结果为其中的 `current-vitest.json`。
- Python 15/15（本轮仅改 TypeScript 测试夹具，未重复运行）；预检、291 项测试身份清单和包内 TypeScript 类型检查通过。此前 9 项工程/类型/打包检查、28 文件 Biome、归档脚本路径检查通过。根 `npm run check` 含全仓 `--write`；本轮只读根 Biome 扫描遇到 `.artifacts` 内历史仓库的嵌套配置，夹具路径本身不在根 Biome 配置的检查范围。
- Linux Node 能加载当前 Runner 模块；只读源码的 unit/integration 为 213 通过、6 项子进程 10 秒超时失败、1 跳过。相同挂载环境中，无执行参数的 Runner 正常退出耗时约 10.9 秒，另一拒绝执行入口耗时约 18.3 秒；先归为该挂载环境的启动耗时限制，不改超时阈值。自动权限审查拒绝把宿主 Docker socket 和可写仓库同时交给容器，因此 Linux Docker 强制用例及证据门槛未完成；Windows 宿主调用 Docker 不能代替它。
- 124 个历史保护文件、42 项原有删除和 78 个运行时源码/扩展/Python 文件仍保持不变。当前候选清单位于 `.artifacts/structure-cleanup/candidates.json`，原有历史报告与已消费授权不进入候选范围。未暂存、未提交、未调用付费模型。
- 结构说明与剩余耦合见 `packages/pi-enhanced/benchmarks/real-agent/README.md`。目前不具备提交条件，主要阻断是 Linux Docker 强制用例及证据门槛未完成；保留当前未提交工作树。

## 真实实验条件

先审查新的精确提交范围并取得提交/推送批准，再通过新 Commit 的 Windows/Linux/Docker CI。在干净检出和真实宿主校准 OFF/V1/V2 输入，检查 Linux 官方评测环境后，单独批准总额 USD 0.24，创建绑定新 Commit、CI、配置、逐模式指纹、唯一输出和有效期的一次性 grant。

旧 USD 0.09 授权已消费，不复用旧 grant、旧输出目录或历史 host-pilot 脚本。三组仍采用受限源码协议；当前没有新的官方 resolved 或 Task 收益结论。

## Knowledge/RAG · K0 源码审计与实施方案（2026-11-18）

开发基线为 `9f44c107de607b73d4cd822455389c7e90b366cd`，使用独立 detached worktree `F:/codex_worktrees/pi-knowledge-rag-9f44c107d`。主工作区含历史删除和其他开发的未提交改动。Memory V3 的 Embedding Provider、Qdrant 适配器和同步队列目前位于另一个同基线的未提交工作区。Task 与 Context 的并行工作区也各自保留。

| 功能 | 固定源码与许可证 | 核心设计和采用方案 |
| --- | --- | --- |
| 格式识别、HTML/DOCX/PDF 转换 | Docling `80f81b2799112d66a59b4a292cad3a86d41d06ad`（2.92.0，MIT，根 LICENSE）。阅读 `docling/document_converter.py`、`datamodel/document.py`、`datamodel/backend_options.py`、`backend/{html,msword,pypdfium2}_backend.py`、`pipeline/simple_pipeline.py`。 | Converter 由允许格式和格式对应的后端路由。HTML 后端保留标题与表格，可关闭渲染和资源下载。DOCX 根据样式和大纲级别识别标题。PDFium 后端读取文本单元和页面信息。项目暂无文档转换组件。Markdown/TXT 原生解析，HTML/DOCX 走 Docling，PDF 只提取文本层。高级格式解析在无网、无宿主挂载的容器内执行。 |
| 结构化分块与来源 | Docling Core `a8aa9dce1a80bee78bed991eb18ecbaa11bd6947`（2.107.1，MIT，根 LICENSE）。阅读 `docling_core/types/doc/document.py`、`docling_core/transforms/chunker/{hierarchical_chunker,hybrid_chunker}.py`。LlamaIndex `4937fc017cbf91d08c6beaadb790ae44745a87a1`（MIT，根 LICENSE）的 `llama-index-core/llama_index/core/node_parser/file/markdown.py` 与 `schema.py`。 | HierarchicalChunker 随标题层级更新路径，序列化保留文档节点和来源。HybridChunker 在结构元素处分段，按 token 大小拆分并合并匹配的段落。项目 TUI 已使用 Marked，Knowledge 使用相同版本识别 Markdown 结构。分块保留标题、可靠来源位置与前后关系。 |
| 去重、增量与删除 | 同版 LlamaIndex 的 `llama-index-core/llama_index/core/ingestion/pipeline.py`。 | 按 ref_doc_id 和 hash 对照，未变即跳过，更新时按文档替换相关节点。Pi Memory V3 的 vector-outbox/vector-sync 有持久重试和对账，但绑定 Memory 表及业务状态。Knowledge 应使用独立 SQLite 表保存原文件 hash、版本和 activeVersion，在向量写成功后切换，再异步清理。后续共用队列能力以稳定接口为前提。 |
| 向量过滤、同步与核验 | Qdrant `4ab6d2ee0f6c718667e553b1055f3e944fef025f`（Apache-2.0，根 LICENSE），`src/actix/api/{collections_api,query_api,update_api}.rs`、`lib/segment/src/types.rs`。Qdrant Client `e7101dc5baf4d3ce7d6321e1500311619aa95a99`（Apache-2.0，根 LICENSE），`qdrant_client/qdrant_remote.py`、`qdrant_client/http/models/models.py`。 | Collection 固定向量维度和距离，Point 按稳定 ID 更新，查询可带 payload filter，写操作可要求 wait。Memory V3 适配器已有 loopback 检查、等待确认、模型版本、过滤和清理操作，接口仍限定 Memory 类型、字段和生命周期。稳定后共享连接与同步实现，Knowledge 使用独立 Collection，结果回 SQLite 校验。 |
| 检索、工具与边界 | Pi `core/{agent-session.ts,extensions/{types,loader,runner}.ts}`，Enhanced `shared/config.ts`、`memory/{extension,project-scope,provider,runtime,semantic-search-adapter}.ts`、`context/{extension,runtime}.ts`、`sandbox/extension.ts`。 | 复用原生 session_start/shutdown、registerCommand 和 registerTool。关闭时隐藏工具并拒绝旧 handler。管理命令使用 Pi slash command，`enhanced-docs` 未被现有扩展占用。作用域沿用规范化项目根目录与 projectId，知识库存储另开目录。FTS5 复用词法检索能力，RRF 当前是 Memory 内部逻辑，需等共享接口。Context 使用原生 tool_result 观察和 context 压缩与分页。Sandbox 当前白名单不含 Knowledge 工具，保持现有权限。 |

K1 先接入默认关闭的 `modules.knowledge.enabled` 和 `/enhanced-docs status`，覆盖启停、异常配置、项目未信任、会话关闭。K2 完成 Document/Chunk 合同、授权根路径和显式递归、五种文档的解析、分块及独立测试。原始文件计算 hash，解析失败不给索引候选，结构块超限明确报错。K3–K6 需要稳定的 Embedding/Qdrant/同步接口。接入阶段需先验证部分提交、进程重启、删向量失败、模型切换、访问策略和模型外发。模型侧只读工具的结果在存储核验和披露授权之后返回。当前 K0 为源码审计，未执行功能测试，未启动服务或模型。

### K1–K2 交付与验证

| 阶段 | 改动和接口 | 测试结果与边界 |
| --- | --- | --- |
| K1 | `packages/pi-enhanced/package.json`、`extensions/knowledge.ts`、`src/knowledge/{config,extension}.ts` 和 `tests/integration/knowledge-lifecycle.test.ts`。新增 `modules.knowledge.enabled`、`createKnowledgeExtension` 和 `/enhanced-docs status`。 | 5 通过，0 失败，0 跳过。沿用 Pi 原生会话和 Enhanced 配置路径。当前状态命令不打开存储，工具生命周期在 K5 接入。 |
| K2 | `src/knowledge/{contracts,sources,markdown,parsers,chunking,ingestion}.ts`、`python/knowledge-parser/`、`tests/{unit/knowledge-ingestion.test.ts,integration/knowledge-docling.test.ts,fixtures/knowledge/}`、`README.md`、包依赖和 lockfile。新增 `KnowledgeDocument`、`DocumentChunk`、`discoverDocumentSources`、`prepareKnowledgeDocument`，以及解析/分块入口。 | 14 项原生导入与分块测试、4 项真实离线 Docling 测试全部通过。PDF 仅恢复文本层和页码，表格、代码缩进和章节的复杂布局仍可能丢失并附告警。分块按估算 token 控制大小，超长结构块直接报错。目录并发改名和替换的对抗测试待补。 |

K2 延用 K0 固定源码。实际转换使用 Docling 的 `InputDocument` 和声明式 HTML/DOCX 后端。直接使用后端可省去 Converter 全局导入的 OCR 和版面模型依赖。Docling Core 保留标题、列表、代码和表格结构并序列化为 Markdown。DOCX 序列化保留原始下划线以供后续精确检索。原生 Markdown 使用 [Marked 18.0.11](https://github.com/markedjs/marked/tree/53cb13f13fc13d433269248c5caa255ffa1361ee)（MIT，根 LICENSE，与 Pi TUI 使用版本相同）。

最终定向回归为 12 个测试文件，85 通过、0 失败、0 跳过，包含 K1–K2 的 23 项测试以及基线 Memory、Context、Task Manager、MCP Policy 和真实 Docker Sandbox 用例。独立测试关闭 Docling 时为 19 通过、0 失败、4 个 Docker 测试跳过。工作区 TypeScript、Knowledge 源码 Biome、npm 打包泄漏检查及 git diff --check 通过。首次在干净 worktree 执行需要补齐被 Git 忽略的模型目录清单。首次 Docling 测试发现 Converter 的可选依赖和字段转义问题，最终两项均已修正。基线 Memory 回归与另一个未提交工作区中的 Memory V3 回归分别记录，后者未运行。

范围内副作用只有独立 worktree、工作区依赖和模型目录清单、本地解析镜像及构建缓存。解析容器无网络和宿主挂载，测试后无残留容器。主工作区仍有 42 项历史删除。无暂存、提交、推送和付费模型请求，未修改其他模块或 Sandbox 权限。

K3–K6 待共享接口进入可引用的基线。Memory V3 为当前同基线的未提交改动，Qdrant 过滤字段和同步队列仍绑定 Memory 实体，Worker 生命周期仍由 Memory runtime 持有。接入后先用真实本机 Qdrant 验证版本激活、重试、清理、重建和跨模型迁移，再验证检索和披露策略。Knowledge 的 SQLite/Qdrant、FTS5/RRF、Agent 工具、增量管理、质量评估和 DeepSeek Flash 对照均未运行。旧 V3.3 未进入实现范围。

## Knowledge/RAG · K3–K6（2026-11-18）

Memory V3 原聊天已验收公共接口。此工作树按 SHA-256 核对后引入 `VECTOR_CONTRACT.md`、`src/shared/{embedding,vector}` 的三个公共 TS 文件，以及离线 E5 使用的 `python/memory-intelligence` 中四个配置和实现文件。它们与 Memory V3 worktree 字节一致。最终集成共用这组文件。Memory、Context、Task Manager、MCP 和 Sandbox 的模块实现均沿用本树基线。

| 阶段 | 改动、接口与参考实现 | 定向验证和边界 |
| --- | --- | --- |
| K3 | `src/knowledge/{store,vector,service,ingestion,sources,contracts}.ts`。新增 `DocumentStore`、`KnowledgeService`、`openDocumentIndex`。SQLite 权威存储含版本、分块、外发策略、审计和分块向量缓存。沿用 LlamaIndex 的来源 ID 与 hash 比较思路，使用本项目 SQLite 版本状态驱动重试。Qdrant 连接和批处理使用已验收的共享客户端。 | 测试首次导入、重复导入、更新、部分写入、重开重试、按模型 revision 重编码、源文件删除、失效屏蔽、迟到/孤立向量、集合重建及本机 Qdrant 停机重启。源路径身份跨项目和语料库隔离，切换到不同向量维度需要另行迁移集合。 |
| K4 | `store.ts` 的 FTS5，`service.ts` 的 Dense、RRF 与候选再核验，`vector.ts` 的文档 payload。参考 K0 的固定 Qdrant 源码和 Memory 已有的 FTS5/RRF。向量预筛当前版本、项目、语料库、文档和策略，返回前再查 SQLite。 | 中英文、精确路径/字段/错误码、同义改写、项目和访问策略在定向测试与评测中覆盖。词法默认开启，语义能力显式配置。Qdrant/E5 错误降级为当前 SQLite 词法结果。 |
| K5 | `src/knowledge/{config,extension,commands,tools}.ts`、`README.md`。使用 Pi 原生注册和现有项目作用域。命令为 `/enhanced-docs add/list/sync/remove/status`。Agent 只读工具为 `enhanced_docs_search/read`。 | 5 项配置与生命周期、1 项原生 Agent 循环/权限/输出、1 项包入口验证。默认 `local-only`，仅宿主读取。Agent 侧统一只读已确认外发的文档，覆盖会话中切换模型。旧 handler 在关闭时拒绝。Sandbox 工具许可仍由现有策略裁决。 |
| K6 | `tests/integration/knowledge-{index,qdrant,tools}.test.ts`、`fixtures/knowledge/vector-lab.ts`、`benchmarks/knowledge/{dataset,evaluate}.ts`、`tests/integration/p0-regression.test.ts`。使用固定版本 Qdrant 和 Memory V3 已预置的 E5 镜像。 | 真实 Qdrant 仅绑定回环端口，E5 容器无网络，只读挂载 Worker 源码。测试使用临时 SQLite、唯一本地集合、容器和卷。保留可单独执行的无网基础测试。真实模型 Agent 修复能力另做受控对照。 |

文档版本只有向量完整可用后才激活。已撤销的权限立即在 SQLite 生效。正在索引和已退役的版本即使还存有远程 Point，也不能进入 Agent 输出。清理与修复只能操作当前项目的向量。词法模式下停用 Qdrant，旧向量待恢复向量模式后清理。当前没有与独立 V3.1/V3.2 worktree 合并后的联合结果。

### 可复现评测

`docs-v1` 包含 API、配置、架构、错误码、排障与发布等 8 个文档，共 15 个片段。人工标注 14 个查询，其中 12 个有相关结果，其余两个检查外发权限和语料库过滤。每个查询重复 3 次。下表为本机 Docker 结果。

| 模式 | Recall@5 | MRR@5 | 作用域误命中 | p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| FTS5 | 75.0% | 0.750 | 0 | 0.34 / 0.70 ms |
| Dense | 100.0% | 0.850 | 0 | 18.91 / 57.09 ms |
| Hybrid | 91.7% | 0.833 | 0 | 19.29 / 55.63 ms |

首次 passage 编码含模型启动约 5.43 s，查询编码中位数 14.02 ms。重复导入 p50/p95 为 4.11/5.77 ms。SQLite 约 120 KiB，独立 Qdrant 数据目录实际分配约 2.67 MiB，逻辑文件大小约 674 MiB（含预分配文件）。Qdrant 和 E5 内存单点采样约 137.8 和 604.7 MiB。原始结果位于 `.artifacts/knowledge/evaluation-docs-v1.json`，包含逐查询真值和命中。小样本仅说明该语料上的表现。

常用复现命令从仓库根目录执行。E5 测试镜像来自 Memory V3 的 `fixtures/memory-v3/Dockerfile.e5`，权重预置与依赖说明见 `VECTOR_CONTRACT.md`。

```powershell
npm run build:offline
docker build --tag pi-enhanced-knowledge-parser:2.92.0 packages/pi-enhanced/python/knowledge-parser
$env:PI_ENHANCED_KNOWLEDGE_DOCLING='1'
$env:PI_ENHANCED_KNOWLEDGE_QDRANT='1'
$env:PI_ENHANCED_RUN_EXTERNAL_MCP='0'
$env:PI_ENHANCED_RUN_SERENA_DOCKER='0'
node node_modules/vitest/dist/cli.js --run packages/pi-enhanced/tests/unit packages/pi-enhanced/tests/integration packages/pi-enhanced/tests/e2e --exclude '**/.artifacts/**' --maxWorkers=1 --testTimeout=30000
node packages/pi-enhanced/benchmarks/knowledge/evaluate.ts
```

### DeepSeek Flash 端到端计划

另行得到模型调用授权后，固定同一代码基线、模型、预算和初始任务，为 RAG 开关各运行相同任务。用两个带公开或已授权合成文档的任务，分别验证精确 API/配置字段查找和跨语言故障定位。先验证选定的评测入口在现有 Sandbox 和 Gateway 规则内允许原生只读 Knowledge 工具。每组记录测试是否通过、引用是否正确、工具调用、Token、费用和耗时。以固定测试判定代码修复，逐例保留失败和权限拒绝。

### 验收记录

- Knowledge 定向回归覆盖 16 个文件，93 通过、0 失败，其中 Knowledge 自身为 30 项。关闭两个 Docker 测试开关后，独立运行 Knowledge 为 25 通过、0 失败、5 条按配置跳过。K3 的最后一轮 real Qdrant 使用已构建的 Docker 镜像与 384 维离线 E5，验证集群丢集合后依据 SQLite 补齐 Point。K5 的最后一轮补验了真实截断分支和 Pi 原生 Agent 工具循环。
- 完成离线构建后，从包目录进行的全量回归为 371 通过、2 失败、41 跳过。两条失败的 Task 崩溃恢复和评测遥测夹具都把仓库根目录当作 cwd。从仓库根目录单独复跑这两个测试文件，17 项全部通过，覆盖原来失败的两项。原始回归和复跑分别保留在 `.artifacts/knowledge/enhanced-regression-final.json` 与 `.artifacts/knowledge/root-cwd-recheck.json`。
- TypeScript（工作区及 Knowledge 测试/评测）、Knowledge Biome、离线构建、打包泄漏、Python 基线 15 项和 `git diff --check` 均通过。核对共享依赖的 8 个文件与 Memory V3 原工作树散列一致。原仓库仍有 42 项历史删除，Git 暂存区为空。
- 实际试验使用本机 Qdrant 和无网 E5/Docling 容器，测试容器、卷和临时运行目录已回收。构建镜像、公开源码缓存和忽略的测试证据保留。真实 DeepSeek Flash 对照待单独授权。

## Knowledge 文档撤权修复（2026-11-18）

原验收在同一会话撤权后两次观测到历史 ToolResult 仍向 Stub 外发 52 字节。修复后，新 Knowledge 工具结果只留下语料库、文档、修订、片段与授权引用。旧正文和旧摘要仍保留在本地会话审计。模型、路由和摘要各入口共用会话的披露策略。普通请求在组装时从 SQLite 重建允许外发的片段，并在支持校验的传输每次交接前复核。来源不明的压缩、恢复、改写内容按相关上下文处理。撤权先于准入时，已组装正文被丢弃，后续重试重新投影。准入记录只表示交接获准，被接收的请求无法撤回。

最终冻结源码、复现脚本、请求字节记录、定向和全量测试证据位于 `.artifacts/revocation-fix/`，汇总见同目录下的 `REVOCATION_FIX_REPORT.md`。

## P0 独立复验与 V3 联合验证（2026-11-18）

从 SHA-256 为 `ca3e14cd0b2b487ce29feba13f67edb33c59b16099638d011518127d62083186` 的撤权修复包恢复独立副本。原样 B1-04 的两条回环 HTTP 请求中撤权标记 0 次、0 字节。B1-03 按新引用格式读出原 Chunk ID，撤权后检索无结果，旧 ID 被拒绝。原独立 QA 树未修改。

合入最终 `v3.1.patch` 和 `v3.2.patch`。V3.1 补接证据确认所需的 SQLite 事务入口。V3.2 按已脱敏的原始日志生成有界诊断预览，原文恢复保留 Knowledge 来源检查。受信任 Sandbox 另有只读 Knowledge 开关，默认不启用。

B4 使用 Faux 与真实无网 Docker pytest。先读取任务和 Memory、运行失败测试并保存暂停检查点。重开会话后确认恢复不重放工具，随后检索 Knowledge、编辑源码、重跑并用有效的 pytest 证据完成任务步骤。两个 Sandbox 审计均完成。

DeepSeek Flash 对照使用两道合成任务，每题的 RAG 开关组都能读取同一份参考资料。请求通过回环预算 Gateway，验证使用无网 Docker。所有输入、源码包、逐项测试及可用的模型结果见 `.artifacts/v3-joint/`。

## E18 · 只读验证与生产预算协同（2026-11-20）

独立工作树 `F:/p18-9f44` 基于 E17 冻结源码 `83d1c66e4b3eed10d5bd2071c6b656c9cce40d299e6536d1d3d9556dffb5aff9`，开工前逐文件校验 2,388 个路径。E17 真实账本和 E15 冻结题集作为只读输入。E18 只运行离线重放、Stub、工程回归和真实 Docker 判分。

生产 Sandbox 支持执行宿主批准的默认 pytest 目标。Task 用真实调用、沙箱收据和当前工作区快照核对完成条件。生产 Memory 的模型工具增加短语回退，继续按原权限复查。生产 Context 接受宿主提供的网关预检和状态，支持预算不足时缩减工具及上下文、优先安排验证和文字收尾。E18 恢复子进程使用相同的运行时策略和原预算账本。

统一交付目录为 `.artifacts/agent-evaluation/e18/`。下一轮真实 E15 对照等待单独授权，包括任务范围和全局费用。冻结题目、测试与判分口径继续沿用。

## E20 · 任务预算档位（2026-11-20）

基于封存的 E19 源码，在独立工作树 `F:/p20-9f44` 增加 Economy 20K、Standard 25K 和 Premium 30K。普通 CLI 的原生 DeepSeek Flash 请求、生产 AgentSession 和受控 Runner 复用本地 Gateway。普通 CLI 绑定 Task 时使用该 Task 的预算账本，无绑定时使用会话账本。恢复沿用原档、用量和截止时间，开工后改档须由宿主明确确认。

E19 已完成 18 个真实单元，20K 端到端 6/9，25K 7/9。本轮预算档位开发仅使用本地 Stub 和无网验证。Premium 暂无独立真实模型对照。源码交接和回归证据位于 `.artifacts/e20/`。

## V4 MA-1 · 本地多 Agent

独立工作树 `F:/pma1-b169`，分支 `feature/ma1-local-multi-agent`。基线为 PR #3 已核验提交 `b16917ec793dc801d979759d2d6d4ca3e3e76972`，集成时需要保留该 PR 的 CI-1 修复。

通过可选 `/enhanced-multi` 启用独立 Code/Test Session。Coordinator 使用现有 Task SQLite 写入委派、操作 ID、工作区版本和 Docker pytest 收据，两个 Session 复用一个持久预算 Gateway。恢复从已落盘的阶段继续，写入已发生但委派无法确认时保留待核验。源码入口与验证命令见 Pi Enhanced README。验收证据集中在 `.artifacts/ma1/`。

首次 Windows 包级串行运行发现入口扫描把 MA-1 算成默认扩展。入口已移至 `packages/pi-enhanced/src/multi-local/extension.ts`，仅在显式加载时注册命令。首次运行与修复后的完整运行分别记录。

## V4 MA-2 · A2A Test Agent

`F:/pma2-b169` 的 `feature/ma2-a2a` 以同一提交和 11 个已验收的 MA-1 文件为基线。MA-1 的源码覆盖层散列为 `74ee77506e45e15edb484d50b95894aa8041c1791c146af2b9348891fd40291b`。

使用 A2A 1.0 JSON-RPC 的独立 Test Agent 进程，启动、提交、轮询和取消走官方 TypeScript SDK。远端任务映射和经验证的 Artifact 保存在同一项目 Task SQLite 里。Coordinator 持久化委派与映射，共用 MA-1 的测试逻辑和父任务预算。验收产物位于 `.artifacts/ma2/`。

## V4 最终集成

`feature/v4-integration` 基于远端 `main` 的 `ded9691b162644811db2deec648f0a57e5fd7e36`，按 PR #3 撤权夹具、MA-1、MA-2、MA-3 的顺序逐文件整合。启动及权限、预算、恢复说明见 `packages/pi-enhanced/docs/v4-architecture.md`。MA-3 的 11 个有效真实结果与 7 个鉴权失败记录已封存。最终集成回归仅使用本地 Stub、无网构建和 Docker，验收证据集中在 `.artifacts/v4-integration/`。

V4 发布前补充同一服务的角色模型配置。`multiAgent.code`、`multiAgent.test` 从可信用户配置读取，任务快照保存模型 ID、能力和费率。Gateway 按实际模型分别计价，两个角色沿用同一个父任务账本。角色模型验证使用本地 Stub，证据位于 `.artifacts/v4-role-models/`。


## V4 后续功能本地开发

- 工作树 `F:/pv4-next`，分支 `feature/v4-local-evaluation`，基线 `6745f0f09126c3298995b36b8e300737a6f0e58f`。
- 本轮在本地完成 Memory 消融、可选 Knowledge CPU 重排、Auto Dream 候选/审批/复核及 CCR 共享 Gateway 的 Stub 验收。RAG 两种留出集均退化，默认维持关闭。
- 用户将当前范围限定为本地功能开发。有效 MA-3 单元、7 个鉴权失败和原账本保留。实际模型调用 0 次，CCR 普通启动器与共享费用硬限入口尚待接线核验。
- 本轮证据见 `.artifacts/v4-next/report.md` 与 `.artifacts/v4-next/results.json`。保留的离线模型在同目录 `model/`，启用要求见模块文档。
- Windows 包级回归 543/0/57，真实 Docker 联合定向 141/0/2，Linux 无网定向 114/0/2。计数依次为通过、失败、跳过。


## CCR 普通启动入口的共享预算

- `scripts/ccr.mjs` 为固定 Flash、固定 Pro 和自动模式加载同一预算入口。自动模式在可信用户目录的 SQLite 账本上允许 Flash 与 Pro，两者按各自费率计价，沿用原 Token、费用、请求次数与截止时间。
- 普通 CLI 使用本地 HTTP Stub 验证启动；实际 AgentSession 与 Docker pytest 跑通两次 Flash 修复失败、确认升级、Pro 修复并复测通过。升级前 4 次请求、490 Token、$0.000219，收尾时同一账本 7 次请求、868 Token、$0.00087636，截止时间相同。额度用尽时剩余请求在上游发送前拒绝。
- 单独验证切换后的 Token、费用、截止时间拒发，校验请求体的模型 ID，验证加载后从环境移除鉴权令牌。使用 Stub，无实际费用。本轮仅修改 `F:/pv4-next`。
- CCR 启动器、预算恢复、Gateway、Memory/Knowledge 撤权和 Docker pytest 定向回归共 117 通过、0 失败、2 跳过。TypeScript、打包和 Git 差异检查通过。


## CCR 3.1.3 实际联调

- 在隔离目录安装真实 CCR 3.1.3，唯一上游指向本机 HTTP Stub。用终端启动 `scripts/ccr.mjs --strategy auto`，通过实际弹窗批准 Pro。运行 `ccr-313-e2e-a498c0d9`，Docker pytest 退出码 1、1、0，Pi 启动器正常退出。
- 已核对真实 CCR 返回裸模型 ID。Gateway 只允许各模型配置中的对应 ID，保留错模型拒绝和保守结算。用量透传 728 输入、140 输出 Token，7 次请求中 4 次 Flash、3 次 Pro，累计 Stub 费用 $0.00087636。切换前后的账本 ID、25K Token、$0.03、8 请求额度与原 180 秒截止时间相同。
- 本轮证据为 `.artifacts/v4-next/ccr-313-e2e.json`，包含启动、协议探针、账本、pytest 和容器事件。Gateway、启动器和预算恢复 70/70 定向通过。真实付费调用 0 次。
- Memory 和 Knowledge 的 HTTP 撤权回归 32 通过、0 失败、2 个夹具跳过。TypeScript、打包和差异检查通过。


## CCR 真实模型 9 单元对照

- 按任务先后运行 `page-buckets`、`meter-adapter`、`record-revision`，每题固定 Flash、固定 Pro 和自动模式各一次。统一 25K、8 请求、180 秒、单次输出 512、单元 $0.03。九个不可重复使用的预留槽合计 $0.27，物理发送前核验槽、同一会话账本、截止时间及请求序号。
- 共 29 次真实请求，26 次回传可核验用量共 62,455 Token，3 次连接超时用量未知。累计 Gateway 保守结算 $0.06219306，未知请求按所在单元全额预留时累计 $0.13941606。固定 Flash、固定 Pro、CCR 自动模式的端到端完成数分别为 2、0、0，独立 Docker 断言分别为 5/6、6/6、4/6。自动模式实际升级 0 次。
- 三组使用同一工具集合。record-revision 通过项目内文件提供原现行合同。隐藏测试由 E15 原有独立 Docker 判分函数执行。额外费用拒发 3 次、Token 拒发 1 次。所有测试容器已退出。结果与逐请求账本见 `.artifacts/v4-next/ccr-live-comparison.json`，离线预检见同目录 `ccr-live-preflight.json`。付费阶段结束。

## V4 最终源码冻结与独立验收

候选标识为 `pi-enhanced-v4-freeze-2026-11-22-6745f0f0`。工作树 `F:/pv4-next` 位于 `feature/v4-local-evaluation`，基线 `6745f0f09126c3298995b36b8e300737a6f0e58f`。PR #4 已合入远端 `main`，远端在冻结时指向 `c13a281b24738a122eebab19917141a7e06858c6`。此候选保留本地基线与经过核验的工作树增量。

冻结报告和带工作树增量的 SHA-256 清单位于此工作树的 `.artifacts/v4-freeze/`。独立验收从清单的基线 Git 对象重建候选，核验全树散列，在新目录使用本地 Stub、Docker 和单独的数据库、端口及缓存运行测试。启动方式见 [Pi Enhanced README](packages/pi-enhanced/README.md) 和 [V4 架构手册](packages/pi-enhanced/docs/v4-architecture.md)。

默认运行 `single`。本地和 A2A 协作显式启用，角色模型共用父预算。RAG 重排默认关闭。Auto Dream 从已完成任务的已验证文件证据产生候选，保存与审批单独确认，来源失效后停止使用。CCR 的安全重试、人工确认、预算继承和 Docker 闭环已用 Stub 验证。最后一次真实 `resume` 烟测中 Flash 修复成功，有效 pytest 失败为 0，实际 Pro 调用为 0。

历史 CCR 原始证据位于 `.artifacts/v4-next/`。MA-3 文档保留 11 个有效单元与 7 个 HTTP 401 的历史统计；旧 `F:/pma3-b169` 工作树在冻结检查时已不在磁盘登记目录。这批原始结果和网关账本的归档缺口见冻结报告。

## 开发与 PR 目标分支

后续 Pi Enhanced 开发以最新的 `origin/pi-agent` 为基线。在独立工作树创建功能分支，PR 的目标分支统一选择 `pi-agent`。`main` 的历史合并仅用于追溯。
