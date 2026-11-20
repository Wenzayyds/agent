import { createHash } from "node:crypto";
import type { EmbeddingModel } from "../shared/embedding/e5.ts";
import { type IndexedPoint, QdrantError, QdrantIndex } from "../shared/vector/qdrant.ts";
import { MEMORY_OUTCOMES, type MemoryOutcome, type MemoryScope, type MemoryVisibility } from "./contracts.ts";

export type { EmbeddingModel } from "../shared/embedding/e5.ts";
export { QdrantError } from "../shared/vector/qdrant.ts";

export const MEMORY_VECTOR_COLLECTION = "pi_enhanced_memory_v3";
export const VECTOR_MEMORY_TYPES = ["semantic", "episodic", "procedural"] as const;
export type VectorMemoryType = (typeof VECTOR_MEMORY_TYPES)[number];

export interface VectorRevision {
	memoryId: string;
	revision: number;
}

export interface MemoryVectorMetadata extends VectorRevision {
	projectId: string;
	contentRevision: number;
	contentHash: string;
	type: VectorMemoryType;
	scope: MemoryScope;
	validFrom?: number;
	validUntil?: number;
	conditions?: readonly string[];
	occurredAt?: number;
	outcome?: MemoryOutcome;
}

export interface MemoryVectorPoint extends MemoryVectorMetadata {
	vector: readonly number[];
}

export interface VectorQuery {
	projectId: string;
	vector: readonly number[];
	visibility?: MemoryVisibility;
	conditions?: readonly string[];
	types?: readonly VectorMemoryType[];
	episodeOutcome?: MemoryOutcome;
	occurredAfter?: number;
	occurredBefore?: number;
	limit: number;
	now?: number;
}

export interface VectorHit extends MemoryVectorMetadata {
	score: number;
}

export interface MemoryVectorIndex {
	readonly model: EmbeddingModel;
	ensure(): Promise<void>;
	upsert(points: readonly MemoryVectorPoint[]): Promise<void>;
	remove(projectId: string, points: readonly VectorRevision[]): Promise<void>;
	search(query: VectorQuery): Promise<VectorHit[]>;
	list(
		projectId: string,
		options?: { memoryId?: string; cursor?: string; limit?: number },
	): Promise<{ points: MemoryVectorMetadata[]; cursor?: string }>;
	get(projectId: string, revisions: readonly VectorRevision[]): Promise<MemoryVectorMetadata[]>;
}

