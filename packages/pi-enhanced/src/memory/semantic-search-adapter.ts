import { createHash } from "node:crypto";
import type { MemoryIntelligenceConfig } from "./config.ts";
import {
	type MemoryIntelligenceStatus,
	type MemoryRecord,
	type MemorySearchResult,
	matchesMemoryQuery,
	memoryTypeOf,
	type ScopedSearchQuery,
	sameMemoryRevision,
} from "./contracts.ts";
import { E5EmbeddingProvider, type EmbeddingProvider } from "./embedding-provider.ts";
import { type MemoryWorkerClientLike, MemoryWorkerError, PythonMemoryWorkerClient } from "./python-worker-client.ts";
import { type MemoryVectorIndex, QdrantVectorIndex, VECTOR_MEMORY_TYPES } from "./qdrant-vector-index.ts";
import type { MemoryService } from "./service.ts";
import { MemoryVectorSync, matchesIndexedRevision, vectorErrorCode } from "./vector-sync.ts";

const RRF_CONSTANT = 60;

interface VectorCandidate {
	memoryId: string;
	score: number;
	contentRevision: number;
	contentHash: string;
}

export interface SemanticSearchAdapterOptions {
	service: MemoryService;
	config: MemoryIntelligenceConfig;
	workerFactory?: () => MemoryWorkerClientLike;
	embedding?: EmbeddingProvider;
	vectorIndex?: MemoryVectorIndex;
}

export class SemanticSearchAdapter {
	private readonly service: MemoryService;
	private readonly config: MemoryIntelligenceConfig;
	private readonly workerFactory: () => MemoryWorkerClientLike;
	private worker?: MemoryWorkerClientLike;
	private snapshotFingerprint?: string;
	private readonly vectorSync?: MemoryVectorSync;
	private legacySearch: Promise<unknown> = Promise.resolve();
	private closed = false;
	private statusValue: MemoryIntelligenceStatus;

	constructor(options: SemanticSearchAdapterOptions) {
		this.service = options.service;
		this.config = options.config;
		this.workerFactory =
			options.workerFactory ??
			(() =>
				new PythonMemoryWorkerClient({
					startupTimeoutMs: this.config.startupTimeoutMs,
					requestTimeoutMs: this.config.requestTimeoutMs,
				}));
		const disabled = !this.config.enabled || this.config.mode === "lexical";
		if (!disabled && (this.config.backend === "e5-qdrant" || options.vectorIndex)) {
			const embedding = options.embedding ?? new E5EmbeddingProvider(() => this.worker ?? this.createWorker());
			const index =
				options.vectorIndex ??
				new QdrantVectorIndex({
					model: embedding.model,
					endpoint: this.config.qdrantEndpoint,
					timeoutMs: this.config.requestTimeoutMs,
				});
			this.vectorSync = new MemoryVectorSync(this.service, index, embedding);
			this.vectorSync.start();
		}
		this.statusValue = {
			state: disabled ? "disabled" : "unavailable",
			configuredMode: this.config.mode,
			activeMode: "lexical",
			indexSize: this.vectorSync ? undefined : 0,
			...(this.vectorSync
				? {
						modelId: this.vectorSync.model.id,
						modelRevision: this.vectorSync.model.revision,
						vectorDimensions: this.vectorSync.model.dimensions,
					}
				: {}),
			reranker: this.config.rerankerEnabled ? "unavailable" : "disabled",
		};
	}

	get status(): Readonly<MemoryIntelligenceStatus> {
		return { ...this.statusValue };
	}

