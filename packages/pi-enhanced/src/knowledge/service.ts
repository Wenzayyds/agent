import type { EmbeddingProvider } from "../shared/embedding/e5.ts";
import { MemoryWorkerError } from "../shared/embedding/python-worker-client.ts";
import { QdrantError, type VectorCondition, type VectorIndex } from "../shared/vector/qdrant.ts";
import { chunkDocument, documentHash } from "./chunking.ts";
import {
	type DocumentAccessPolicy,
	type DocumentChunk,
	type KnowledgeDocument,
	KnowledgeDocumentError,
} from "./contracts.ts";
import { documentIdentity, type PreparedDocument, prepareDocumentBytes } from "./ingestion.ts";
import { readDocumentSource } from "./sources.ts";
import {
	type DocumentRow,
	DocumentStore,
	embeddingHash,
	embeddingText,
	type SearchScope,
	type StoredChunk,
} from "./store.ts";
import { type DocumentVectorPayload, documentPointId, embeddingModelKey, pointMetadata } from "./vector.ts";

export type RetrievalMode = "lexical" | "semantic" | "hybrid";

export interface KnowledgeVectors {
	collection: string;
	index: VectorIndex<DocumentVectorPayload>;
	embedding: EmbeddingProvider;
	close?: () => Promise<void>;
}

interface SearchResult {
	rerank?: "applied" | "fallback";
	hits: StoredChunk[];
	mode: RetrievalMode;
	fallback?: string;
}

const BATCH = 16;
const POLICY_LABELS = ["local-only", "allow-external"];
const ID = /^[a-f0-9]{64}$/u;
export const CORPUS_ID = /^[\p{L}\d_-]{1,64}$/u;

export interface KnowledgeReranker {
	rank(query: string, passages: readonly string[]): Promise<readonly number[]>;
	close?(): Promise<void>;
}

export const KNOWLEDGE_RERANK_DEPTH = 12;
export class KnowledgeService {
	readonly projectId: string;
	private readonly store: DocumentStore;
	private readonly vectors?: KnowledgeVectors;
	private readonly model: string | null;
	private readonly mode: RetrievalMode;
	private readonly reranker?: KnowledgeReranker;
	private reranking = false;
	private readonly operations = new Set<Promise<unknown>>();
	private timer?: NodeJS.Timeout;
	private closing?: Promise<void>;
	private stopped = false;
	private ensure?: Promise<void>;
	private cursor?: string;
	private localCursor = "";
	private maintenanceError?: string;

	constructor(options: {
		projectId: string;
		filename: string;
		mode: RetrievalMode;
		reranker?: KnowledgeReranker;
		vectors?: KnowledgeVectors;
		background?: boolean;
	}) {
		if (options.mode !== "lexical" && !options.vectors)
			throw new TypeError("Vector retrieval requires a local embedding and index");
		this.projectId = options.projectId;
		this.mode = options.mode;
		this.reranker = options.reranker;
		this.vectors = options.vectors;
		this.model = options.vectors ? embeddingModelKey(options.vectors.embedding.model) : null;
		this.store = new DocumentStore(options.filename, options.projectId);
		if (options.background) {
			this.timer = setInterval(() => {
				if (this.operations.size) return;
				void this.maintain().then(
					() => {
						this.maintenanceError = undefined;
					},
					(error: unknown) => {
						this.maintenanceError = errorCode(error);
					},
				);
			}, 5_000);
			this.timer.unref();
		}
	}

	add(root: string, source: string, corpusId = "default", policy: DocumentAccessPolicy = "local-only") {
		if (!CORPUS_ID.test(corpusId) || !POLICY_LABELS.includes(policy)) {
			throw new KnowledgeDocumentError("invalid-parameter");
		}
		return this.write(() => this.refreshSource(root, source, corpusId, policy));
	}

