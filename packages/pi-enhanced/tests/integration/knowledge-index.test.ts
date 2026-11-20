import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import type { DocumentVectorPayload } from "../../src/knowledge/vector.ts";
import { MemoryWorkerError } from "../../src/shared/embedding/python-worker-client.ts";
import { QdrantError, type VectorIndex, type VectorWrite } from "../../src/shared/vector/qdrant.ts";

let root: string;
const services: KnowledgeService[] = [];
const host = { audience: "host" } as const;
const agent = { audience: "agent" } as const;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-knowledge-index-"));
});
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	rmSync(root, { recursive: true, force: true });
});

function fixture(projectId = "fixture", revision = "r1") {
	const points = new Map<string, VectorWrite<DocumentVectorPayload>>();
	const encodeCalls: string[][] = [];
	const options = { unavailable: false, failUpsert: false, failDelete: false, embeddingUnavailable: false };
	const index: VectorIndex<DocumentVectorPayload> = {
		async ensure() {
			if (options.unavailable) throw new QdrantError("qdrant-unavailable");
		},
		async upsert(writes) {
			for (const point of writes) {
				points.set(point.id, point);
				if (options.failUpsert) throw new QdrantError("qdrant-timeout");
			}
		},
		async delete(ids) {
			if (options.failDelete) throw new QdrantError("qdrant-unavailable");
			ids.forEach((id) => points.delete(id));
		},
		async search() {
			if (options.unavailable) throw new QdrantError("qdrant-unavailable");
			// Deliberately returns records without honoring filters to verify SQLite is authoritative.
			return [...points.values()].map((point) => ({ ...point, score: 0.95 }));
		},
		async get(ids) { return ids.flatMap((id) => points.get(id) ?? []); },
		async scroll() { return { points: [...points.values()] }; },
	};
	const database = join(root, "documents.sqlite3");
	const open = (modelRevision = revision) => {
		const service = new KnowledgeService({
			projectId, filename: database, mode: "hybrid", vectors: {
				collection: "fixture_docs", index, embedding: {
					model: { id: "fake", revision: modelRevision, dimensions: 2 },
					async encode(texts, purpose) {
						if (options.embeddingUnavailable) throw new MemoryWorkerError("worker-unavailable", "Offline E5 unavailable");
						if (purpose === "passage") encodeCalls.push([...texts]);
						return texts.map(() => [1, 0]);
					},
				},
			},
		});
		services.push(service);
		return service;
	};
	return { open, options, points, encodeCalls };
}

it("switches only fully indexed versions, retries a partial remote write after reopen, and reuses unchanged embeddings", async () => {
	const f = fixture();
	let service = f.open();
	writeFileSync(join(root, "api.md"), "# Auth\n\nGET /v1/keys requires scope_id.\n\n# Errors\n\nAUTH_403 means missing scope.");
	const { documentId } = await service.add(root, "api.md", "api", "allow-external");
	const first = (await service.search("scope_id", agent, 1)).hits[0];
	const delayed = [...f.points.values()].find(({ payload }) => payload.chunkId === first.chunk.chunkId)!;
	expect(first.document.activeVersion).toBe(1);
	expect((await service.add(root, "api.md", "api", "allow-external")).outcome).toBe("unchanged");
	expect(f.encodeCalls.flat()).toHaveLength(2);
	f.options.failUpsert = true;
	writeFileSync(join(root, "api.md"), "# Auth\n\nPOST /v2/keys requires workspace_id.\n\n# Errors\n\nAUTH_403 means missing scope.");
	await expect(service.add(root, "api.md", "api", "allow-external")).rejects.toMatchObject({ code: "qdrant-timeout" });
	expect(service.list()[0]).toMatchObject({ activeVersion: 1, pendingVersion: 2, error: "qdrant-timeout" });
	const during = await service.search("workspace_id", agent, 10, "semantic");
	expect(during.hits.every((row) => row.chunk.documentVersion === 1)).toBe(true);
	await service.close();
	service = f.open();
	f.options.failUpsert = false;
	await expect(service.sync(documentId)).resolves.toEqual([{ documentId, outcome: "retried" }]);
	expect(f.encodeCalls.flat()).toHaveLength(3);
	const current = await service.search("workspace_id", agent, 1);
	expect(current.hits[0].chunk.documentVersion).toBe(2);
	expect(current.hits[0].chunk.content).toContain("POST /v2/keys");
	expect(() => service.read(first.chunk.chunkId, agent)).toThrow("document-not-found");
	expect((await service.maintain()).cleaned).toBe(1);
	expect([...f.points.values()].every((point) => point.payload.documentVersion === 2)).toBe(true);
	f.points.set(delayed.id, delayed);
	expect((await service.search("scope_id", agent, 10, "semantic")).hits
		.every(({ chunk }) => chunk.documentVersion === 2)).toBe(true);
	expect((await service.maintain()).orphans).toBe(1);
	expect(f.points.has(delayed.id)).toBe(false);
});

