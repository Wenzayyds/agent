import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { MemoryRecord, NewMemoryInput } from "../../src/memory/contracts.ts";
import type { EmbeddingProvider } from "../../src/memory/embedding-provider.ts";
import { MemoryWorkerError } from "../../src/memory/python-worker-client.ts";
import { QdrantVectorIndex, type MemoryVectorIndex, type MemoryVectorPoint, type VectorRevision } from "../../src/memory/qdrant-vector-index.ts";
import { ScopedMemoryReaderAdapter } from "../../src/memory/reader.ts";
import { SemanticSearchAdapter } from "../../src/memory/semantic-search-adapter.ts";
import { MemoryVectorSync } from "../../src/memory/vector-sync.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { openMemoryService, type MemoryService } from "../../src/memory/service.ts";

const roots: string[] = [];
const stores: MemoryService[] = [];
async function openStore() {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-v3-"));
	roots.push(root);
	const cwd = join(root, "project");
	mkdirSync(cwd);
	const service = await openMemoryService(createProjectScope({ cwd, agentDir: join(root, "agent") }));
	stores.push(service);
	return service;
}

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const source = { type: "user", ref: "manual" } as const;

it("persists five memory types independently of kind and applies task and session isolation", async () => {
	const store = await openStore();
	const other = await openStore();
	const inputs: readonly Partial<NewMemoryInput>[] = [
		{ type: "semantic", scope: { kind: "project" } },
		{ type: "episodic", scope: { kind: "task", id: "task-a" }, data: { outcome: "success" } },
		{ type: "working", scope: { kind: "session", id: "session-a" } },
		{ type: "procedural", scope: { kind: "project" }, data: { conditions: ["linux"] } },
		{ type: "preference", scope: { kind: "project" }, data: { value: false }, metadata: { subjectKey: "verbose" } },
	];
	for (const input of inputs) {
		const record = await store.saveCandidate({ kind: "fact", content: "fixed test setup", source, ...input });
		expect(await store.get(record.id)).toMatchObject({
			type: input.type, scope: input.scope, ...(input.data ? { data: input.data } : {}),
		});
		expect(await other.get(record.id)).toBeNull();
		expect((await store.saveCandidate({ kind: "fact", content: record.content, source, ...input })).id).toBe(record.id);
	}
	const query = { text: "fixed test setup", conditions: ["linux"], statuses: ["candidate"] as const };
	expect((await store.search({ ...query, statuses: [...query.statuses] })).map(({ type }) => type).sort())
		.toEqual(["procedural", "semantic"]);
	expect((await store.search({ ...query, statuses: [...query.statuses], visibility: { taskId: "task-a", sessionId: "session-a" } })).length).toBe(4);
	expect(await store.search({ ...query, statuses: [...query.statuses], types: ["episodic"], visibility: { taskId: "task-b" } })).toEqual([]);
	expect(await other.search({ ...query, statuses: [...query.statuses] })).toEqual([]);
});

it("checks a structured preference, a working scope, and a task origin before saving", async () => {
	const store = await openStore();
	const input = { kind: "fact", content: "test content", source } as const;
	await expect(store.saveCandidate({ ...input, type: "working" })).rejects.toThrow("session scope");
	await expect(store.saveCandidate({ ...input, type: "preference" })).rejects.toThrow("subject key and value");
	await expect(store.saveCandidate({ ...input, scope: { kind: "project" }, source: { ...source, ref: "task:a:experience:1" } })).rejects.toThrow("does not match");
});

async function verify(store: MemoryService, input: NewMemoryInput): Promise<MemoryRecord> {
	const candidate = await store.saveCandidate(input);
	const path = "proof.txt";
	writeFileSync(join(store.scope.rootPath, path), candidate.content);
	return store.verifyFileFact(candidate.id, { relativePath: path, exactExcerpt: candidate.content }, candidate.revision);
}

const config = {
	enabled: true, mode: "hybrid", backend: "e5-qdrant", rerankerEnabled: false,
	startupTimeoutMs: 500, requestTimeoutMs: 500, maximumSnapshotRecords: 2000, semanticCandidates: 30,
} as const;

