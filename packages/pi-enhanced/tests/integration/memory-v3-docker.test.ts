import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compose, dockerWorker, reserveLoopbackPort } from "../../fixtures/memory-v3/lab.ts";
import { E5EmbeddingProvider } from "../../src/memory/embedding-provider.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { QdrantVectorIndex, vectorPointId } from "../../src/memory/qdrant-vector-index.ts";
import { SemanticSearchAdapter } from "../../src/memory/semantic-search-adapter.ts";
import { openMemoryService } from "../../src/memory/service.ts";

const run = process.env.PI_MEMORY_V3_DOCKER === "1";
const image = process.env.PI_MEMORY_V3_E5_IMAGE ?? "pi-memory-v3-e5:local";

it.runIf(run)("E5 and Qdrant use isolated local resources and recover after Qdrant restarts", async () => {
	const project = `pi-memory-v3-test-${randomUUID().slice(0, 8)}`;
	const root = mkdtempSync(join(tmpdir(), "pi-memory-v3-docker-"));
	const store = await openMemoryService(createProjectScope({ cwd: root, agentDir: join(root, "agent") }));
	const worker = dockerWorker(image);
	let adapter: SemanticSearchAdapter | undefined;
	try {
		await reserveLoopbackPort(project);
		compose(project, "up", "-d", "--wait", "--wait-timeout", "30");
		const address = compose(project, "port", "qdrant", "6333");
		expect(address).toMatch(/^127\.0\.0\.1:\d+$/u);
		const endpoint = `http://${address}`;
		const embedding = new E5EmbeddingProvider(() => worker);
		const collection = "test_" + randomUUID().replaceAll("-", "");
		const index = new QdrantVectorIndex({ model: embedding.model, collection, endpoint, timeoutMs: 8_000 });
		const seed = async (body: string, taskId?: string) => {
			const content = body;
			const ref = `${randomUUID()}.txt`;
			writeFileSync(join(root, ref), content);
			const candidate = await store.saveCandidate({
				kind: "fact", type: taskId ? "episodic" : "semantic",
				scope: taskId ? { kind: "task", id: taskId } : { kind: "project" },
				content, source: { type: "file", ref },
			});
			return store.verifyFileFact(candidate.id, { relativePath: ref, exactExcerpt: content }, candidate.revision);
		};
		const semantic = await seed("Redis automatically removes cached items when their lifetime ends.");
		const chinese = await seed("\u751f\u4ea7\u53d1\u5e03\u5fc5\u987b\u7ecf\u8fc7\u4eba\u5de5\u5ba1\u6279\u3002");
		const privateMemory = await seed("Database recovery uses archived transaction logs.", "task-a");
		await seed("Dashboard icons use blue accents.");
		const config = { enabled: true, backend: "e5-qdrant", mode: "hybrid", maximumSnapshotRecords: 100,
			rerankerEnabled: false, startupTimeoutMs: 20_000, requestTimeoutMs: 20_000, semanticCandidates: 10 } as const;
		adapter = new SemanticSearchAdapter({ service: store, embedding, vectorIndex: index, config });

		const paraphrase = await adapter.search({ text: "How do stale cache entries get evicted?" });
		expect(paraphrase, JSON.stringify(paraphrase)).toMatchObject({ mode: "hybrid" });
		expect(paraphrase.records[0]?.id).toBe(semantic.id);
		const bilingual = await adapter.search({ text: "Who needs to authorize a production rollout?" });
		expect(bilingual.records[0]?.id).toBe(chinese.id);
		const localized = await adapter.search({ text: "\u8c01\u80fd\u6279\u51c6\u4e0a\u7ebf\uff1f" });
		expect(localized.records[0]?.id).toBe(chinese.id);
		const [vector] = await embedding.encode(["restore database from transaction history"], "query");
		expect((await index.search({ projectId: store.scope.projectId, vector, visibility: { taskId: "task-b" },
			types: ["episodic"], limit: 10 }))).toEqual([]);
		expect((await index.search({ projectId: store.scope.projectId, vector, visibility: { taskId: "task-a" },
			types: ["episodic"], limit: 10 }))[0]?.memoryId).toBe(privateMemory.id);
		expect(await index.search({ projectId: "other-project", vector, limit: 10 })).toEqual([]);
		const point = { memoryId: "fixture-procedure", projectId: store.scope.projectId, type: "procedural",
			scope: { kind: "project" }, revision: 1, contentRevision: 1, contentHash: "sha", vector,
			conditions: ["linux", "docker"] } as const;
		await index.upsert([point, { ...point, memoryId: "expired-fixture", validUntil: Date.now() - 1 }]);
		const procedural = { projectId: store.scope.projectId, vector, types: ["procedural"], limit: 10 } as const;
		expect(await index.search(procedural)).toEqual([]);
		expect(await index.search({ ...procedural, conditions: ["linux"] })).toEqual([]);
		expect((await index.search({ ...procedural, conditions: ["linux", "docker"] })).map(({ memoryId }) => memoryId))
			.toEqual([point.memoryId]);
		const otherModel = new QdrantVectorIndex({ model: { ...embedding.model, revision: "fixture-alternate" }, collection, endpoint, timeoutMs: 8_000 });
		expect(await otherModel.search(procedural)).toEqual([]);
		const wrongDimensions = new QdrantVectorIndex({ model: { ...embedding.model, dimensions: 2 }, collection, endpoint, timeoutMs: 8_000 });
		await expect(wrongDimensions.ensure()).rejects.toMatchObject({ code: "qdrant-incompatible-collection" });
		const raw = await fetch(endpoint + "/collections/" + collection + "/points/" + vectorPointId(store.scope.projectId, point, embedding.model));
		const { result } = await raw.json() as { result: { payload: object } };
		expect(Object.keys(result.payload)).not.toContain("content");
		await index.remove(store.scope.projectId, [point, { ...point, memoryId: "expired-fixture" }]);

		const archived = await store.archive(semantic.id, semantic.revision);
		await adapter.search({ text: "cache" });
		expect(await index.get(store.scope.projectId, [{ memoryId: semantic.id, revision: semantic.revision }])).toEqual([]);
		const restored = await store.restore(archived.id, archived.revision);
		await adapter.search({ text: "cache" });
		expect(await index.get(store.scope.projectId, [{ memoryId: restored.id, revision: restored.revision }])).toHaveLength(1);
		expect(vectorPointId(store.scope.projectId, { memoryId: semantic.id, revision: semantic.revision }, index.model))
			.not.toBe(vectorPointId(store.scope.projectId, { memoryId: restored.id, revision: restored.revision }, index.model));

		compose(project, "stop", "qdrant");
		const fallback = await adapter.search({ text: "Redis automatically" });
		expect(fallback).toMatchObject({ mode: "lexical", fallbackReason: "qdrant-unavailable" });
		expect(fallback.records[0]?.id).toBe(semantic.id);
		await store.delete(restored.id, restored.revision);
		compose(project, "up", "-d", "--wait", "--wait-timeout", "30");
		const recovered = await adapter.search({ text: "Who needs to authorize a production rollout?" });
		expect(recovered, JSON.stringify(recovered)).toMatchObject({ mode: "hybrid" });
		expect(recovered.records[0]?.id).toBe(chinese.id);
		expect(await index.get(store.scope.projectId, [{ memoryId: semantic.id, revision: restored.revision }])).toEqual([]);

		const unprovisioned = dockerWorker(image, undefined, "/empty-model-cache");
		const withoutModel = new SemanticSearchAdapter({ service: store, vectorIndex: index,
			workerFactory: () => unprovisioned, config });
		try {
			const lexical = await withoutModel.search({ text: "生产发布" });
			expect(lexical).toMatchObject({ mode: "lexical", fallbackReason: "model-not-installed" });
			expect(lexical.records[0]?.id).toBe(chinese.id);
		} finally { await withoutModel.close(); }

		// This collection is scoped to the temporary Compose project and contains derived points only.
		const deletedCollection = await fetch(`${endpoint}/collections/${collection}`, { method: "DELETE" });
		expect(deletedCollection.ok).toBe(true);
		await deletedCollection.body?.cancel();
		await adapter.search({ text: "生产发布" }); // Observe a lost collection if the readiness cache is still warm.
		const repair = await adapter.reconcileIndex();
		expect(repair).toMatchObject({ missingIds: [], orphanIds: [] });
		const rebuilt = await adapter.search({ text: "Who needs to authorize a production rollout?" });
		expect(rebuilt).toMatchObject({ mode: "hybrid" });
		expect(rebuilt.records[0]?.id).toBe(chinese.id);

		// The same service reachable by the host is unreachable in a network-disabled container.
		const probe = [
			"import sys, urllib.error, urllib.request",
			"try: urllib.request.urlopen(sys.argv[1], timeout=2)",
			"except urllib.error.URLError: sys.exit(0)",
			"sys.exit('Qdrant was reachable without networking')",
		].join("\n");
		execFileSync("docker", ["run", "--rm", "--network", "none", image, "python", "-c", probe,
			"http://host.docker.internal:" + address.split(":").at(-1) + "/readyz"],
			{ stdio: "pipe", timeout: 15_000 });
	} finally {
		await adapter?.close();
		await worker.close();
		await store.close();
		compose(project, "down", "-v");
		rmSync(root, { recursive: true, force: true });
	}
}, 100_000);