	sync(documentId?: string, rebuild = false) {
		return this.write(async () => {
			const records = documentId ? [this.required(documentId)] : this.store.documents();
			if (rebuild) this.ensure = undefined;
			const results: { documentId: string; outcome: string }[] = [];
			for (const doc of records) {
				try {
					if (rebuild) {
						const prepared = this.rebuildVersion(doc);
						await this.stage(doc.root, doc.source, prepared);
						await this.index(prepared.document.documentId);
						results.push({ documentId: doc.id, outcome: "rebuilt" });
					} else {
						const result = await this.refreshSource(doc.root, doc.source, doc.corpus, doc.policy);
						results.push({ documentId: doc.id, outcome: result.outcome });
					}
				} catch (error) {
					if (
						error instanceof KnowledgeDocumentError &&
						error.code === "source-unavailable" &&
						(error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
					) {
						this.store.hide(doc.id);
						this.store.audit("sync", "source-deleted", doc.id);
						results.push({ documentId: doc.id, outcome: "source-deleted" });
						continue;
					}
					const code = errorCode(error);
					this.store.markError(doc.id, code);
					this.store.audit("sync", code, doc.id);
					results.push({ documentId: doc.id, outcome: code });
				}
			}
			return results;
		});
	}

	remove(documentId: string) {
		return this.write(async () => {
			this.required(documentId);
			this.store.hide(documentId);
			this.store.audit("remove", "hidden", documentId);
		});
	}

	list(corpusId?: string) {
		this.assertOpen();
		if (corpusId !== undefined && !CORPUS_ID.test(corpusId)) throw new KnowledgeDocumentError("invalid-parameter");
		return this.store
			.documents()
			.filter((row) => !corpusId || corpusId === row.corpus)
			.map((row) => {
				const version = this.store.version(row.id, row.desired ?? row.active);
				const document: KnowledgeDocument | undefined = version && JSON.parse(version.meta);
				return {
					id: row.id,
					corpusId: row.corpus,
					title: document?.title ?? row.source,
					source: row.source,
					activeVersion: row.active,
					pendingVersion: row.desired,
					policy: row.policy,
					error: row.error,
					warnings: version ? (JSON.parse(version.warnings) as string[]) : [],
				};
			});
	}

	status() {
		this.assertOpen();
		return {
			...this.store.status(),
			mode: this.mode,
			collection: this.vectors?.collection,
			model: this.model,
			maintenanceError: this.maintenanceError,
		};
	}

	audit(operation: string, outcome: string, documentId?: string): void {
		if (!this.stopped) this.store.audit(operation, outcome, documentId);
	}

	search(text: string, scope: SearchScope, limit = 5, mode = this.mode): Promise<SearchResult> {
		this.validateScope(scope);
		if (
			typeof text !== "string" ||
			!text.trim() ||
			text.length > 500 ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 10 ||
			!["lexical", "semantic", "hybrid"].includes(mode)
		)
			throw new KnowledgeDocumentError("invalid-parameter");
		return this.track(async () => {
			const query = text.trim();
			const candidates = Math.min(128, limit * 8);
			if (mode === "lexical") return { hits: this.store.lexical(query, scope, limit), mode };
			const lexical = mode === "hybrid" ? this.store.lexical(query, scope, candidates) : [];
			try {
				const semantic = await this.semantic(query, scope, candidates);
				const ranks = mode === "hybrid" ? fusion(lexical, semantic) : semantic;
				const hits = ranks.flatMap(({ chunk, score }) => {
					const live = this.store.chunk(chunk.chunkId, scope);
					return live ? [{ ...live, score }] : [];
				});
				if (mode === "hybrid" && this.reranker && hits.length > 1) {
					return this.rerank(query, scope, hits, limit, this.reranker);
				}
				return { hits: hits.slice(0, limit), mode };
			} catch (error) {
				this.ensure = undefined;
				return { hits: this.store.lexical(query, scope, limit), mode: "lexical", fallback: errorCode(error) };
			}
		});
	}

	private async rerank(
		query: string,
		scope: SearchScope,
		hits: StoredChunk[],
		limit: number,
		reranker: KnowledgeReranker,
	): Promise<SearchResult> {
		const head = hits.slice(0, KNOWLEDGE_RERANK_DEPTH);
		const fallback = (): SearchResult => ({ mode: "hybrid", rerank: "fallback", hits: refresh(hits) });
		const refresh = (ranking: StoredChunk[]) =>
			ranking
				.flatMap(({ chunk, score }) => {
					const live = this.store.chunk(chunk.chunkId, scope);
					return live ? [{ ...live, score }] : [];
				})
				.slice(0, limit);
		if (this.reranking) return fallback();
		this.reranking = true;
		try {
			const scores = await reranker.rank(
				query,
				head.map(({ chunk }) => chunk.content.slice(0, 1_400)),
			);
			if (scores.length !== head.length || !scores.every(Number.isFinite)) return fallback();
			const ranked = head
				.map((hit, index) => ({ hit, score: scores[index]! }))
				.sort((a, b) => b.score - a.score)
				.map(({ hit }) => hit);
			return { mode: "hybrid", rerank: "applied", hits: refresh([...ranked, ...hits.slice(head.length)]) };
		} catch {
			return fallback();
		} finally {
			this.reranking = false;
		}
	}

	read(chunkId: string, scope: SearchScope, neighbors = 0): { match: StoredChunk; adjacent: StoredChunk[] } {
		this.assertOpen();
		this.validateScope(scope);
		if (!ID.test(chunkId) || !Number.isInteger(neighbors) || neighbors < 0 || neighbors > 2) {
			throw new KnowledgeDocumentError("invalid-parameter");
		}
		const match = this.store.chunk(chunkId, scope);
		if (!match) throw new KnowledgeDocumentError("document-not-found");
		const adjacent: StoredChunk[] = [];
		for (const direction of ["previousChunkId", "nextChunkId"] as const) {
			let target = match.chunk[direction];
			for (let range = 0; target && range < neighbors; range += 1) {
				const next = this.store.chunk(target, { ...scope, documentId: match.document.documentId });
				if (!next || next.chunk.documentVersion !== match.chunk.documentVersion) break;
				adjacent.push(next);
				target = next.chunk[direction];
			}
		}
		adjacent.sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);
		return { match, adjacent };
	}

