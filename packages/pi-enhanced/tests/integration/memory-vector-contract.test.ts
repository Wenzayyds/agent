import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { compose, dockerWorker, reserveLoopbackPort } from "../../fixtures/memory-v3/lab.ts";
import { E5EmbeddingProvider, MULTILINGUAL_E5_SMALL } from "../../src/shared/embedding/e5.ts";
import { QdrantIndex } from "../../src/shared/vector/qdrant.ts";

interface DocumentPayload { schemaVersion: number; document: string; section: string }
function parseDocument(value: unknown): DocumentPayload {
	const item = value as Partial<DocumentPayload> | null;
	if (!item || item.schemaVersion !== 1 || typeof item.document !== "string" || typeof item.section !== "string")
		throw new TypeError("Bad document payload");
	return { schemaVersion: item.schemaVersion, document: item.document, section: item.section };
}

it("classifies local HTTP rate limits, permission, timeout and invalid acknowledgements", async () => {
	let mode = "429";
	const server = createServer((_, response) => {
		if (mode === "timeout") return;
		if (mode === "bad-write") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
				status: "ok", result: { status: "acknowledged" },
			}));
		} else response.writeHead(Number(mode)).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
		const index = new QdrantIndex({ endpoint: "http://127.0.0.1:" + address.port,
			collectionName: "docs", dimensions: 2, timeoutMs: 250, parsePayload: parseDocument });
		const ids = [randomUUID()];
		await expect(index.get(ids)).rejects.toMatchObject({ code: "qdrant-rate-limited", httpStatus: 429 });
		mode = "403";
		await expect(index.get(ids)).rejects.toMatchObject({ code: "qdrant-permission-denied" });
		mode = "timeout";
		await expect(index.get(ids)).rejects.toMatchObject({ code: "qdrant-timeout" });
		mode = "bad-write";
		await expect(index.delete(ids)).rejects.toMatchObject({ code: "qdrant-invalid-response" });
		await expect(index.get(Array.from({ length: 129 }, () => randomUUID()))).rejects.toThrow("128");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

it("checks E5 batch and validates the worker response without a Memory runtime", async () => {
	let calls = 0;
	const provider = new E5EmbeddingProvider(() => ({
		async request(operation, payload) {
			calls++;
			expect(operation).toBe("encode_e5");
			expect(payload?.purpose).toBe("query");
			return { model: MULTILINGUAL_E5_SMALL, vectors: [Array(384).fill(1)] };
		},
		async close() {},
	}));
	await expect(provider.encode(Array(33).fill("too many"), "passage")).rejects.toMatchObject({ code: "invalid-payload" });
	expect(calls).toBe(0);
	expect((await provider.encode(["find ledger"], "query"))[0]).toHaveLength(384);
});

it.runIf(process.env.PI_MEMORY_V3_DOCKER === "1")("encodes and indexes document payloads without Memory in a dedicated collection", async () => {
	const project = "pi-memory-v3-vector-contract-" + randomUUID().slice(0, 8);
	const worker = dockerWorker(process.env.PI_MEMORY_V3_E5_IMAGE ?? "pi-memory-v3-e5:local");
	try {
		await reserveLoopbackPort(project);
		compose(project, "up", "-d", "--wait", "--wait-timeout", "30");
		const endpoint = "http://" + compose(project, "port", "qdrant", "6333");
		const options = { endpoint, dimensions: 384, timeoutMs: 8_000, parsePayload: parseDocument, payloadIndexes: { section: "keyword" } } as const;
		const docs = new QdrantIndex({ ...options, collectionName: "pi_enhanced_docs_v1" });
		const second = new QdrantIndex({ ...options, collectionName: "isolated_docs" });
		await docs.ensure();
		await second.ensure();
		const embedding = new E5EmbeddingProvider(() => worker);
		const [vector, other] = await embedding.encode(["Production rollout needs approval", "The sidebar has icons"], "passage");
		const [query] = await embedding.encode(["Who approves a release?"], "query");
		const id = randomUUID();
		const payload = { schemaVersion: 1, document: "deployment.md", section: "release" };
		const guard = { must: [{ key: "section", match: { value: "release" } }] };
		await docs.upsert([{ id, payload, vector }, {
			id: randomUUID(), vector: other, payload: { ...payload, document: "ui.md", section: "ui" },
		}]);
		expect((await docs.search(query, { limit: 5, filter: guard })).map((hit) => hit.payload)).toEqual([payload]);
		const page = await docs.scroll({ limit: 1 });
		expect(page.points).toHaveLength(1);
		expect((await docs.scroll({ limit: 1, cursor: page.cursor })).points[0].id).not.toBe(page.points[0].id);
		expect(await docs.get([id])).toEqual([{ id, payload }]);
		expect(await second.get([id])).toEqual([]);
		await docs.delete([id]);
		await docs.delete([id]);
		expect(await docs.search(query, { limit: 5, filter: guard })).toEqual([]);
		const strict = await fetch(`${endpoint}/collections/isolated_docs`, {
			method: "PATCH", headers: { "content-type": "application/json" },
			body: JSON.stringify({ strict_mode_config: { enabled: true, read_rate_limit: 1 } }),
		});
		expect(strict.ok, await strict.text()).toBe(true);
		const reads = await Promise.allSettled(Array.from({ length: 4 }, () => second.search(query, { limit: 1 })));
		expect(reads).toContainEqual(expect.objectContaining({
			status: "rejected", reason: expect.objectContaining({ code: "qdrant-rate-limited", httpStatus: 429 }),
		}));
	} finally {
		await worker.close();
		compose(project, "down", "-v");
	}
}, 70_000);
