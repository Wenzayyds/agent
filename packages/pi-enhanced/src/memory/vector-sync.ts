import { type MemoryRecord, recordScope, type ScopedSearchQuery } from "./contracts.ts";
import type { EmbeddingProvider } from "./embedding-provider.ts";
import { MemoryWorkerError } from "./python-worker-client.ts";
import {
	type MemoryVectorIndex,
	type MemoryVectorMetadata,
	QdrantError,
	VECTOR_MEMORY_TYPES,
	type VectorHit,
	type VectorMemoryType,
	type VectorRevision,
} from "./qdrant-vector-index.ts";
import type { MemoryService } from "./service.ts";
import type { VectorJob } from "./vector-outbox.ts";

const WRITE_BATCH = 16;
const INSPECTION_BATCH = 64;

export class MemoryVectorSync {
	private readonly service: MemoryService;
	private readonly index: MemoryVectorIndex;
	private readonly embedding: EmbeddingProvider;
	private readonly projectId: string;
	private ready?: Promise<void>;
	private running?: Promise<void>;
	private timer?: ReturnType<typeof setInterval>;
	private closed = false;
	private localCursor = "";
	private remoteCursor?: string;
	private reconcileAfter = 0;

	constructor(service: MemoryService, index: MemoryVectorIndex, embedding: EmbeddingProvider) {
		this.service = service;
		this.index = index;
		this.embedding = embedding;
		this.projectId = service.scope.projectId;
		const model = index.model;
		if (
			model.id !== embedding.model.id ||
			model.revision !== embedding.model.revision ||
			model.dimensions !== embedding.model.dimensions
		)
			throw new TypeError("Index and embedding models differ");
	}

	get model() {
		return this.index.model;
	}

	start(): void {
		if (this.timer || this.closed) return;
		this.timer = setInterval(() => {
			void this.flush().catch(() => undefined);
		}, 3_000);
		this.timer.unref();
	}