export function vectorPointId(projectId: string, ref: VectorRevision, model: EmbeddingModel): string {
	const hash = createHash("sha256")
		.update(JSON.stringify([projectId, ref.memoryId, ref.revision, modelKey(model)]))
		.digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class QdrantVectorIndex implements MemoryVectorIndex {
	readonly model: EmbeddingModel;
	private readonly index: QdrantIndex<Record<string, unknown>>;
	private readonly key: string;

	constructor(options: { model: EmbeddingModel; endpoint?: string; collection?: string; timeoutMs?: number }) {
		if (!options.model.id || !options.model.revision) throw new TypeError("Invalid embedding model identity");
		this.model = Object.freeze({ ...options.model });
		this.key = modelKey(this.model);
		this.index = new QdrantIndex({
			endpoint: options.endpoint ?? "http://127.0.0.1:6333",
			collectionName: options.collection ?? MEMORY_VECTOR_COLLECTION,
			dimensions: this.model.dimensions,
			timeoutMs: options.timeoutMs,
			parsePayload: object,
			payloadIndexes: {
				projectId: "keyword",
				modelKey: "keyword",
				memoryId: "keyword",
				scopeKey: "keyword",
				type: "keyword",
				conditions: "keyword",
				occurredAt: "integer",
				outcome: "keyword",
				validFrom: "integer",
				validUntil: "integer",
			},
		});
	}
	async ensure(): Promise<void> {
		await this.index.ensure();
	}

	async upsert(points: readonly MemoryVectorPoint[]): Promise<void> {
		await this.index.upsert(
			points.map((point) => ({
				id: vectorPointId(point.projectId, point, this.model),
				vector: point.vector,
				payload: {
					projectId: point.projectId,
					memoryId: point.memoryId,
					revision: point.revision,
					contentRevision: point.contentRevision,
					contentHash: point.contentHash,
					type: point.type,
					scopeKey: scopeKey(point.scope),
					modelKey: this.key,
					conditions: point.conditions ?? [],
					occurredAt: point.occurredAt,
					outcome: point.outcome,
					validFrom: point.validFrom ?? 0,
					validUntil: point.validUntil ?? Number.MAX_SAFE_INTEGER,
				},
			})),
		);
	}

	async remove(projectId: string, points: readonly VectorRevision[]): Promise<void> {
		await this.index.delete(points.map((point) => vectorPointId(projectId, point, this.model)));
	}

	async search(query: VectorQuery): Promise<VectorHit[]> {
		if (query.types?.length === 0) return [];
		const scopes = [scopeKey({ kind: "project" })];
		if (query.visibility?.sessionId) scopes.push(scopeKey({ kind: "session", id: query.visibility.sessionId }));
		if (query.visibility?.taskId) scopes.push(scopeKey({ kind: "task", id: query.visibility.taskId }));
		const now = query.now ?? Date.now();
		const result = await this.index.search(query.vector, {
			limit: query.limit,
			filter: {
				must: [
					...this.scopeFilter(query.projectId),
					{ key: "scopeKey", match: { any: scopes } },
					...(query.types ? [{ key: "type", match: { any: query.types } }] : []),
					{ key: "validFrom", range: { lte: now } },
					{ key: "validUntil", range: { gt: now } },
					...(!query.conditions?.length ? [{ is_empty: { key: "conditions" } }] : []),
					...(query.episodeOutcome ? [match("outcome", query.episodeOutcome), match("type", "episodic")] : []),
					...(query.occurredAfter !== undefined || query.occurredBefore !== undefined
						? [
								{ key: "occurredAt", range: { gte: query.occurredAfter, lt: query.occurredBefore } },
								match("type", "episodic"),
							]
						: []),
				],
				...(query.conditions?.length
					? { must_not: [{ key: "conditions", match: { except: query.conditions } }] }
					: {}),
			},
		});
		return result.map((point) => ({ ...this.parsePoint(query.projectId, point), score: point.score }));
	}

	async list(projectId: string, options: { memoryId?: string; cursor?: string; limit?: number } = {}) {
		const { points, cursor } = await this.index.scroll({
			cursor: options.cursor,
			limit: options.limit,
			filter: {
				must: [...this.scopeFilter(projectId), ...(options.memoryId ? [match("memoryId", options.memoryId)] : [])],
			},
		});
		return { points: points.map((point) => this.parsePoint(projectId, point)), cursor };
	}

	async get(projectId: string, revisions: readonly VectorRevision[]): Promise<MemoryVectorMetadata[]> {
		const result = await this.index.get(revisions.map((ref) => vectorPointId(projectId, ref, this.model)));
		return result.map((point) => this.parsePoint(projectId, point));
	}

	private scopeFilter(projectId: string) {
		return [match("projectId", projectId), match("modelKey", this.key)];
	}

	private parsePoint(projectId: string, point: IndexedPoint<Record<string, unknown>>): MemoryVectorMetadata {
		const { payload: data, id } = point;
		const scope = parseScopeKey(data.scopeKey);
		if (
			data.projectId !== projectId ||
			data.modelKey !== this.key ||
			!scope ||
			typeof data.memoryId !== "string" ||
			!Number.isSafeInteger(data.revision) ||
			!Number.isSafeInteger(data.contentRevision) ||
			typeof data.contentHash !== "string" ||
			!VECTOR_MEMORY_TYPES.includes(data.type as VectorMemoryType) ||
			!Number.isSafeInteger(data.validFrom) ||
			!Number.isSafeInteger(data.validUntil) ||
			(data.occurredAt !== undefined && !Number.isSafeInteger(data.occurredAt)) ||
			(data.outcome !== undefined && !MEMORY_OUTCOMES.includes(data.outcome as MemoryOutcome)) ||
			(data.conditions !== undefined &&
				(!Array.isArray(data.conditions) || !data.conditions.every((entry) => typeof entry === "string")))
		)
			throw new QdrantError("qdrant-invalid-response");
		const ref = { memoryId: data.memoryId, revision: data.revision as number };
		if (id !== vectorPointId(projectId, ref, this.model)) throw new QdrantError("qdrant-invalid-response");
		return {
			...ref,
			projectId,
			scope,
			contentRevision: data.contentRevision as number,
			contentHash: data.contentHash,
			type: data.type as VectorMemoryType,
			conditions: data.conditions as string[] | undefined,
			occurredAt: data.occurredAt as number | undefined,
			outcome: data.outcome as MemoryOutcome | undefined,
			validFrom: data.validFrom === 0 ? undefined : (data.validFrom as number),
			validUntil: data.validUntil === Number.MAX_SAFE_INTEGER ? undefined : (data.validUntil as number),
		};
	}
}

function modelKey(model: EmbeddingModel): string {
	return JSON.stringify([model.id, model.revision, model.dimensions]);
}

function scopeKey(scope: MemoryScope): string {
	return JSON.stringify(scope.kind === "project" ? ["project"] : [scope.kind, scope.id]);
}

function parseScopeKey(value: unknown): MemoryScope | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const fields: unknown = JSON.parse(value);
		if (!Array.isArray(fields)) return undefined;
		if (fields.length === 1 && fields[0] === "project") return { kind: "project" };
		if (
			fields.length === 2 &&
			(fields[0] === "session" || fields[0] === "task") &&
			typeof fields[1] === "string" &&
			fields[1]
		)
			return { kind: fields[0], id: fields[1] };
	} catch {
		return undefined;
	}
	return undefined;
}

function match(key: string, value: string) {
	return { key, match: { value } };
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