	admitDisclosure(documentIds: readonly string[], check: () => boolean): boolean {
		this.assertOpen();
		// Serialize this decision with policy writes across processes. No network or await holds this lock.
		return this.store.transaction(() => {
			const allowed = check();
			this.store.audit("model-disclosure", allowed ? "dispatch-admitted" : "dispatch-denied");
			if (allowed) {
				for (const id of documentIds) this.store.audit("model-disclosure-source", "dispatch-admitted", id);
			}
			return allowed;
		});
	}

	maintain() {
		return this.write(async () => {
			this.ensure = undefined;
			const pending = this.store.documents().find((row) => row.desired !== null && row.retryAt <= Date.now());
			if (pending) {
				try {
					await this.index(pending.id);
				} catch (error) {
					this.store.audit("retry", errorCode(error), pending.id);
				}
			}
			const cleaned = await this.cleanup();
			const { orphans, truncated } = await this.checkOrphans();
			const missing = await this.repairMissing();
			return {
				retried: pending?.id,
				cleaned,
				orphans,
				repaired: missing.repaired,
				truncated: truncated || missing.truncated,
			};
		});
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.stopped = true;
		clearInterval(this.timer);
		this.closing = (async () => {
			try {
				await this.vectors?.close?.();
			} finally {
				await Promise.allSettled(this.operations);
				try {
					await this.reranker?.close?.();
				} finally {
					this.store.close();
				}
			}
		})();
		return this.closing;
	}