	flush(): Promise<void> {
		if (this.closed) return Promise.reject(new MemoryWorkerError("worker-closed", "Vector sync is closed"));
		this.running ??= this.run().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	async search(query: ScopedSearchQuery, types: readonly VectorMemoryType[], limit: number): Promise<VectorHit[]> {
		if (!types.length) return [];
		await this.flush();
		try {
			const [vector] = await this.embedding.encode([query.text], "query");
			return await this.index.search({
				projectId: this.projectId,
				vector,
				visibility: query.visibility,
				conditions: query.conditions,
				episodeOutcome: query.episodeOutcome,
				occurredAfter: query.occurredAfter,
				occurredBefore: query.occurredBefore,
				types,
				limit,
			});
		} catch (error) {
			if (error instanceof QdrantError) this.invalidateIndex();
			throw error;
		}
	}

	async reconcileNow() {
		await this.running?.catch(() => undefined);
		this.reconcileAfter = 0;
		await this.flush();
		return this.diagnose();
	}

	async diagnose(): Promise<{ orphanIds: string[]; staleIds: string[]; missingIds: string[]; truncated: boolean }> {
		const { points, invalid, cursor } = await this.index.list(this.projectId, { limit: INSPECTION_BATCH });
		const orphanIds = new Set<string>();
		const staleIds = new Set<string>();
		for (const point of points) {
			const record = await this.service.get(point.memoryId);
			if (!record) orphanIds.add(point.memoryId);
			else {
				const expected = this.asPoint(record);
				if (!expected || !samePoint(expected, point)) staleIds.add(point.memoryId);
			}
		}
		for (const { memoryId } of invalid ?? []) {
			if (await this.service.get(memoryId)) staleIds.add(memoryId);
			else orphanIds.add(memoryId);
		}
		const candidates = this.service.indexCandidates("", INSPECTION_BATCH + 1);
		const expected = candidates.slice(0, INSPECTION_BATCH).flatMap((record) => this.asPoint(record) ?? []);
		const indexed = await this.index.get(this.projectId, expected);
		return {
			orphanIds: [...orphanIds],
			staleIds: [...staleIds],
			missingIds: expected
				.filter((point) => !indexed.some((other) => samePoint(point, other)))
				.map(({ memoryId }) => memoryId),
			truncated: Boolean(cursor) || candidates.length > INSPECTION_BATCH,
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.timer);
		await this.running?.catch(() => undefined);
	}

	private async run(): Promise<void> {
		let jobs: VectorJob[] = [];
		try {
			jobs = this.service.vectorOutbox.due(WRITE_BATCH);
			this.ready ??= this.index.ensure().catch((error: unknown) => {
				this.ready = undefined;
				throw error;
			});
			await this.ready;
			if (Date.now() >= this.reconcileAfter) {
				await this.reconcile();
				this.reconcileAfter = Date.now() + 15_000;
				jobs = this.service.vectorOutbox.due(WRITE_BATCH);
			}
			if (!jobs.length) return;
			const batch = await Promise.all(
				jobs.map(async (job) => {
					const record = await this.service.get(job.memoryId);
					const point = record?.revision === job.revision ? this.asPoint(record) : undefined;
					return { job, record, point };
				}),
			);
			const passages = batch.flatMap(({ point, record }) =>
				point && record ? [{ point, content: record.content }] : [],
			);
			if (passages.length) {
				const vectors = await this.embedding.encode(
					passages.map(({ content }) => content),
					"passage",
				);
				await this.index.upsert(passages.map(({ point }, index) => ({ ...point, vector: vectors[index] })));
			}
			for (const { job, record, point } of batch) {
				if (record && record.revision !== job.revision) continue;
				await this.removeOlder(job, point !== undefined);
				this.service.vectorOutbox.complete(job, point?.validUntil);
			}
		} catch (error) {
			if (error instanceof QdrantError) this.invalidateIndex();
			const code = vectorErrorCode(error);
			for (const job of jobs) this.service.vectorOutbox.retry(job, code);
			throw error;
		}
	}

	private invalidateIndex(): void {
		this.ready = undefined;
		this.reconcileAfter = 0;
		this.localCursor = "";
		this.remoteCursor = undefined;
	}

	private async removeOlder(job: VectorJob, countedAsLive: boolean): Promise<void> {
		let cursor: string | undefined;
		do {
			const page = await this.index.list(this.projectId, { memoryId: job.memoryId, cursor });
			const superseded = [...page.points, ...(page.invalid ?? [])].filter(
				({ revision }) => revision < job.revision || (!countedAsLive && revision === job.revision),
			);
			await this.index.remove(this.projectId, superseded);
			cursor = page.cursor;
		} while (cursor);
	}

	private async reconcile(): Promise<void> {
		const local = this.service.indexCandidates(this.localCursor, INSPECTION_BATCH);
		const expected = local.flatMap((record) => this.asPoint(record) ?? []);
		const indexed = await this.index.get(this.projectId, expected);
		for (const point of expected) {
			if (!indexed.some((other) => samePoint(point, other)))
				this.service.vectorOutbox.enqueue(point.memoryId, point.revision);
		}
		this.localCursor = local.length === INSPECTION_BATCH ? local.at(-1)!.id : "";

		const remote = await this.index.list(this.projectId, { cursor: this.remoteCursor, limit: INSPECTION_BATCH });
		const obsolete: VectorRevision[] = [];
		for (const point of remote.points) {
			const current = await this.service.get(point.memoryId);
			// A point ahead of the local observation can be the result of another host's update.
			if (current && point.revision > current.revision) continue;
			const expectedPoint = current ? this.asPoint(current) : undefined;
			if (!expectedPoint || !samePoint(expectedPoint, point)) obsolete.push(point);
		}
		for (const point of remote.invalid ?? []) {
			const current = await this.service.get(point.memoryId);
			if (current && point.revision > current.revision) continue;
			if (current?.revision === point.revision && this.asPoint(current)) {
				this.service.vectorOutbox.enqueue(point.memoryId, point.revision);
			} else obsolete.push(point);
		}
		await this.index.remove(this.projectId, obsolete);
		this.remoteCursor = remote.cursor;
	}

	private asPoint(record: MemoryRecord): MemoryVectorMetadata | undefined {
		const scope = recordScope(record);
		const type = record.type as VectorMemoryType;
		if (
			!scope ||
			!VECTOR_MEMORY_TYPES.includes(type) ||
			record.lifecycle !== "active" ||
			(record.validUntil !== undefined && record.validUntil <= Date.now()) ||
			!this.service.hasValidEvidence(record)
		)
			return undefined;
		return {
			memoryId: record.id,
			revision: record.revision,
			contentRevision: record.contentRevision,
			contentHash: record.contentHash,
			projectId: record.projectId,
			scope,
			type,
			validFrom: record.validFrom,
			validUntil: record.validUntil,
			conditions: record.data?.conditions,
			occurredAt: type === "episodic" ? (record.data?.occurredAt ?? record.createdAt) : undefined,
			outcome: record.data?.outcome,
		};
	}
}

export function matchesIndexedRevision(record: MemoryRecord, point: MemoryVectorMetadata): boolean {
	return (
		record.projectId === point.projectId &&
		record.id === point.memoryId &&
		record.revision === point.revision &&
		record.contentRevision === point.contentRevision &&
		record.contentHash === point.contentHash
	);
}

export function vectorErrorCode(error: unknown): string {
	if (error instanceof QdrantError || error instanceof MemoryWorkerError) return error.code;
	return "vector-sync-error";
}

function samePoint(left: MemoryVectorMetadata, right: MemoryVectorMetadata): boolean {
	return (
		left.memoryId === right.memoryId &&
		left.revision === right.revision &&
		left.projectId === right.projectId &&
		left.type === right.type &&
		left.scope.kind === right.scope.kind &&
		(left.scope.kind === "project" || (right.scope.kind !== "project" && left.scope.id === right.scope.id)) &&
		left.contentRevision === right.contentRevision &&
		left.contentHash === right.contentHash &&
		(left.validFrom ?? 0) === (right.validFrom ?? 0) &&
		(left.validUntil ?? Number.MAX_SAFE_INTEGER) === (right.validUntil ?? Number.MAX_SAFE_INTEGER) &&
		left.occurredAt === right.occurredAt &&
		left.outcome === right.outcome &&
		JSON.stringify(left.conditions ?? []) === JSON.stringify(right.conditions ?? [])
	);
}
