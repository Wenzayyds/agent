import { createHash } from "node:crypto";
import type { MemoryIntelligenceConfig } from "./config.ts";
import type { MemoryIntelligenceStatus, MemoryRecord, MemorySearchResult, ScopedSearchQuery } from "./contracts.ts";
import { type MemoryWorkerClientLike, MemoryWorkerError, PythonMemoryWorkerClient } from "./python-worker-client.ts";
import type { MemoryService } from "./service.ts";

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
}

export class SemanticSearchAdapter {
	private readonly service: MemoryService;
	private readonly config: MemoryIntelligenceConfig;
	private readonly workerFactory: () => MemoryWorkerClientLike;
	private worker?: MemoryWorkerClientLike;
	private snapshotFingerprint?: string;
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
		this.statusValue = {
			state: disabled ? "disabled" : "unavailable",
			configuredMode: this.config.mode,
			activeMode: "lexical",
			indexSize: 0,
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
		const lexical = await this.service.search({ ...query, limit: lexicalLimit, statuses: ["verified"] });
		if (!this.config.enabled || this.config.mode === "lexical") {
			return { records: lexical.slice(0, requestedLimit), mode: "lexical" };
		}
		try {
			const semantic = await this.semanticSearch(query, Math.max(requestedLimit, this.config.semanticCandidates));
			if (this.config.mode === "semantic") {
				this.markReady("semantic");
				return { records: semantic.slice(0, requestedLimit), mode: "semantic" };
			}
			this.markReady("hybrid");
			return {
				records: reciprocalRankFusion(lexical, semantic).slice(0, requestedLimit),
				mode: "hybrid",
			};
		} catch (error) {
			const code = classifyError(error);
			await this.discardWorker();
			this.statusValue = {
				...this.statusValue,
				state: "degraded",
				activeMode: "lexical",
				lastErrorCode: code,
			};
			return { records: lexical.slice(0, requestedLimit), mode: "lexical", fallbackReason: code };
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.discardWorker();
	}

	private async semanticSearch(query: ScopedSearchQuery, topK: number): Promise<MemoryRecord[]> {
		if (this.closed) throw new Error("Memory intelligence adapter is closed");
		const snapshot = await this.service.listVerifiedSnapshot(this.config.maximumSnapshotRecords);
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
		for (const candidate of candidates) {
			const record = await this.service.get(candidate.memoryId);
			if (
				!record ||
				record.projectId !== this.service.scope.projectId ||
				record.status !== "verified" ||
				record.lifecycle !== "active"
			)
				continue;
			if (record.contentRevision !== candidate.contentRevision || record.contentHash !== candidate.contentHash)
				continue;
			if (query.kinds && !query.kinds.includes(record.kind)) continue;
			if (query.sourceTypes && !record.sources.some((source) => query.sourceTypes?.includes(source.type))) continue;
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

function reciprocalRankFusion(lexical: readonly MemoryRecord[], semantic: readonly MemoryRecord[]): MemoryRecord[] {
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

function classifyError(error: unknown): string {
	if (error instanceof MemoryWorkerError) return error.code;
	return "memory-intelligence-error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
