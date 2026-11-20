import { expect, it } from "vitest";
import { startMemoryRuntime } from "../../src/memory/runtime.ts";
import { createLocalEmbedding, E5EmbeddingProvider, MULTILINGUAL_E5_SMALL } from "../../src/shared/embedding/e5.ts";
import { PythonMemoryWorkerClient } from "../../src/shared/embedding/python-worker-client.ts";

const mockWorker = String.raw`
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.payload?.texts?.[0] === "crash") process.exit(31);
	const result = request.op === "health" ? { status: "ready" }
		: request.op === "shutdown" ? { status: "stopped" }
		: { model: ${JSON.stringify(MULTILINGUAL_E5_SMALL)}, vectors: request.payload.texts.map(() => [1, ...Array(383).fill(0)]) };
	process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: true, result }) + String.fromCharCode(10));
	if (request.op === "shutdown") break;
}
`;
const options = {
	command: process.execPath, cwd: process.cwd(), args: ["--input-type=module", "-e", mockWorker],
	startupTimeoutMs: 2_000, requestTimeoutMs: 2_000,
};

it.each([
	[false, false], [false, true], [true, false], [true, true],
])("keeps Memory enabled=%s and a fake Knowledge owner enabled=%s independent", async (memoryEnabled, knowledgeEnabled) => {
	let closed = 0;
	let opened = 0;
	const runtime = await startMemoryRuntime({
		enabled: memoryEnabled, cwd: process.cwd(), agentDir: process.cwd(), projectTrusted: true,
		openBackend: async () => { opened++; return { async close() { closed++; } }; },
	});
	const memory = memoryEnabled ? createLocalEmbedding(options) : undefined;
	const knowledge = knowledgeEnabled ? createLocalEmbedding(options) : undefined;
	try {
		expect(runtime.state).toBe(memoryEnabled ? "ready" : "disabled");
		expect(opened).toBe(Number(memoryEnabled));
		if (memory) expect((await memory.embedding.encode(["Memory query"], "query"))[0][0]).toBe(1);
		if (knowledge) expect((await knowledge.embedding.encode(["Knowledge document"], "passage"))[0][0]).toBe(1);
		if (memoryEnabled && knowledge) {
			await memory?.close();
			await runtime.close();
			expect((await knowledge.embedding.encode(["Knowledge query"], "query"))[0][0]).toBe(1);
		}
	} finally {
		await memory?.close();
		await knowledge?.close();
		await runtime.close();
	}
	if (knowledge) await expect(knowledge.embedding.encode(["after close"], "query")).rejects.toMatchObject({ code: "worker-closed" });
	if (memory) await expect(memory.embedding.encode(["after close"], "query")).rejects.toMatchObject({ code: "worker-closed" });
	expect(closed).toBe(Number(memoryEnabled));
});

it("distinguishes worker crashes and starts a new process on the next request", async () => {
	const worker = new PythonMemoryWorkerClient(options);
	const provider = new E5EmbeddingProvider(() => worker);
	try {
		await provider.encode(["start"], "query");
		const before = worker.processId;
		await expect(provider.encode(["crash"], "query")).rejects.toMatchObject({ code: "worker-exited" });
		expect((await provider.encode(["retry"], "query"))[0]).toHaveLength(384);
		expect(worker.processId).not.toBe(before);
	} finally {
		await Promise.all([worker.close(), worker.close()]);
	}
	expect(worker.processId).toBeUndefined();
});
