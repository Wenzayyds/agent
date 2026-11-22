import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { QdrantVectorIndex, vectorPointId } from "../../src/memory/qdrant-vector-index.ts";

const model = { id: "test-model", revision: "v1", dimensions: 2 };
const projectId = "memory-project";
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});

function point(memoryId: string) {
	const ref = { memoryId, revision: 2 };
	return {
		id: vectorPointId(projectId, ref, model),
		score: 0.5,
		payload: {
			...ref,
			projectId,
			modelKey: JSON.stringify([model.id, model.revision, model.dimensions]),
			scopeKey: JSON.stringify(["project"]),
			type: "semantic",
			contentRevision: 1,
			contentHash: "proof",
			validFrom: 0,
			validUntil: Number.MAX_SAFE_INTEGER,
		},
	};
}

async function openIndex(result: (path: string | undefined) => unknown) {
	const server = createServer((request, response) => {
		request.resume();
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ status: "ok", result: result(request.url) }));
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing Qdrant fixture address");
	return new QdrantVectorIndex({ model, endpoint: `http://127.0.0.1:${address.port}` });
}

it("keeps healthy results and distinguishes malformed metadata on an owned point", async () => {
	const healthy = point("healthy");
	const incorrect = point("outdated");
	const malformed = { ...incorrect, payload: { ...incorrect.payload, contentRevision: "v1" } };
	let hits = [malformed, healthy];
	const index = await openIndex((path) => {
		if (path?.endsWith("/scroll")) return { points: [malformed, healthy], next_page_offset: healthy.id };
		if (path?.endsWith("/query")) return { points: hits };
		return [malformed];
	});
	await expect(index.search({ projectId, vector: [1, 0], limit: 2 })).resolves.toMatchObject([
		{ memoryId: "healthy", revision: 2 },
	]);
	await expect(index.list(projectId)).resolves.toMatchObject({
		points: [{ memoryId: "healthy" }],
		invalid: [{ memoryId: "outdated", revision: 2 }],
		cursor: healthy.id,
	});
	await expect(index.get(projectId, [{ memoryId: "outdated", revision: 2 }])).resolves.toEqual([]);
	hits = [healthy, incorrect];
	await expect(index.search({ projectId, vector: [1, 0], limit: 2 })).resolves.toMatchObject([
		{ memoryId: "healthy" },
		{ memoryId: "outdated" },
	]);
	hits = [malformed];
	await expect(index.search({ projectId, vector: [1, 0], limit: 2 })).rejects.toMatchObject({
		code: "qdrant-invalid-response",
	});
	hits = [];
	await expect(index.search({ projectId, vector: [1, 0], limit: 2 })).resolves.toEqual([]);
});

it("rejects a conflicting project or point identity and unexpected Memory ID in a filtered response", async () => {
	const original = point("one");
	let response = { ...original, payload: { ...original.payload, projectId: "other-project" } };
	const index = await openIndex(() => ({ points: [response] }));
	await expect(index.search({ projectId, vector: [1, 0], limit: 2 })).rejects.toMatchObject({
		code: "qdrant-invalid-response",
	});
	response = { ...original, id: point("another-id").id };
	await expect(index.list(projectId)).rejects.toMatchObject({ code: "qdrant-invalid-response" });
	response = { ...original, payload: { ...original.payload, scopeKey: JSON.stringify(["task", "other"]) } };
	await expect(
		index.search({ projectId, vector: [1, 0], limit: 2, visibility: { taskId: "mine" } }),
	).rejects.toMatchObject({
		code: "qdrant-invalid-response",
	});
	response = original;
	await expect(index.list(projectId, { memoryId: "another-id" })).rejects.toMatchObject({
		code: "qdrant-invalid-response",
	});
});