const embedding: EmbeddingProvider = {
	model: { id: "fixture", revision: "v1", dimensions: 2 },
	encode: async (texts) => texts.map(() => [1, 0]),
};

function fakeIndex(): MemoryVectorIndex & { points: Map<string, MemoryVectorPoint> } {
	const points = new Map<string, MemoryVectorPoint>();
	const key = (projectId: string, ref: VectorRevision) => JSON.stringify([projectId, ref.memoryId, ref.revision]);
	return {
		model: embedding.model,
		points,
		async ensure() { },
		async upsert(batch) { for (const point of batch) points.set(key(point.projectId, point), point); },
		async remove(projectId, revisions) { for (const ref of revisions) points.delete(key(projectId, ref)); },
		async get(projectId, revisions) { return revisions.flatMap((ref) => points.get(key(projectId, ref)) ?? []); },
		async list(projectId, options) {
			return { points: [...points.values()].filter((point) => point.projectId === projectId &&
				(!options?.memoryId || point.memoryId === options.memoryId)) };
		},
		async search(query) {
			return [...points.values()].filter((point) => point.projectId === query.projectId)
				.map(({ vector: _vector, ...point }) => ({ ...point, score: 1 }));
		},
	};
}

it("uses exact preference fields and chronological working reads, with applicability and episode ordering", async () => {
	const store = await openStore();
	const seed = (input: Partial<NewMemoryInput> = {}) => store.saveCandidate({
		kind: "fact", content: "the task note", source, ...input,
	});
	const pref = await seed({ type: "preference", data: { value: false }, metadata: { subjectKey: "verbose" } });
	const query = { statuses: ["candidate"] as ["candidate"] };
	expect((await store.search({ ...query, text: "", preferenceKey: "verbose" }))[0]?.id).toBe(pref.id);
	expect(await store.search({ ...query, text: "the task note", types: ["preference"] })).toEqual([]);
	const updated = await store.updateContent(pref.id, pref.content, pref.revision, { value: true });
	expect(updated).toMatchObject({ contentRevision: 2, data: { value: true } });
	const scope = { kind: "session", id: "s" } as const;
	const recent = await seed({ type: "working", scope, content: "working item two" });
	const database = new DatabaseSync(store.scope.databasePath);
	const older = await seed({ type: "working", scope, content: "working item one" });
	database.prepare("UPDATE memories SET created_at=1 WHERE id=?").run(older.id);
	database.close();
	expect((await store.search({ ...query, text: "", types: ["working"], visibility: { sessionId: "s" } })).map(({ id }) => id))
		.toEqual([older.id, recent.id]);
	const procedure = await seed({ type: "procedural", data: { conditions: ["linux", "docker"] } });
	expect(await store.search({ ...query, text: "task note", types: ["procedural"], conditions: ["linux"] })).toEqual([]);
	expect((await store.search({ ...query, text: "task note", types: ["procedural"], conditions: ["linux", "docker"] }))[0]?.id)
		.toBe(procedure.id);
	const task = { kind: "task", id: "t" } as const;
	const success = await seed({ type: "episodic", scope: task, content: "episode executed", data: { outcome: "success" } });
	const failure = await seed({ type: "episodic", scope: task, content: "episode failed", data: { outcome: "failure" } });
	expect((await store.search({ ...query, text: "episode", order: "successful", visibility: { taskId: "t" } })).map(({ id }) => id))
		.toEqual([success.id, failure.id]);
});

it("keeps durable retries across reopen and refuses an acknowledgement for an obsolete revision", async () => {
	const store = await openStore();
	const record = await verify(store, { kind: "fact", content: "release approval gate", source });
	const [old] = store.vectorOutbox.due(4);
	const peer = await openMemoryService(store.scope);
	stores.push(peer);
	expect(peer.vectorOutbox.due(4)).toEqual([old]);
	peer.vectorOutbox.retry(old, "fixture-interruption");
	expect(store.vectorOutbox.stats()).toEqual({ pending: 1, failed: 1 });
	expect(store.vectorOutbox.due(4)).toEqual([]);
	const archived = await peer.archive(record.id, record.revision);
	expect(store.vectorOutbox.complete(old)).toBe(false);
	expect(store.vectorOutbox.due(4)[0]).toMatchObject({ revision: archived.revision, attempts: 0 });
	const restored = await store.restore(archived.id, archived.revision);
	await expect(peer.delete(restored.id, archived.revision)).rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT" });
	await store.delete(restored.id, restored.revision);
	expect(peer.vectorOutbox.due(4)[0]).toMatchObject({ revision: restored.revision + 1 });
	expect(await peer.get(restored.id)).toBeNull();
});

