# Knowledge/RAG 混合检索评测

生产 Hybrid 保留现有等权 RRF。开发集和固定集支持继续调查按查询形态排序，但独立验证集中该方案与基线在四项主要质量指标上持平。

## 数据与指标

| 数据集 | 文档 | 查询 | 有相关片段 | 多相关片段 |
| --- | ---: | ---: | ---: | ---: |
| `docs-v1` | 8 | 14 | 12 | 0 |
| `rag-ranking-dev-v1` | 23 | 21 | 14 | 3 |
| `rag-ranking-holdout-v1` | 23 | 21 | 14 | 3 |

固定集保持原标注。开发集和验证集各自有独立文档、查询和合成干扰段落。每条正例按文件和章节人工标注。评测导入后解析实际 `documentId`、`chunkId`、版本及行号，无法唯一解析时终止。当前 `documentId` 由项目、语料库和绝对源路径计算，因此不同临时目录的物理 ID 会变化。每次评测 JSON 均附本次对应的标注、物理 ID 和输出列表。

Recall@K 以相关 Chunk 为单位，按正例宏平均。MRR@5 取第一个相关 Chunk 的倒数排名。Precision@5 以 5 为分母，另报多相关场景。无相关文档的公开负例报告返回数。越权命中单独计数，并令评测失败。引用准确率用实际 Knowledge 输出投影核对 Chunk、文档、版本、语料库、标题路径和源位置。该指标用于核对引用指向，不评判模型回答。

导入文档已加载 E5 模型。每个方案随后测量三次，并轮换运行顺序。耗时覆盖候选查询、排序和末端 SQLite 核验，排除引用投影和 JSON 序列化。评测通过生产语义入口取得实际 Qdrant 响应，同时重读完整候选以记录诊断，其中包含额外的 SQLite 读取成本。候选数量报告每路实际返回数、请求深度及并集。宿主内存为同进程 RSS 每查询采样和峰值，Qdrant 和 E5 为独立 Docker Stats 快照。

项目隔离使用同一 Qdrant 集合中的另一项目，语料库隔离包含同标题文档。不可见样本包括 local-only、已撤权、已删除和被新版本替换的记录。评测明确把已删除及被替换的旧向量留在 Qdrant，验证活跃版本和最后读取仍受 SQLite 控制。查询只有当前版本可见时，返回当前版本不记作权限越界。

## 方案

| 方案 | 行为 |
| --- | --- |
| A | 每路 40 条候选，按 `1 / (60 + rank)` 等权融合，最后取 5 条。评测逐查询核对生产基线的 Top 5 和分数。 |
| B | 每路请求 80 条，沿用 A 的融合与截断。 |
| C | 对语义路的 RRF 贡献乘以开发集权重。从 0.5、1、2、4、8、16、32 选择。 |
| D | 先保留每份文档排名最高的 Chunk，再按原名次补足。 |
| E | 自然语言优先用语义排序，语义无候选时用词法。识别到 API 路径、函数、错误码或带分隔符的标识符时，在等权 RRF 候选上按完整标识符的命中数排序。 |