	private async refreshSource(root: string, source: string, corpusId: string, policy: DocumentAccessPolicy) {
		const input = await readDocumentSource(root, source);
		const documentId = documentIdentity(this.projectId, corpusId, input.sourcePath);
		const previous = this.store.document(documentId);
		if (previous?.policy === "allow-external" && policy === "local-only") {
			this.store.restrict(documentId);
			this.store.audit("access", "local-only", documentId);
		}
		const current = !previous?.deleted
			? this.store.version(documentId, previous?.desired ?? previous?.active ?? null)
			: undefined;
		const hash = documentHash(input.bytes);
		if (
			previous &&
			current &&
			previous.policy === policy &&
			current.model === this.model &&
			(JSON.parse(current.meta) as KnowledgeDocument).contentHash === hash
		) {
			if (previous.desired === null) return { documentId, outcome: "unchanged" };
			await this.index(documentId);
			return { documentId, outcome: "retried" };
		}
		const prepared = await prepareDocumentBytes(
			{
				root,
				source,
				projectId: this.projectId,
				corpusId,
				version: (previous?.latest ?? 0) + 1,
				accessPolicy: policy,
			},
			input,
		);
		await this.stage(root, source, prepared);
		await this.index(documentId);
		return { documentId, outcome: previous && !previous.deleted ? "updated" : "indexed" };
	}

	private async stage(root: string, source: string, prepared: PreparedDocument): Promise<void> {
		// If cleanup is temporarily unavailable, the version quota still bounds storage growth.
		await this.cleanup().catch((error) => this.store.audit("cleanup", errorCode(error)));
		this.store.stage(
			{ root, source, model: this.model, collection: this.vectors?.collection ?? null },
			prepared.document,
			prepared.chunks,
			prepared.warnings,
		);
		this.store.audit("stage", "pending", prepared.document.documentId);
	}

	private async index(documentId: string): Promise<void> {
		const row = this.required(documentId);
		const version = this.store.version(documentId, row.desired);
		if (!version || row.desired === null) return;
		try {
			if (version.model) {
				if (!this.vectors || version.model !== this.model || version.collection !== this.vectors.collection) {
					throw new QdrantError("qdrant-incompatible-collection");
				}
				const document: KnowledgeDocument = JSON.parse(version.meta);
				await this.ensureIndex();
				const chunks = this.store.chunks(documentId, row.desired);
				for (let offset = 0; offset < chunks.length; offset += BATCH) {
					await this.upsertBatch(
						chunks.slice(offset, offset + BATCH).map((chunk) => ({ document, chunk })),
						this.vectors,
						version.model,
					);
				}
			}
			this.assertOpen();
			this.store.activate(documentId, row.desired);
			this.store.audit("activate", "indexed", documentId);
		} catch (error) {
			this.ensure = undefined;
			this.store.markError(documentId, errorCode(error));
			this.store.audit("index", errorCode(error), documentId);
			throw error;
		}
	}

	private async upsertBatch(
		rows: readonly { document: KnowledgeDocument; chunk: DocumentChunk }[],
		vectors: KnowledgeVectors,
		model: string,
	): Promise<void> {
		this.assertOpen();
		const hashes = new Map(rows.map(({ chunk }) => [embeddingHash(chunk), chunk]));
		const missing = [...hashes].filter(([hash]) => !this.store.cached(model, hash));
		if (missing.length) {
			const fresh = await vectors.embedding.encode(
				missing.map(([, chunk]) => embeddingText(chunk)),
				"passage",
			);
			if (
				fresh.length !== missing.length ||
				fresh.some(
					(vector) =>
						vector.length !== vectors.embedding.model.dimensions ||
						!vector.every(Number.isFinite) ||
						!vector.some((component) => component !== 0),
				)
			) {
				throw new MemoryWorkerError("invalid-response", "Invalid vectors");
			}
			for (const [i, [hash]] of missing.entries()) this.store.cache(model, hash, fresh[i]);
		}
		await vectors.index.upsert(
			rows.map(({ chunk, document }) => ({
				id: documentPointId(chunk.chunkId, model),
				payload: pointMetadata(document, chunk, model),
				vector: this.store.cached(model, embeddingHash(chunk))!,
			})),
		);
	}