it("immediately excludes deleted and private versions in lexical, dense and neighbor reads", async () => {
	const f = fixture();
	const service = f.open();
	writeFileSync(join(root, "public.md"), "# API\n\nUse resolveConfig and scope_id.\n\n# Errors\n\nAUTH_403 未授权。");
	writeFileSync(join(root, "private.md"), "# Private\n\nUse resolveConfig and SECRET_FIELD.");
	const { documentId } = await service.add(root, "public.md", "api", "allow-external");
	const privateDoc = await service.add(root, "private.md", "internal");
	const privateHit = (await service.search("SECRET_FIELD", host, 1, "lexical")).hits[0];
	expect((await service.search("SECRET_FIELD", agent, 10, "lexical")).hits).toEqual([]);
	expect((await service.search("resolveConfig", agent, 10, "semantic")).hits.every(({ document }) => document.documentId === documentId)).toBe(true);
	expect((await service.search("resolveConfig", { ...agent, documentId: privateDoc.documentId }, 10, "hybrid")).hits).toEqual([]);
	expect(() => service.read(privateHit.chunk.chunkId, agent)).toThrow("document-not-found");
	const first = (await service.search("resolveConfig", agent, 1, "lexical")).hits[0];
	expect(service.read(first.chunk.chunkId, agent, 1).adjacent[0].chunk.content).toContain("AUTH_403");
	f.options.failDelete = true;
	await service.remove(documentId);
	expect((await service.search("resolveConfig", agent)).hits).toEqual([]);
	expect(() => service.read(first.chunk.chunkId, agent)).toThrow("document-not-found");
	await expect(service.maintain()).rejects.toMatchObject({ code: "qdrant-unavailable" });
	expect([...f.points.values()].some((point) => point.payload.documentId === documentId)).toBe(true);
	f.options.failDelete = false;
	await service.maintain();
	expect([...f.points.values()].every((point) => point.payload.documentId !== documentId)).toBe(true);
});

it("supports lexical fallback, model revision re-embedding, rebuild and removed source cleanup", async () => {
	const f = fixture();
	let service = f.open();
	const file = join(root, "runbook.md");
	writeFileSync(file, "# 排障\n\n认证错误 AUTH_403 检查 scope_id。");
	const { documentId } = await service.add(root, "runbook.md");
	f.options.unavailable = true;
	expect(await service.search("认证错误", host)).toMatchObject({ mode: "lexical", fallback: "qdrant-unavailable" });
	f.options.unavailable = false;
	f.options.embeddingUnavailable = true;
	await expect(service.search("AUTH_403", host)).resolves.toMatchObject({
		mode: "lexical", fallback: "worker-unavailable", hits: [expect.objectContaining({ source: "runbook.md" })],
	});
	f.options.embeddingUnavailable = false;
	await service.close();
	service = f.open("r2");
	f.options.unavailable = false;
	await expect(service.sync(documentId)).resolves.toEqual([{ documentId, outcome: "updated" }]);
	expect(f.encodeCalls.flat()).toHaveLength(2);
	await expect(service.sync(documentId, true)).resolves.toEqual([{ documentId, outcome: "rebuilt" }]);
	expect(f.encodeCalls.flat()).toHaveLength(2);
	unlinkSync(file);
	await expect(service.sync(documentId)).resolves.toEqual([{ documentId, outcome: "source-deleted" }]);
	await service.maintain();
	expect(f.points.size).toBe(0);
	expect((await service.search("scope_id", host)).hits).toEqual([]);
});

it("revokes external access during a failed update without exposing staged text", async () => {
	const f = fixture();
	const service = f.open();
	const file = join(root, "policy.md");
	writeFileSync(file, "# Policy\n\nexternal_approval existing statement");
	const { documentId } = await service.add(root, "policy.md", "api", "allow-external");
	const first = (await service.search("external_approval", agent, 1, "lexical")).hits[0];
	f.options.failUpsert = true;
	writeFileSync(file, "# Policy\n\ninternal_rule successfully changed");
	await expect(service.add(root, "policy.md", "api", "local-only")).rejects.toMatchObject({ code: "qdrant-timeout" });
	expect(service.list()[0]).toMatchObject({ id: documentId, policy: "local-only", activeVersion: 1, pendingVersion: 2 });
	expect((await service.search("external_approval", agent)).hits).toEqual([]);
	expect(() => service.read(first.chunk.chunkId, agent)).toThrow("document-not-found");
	expect(service.read(first.chunk.chunkId, host).match.chunk.documentVersion).toBe(1);
});

it("checks project ownership of SQLite and deletes orphan points for only its project", async () => {
	const f = fixture();
	const service = f.open();
	writeFileSync(join(root, "doc.md"), "# Scope\n\nscope_key works");
	await service.add(root, "doc.md", "api", "allow-external");
	expect(() => new KnowledgeService({
		projectId: "other", filename: join(root, "documents.sqlite3"), mode: "lexical",
	})).toThrow("Knowledge database belongs to another project");
	const point = [...f.points.values()][0];
	f.points.set("orphan", { ...point, id: "orphan", payload: { ...point.payload, chunkId: "removed" } });
	f.points.set("other-scope", { ...point, id: "other-scope", payload: { ...point.payload, projectId: "foreign" } });
	const result = await service.maintain();
	expect(result.orphans).toBe(1);
	expect(f.points.has("orphan")).toBe(false);
	expect(f.points.has("other-scope")).toBe(true);
	expect((await service.search("scope_key", agent, 5, "semantic")).hits).toHaveLength(1);
});