本项目运行 Qdrant `v1.15.5`，镜像摘要为 `sha256:0fb8897412abc81d1c0430a899b9a81eb8328aa634e7242d1bc804c1fe8fe863`。参考了官方预取、融合、按文档分组和重排序的分阶段设计，以及 `v1.15.5` 的 RRF 源码。Qdrant 该版本的默认常数为 2，本项目保持现有 1-based 名次和 (k=60)。当前文档的可调 `k` 和服务端加权接口分别从 1.16 和 1.17 提供，本次用 TypeScript 在现有授权候选上做实验。FTS5 留在 SQLite，E5 调用现有 Qdrant 向量检索。没有引入服务端新接口或复制上游源码。Qdrant 源码采用 Apache-2.0。[Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/) · [v1.15.5 RRF](https://github.com/qdrant/qdrant/blob/v1.15.5/lib/segment/src/common/reciprocal_rank_fusion.rs) · [许可证](https://github.com/qdrant/qdrant/blob/v1.15.5/LICENSE)

扩大候选池能让更多片段进入融合，也会增加向量返回和 SQLite 验证成本。分组有助于让多个文档出现在第一页，但可能挤出同一文档的第二条正确证据。精确标识符和自然语义采用各自有优势的检索信号。交叉编码器对每个候选另做推理，可以改善相关性排序，也会增加 CPU、内存和尾延迟。本次评测 E 的完整标识符排序，未运行交叉编码器。[Qdrant 重排序测试与适用条件](https://qdrant.tech/documentation/search-tuning/when-a-reranker-is-worth-it/)

## 复现顺序

先完成仓库的离线构建。以下命令在 `packages/pi-enhanced` 运行，使用预置的 Qdrant 与离线 E5 镜像，Docker 仅使用本次生成的资源名。

```powershell
node --experimental-strip-types benchmarks/knowledge/retrieval-eval.ts legacy > legacy.json
node --experimental-strip-types benchmarks/knowledge/retrieval-eval.ts dev > development-grid.json
$weight = node --experimental-strip-types benchmarks/knowledge/select-retrieval.ts weight development-grid.json
node --experimental-strip-types benchmarks/knowledge/retrieval-eval.ts dev $weight > development.json
node --experimental-strip-types benchmarks/knowledge/retrieval-eval.ts legacy-compare $weight > fixed.json
node --experimental-strip-types benchmarks/knowledge/select-retrieval.ts lock development.json fixed.json > selection.json
node --experimental-strip-types benchmarks/knowledge/retrieval-eval.ts holdout selection.json > holdout.json
node --experimental-strip-types benchmarks/knowledge/select-retrieval.ts verify development.json holdout.json selection.json
```

先在开发集选定权重，以固定集检验原回归。然后封存开发集、固定集和实验源码指纹。验证集只运行基线、锁定的候选和两个单路对照。程序的 `verify` 判断候选是否满足验证集不退化门槛。实际发布决策还需要独立集显示质量收益。

## 本轮结论

- 固定集的损失来自正确 Chunk 在向量侧第 5、词法侧缺席。融合前五都由两路同时命中的候选占据，正确 Chunk 降到第 10。
- 开发集候选加倍没有改善质量。文档分组降低了多相关场景的 Precision@5。语义权重 32 提升了开发集 Recall@5，同时降低了 Recall@1，且固定集仍然漏召回。
- E 将固定集 Recall@5 从 91.67% 提升到 100%，将开发集从 75.00% 提升到 92.86%。独立集 A 与 E 的 Recall@1 为 82.14%、Recall@5 为 92.86%、MRR@5 为 92.86%、多相关 Precision@5 为 40.00%。两种方案各对两条无关的公开查询返回了五条可见文档。独立集没有出现权限越界。
- 新增评测入口、双数据集和回归测试可独立集成。生产排序和工具接口保持原样。后续独立样本应增加跨语言、真实长文档和同标题文档查询，并单独评估无答案识别。

## K7 候选与证据状态

`enhanced_docs_search` 仍可用原参数搜索相似片段。模型投影附带 `evidenceStatus`，每条结果标记为 `candidate` 或 `exact-reference`。只有明确的代码标识符、错误码、函数或 HTTP 路径查询，且所查文字完整出现在同一段可见摘录时，才标记为精确引用。系统确认的是原文位置，仍需阅读正文核对事实、适用条件和版本。

| 状态 | 含义 |
| --- | --- |
| `supported` | 可见的返回结果包含至少一条精确引用。 |
| `insufficient-evidence` | 找到了候选，当前规则无法确认精确引用。自然语言改写、跨语言及多段推理也可能处于此状态。 |
| `no-candidates` | 当前授权范围内没有可用候选。 |
| `backend-unavailable` | 请求的后端不可用，转为 FTS5。若仍有候选，继续返回并给出 `fallback` 原因。总检索失败沿用工具错误。 |

调用方可显式传 `evidenceOnly: true`，只看含有精确引用的摘录。默认返回授权候选，保留探索式检索与 `enhanced_docs_read`。模型读取历史引用时按当前权限和版本重新判定，有效摘录减少后会随之改变状态。旧历史的证明字段缺失时按普通候选处理。

现有评测入口新增 `k7 fixed|dev|holdout|challenge`。它复用相同的三次采样、语料导入、作用域验证和引用检查，额外采集默认工具投影与显式证据模式的差异。独立挑战集包含共享关键词、近义但事实缺失的负例，以及两个跨语言方向和多片段正例。评测结果统一保存在任务的 `.artifacts/rag-k7-k9/results.json`。此前已封存的源码和评测结果用于复现上轮选择。

## 可选本地重排

默认继续使用等权 RRF。受信任的项目可以设置 `modules.knowledge.rerank: true`，且检索模式必须为 `hybrid`。例如，在配置文件中加入以下设置。

```json
{
  "modules": {
    "knowledge": {
      "enabled": true,
      "mode": "hybrid",
      "rerank": true
    }
  }
}
```

宿主通过 `PI_KNOWLEDGE_RERANK_MODEL_DIR` 指向预先下载的权重目录。模型为 [multilingual MiniLM v2](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/tree/1427fd652930e4ba29e8149678df786c240d8825)，Apache-2.0，固定 revision `1427fd652930e4ba29e8149678df786c240d8825`。目录需包含 `config.json`、`model.safetensors`、`sentencepiece.bpe.model`、`special_tokens_map.json`、`tokenizer.json` 和 `tokenizer_config.json`，约 493 MB。Worker 启动时校验六个文件的 SHA-256。`PI_MEMORY_V3_E5_IMAGE` 沿用本地 Memory CPU 镜像配置，默认 `pi-memory-v3-e5:local`。已验证版本为 PyTorch 2.7.1+cpu、Transformers 4.57.6。

重排进程只使用宿主的本地 Docker 命名管道或 Unix socket，在断网容器运行，限制为 2 核、1536 MiB、1 个并行推理，每次至多 12 个候选。模型启动上限 12 秒，推理请求上限 1.5 秒。进程解析失败、超时或繁忙时沿用原 RRF 顺序。服务在重排前按查询范围筛选候选，重排结束后再次检查权限和文档版本。现有引用和充分证据判定保持原规则。

在 `packages/pi-enhanced` 下运行以下命令。三个分组分别记录，留出集结果不用于调参。

```powershell
node --experimental-strip-types benchmarks/knowledge/retrieval-eval.ts rerank dev
node --experimental-strip-types benchmarks/knowledge/retrieval-eval.ts rerank holdout
node --experimental-strip-types benchmarks/knowledge/retrieval-eval.ts rerank docs
```

`docs` 使用本仓库 README、V4 架构手册和 Memory V3 手册的真实段落，逐题标注对应标题。评测还保留原有带项目、corpus、撤权和版本负例的数据集。