	private async repairMissing(): Promise<{ repaired: number; truncated: boolean }> {
		const { vectors, model } = this;
		if (!vectors || !model) return { repaired: 0, truncated: false };
		const rows = this.store.vectorPage(model, vectors.collection, this.localCursor, 65);
		const page = rows.slice(0, 64);
		const remote = new Map(
			(await vectors.index.get(page.map(({ chunk }) => documentPointId(chunk.chunkId, model)))).map(
				({ id, payload }) => [id, payload],
			),
		);
		const missing = page.filter(({ document, chunk }) => {
			const point = remote.get(documentPointId(chunk.chunkId, model));
			return !point || !this.matchesReference(point, document, chunk, model);
		});
		for (let offset = 0; offset < missing.length; offset += BATCH) {
			await this.upsertBatch(missing.slice(offset, offset + BATCH), vectors, model);
		}
		this.localCursor = rows.length > page.length ? page.at(-1)!.chunk.chunkId : "";
		return { repaired: missing.length, truncated: !!this.localCursor };
	}

	private rebuildVersion(row: DocumentRow): PreparedDocument {
		const oldVersion = row.desired ?? row.active;
		const entry = this.store.version(row.id, oldVersion);
		if (!entry || oldVersion === null) throw new KnowledgeDocumentError("document-not-found");
		const document: KnowledgeDocument = {
			...JSON.parse(entry.meta),
			version: row.latest + 1,
			status: "prepared",
			updatedAt: Date.now(),
			accessPolicy: row.policy,
		};
		const old = this.store.chunks(row.id, oldVersion);
		const chunks = chunkDocument(row.id, document.version, {
			parserVersion: old[0].parserVersion,
			warnings: [],
			blocks: old.map((chunk) => ({
				kind: "literal",
				sectionIndex: chunk.chunkIndex,
				text: chunk.content,
				headingPath: chunk.headingPath,
				pageNumber: chunk.pageNumber,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
			})),
		});
		return { document, chunks, warnings: JSON.parse(entry.warnings) };
	}

	private async semantic(text: string, scope: SearchScope, limit: number): Promise<StoredChunk[]> {
		if (!this.vectors || !this.model) throw new QdrantError("qdrant-unavailable");
		const active = this.store.activeVersions(scope, this.model, this.vectors.collection);
		if (!active.length) return [];
		const revisions = new Map<number, string[]>();
		for (const { id, version } of active) {
			const ids = revisions.get(version) ?? [];
			ids.push(id);
			revisions.set(version, ids);
		}
		const must: VectorCondition[] = [
			{
				should: [...revisions].map(([version, ids]) => ({
					must: [
						{ key: "documentId", match: { any: ids } },
						{ key: "documentVersion", match: { value: version } },
					],
				})),
			},
			{ key: "projectId", match: { value: this.projectId } },
			{ key: "embeddingModelId", match: { value: this.model } },
		];
		if (scope.corpusId) must.push({ key: "corpusId", match: { value: scope.corpusId } });
		if (scope.documentId) must.push({ key: "documentId", match: { value: scope.documentId } });
		if (scope.audience === "agent") must.push({ key: "accessPolicy", match: { value: "allow-external" } });
		const [vector] = await this.vectors.embedding.encode([text], "query");
		const hits = await this.vectors.index.search(vector, { filter: { must }, limit });
		return hits.flatMap(({ id, payload, score }) => {
			const live = this.store.chunk(payload.chunkId, scope);
			if (
				!live ||
				id !== documentPointId(payload.chunkId, this.model!) ||
				!this.matchesReference(payload, live.document, live.chunk, this.model!)
			)
				return [];
			return [{ ...live, score }];
		});
	}

	private async cleanup(): Promise<number> {
		let cleaned = 0;
		for (const old of this.store.retired(8)) {
			if (old.model) {
				if (!this.vectors || old.collection !== this.vectors.collection) continue;
				await this.ensureIndex();
				const ids = this.store
					.chunks(old.id, old.version)
					.map((chunk) => documentPointId(chunk.chunkId, old.model!));
				for (let offset = 0; offset < ids.length; offset += 128) {
					await this.vectors.index.delete(ids.slice(offset, offset + 128));
				}
			}
			this.store.purge(old.id, old.version);
			cleaned += 1;
		}
		return cleaned;
	}