it("filters residual points, recovers an interrupted sync, and repairs drift and deletion", async () => {
	const store = await openStore();
	const index = fakeIndex();
	const first = await verify(store, { kind: "fact", content: "release approval gate", source });
	const originalUpsert = index.upsert;
	index.upsert = async () => { throw new Error("write interrupted"); };
	const sync = new MemoryVectorSync(store, index, embedding);
	await expect(sync.flush()).rejects.toThrow("write interrupted");
	expect(store.vectorOutbox.stats().failed).toBe(1);
	index.upsert = originalUpsert;
	const retired = await store.archive(first.id, first.revision);
	const restored = await store.restore(retired.id, retired.revision);
	await sync.flush();
	expect([...index.points.values()][0]?.revision).toBe(restored.revision);
	await store.delete(restored.id, restored.revision);
	const adapter = new SemanticSearchAdapter({ service: store, config, embedding, vectorIndex: index });
	try {
		// Let query receive a physically retained point even if the delete request silently drops.
		const oldRemove = index.remove;
		index.remove = async () => { };
		const result = await adapter.search({ text: "release approval" });
		expect(result.records).toEqual([]);
		expect((await adapter.diagnoseIndex())?.orphanIds).toEqual([first.id]);
		index.remove = oldRemove;
		const repair = new MemoryVectorSync(store, index, embedding);
		await repair.flush();
		expect(index.points.size).toBe(0);
		await repair.close();
	} finally {
		await adapter.close();
		await sync.close();
	}
});

it("falls back through FTS when the model cannot load and reports invalid file evidence", async () => {
	const store = await openStore();
	const record = await verify(store, { kind: "fact", content: "local approval gate", source });
	const index = fakeIndex();
	const failing: EmbeddingProvider = { ...embedding, encode: async () => { throw new MemoryWorkerError("model-not-installed", "fixture"); } };
	const adapter = new SemanticSearchAdapter({ service: store, config, embedding: failing, vectorIndex: index });
	try {
		const result = await adapter.search({ text: "local approval" });
		expect(result).toMatchObject({ mode: "lexical", fallbackReason: "model-not-installed" });
		expect(result.records.map(({ id }) => id)).toEqual([record.id]);
		rmSync(join(store.scope.rootPath, "proof.txt"));
		const doctor = await store.doctor({ maximumScanRecords: 100, nearDuplicatePercent: 82, archiveAfterDays: 180, coreWarningBytes: 8192 });
		expect(doctor.invalidEvidenceIds).toEqual([record.id]);
		expect(await store.getVisible(record.id)).toBeNull();
		expect((await store.reflectFileEvidence(record.id, record.revision)).status).toBe("stale");
	} finally {
		await adapter.close();
	}
});

it("keeps a late write from replacing or deleting a newer vector revision", async () => {
	const store = await openStore();
	const index = fakeIndex();
	const old = await verify(store, { kind: "fact", content: "old approval gate", source });
	const upsert = index.upsert;
	let resume!: () => void;
	const hold = new Promise<void>((resolve) => { resume = resolve; });
	let reached!: () => void;
	const started = new Promise<void>((resolve) => { reached = resolve; });
	index.upsert = async (points) => {
		if (points.some((point) => point.revision === old.revision)) {
			reached();
			await hold;
		}
		await upsert(points);
	};
	const firstSync = new MemoryVectorSync(store, index, embedding);
	const secondSync = new MemoryVectorSync(store, index, embedding);
	const lateWrite = firstSync.flush();
	try {
		await started;
		const update = await store.updateContent(old.id, "new approval gate", old.revision);
		writeFileSync(join(store.scope.rootPath, "proof.txt"), update.content);
		const current = await store.verifyFileFact(update.id, { relativePath: "proof.txt", exactExcerpt: update.content }, update.revision);
		await secondSync.flush();
		resume();
		await lateWrite;
		expect([...index.points.values()].map(({ revision }) => revision)).toEqual([current.revision, old.revision]);
		const adapter = new SemanticSearchAdapter({ service: store, config, embedding, vectorIndex: index });
		try {
			const result = await adapter.search({ text: "approval gate" });
			expect(result.records.map(({ revision }) => revision)).toEqual([current.revision]);
		} finally { await adapter.close(); }
	} finally {
		resume();
		await firstSync.close();
		await secondSync.close();
	}
});

