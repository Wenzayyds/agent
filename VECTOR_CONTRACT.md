# 本地 Embedding 与向量索引契约

Memory 和 Knowledge 各自加载配置。两个公共模块可以直接导入，构造函数也不会启动 Worker 或访问 Qdrant。Knowledge 可在 Memory 关闭时独立使用此接口。

## 导出与签名

相对 `packages/pi-enhanced` 的源码导入路径如下。类型从各自模块导入。

- `src/shared/embedding/e5.ts` 导出 `EmbeddingProvider`、`EmbeddingModel`、`E5EmbeddingProvider`、`createLocalEmbedding`、`MULTILINGUAL_E5_SMALL` 和 `E5_BATCH_LIMIT`。
- `src/shared/vector/qdrant.ts` 导出 `VectorIndex<P>`、`VectorWrite<P>`、`IndexedPoint<P>`、`VectorFilter`、`VectorCondition`、`QdrantIndex<P>`、`QdrantIndexOptions<P>`、`QdrantError`、`QdrantErrorCode` 和 `QDRANT_BATCH_LIMIT`。

```ts
interface EmbeddingModel { id: string; revision: string; dimensions: number }
interface EmbeddingProvider {
	readonly model: EmbeddingModel;
	encode(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]>;
}
function createLocalEmbedding(options?: Partial<PythonWorkerClientOptions>): {
	embedding: EmbeddingProvider;
	close(): Promise<void>;
};

interface IndexedPoint<P extends object> { id: string; payload: P }
interface VectorWrite<P extends object> extends IndexedPoint<P> { vector: readonly number[] }
interface VectorIndex<P extends object> {
	ensure(): Promise<void>;
	upsert(points: readonly VectorWrite<P>[]): Promise<void>;
	delete(ids: readonly string[]): Promise<void>;
	search(vector: readonly number[], options: { limit: number; filter?: VectorFilter }):
		Promise<(IndexedPoint<P> & { score: number })[]>;
	scroll(options?: { limit?: number; cursor?: string; filter?: VectorFilter }):
		Promise<{ points: IndexedPoint<P>[]; cursor?: string }>;
	get(ids: readonly string[]): Promise<IndexedPoint<P>[]>;
}
```

`QdrantIndex` 构造参数为 `endpoint: string`、`collectionName: string`、`dimensions: number`、`parsePayload: (value: unknown) => P`，可传 `timeoutMs: number` 和 `payloadIndexes: Readonly<Record<string, "keyword" | "integer" | "bool" | "float">>`。Filter 通过请求体传递，支持 `must`、`should`、`must_not`、`match.value/any/except`、数值 `range`、`is_empty`、`has_id` 和嵌套 Filter。每批最多 128 条，默认每次请求 2000 ms。传入小写 UUID，写入等待确认，重放同一 UUID 可覆盖同一个 Point。获取不存在的 ID 返回空数组，scroll 无下一页时不返回 cursor。

E5 固定为 `intfloat/multilingual-e5-small`，revision 为 `614241f622f53c4eeff9890bdc4f31cfecc418b3`，输出 384 维。每批 1–32 条，每条最多 8000 个 Unicode 码点。Python 在 CPU 上使用 `query:` 或 `passage:` 前缀编码并归一化。宿主用 `PI_ENHANCED_MEMORY_PYTHON` 指定 Python，用 `PI_ENHANCED_MEMORY_MODEL_CACHE` 指向预置缓存，两个覆盖值均为绝对路径。默认缓存位于用户目录的 `.cache/huggingface/hub`。离线 Worker 启动失败时不会下载模型。

`createLocalEmbedding` 每次创建独立进程的所有者，按首次请求惰性启动。模块可以共用模型缓存。释放时调用本模块的 `close()`。已有宿主可以用 `new E5EmbeddingProvider(() => worker)` 借用 Worker，由调用方负责关闭。公共 Worker 类型与实现从 `src/shared/embedding/python-worker-client.ts` 导入。Memory 中原有导出路径继续可用。

## 独立使用

```ts
import { randomUUID } from "node:crypto";
import { createLocalEmbedding } from "./src/shared/embedding/e5.ts";
import { QdrantIndex } from "./src/shared/vector/qdrant.ts";

interface Payload { schemaVersion: 1; document: string }
const local = createLocalEmbedding();
const index = new QdrantIndex<Payload>({
	endpoint: "http://127.0.0.1:6333", collectionName: "pi_enhanced_docs_v1",
	dimensions: local.embedding.model.dimensions, payloadIndexes: { document: "keyword" },
	parsePayload(value) {
		const item = value as Partial<Payload> | null;
		if (item?.schemaVersion !== 1 || typeof item.document !== "string") throw new TypeError("Invalid payload");
		return { schemaVersion: 1, document: item.document };
	},
});
try {
	await index.ensure();
	const id = randomUUID();
	const [vector] = await local.embedding.encode(["Deployment requires approval"], "passage");
	await index.upsert([{ id, vector, payload: { schemaVersion: 1, document: "release.md" } }]);
	const [query] = await local.embedding.encode(["Who approves a release?"], "query");
	const hit = await index.search(query, { limit: 5, filter: { must: [{ key: "document", match: { value: "release.md" } }] } });
	await index.delete([id]);
} finally {
	await local.close();
}
```

Mock 实现可实现 `VectorIndex<Payload>`，使用 Map 保存 UUID 到 payload，按测试需要实现 `search`、`scroll` 与异常。真实加假服务的合约测试位于 `tests/integration/memory-vector-contract.test.ts`。

## 所有权、兼容性与异常

Memory 集合默认 `pi_enhanced_memory_v3`，继续使用已有的项目、Memory ID、修订、模型版本编码。Knowledge 使用独立的 `pi_enhanced_docs_v1`，建议以业务主键、文档修订、分块序号和模型版本生成稳定 UUID，并在 payload 中独立登记 schema version。创建后按集合固定维度和距离，遇到不兼容 schema 直接报错。业务方负责应用自己的可见性与权威数据复核。

Qdrant 仅接受显式本机 HTTP origin。错误对象包含 `code`，HTTP 错误另有 `httpStatus`。停机和拒绝连接为 `qdrant-unavailable`，超时为 `qdrant-timeout`，429 为 `qdrant-rate-limited`，401/403 为 `qdrant-permission-denied`，写入确认与响应或 payload 校验失败为 `qdrant-invalid-response`。Qdrant 故障由业务调用方降级。Memory 继续使用 SQLite 复核及 FTS5 回退。E5 通过 `MemoryWorkerError.code` 报告 `model-not-installed`、`invalid-payload`、`invalid-response` 和已有进程错误。

集成只需要公共 TS 源码及现有 Python Worker，使用 Node 内置 HTTP，无新增 npm 依赖。保留现有配置与 Python extras。合并时检查发布范围是否包含这一对公共目录和现有 Worker。

```powershell
$env:PI_MEMORY_V3_DOCKER = '1'
npm run test --workspace @wz-agent/pi-enhanced -- memory-vector-contract memory-v3-docker python-worker-client
```
