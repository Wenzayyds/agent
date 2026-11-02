import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	PythonMemoryWorkerClient,
	resolvePythonWorkerLaunch,
} from "../../src/memory/python-worker-client.ts";

const clients: PythonMemoryWorkerClient[] = [];
const pythonAvailable =
	spawnSync(process.platform === "win32" ? "py" : "python3", process.platform === "win32" ? ["-3", "-c", "import numpy"] : ["-c", "import numpy"]).status === 0;

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("P2-8 Python memory worker client", () => {
	it("accepts only an absolute Python override and keeps paths with spaces as one spawn argument", () => {
		const absolute = process.platform === "win32" ? "C:\\Program Files\\Python\\python.exe" : "/opt/python env/bin/python";
		expect(resolvePythonWorkerLaunch(absolute)).toMatchObject({ command: absolute });
		expect(resolvePythonWorkerLaunch("relative/python").command).not.toBe("relative/python");
	});

	it.skipIf(!pythonAvailable)("uses the real local worker without returning memory content", async () => {
		const client = new PythonMemoryWorkerClient({ startupTimeoutMs: 5_000, requestTimeoutMs: 2_000 });
		clients.push(client);
		const hash = "a".repeat(64);
		const sync = await client.request("sync_snapshot", {
			projectId: "ts-worker-test",
			records: [
				{
					memoryId: "deploy-target",
					content: "production deployment requires the release controls before publishing",
					contentRevision: 1,
					contentHash: hash,
					kind: "decision",
				},
				{
					memoryId: "bridge",
					content: "approval workflow connects operator authorization to release controls",
					contentRevision: 1,
					contentHash: "b".repeat(64),
					kind: "fact",
				},
			],
		});
		expect(sync).toMatchObject({ modelId: "lsa-tfidf-svd-v1", recordCount: 2 });
		const result = await client.request("search_vectors", {
			projectId: "ts-worker-test",
			query: "operator authorization",
			topK: 2,
		});
		expect(result.candidates).toEqual(
			expect.arrayContaining([expect.objectContaining({ memoryId: "deploy-target", contentHash: hash })]),
		);
		expect(JSON.stringify(result)).not.toContain("production deployment");
		const concurrent = await Promise.all([
			client.request("search_vectors", { projectId: "ts-worker-test", query: "release controls", topK: 2 }),
			client.request("search_vectors", { projectId: "ts-worker-test", query: "approval workflow", topK: 2 }),
		]);
		expect(concurrent).toHaveLength(2);
	});

	it("bounds startup time when a worker never answers", async () => {
		const client = new PythonMemoryWorkerClient({
			startupTimeoutMs: 100,
			requestTimeoutMs: 100,
			command: process.execPath,
			args: ["-e", "process.stdin.resume()"],
		});
		clients.push(client);
		await expect(client.request("health")).rejects.toMatchObject({ code: "worker-timeout" });
	});

	it("rejects invalid stdout instead of treating it as retrieval data", async () => {
		const client = new PythonMemoryWorkerClient({
			startupTimeoutMs: 500,
			requestTimeoutMs: 500,
			command: process.execPath,
			args: ["-e", "process.stdin.once('data',()=>process.stdout.write('not-json\\n'))"],
		});
		clients.push(client);
		await expect(client.request("health")).rejects.toMatchObject({ code: "invalid-response" });
	});

	it("reports a missing Python executable as unavailable", async () => {
		const client = new PythonMemoryWorkerClient({
			startupTimeoutMs: 500,
			requestTimeoutMs: 500,
			command: joinMissingExecutableName(),
		});
		clients.push(client);
		await expect(client.request("health")).rejects.toMatchObject({ code: "worker-start-failed" });
	});
});

function joinMissingExecutableName(): string {
	return `pi-enhanced-python-missing-${process.pid}.exe`;
}