it("keeps competing subject values as separate candidates and audits mutations", async () => {
	const store = await openStore();
	const input = { type: "preference", kind: "decision", source,
		metadata: { subjectKey: "view.detail" }, data: { value: "compact" } } as const;
	const verified = await verify(store, { ...input, content: "Use compact detail" });
	const conflicting = await store.saveCandidate({ ...input, data: { value: "expanded" }, content: "Use expanded detail" });
	expect(conflicting.status).toBe("candidate");
	const report = await store.doctor({ maximumScanRecords: 20, nearDuplicatePercent: 75, archiveAfterDays: 14, coreWarningBytes: 2048 });
	expect([...(report.conflictGroups[0] ?? [])].sort()).toEqual([conflicting.id, verified.id].sort());
	await expect(store.saveCandidate({ ...input, data: { value: "expanded" }, content: verified.content }))
		.rejects.toMatchObject({ code: "MEMORY_CONTENT_CONFLICT" });
	const updated = await store.updateContent(conflicting.id, "Use full detail", conflicting.revision, { value: "full" });
	const archived = await store.archive(updated.id, updated.revision);
	const restored = await store.restore(archived.id, archived.revision);
	await store.delete(restored.id, restored.revision);
	const db = new DatabaseSync(store.scope.databasePath, { readOnly: true });
	try {
		const audit = db.prepare("SELECT action, after_json FROM memory_governance_audit WHERE memory_id=? ORDER BY rowid")
			.all(conflicting.id) as { action: string; after_json: string }[];
		expect(audit.map(({ action }) => action)).toEqual(["candidate_created", "content_changed", "archived", "restored", "deleted"]);
		expect(JSON.parse(audit[0].after_json)).toMatchObject({ possibleConflictId: verified.id });
		expect(JSON.parse(audit[4].after_json)).toMatchObject({ deleted: true, revision: restored.revision + 1 });
	} finally {
		db.close();
	}
});

it("validates loopback endpoints before creating an HTTP client", () => {
	for (const endpoint of ["https://127.0.0.1:6333", "http://127.0.0.1.example.org", "http://127.0.0.1:6333?q=1"]) {
		expect(() => new QdrantVectorIndex({ model: embedding.model, endpoint })).toThrow("loopback HTTP origin");
	}
});

it("retries the same SQLite revision after the configured backoff", async () => {
	const store = await openStore();
	const current = await verify(store, { kind: "fact", content: "retry unchanged revision", source });
	const index = fakeIndex();
	const upsert = index.upsert;
	index.upsert = async () => { throw new Error("fixture write unavailable"); };
	const sync = new MemoryVectorSync(store, index, embedding);
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const before = Date.now();
		await expect(sync.flush()).rejects.toThrow("fixture write unavailable");
		expect(store.vectorOutbox.due(4)).toEqual([]);
		vi.setSystemTime(before + 1_001);
		expect(store.vectorOutbox.due(4)[0]).toMatchObject({ revision: current.revision, attempts: 1 });
		index.upsert = upsert;
		await sync.flush();
		expect(store.vectorOutbox.stats()).toEqual({ pending: 0, failed: 0 });
		expect([...index.points.values()][0]).toMatchObject({ memoryId: current.id, revision: current.revision });
	} finally {
		vi.useRealTimers();
		await sync.close();
	}
});

