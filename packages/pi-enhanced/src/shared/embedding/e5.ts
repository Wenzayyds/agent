import type { MemoryWorkerClientLike } from "./python-worker-client.ts";
import { MemoryWorkerError, PythonMemoryWorkerClient, type PythonWorkerClientOptions } from "./python-worker-client.ts";

export interface EmbeddingModel {
	id: string;
	revision: string;
	dimensions: number;
}

export const E5_BATCH_LIMIT = 32;

export const MULTILINGUAL_E5_SMALL: Readonly<EmbeddingModel> = Object.freeze({
	id: "intfloat/multilingual-e5-small",
	revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
	dimensions: 384,
});

export interface EmbeddingProvider {
	readonly model: EmbeddingModel;
	encode(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]>;
}

export class E5EmbeddingProvider implements EmbeddingProvider {
	readonly model = MULTILINGUAL_E5_SMALL;
	private readonly worker: () => MemoryWorkerClientLike;

	constructor(worker: () => MemoryWorkerClientLike) {
		this.worker = worker;
	}

	async encode(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]> {
		if (
			!["query", "passage"].includes(purpose) ||
			texts.length < 1 ||
			texts.length > E5_BATCH_LIMIT ||
			texts.some(
				(text) => typeof text !== "string" || !text.trim() || [...text].length > 8000 || text.includes("\0"),
			)
		)
			throw new MemoryWorkerError("invalid-payload", "Invalid E5 batch");
		const { model, vectors } = await this.worker().request("encode_e5", { texts, purpose });
		if (
			!matchesModel(model, this.model) ||
			!Array.isArray(vectors) ||
			vectors.length !== texts.length ||
			!vectors.every(
				(vector: unknown) =>
					Array.isArray(vector) &&
					vector.length === this.model.dimensions &&
					vector.every((value: unknown) => typeof value === "number" && Number.isFinite(value)),
			)
		)
			throw new MemoryWorkerError("invalid-response", "E5 returned invalid vectors or a different model");
		return vectors;
	}
}

// Each consumer owns its worker. The cache path is shared without sharing process lifetime.
export function createLocalEmbedding(options: Partial<PythonWorkerClientOptions> = {}): {
	embedding: EmbeddingProvider;
	close(): Promise<void>;
} {
	const worker = new PythonMemoryWorkerClient({ startupTimeoutMs: 15_000, requestTimeoutMs: 20_000, ...options });
	return { embedding: new E5EmbeddingProvider(() => worker), close: () => worker.close() };
}

function matchesModel(value: unknown, expected: EmbeddingModel): boolean {
	if (!value || typeof value !== "object") return false;
	const model = value as Partial<EmbeddingModel>;
	return model.id === expected.id && model.revision === expected.revision && model.dimensions === expected.dimensions;
}
