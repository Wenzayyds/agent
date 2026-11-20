import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryIntelligenceConfig } from "../../src/memory/config.ts";
import type { MemoryKind, MemoryRecord, ProjectScope } from "../../src/memory/contracts.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { LocalMemoryProvider } from "../../src/memory/provider.ts";
import type { MemoryWorkerClientLike, MemoryWorkerOperation } from "../../src/memory/python-worker-client.ts";
import { SemanticSearchAdapter } from "../../src/memory/semantic-search-adapter.ts";
import { MemoryService } from "../../src/memory/service.ts";
import { ensureProjectStorage } from "../../src/memory/storage.ts";

const tempDirs: string[] = [];
const services: MemoryService[] = [];

function config(mode: "semantic" | "hybrid"): MemoryIntelligenceConfig {
	return {
		enabled: true,
		mode,
		rerankerEnabled: false,
		startupTimeoutMs: 500,
		requestTimeoutMs: 500,
		maximumSnapshotRecords: 100,
		semanticCandidates: 10,
	};
}

function createService(): { service: MemoryService; provider: LocalMemoryProvider; scope: ProjectScope } {
	const root = mkdtempSync(join(tmpdir(), "pi-enhanced-intelligence-"));
	tempDirs.push(root);
	const project = join(root, "project");
	mkdirSync(project);
	const scope = createProjectScope({ cwd: project, agentDir: join(root, "agent") });
	ensureProjectStorage(scope);
	const provider = new LocalMemoryProvider(scope);
	const service = new MemoryService(scope, provider);
	services.push(service);
	return { service, provider, scope };
}

async function addMemory(
	provider: LocalMemoryProvider,
	content: string,
	status: "candidate" | "verified" = "verified",
	kind: MemoryKind = "fact",
): Promise<MemoryRecord> {
	const normalized = content.normalize("NFKC").replace(/\s+/gu, " ").trim();
	const candidate = await provider.saveCandidate({
		kind,
		content,
		normalizedContent: normalized,
		contentHash: createHash("sha256").update(normalized).digest("hex"),
		source: { type: "test", ref: "memory-intelligence.test.ts", observedAt: Date.now() },
		now: Date.now(),
	});
	if (status === "candidate") return candidate;
	return provider.setStatus({
		id: candidate.id,
		status: "verified",
		verification: {
			id: randomUUID(),
			type: "test_passed",
			evidenceRef: "memory-intelligence.test.ts",
			evidenceVersion: "v1",
			verifiedAt: Date.now(),
		},
		expectedRevision: candidate.revision,
		now: Date.now(),
	});
}

class FakeWorker implements MemoryWorkerClientLike {
	readonly snapshots: unknown[] = [];
	constructor(private readonly candidates: readonly Record<string, unknown>[] | Error) {}

	async request(operation: MemoryWorkerOperation, payload: Readonly<Record<string, unknown>> = {}) {
		if (this.candidates instanceof Error) throw this.candidates;
		if (operation === "sync_snapshot") {
			this.snapshots.push(payload.records);
			return { modelId: "test-vector-v1", recordCount: Array.isArray(payload.records) ? payload.records.length : 0 };
		}
		if (operation === "search_vectors") return { candidates: this.candidates, recordCount: this.candidates.length };
		return { status: "ready" };
	}