it("binds reader task visibility to the host and creates a separate reverified project candidate", async () => {
	const store = await openStore();
	const task = await verify(store, { kind: "experience", type: "episodic", scope: { kind: "task", id: "task-1" },
		source, content: "reviewed task knowledge" });
	let taskId = "task-10";
	const reader = new ScopedMemoryReaderAdapter(store, undefined, "session-1", async () => ({ taskId }));
	const forged = { taskId: "task-1", sessionId: "session-10" };
	expect(await reader.get(task.id, forged)).toBeNull();
	expect(await reader.search({ text: "reviewed task", visibility: forged })).toEqual([]);
	taskId = "task-1";
	expect((await reader.get(task.id))?.id).toBe(task.id);
	const ctx = { hasUI: true, ui: { confirm: async () => true },
		sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionCommandContext;
	const candidate = await store.proposeProjectPromotion(task.id, task.revision, "reuse after review", ctx);
	expect(candidate).toMatchObject({ scope: { kind: "project" }, status: "candidate" });
	expect((await store.inspect(candidate.id)).relations).toContainEqual(expect.objectContaining({
		targetMemoryId: task.id, relation: "derived_from",
	}));
	expect(await store.getVisible(candidate.id)).toBeNull();
	await store.confirmByUser(candidate.id, candidate.revision, ctx);
	expect((await store.getVisible(candidate.id))?.id).toBe(candidate.id);
	reader.close();
	await expect(reader.get(task.id)).rejects.toMatchObject({ code: "MEMORY_RUNTIME_CLOSED" });
});

it("keeps edit provenance and withdraws evidence on an actual hash change", async () => {
	const store = await openStore();
	const original = await verify(store, { kind: "fact", source, content: "reviewed syntax rule" });
	writeFileSync(join(store.scope.rootPath, "proof.txt"), original.content + "\nchanged surroundings");
	expect(await store.getVisible(original.id)).toBeNull();
	const rejected = await store.reflectFileEvidence(original.id, original.revision);
	expect(rejected.status).toBe("stale");
	const change = { source: { type: "user", ref: "review:edit-1" }, reason: "correct the rule" } as const;
	const revised = await store.updateContent(rejected.id, "new syntax rule", rejected.revision, undefined, change);
	expect(revised).toMatchObject({ status: "candidate", contentRevision: original.contentRevision + 1 });
	expect(revised.sources).toContainEqual(expect.objectContaining(change.source));
	const db = new DatabaseSync(store.scope.databasePath, { readOnly: true });
	try {
		const event = db.prepare("SELECT after_json FROM memory_governance_audit WHERE memory_id=? AND action='content_changed'")
			.get(revised.id) as { after_json: string };
		expect(JSON.parse(event.after_json)).toMatchObject({ change });
	} finally { db.close(); }
});

it("keeps working TTL and bindings exact, filters episode evidence and resolves explicit preference conflicts", async () => {
	const store = await openStore();
	const ctx = { hasUI: true, ui: { confirm: async () => true },
		sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionCommandContext;
	const seed = async (input: NewMemoryInput) => {
		const record = await store.saveCandidate(input);
		return store.confirmByUser(record.id, record.revision, ctx);
	};
	const session = { kind: "session", id: "session-1" } as const;
	const working = { kind: "fact", type: "working", scope: session, content: "resume notes", source } as const;
	const one = await seed({ ...working, data: { taskId: "task-1" }, metadata: { importance: 3 } });
	const two = await seed({ ...working, data: { taskId: "task-10" } });
	const expired = await seed({ ...working, content: "expired notes", metadata: { validUntil: 1 } });
	expect(one.validUntil).toBeGreaterThan(one.createdAt);
	expect(two.id).not.toBe(one.id);
	expect(await store.getVisible(expired.id, { sessionId: session.id })).toBeNull();
	const view = { sessionId: session.id, taskId: "task-1" };
	expect((await store.search({ text: "", types: ["working"], visibility: view, order: "priority" })).map(({ id }) => id)).toEqual([one.id]);
	expect(await store.search({ text: "", types: ["working"], visibility: { sessionId: "session-10", taskId: "task-1" } })).toEqual([]);
	await expect(store.updateContent(one.id, "changed", one.revision, { taskId: "task-10" }))
		.rejects.toMatchObject({ code: "MEMORY_VALIDATION_ERROR" });

	const event = await seed({ kind: "experience", type: "episodic", content: "release followup", source,
		scope: { kind: "task", id: "task-1" }, data: { outcome: "failure", occurredAt: 150, causes: ["test:case-7"] } });
	expect((await store.search({ text: "release", visibility: view, episodeOutcome: "failure",
		occurredAfter: 100, occurredBefore: 200 }))[0]?.data).toEqual(event.data);
	expect(await store.search({ text: "release", visibility: view, episodeOutcome: "success" })).toEqual([]);
	expect(await store.search({ text: "release", visibility: view, occurredBefore: 150 })).toEqual([]);

	const procedure = await seed({ kind: "experience", type: "procedural", content: "run release check", source,
		data: { conditions: ["platform:linux", "tool:read"], prerequisites: ["configured test root"], steps: ["read the manifest", "verify the digest"] } });
	let conditions = ["platform:win32", "tool:read"];
	const reader = new ScopedMemoryReaderAdapter(store, undefined, session.id, async () => ({ ...view, conditions }));
	expect(await reader.search({ text: "release check", conditions: ["platform:linux", "tool:read"] })).toEqual([]);
	expect(await reader.get(procedure.id)).toBeNull();
	conditions = ["platform:linux", "tool:read"];
	expect((await reader.search({ text: "release check" }))[0]?.data?.steps).toEqual(procedure.data?.steps);

	const prefix = { kind: "decision", type: "preference", source, metadata: { subjectKey: "view.detail" } } as const;
	const first = await seed({ ...prefix, content: "use compact view", data: { value: "compact" } });
	await new Promise((resolve) => setTimeout(resolve, 4));
	const last = await seed({ ...prefix, content: "use expanded view", data: { value: "expanded" } });
	const lookup = { text: "", preferenceKey: "view.detail" };
	expect((await store.search(lookup)).map(({ id }) => id)).toEqual([last.id]);
	await store.review(last.id, "mark_stale", last.revision, "user revoked");
	expect((await store.search(lookup)).map(({ id }) => id)).toEqual([first.id]);
	expect(await store.search({ text: "", preferenceKey: "view" })).toEqual([]);
});

it("replays a partially acknowledged vector batch without duplicate points", async () => {
	const store = await openStore();
	const first = await verify(store, { kind: "fact", content: "batch first verified text", source });
	const nextSource = "other-proof.txt";
	writeFileSync(join(store.scope.rootPath, nextSource), "batch second verified text");
	const candidate = await store.saveCandidate({ kind: "fact", content: "batch second verified text", source });
	const second = await store.verifyFileFact(candidate.id, { relativePath: nextSource, exactExcerpt: candidate.content }, candidate.revision);
	const index = fakeIndex();
	const upsert = index.upsert;
	index.upsert = async (points) => {
		await upsert(points.slice(0, 1));
		throw new Error("connection interrupted after partial write");
	};
	const sync = new MemoryVectorSync(store, index, embedding);
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const before = Date.now();
		await expect(sync.flush()).rejects.toThrow("partial write");
		expect(index.points.size).toBe(1);
		expect(store.vectorOutbox.stats().failed).toBe(2);
		vi.setSystemTime(before + 1001);
		index.upsert = upsert;
		await sync.reconcileNow();
		expect([...index.points.values()].map(({ memoryId }) => memoryId).sort()).toEqual([first.id, second.id].sort());
		expect(store.vectorOutbox.stats().failed).toBe(0);
	} finally {
		vi.useRealTimers();
		await sync.close();
	}
});

it("re-reads the authoritative revision before returning a peer Reader result", async () => {
	const store = await openStore();
	const record = await verify(store, { kind: "fact", content: "late archive fixture", source });
	let reads = 0;
	const reader = new ScopedMemoryReaderAdapter(store, undefined, undefined, async () => {
		if (++reads === 2) await store.archive(record.id, record.revision);
		return {};
	});
	expect(await reader.search({ text: "late archive" })).toEqual([]);
});