	async search(query: ScopedSearchQuery): Promise<MemorySearchResult> {
		const requestedLimit = Math.min(query.limit ?? 20, 50);
		const lexicalLimit =
			this.config.mode === "hybrid" ? Math.max(requestedLimit, this.config.semanticCandidates) : requestedLimit;
		const lexical = await this.service.search({
			...query,
			limit: lexicalLimit,
			statuses: ["verified"],
			lifecycles: ["active"],
		});
		const types = VECTOR_MEMORY_TYPES.filter((type) => !query.types || query.types.includes(type));
		if (
			!this.config.enabled ||
			this.config.mode === "lexical" ||
			!types.length ||
			query.preferenceKey ||
			!query.text.trim()
		) {
			return { records: await this.recheck(lexical, query, requestedLimit), mode: "lexical" };
		}
		try {
			const topK = Math.max(requestedLimit, this.config.semanticCandidates);
			let semantic: MemoryRecord[];
			if (this.vectorSync) {
				const candidates = await this.vectorSync.search(query, types, topK);
				const records = await Promise.all(
					candidates.map(async (candidate) => {
						const row = await this.service.getVisible(candidate.memoryId, query.visibility);
						return row && matchesIndexedRevision(row, candidate) && matchesMemoryQuery(row, query) ? row : null;
					}),
				);
				semantic = records.filter((row) => row !== null);
				if (!semantic.length && lexical.length && this.service.vectorOutbox.stats().failed)
					throw new MemoryWorkerError("vector-sync-pending", "Vector sync is awaiting retry");
			} else {
				const run = this.legacySearch.then(() => this.semanticSearch(query, topK));
				this.legacySearch = run.catch(() => undefined);
				semantic = await run;
			}
			const routed = lexical.filter((row) => !VECTOR_MEMORY_TYPES.some((type) => type === memoryTypeOf(row)));
			if (this.config.mode === "semantic") {
				this.markReady("semantic");
				return { records: await this.recheck([...routed, ...semantic], query, requestedLimit), mode: "semantic" };
			}
			this.markReady("hybrid");
			return {
				records: await this.recheck(reciprocalRankFusion(lexical, semantic), query, requestedLimit),
				mode: "hybrid",
			};
		} catch (error) {
			const code = this.vectorSync ? vectorErrorCode(error) : classifyError(error);
			if (!this.vectorSync || (error instanceof MemoryWorkerError && error.code !== "model-not-installed"))
				await this.discardWorker();
			this.statusValue = {
				...this.statusValue,
				state: "degraded",
				activeMode: "lexical",
				lastErrorCode: code,
			};
			return { records: await this.recheck(lexical, query, requestedLimit), mode: "lexical", fallbackReason: code };
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.vectorSync?.close();
		await this.legacySearch;
		await this.discardWorker();
	}

	async reconcileIndex() {
		return this.vectorSync?.reconcileNow();
	}

	async diagnoseIndex(): Promise<Awaited<ReturnType<MemoryVectorSync["diagnose"]>> | undefined> {
		return this.vectorSync?.diagnose();
	}

	private async recheck(
		records: readonly MemoryRecord[],
		query: ScopedSearchQuery,
		limit: number,
	): Promise<MemoryRecord[]> {
		const seen = new Set<string>();
		const result: MemoryRecord[] = [];
		for (const observed of orderMemoryResults(records, query.order)) {
			if (seen.has(observed.id)) continue;
			const row = await this.service.getVisible(observed.id, query.visibility);
			if (row && sameMemoryRevision(observed, row) && matchesMemoryQuery(row, query)) {
				result.push(row);
				seen.add(row.id);
			}
			if (result.length === limit) break;
		}
		return result;
	}

	private async semanticSearch(query: ScopedSearchQuery, topK: number): Promise<MemoryRecord[]> {
		if (this.closed) throw new Error("Memory intelligence adapter is closed");
		const snapshot = await this.service.listVerifiedSnapshot(this.config.maximumSnapshotRecords, query);
		if (snapshot.truncated)
			throw new MemoryWorkerError("snapshot-too-large", "Verified memory snapshot is too large");
		const fingerprint = createSnapshotFingerprint(snapshot.records);
		const worker = this.worker ?? this.createWorker();
		if (fingerprint !== this.snapshotFingerprint) {
			const sync = await worker.request("sync_snapshot", {
				projectId: this.service.scope.projectId,
				records: snapshot.records.map((record) => ({
					memoryId: record.id,
					content: record.content,
					contentRevision: record.contentRevision,
					contentHash: record.contentHash,
					kind: record.kind,
				})),
			});
			this.snapshotFingerprint = fingerprint;
			this.updateWorkerMetadata(sync);
		}
		const response = await worker.request("search_vectors", {
			projectId: this.service.scope.projectId,
			query: query.text,
			topK: Math.min(topK, 50),
		});
		this.updateWorkerMetadata(response);
		const candidates = parseCandidates(response.candidates);
		const records: MemoryRecord[] = [];
		const now = Date.now();
		for (const candidate of candidates) {
			const record = await this.service.getVisible(candidate.memoryId, query.visibility);
			if (
				!record ||
				record.projectId !== this.service.scope.projectId ||
				record.lifecycle !== "active" ||
				(record.validFrom !== undefined && record.validFrom > now) ||
				(record.validUntil !== undefined && record.validUntil <= now)
			)
				continue;
			if (record.contentRevision !== candidate.contentRevision || record.contentHash !== candidate.contentHash)
				continue;
			if (!matchesMemoryQuery(record, query)) continue;
			records.push(record);
		}
		return records;
	}

	private createWorker(): MemoryWorkerClientLike {
		const worker = this.workerFactory();
		this.worker = worker;
		return worker;
	}

	private async discardWorker(): Promise<void> {
		const worker = this.worker;
		this.worker = undefined;
		this.snapshotFingerprint = undefined;
		await worker?.close().catch(() => undefined);
	}

	private updateWorkerMetadata(response: Readonly<Record<string, unknown>>): void {
		this.statusValue = {
			...this.statusValue,
			...(typeof response.modelId === "string" ? { modelId: response.modelId } : {}),
			...(Number.isSafeInteger(response.recordCount) ? { indexSize: response.recordCount as number } : {}),
		};
	}

	private markReady(mode: "semantic" | "hybrid"): void {
		this.statusValue = {
			...this.statusValue,
			state: "ready",
			activeMode: mode,
			lastErrorCode: undefined,
		};
	}
}

function createSnapshotFingerprint(records: readonly MemoryRecord[]): string {
	const hash = createHash("sha256");
	for (const record of records) hash.update(`${record.id}\0${record.contentRevision}\0${record.contentHash}\n`);
	return hash.digest("hex");
}

function parseCandidates(value: unknown): VectorCandidate[] {
	if (!Array.isArray(value) || value.length > 50)
		throw new MemoryWorkerError("invalid-response", "Vector candidates are invalid");
	return value.map((candidate) => {
		if (
			!isRecord(candidate) ||
			typeof candidate.memoryId !== "string" ||
			typeof candidate.score !== "number" ||
			!Number.isFinite(candidate.score) ||
			!Number.isSafeInteger(candidate.contentRevision) ||
			typeof candidate.contentHash !== "string"
		) {
			throw new MemoryWorkerError("invalid-response", "Vector candidate is invalid");
		}
		return {
			memoryId: candidate.memoryId,
			score: candidate.score,
			contentRevision: candidate.contentRevision as number,
			contentHash: candidate.contentHash,
		};
	});
}

export function reciprocalRankFusion(
	lexical: readonly MemoryRecord[],
	semantic: readonly MemoryRecord[],
): MemoryRecord[] {
	const records = new Map<string, MemoryRecord>();
	const scores = new Map<string, number>();
	for (const ranking of [lexical, semantic]) {
		for (const [index, record] of ranking.entries()) {
			records.set(record.id, record);
			scores.set(record.id, (scores.get(record.id) ?? 0) + 1 / (RRF_CONSTANT + index + 1));
		}
	}
	return [...records.values()].sort((left, right) => {
		const scoreDifference = (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0);
		return scoreDifference !== 0 ? scoreDifference : left.id.localeCompare(right.id);
	});
}

function orderMemoryResults(
	records: readonly MemoryRecord[],
	order: ScopedSearchQuery["order"],
): readonly MemoryRecord[] {
	if (order === "priority")
		return [...records].sort(
			(left, right) =>
				right.importance - left.importance ||
				(right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt) ||
				left.id.localeCompare(right.id),
		);
	if (order !== "recent" && order !== "successful") return records;
	return [...records].sort((left, right) => {
		const outcome =
			order === "successful"
				? Number(right.data?.outcome === "success") - Number(left.data?.outcome === "success")
				: 0;
		return (
			outcome ||
			(right.data?.occurredAt ?? right.createdAt) - (left.data?.occurredAt ?? left.createdAt) ||
			left.id.localeCompare(right.id)
		);
	});
}

function classifyError(error: unknown): string {
	if (error instanceof MemoryWorkerError) return error.code;
	return "memory-intelligence-error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