	async close() {}
}

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P2-8 TypeScript memory intelligence authority", () => {
	it("sends only verified records and revalidates worker IDs, revisions and hashes", async () => {
		const { service, provider } = createService();
		const valid = await addMemory(provider, "release controls protect production deployment", "verified", "decision");
		const stale = await addMemory(provider, "old deployment note");
		await addMemory(provider, "candidate must stay out", "candidate");
		const worker = new FakeWorker([
			{
				memoryId: stale.id,
				score: 0.99,
				contentRevision: stale.contentRevision,
				contentHash: "0".repeat(64),
			},
			{
				memoryId: valid.id,
				score: 0.8,
				contentRevision: valid.contentRevision,
				contentHash: valid.contentHash,
			},
		]);
		const adapter = new SemanticSearchAdapter({ service, config: config("semantic"), workerFactory: () => worker });
		const result = await adapter.search({ text: "operator authorization", kinds: ["decision"] });
		expect(result.records.map((record) => record.id)).toEqual([valid.id]);
		expect(worker.snapshots[0]).toHaveLength(1);
		expect(adapter.status).toMatchObject({ state: "ready", activeMode: "semantic", modelId: "test-vector-v1" });
		await adapter.close();
	});

	it("combines lexical and vector rankings with deterministic reciprocal-rank fusion", async () => {
		const { service, provider } = createService();
		const lexicalFirst = await addMemory(provider, "release gate alpha");
		const lexicalSecond = await addMemory(provider, "release gate beta");
		const semanticOnly = await addMemory(provider, "operator approval workflow");
		const worker = new FakeWorker([
			{
				memoryId: semanticOnly.id,
				score: 0.9,
				contentRevision: semanticOnly.contentRevision,
				contentHash: semanticOnly.contentHash,
			},
			{
				memoryId: lexicalFirst.id,
				score: 0.8,
				contentRevision: lexicalFirst.contentRevision,
				contentHash: lexicalFirst.contentHash,
			},
		]);
		const adapter = new SemanticSearchAdapter({ service, config: config("hybrid"), workerFactory: () => worker });
		const result = await adapter.search({ text: "release gate", limit: 3 });
		expect(result.mode).toBe("hybrid");
		expect(result.records.map((record) => record.id)).toEqual(
			expect.arrayContaining([lexicalFirst.id, lexicalSecond.id, semanticOnly.id]),
		);
		expect(result.records[0]?.id).toBe(lexicalFirst.id);
		await adapter.close();
	});

	it("automatically falls back to FTS5 when the Python worker fails", async () => {
		const { service, provider } = createService();
		const record = await addMemory(provider, "fallback token is indexed by SQLite FTS5");
		const worker = new FakeWorker(new Error("python unavailable"));
		const adapter = new SemanticSearchAdapter({ service, config: config("hybrid"), workerFactory: () => worker });
		const result = await adapter.search({ text: "fallback token" });
		expect(result).toMatchObject({ mode: "lexical", fallbackReason: "memory-intelligence-error" });
		expect(result.records.map(({ id }) => id)).toEqual([record.id]);
		expect(adapter.status).toMatchObject({ state: "degraded", activeMode: "lexical" });
		await adapter.close();
	});

	it("discards a failed worker and rebuilds the snapshot on the next query", async () => {
		const { service, provider } = createService();
		const record = await addMemory(provider, "recovery record for semantic worker");
		const failed = new FakeWorker(new Error("first worker failed"));
		const recovered = new FakeWorker([
			{
				memoryId: record.id,
				score: 0.8,
				contentRevision: record.contentRevision,
				contentHash: record.contentHash,
			},
		]);
		const workers = [failed, recovered];
		const adapter = new SemanticSearchAdapter({
			service,
			config: config("semantic"),
			workerFactory: () => workers.shift() ?? recovered,
		});
		expect(await adapter.search({ text: "recovery record" })).toMatchObject({
			mode: "lexical",
			fallbackReason: "memory-intelligence-error",
		});
		expect((await adapter.search({ text: "unrelated semantic query" })).records.map(({ id }) => id)).toEqual([
			record.id,
		]);
		expect(recovered.snapshots).toHaveLength(1);
		expect(adapter.status.state).toBe("ready");
		await adapter.close();
	});

	it("does not let a stale Python candidate revive a deleted authoritative record", async () => {
		const { service, provider } = createService();
		const record = await addMemory(provider, "deleted vector result must stay deleted");
		const worker = new FakeWorker([
			{
				memoryId: record.id,
				score: 0.99,
				contentRevision: record.contentRevision,
				contentHash: record.contentHash,
			},
		]);
		await service.delete(record.id, record.revision);
		const adapter = new SemanticSearchAdapter({ service, config: config("semantic"), workerFactory: () => worker });
		const result = await adapter.search({ text: "deleted vector result" });
		expect(result).toMatchObject({ mode: "semantic", records: [] });
		expect(await service.get(record.id)).toBeNull();
		await adapter.close();
	});
});
