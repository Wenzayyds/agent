import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it } from "vitest";
import { compose, reserveLoopbackPort } from "../../fixtures/memory-v3/lab.ts";
import type { EmbeddingProvider } from "../../src/memory/embedding-provider.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { type MemoryVectorPoint, QdrantVectorIndex, vectorPointId } from "../../src/memory/qdrant-vector-index.ts";
import { SemanticSearchAdapter } from "../../src/memory/semantic-search-adapter.ts";
import { openMemoryService } from "../../src/memory/service.ts";
import { MemoryVectorSync } from "../../src/memory/vector-sync.ts";
import { QdrantIndex } from "../../src/shared/vector/qdrant.ts";

function removeFixture(root: string, temporary: string): void {
	const resolved = realpathSync(root);
	if (dirname(resolved) !== temporary || !basename(resolved).startsWith("pi-memory-index-repair-"))
		throw new Error("Unexpected Memory fixture directory");
	rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

it.runIf(process.env.PI_MEMORY_V3_DOCKER === "1")(
	"rebuilds malformed Memory metadata and cleans owned orphan points on a real Qdrant instance",
	async () => {
		const project = `pi-memory-index-repair-${randomUUID().slice(0, 8)}`;
		const temporary = realpathSync(tmpdir());
		const root = mkdtempSync(join(temporary, "pi-memory-index-repair-"));
		const store = await openMemoryService(createProjectScope({ cwd: root, agentDir: join(root, "agent") }));
		const { projectId } = store.scope;
		let adapter: SemanticSearchAdapter | undefined;
		let sync: MemoryVectorSync | undefined;
		try {
			await reserveLoopbackPort(project);
			compose(project, "up", "-d", "--wait", "--wait-timeout", "30");
			const address = compose(project, "port", "qdrant", "6333");
			expect(address).toMatch(/^127\.0\.0\.1:\d+$/u);
			const endpoint = `http://${address}`;
			const collection = `memory_repair_${randomUUID().replaceAll("-", "")}`;
			const vector = [1, 0];
			const model = { id: "memory-repair", revision: "v1", dimensions: vector.length };
			const embedding: EmbeddingProvider = { model, encode: async (texts) => texts.map(() => vector) };
			const index = new QdrantVectorIndex({ model, endpoint, collection, timeoutMs: 8_000 });
			const raw = new QdrantIndex({
				endpoint,
				collectionName: collection,
				dimensions: model.dimensions,
				timeoutMs: 8_000,
				parsePayload: (payload) => payload as Record<string, unknown>,
			});
			const seed = async (file: string, content: string) => {
				writeFileSync(join(root, file), content);
				const memory = await store.saveCandidate({
					type: "semantic",
					kind: "fact",
					content,
					source: { type: "file", ref: file },
				});
				return store.verifyFileFact(memory.id, { relativePath: file, exactExcerpt: content }, memory.revision);
			};
			const repairable = await seed("one.txt", "Deployment requires an independent approval.");
			const healthy = await seed("two.txt", "Retain the delivery receipt after a deploy.");
			sync = new MemoryVectorSync(store, index, embedding);
			await sync.flush();

			const ref = { memoryId: repairable.id, revision: repairable.revision };
			const orphan: MemoryVectorPoint = {
				...ref,
				memoryId: "orphan",
				projectId,
				vector,
				contentRevision: 1,
				contentHash: "orphan-hash",
				type: "semantic",
				scope: { kind: "project" },
			};
			const sibling = { ...orphan, memoryId: "sibling", projectId: "different-project" };
			const future = { ...orphan, memoryId: ref.memoryId, revision: ref.revision + 1 };
			await index.upsert([orphan, sibling, future]);
			const currentId = vectorPointId(projectId, ref, model);
			const orphanId = vectorPointId(projectId, orphan, model);
			const futureId = vectorPointId(projectId, future, model);
			const siblingId = vectorPointId(sibling.projectId, sibling, model);
			const corrupted = await fetch(`${endpoint}/collections/${collection}/points/payload?wait=true`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: AbortSignal.timeout(8_000),
				body: JSON.stringify({
					payload: { contentRevision: "invalid" },
					points: [currentId, orphanId, futureId, siblingId],
				}),
			});
			expect(corrupted.ok, await corrupted.text()).toBe(true);

			const vectorHits = await index.search({ projectId, vector, limit: 8, types: ["semantic"] });
			expect(vectorHits.map(({ memoryId }) => memoryId)).toEqual([healthy.id]);
			expect(await sync.diagnose()).toMatchObject({
				staleIds: [repairable.id],
				orphanIds: ["orphan"],
				missingIds: [repairable.id],
			});
			expect((await raw.get([currentId, orphanId])).map(({ payload }) => payload.contentRevision)).toEqual([
				"invalid",
				"invalid",
			]);

			await sync.close();
			sync = new MemoryVectorSync(store, index, embedding);
			expect(await sync.reconcileNow()).toMatchObject({ staleIds: [repairable.id], orphanIds: [], missingIds: [] });
			expect(await raw.get([orphanId])).toEqual([]);
			expect((await raw.get([futureId, siblingId])).map(({ payload }) => payload.contentRevision)).toEqual([
				"invalid",
				"invalid",
			]);
			expect(await index.get(projectId, [ref])).toMatchObject([
				{
					memoryId: repairable.id,
					revision: repairable.revision,
					contentRevision: repairable.contentRevision,
					contentHash: repairable.contentHash,
				},
			]);
			adapter = new SemanticSearchAdapter({
				service: store,
				embedding,
				vectorIndex: index,
				config: {
					enabled: true,
					backend: "e5-qdrant",
					mode: "hybrid",
					maximumSnapshotRecords: 32,
					rerankerEnabled: false,
					startupTimeoutMs: 8_000,
					requestTimeoutMs: 8_000,
					semanticCandidates: 8,
				},
			});
			const repaired = await adapter.search({ text: "deployment" });
			expect(repaired.mode).toBe("hybrid");
			expect(new Set(repaired.records.map(({ id }) => id))).toEqual(new Set([repairable.id, healthy.id]));
			await store.archive(repairable.id, repairable.revision);
			await sync.reconcileNow();
			await sync.reconcileNow();
			expect(await raw.get([currentId, orphanId])).toEqual([]);
			expect(await raw.get([siblingId])).toHaveLength(1);
			const visible = await adapter.search({ text: "deployment" });
			expect(visible.records.map(({ id }) => id)).toEqual([healthy.id]);
		} finally {
			try {
				await adapter?.close();
				await sync?.close();
				await store.close();
			} finally {
				try {
					compose(project, "down", "-v");
				} finally {
					removeFixture(root, temporary);
				}
			}
		}
	},
	70_000,
);