	private async checkOrphans(): Promise<{ orphans: number; truncated: boolean }> {
		if (!this.vectors) return { orphans: 0, truncated: false };
		await this.ensureIndex();
		const page = await this.vectors.index.scroll({
			limit: 128,
			cursor: this.cursor,
			filter: { must: [{ key: "projectId", match: { value: this.projectId } }] },
		});
		const ids = page.points.flatMap(({ id, payload }) => {
			// Never delete records for another project even if the server ignored a filter.
			if (payload.projectId !== this.projectId) return [];
			const ref = this.store.pointReference(payload.chunkId);
			return ref?.collection === this.vectors?.collection &&
				ref?.model &&
				id === documentPointId(payload.chunkId, ref.model) &&
				this.matchesReference(payload, JSON.parse(ref.meta), JSON.parse(ref.data), ref.model)
				? []
				: [id];
		});
		await this.vectors.index.delete(ids);
		this.cursor = page.cursor;
		return { orphans: ids.length, truncated: !!page.cursor };
	}

	private matchesReference(
		payload: DocumentVectorPayload,
		document: KnowledgeDocument,
		chunk: DocumentChunk,
		model: string,
	): boolean {
		const expected = pointMetadata(document, chunk, model);
		return (
			payload.projectId === expected.projectId &&
			payload.corpusId === expected.corpusId &&
			payload.documentId === expected.documentId &&
			payload.documentVersion === expected.documentVersion &&
			payload.contentHash === expected.contentHash &&
			payload.embeddingModelId === expected.embeddingModelId &&
			payload.accessPolicy === expected.accessPolicy
		);
	}

	private ensureIndex(): Promise<void> {
		this.ensure ??= this.vectors!.index.ensure().catch((error: unknown) => {
			this.ensure = undefined;
			throw error;
		});
		return this.ensure;
	}

	private required(id: string): DocumentRow {
		if (!ID.test(id)) throw new KnowledgeDocumentError("invalid-parameter");
		const record = this.store.document(id);
		if (!record || record.deleted) throw new KnowledgeDocumentError("document-not-found");
		return record;
	}

	private validateScope(scope: SearchScope): void {
		if (
			(scope.corpusId !== undefined && !CORPUS_ID.test(scope.corpusId)) ||
			(scope.documentId !== undefined && !ID.test(scope.documentId)) ||
			(scope.audience !== "agent" && scope.audience !== "host")
		)
			throw new KnowledgeDocumentError("invalid-parameter");
	}

	private assertOpen(): void {
		if (this.stopped) throw new KnowledgeDocumentError("knowledge-disabled");
	}

	private track<T>(run: () => Promise<T>): Promise<T> {
		this.assertOpen();
		const promise = Promise.resolve()
			.then(run)
			.finally(() => this.operations.delete(promise));
		this.operations.add(promise);
		return promise;
	}

	private write<T>(run: () => Promise<T>): Promise<T> {
		return this.track(() => this.store.write(run));
	}
}

export function errorCode(error: unknown): string {
	if (error instanceof KnowledgeDocumentError || error instanceof QdrantError || error instanceof MemoryWorkerError)
		return error.code;
	return "knowledge-operation-failed";
}

function fusion(lexical: StoredChunk[], semantic: StoredChunk[]): StoredChunk[] {
	const results = new Map<string, StoredChunk>();
	for (const ranking of [lexical, semantic]) {
		for (const [rank, candidate] of ranking.entries()) {
			const id = candidate.chunk.chunkId;
			const score = (results.get(id)?.score ?? 0) + 1 / (60 + rank + 1);
			results.set(id, { ...candidate, score });
		}
	}
	return [...results.values()].sort(
		(left, right) =>
			right.score - left.score ||
			left.source.localeCompare(right.source, "en") ||
			left.chunk.chunkIndex - right.chunk.chunkIndex ||
			left.chunk.chunkId.localeCompare(right.chunk.chunkId),
	);
}
