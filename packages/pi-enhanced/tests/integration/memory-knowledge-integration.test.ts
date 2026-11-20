import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createHarness, createTestUiContext, getToolResult } from "../../../coding-agent/test/suite/harness.ts";
import { compose, dockerWorker, reserveLoopbackPort } from "../../fixtures/memory-v3/lab.ts";
import { injectVerifiedMemory, type MemoryInjectionResult } from "../../src/context/memory-source.ts";
import { createKnowledgeExtension } from "../../src/knowledge/extension.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import { KNOWLEDGE_READ, KNOWLEDGE_SEARCH } from "../../src/knowledge/tools.ts";
import { KNOWLEDGE_COLLECTION, openDocumentIndex } from "../../src/knowledge/vector.ts";
import { createMemoryExtension } from "../../src/memory/extension.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { MEMORY_VECTOR_COLLECTION, QdrantVectorIndex } from "../../src/memory/qdrant-vector-index.ts";
import { requestScopedMemoryReader } from "../../src/memory/reader.ts";
import { SemanticSearchAdapter } from "../../src/memory/semantic-search-adapter.ts";
import { type MemoryService, openMemoryService } from "../../src/memory/service.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { E5EmbeddingProvider } from "../../src/shared/embedding/e5.ts";

const memoryTool = "enhanced_memory_search";
const query = "production rollout";
const memoryFact = "The production rollout owner is the release coordinator.";
const documentFact = "The production rollout requires a signed review.";

function trustFixtureProject(harness: Awaited<ReturnType<typeof createHarness>>): void {
	// The shared harness creates its in-memory session with the process cwd.
	(harness.sessionManager as unknown as { cwd: string }).cwd = harness.tempDir;
	harness.settingsManager.setProjectTrusted(true);
}

async function verifyFileMemory(service: MemoryService, root: string) {
	const ref = "operations.txt";
	writeFileSync(join(root, ref), memoryFact);
	const candidate = await service.saveCandidate({
		kind: "fact",
		type: "semantic",
		content: memoryFact,
		source: { type: "file", ref },
	});
	return service.verifyFileFact(candidate.id, { relativePath: ref, exactExcerpt: memoryFact }, candidate.revision);
}

it.each([
	[false, false],
	[true, false],
	[false, true],
	[true, true],
])("loads both production factories with Memory=%s and Knowledge=%s", async (memory, knowledge) => {
	const root = mkdtempSync(join(tmpdir(), "pi-enhanced-integration-switches-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, ENHANCED_CONFIG_FILE),
		JSON.stringify({
			modules: {
				// The pre-V3 Memory config does not specify a backend or a Knowledge module.
				memory: { enabled: memory, intelligence: { enabled: true, mode: "hybrid" } },
				...(knowledge ? { knowledge: { enabled: true } } : {}),
			},
		}),
	);
	const harness = await createHarness({
		extensionFactories: [createMemoryExtension({ agentDir }), createKnowledgeExtension({ agentDir })],
	});
	try {
		trustFixtureProject(harness);
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ confirm: async () => true }) });
		const runner = harness.session.extensionRunner;
		expect(runner.getActiveTools().includes(memoryTool)).toBe(memory);
		expect(runner.getActiveTools().includes(KNOWLEDGE_SEARCH)).toBe(knowledge);
		expect(runner.getActiveTools().includes(KNOWLEDGE_READ)).toBe(knowledge);
		if (memory) {
			const service = await openMemoryService(createProjectScope({ cwd: harness.tempDir, agentDir }));
			try {
				await verifyFileMemory(service, harness.tempDir);
			} finally {
				await service.close();
			}
		}
		if (knowledge) {
			const path = join(harness.tempDir, "rollout.md");
			writeFileSync(path, `# Rollout\n\n${documentFact}`);
			await harness.session.prompt(`/enhanced-docs add --allow-external ${JSON.stringify([path])}`);
		}
		const expected = [...(memory ? [memoryTool] : []), ...(knowledge ? [KNOWLEDGE_SEARCH] : [])];
		harness.setResponses([
			...expected.map(name => fauxAssistantMessage([fauxToolCall(name, { query })], { stopReason: "toolUse" })),
			(context) => {
				const wire = JSON.stringify(context.messages);
				expect(wire.includes(memoryFact)).toBe(memory);
				expect(wire.includes(documentFact)).toBe(knowledge);
				if (knowledge) expect(wire).toContain("insufficient-evidence");
				return fauxAssistantMessage("Checked only the available sources.");
			},
		]);
		await harness.session.prompt("Check the available references.");
		expect(harness.eventsOfType("tool_execution_start").map(({ toolName })=>toolName)).toEqual(expected);
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		expect(runner.getActiveTools()).not.toContain(memoryTool);
		expect(runner.getActiveTools()).not.toContain(KNOWLEDGE_SEARCH);
	} finally {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

it("returns Memory and Knowledge to one Pi turn and rechecks both channels after invalidation and trust withdrawal", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-enhanced-integration-tools-"));
	mkdirSync(join(root, "agent"));
	const agentDir = join(root, "agent");
	writeFileSync(
		join(agentDir, ENHANCED_CONFIG_FILE),
		JSON.stringify({ modules: { memory: { enabled: true }, knowledge: { enabled: true } } }),
	);
	const stores: MemoryService[] = [];
	let events: EventBus | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				events = pi.events;
			},
			createMemoryExtension({
				agentDir,
				async openBackend(scope) {
					const store = await openMemoryService(scope);
					stores.push(store);
					return store;
				},
			}),
			createKnowledgeExtension({ agentDir }),
		],
	});
	try {
		trustFixtureProject(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({ confirm: async () => true }),
		});
		const memory = await verifyFileMemory(stores.at(-1)!, harness.tempDir);
		writeFileSync(join(harness.tempDir, "rollout.md"), `# Rollout\n\n${documentFact}`);
		await harness.session.prompt(
			`/enhanced-docs add --allow-external ${JSON.stringify([join(harness.tempDir, "rollout.md")])}`,
		);
		let modelContext = "";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(memoryTool, { query }), fauxToolCall(KNOWLEDGE_SEARCH, { query })], {
				stopReason: "toolUse",
			}),
			(request) => {
				modelContext = JSON.stringify(request.messages.filter((message) => message.role === "toolResult"));
				return fauxAssistantMessage("Found the rollout owner and approval rule.");
			},
		]);
		await harness.session.prompt("Look up the production rollout.");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(JSON.stringify(getToolResult(harness, memoryTool))).toContain(memoryFact);
		expect(modelContext).toContain(documentFact);
		expect(JSON.stringify(getToolResult(harness, KNOWLEDGE_SEARCH))).not.toContain(documentFact);

		const runner = harness.session.extensionRunner;
		const searchMemory = runner.getToolDefinition(memoryTool)!;
		const searchDocs = runner.getToolDefinition(KNOWLEDGE_SEARCH)!;
		const ctx = runner.createToolContext("integrated-retrieval", undefined);
		const reader = await requestScopedMemoryReader(events!, ctx);
		const inject = (previous?: MemoryInjectionResult) =>
			injectVerifiedMemory({
				messages: previous?.messages ?? [{ role: "user", content: query, timestamp: 1 }],
				reader,
				projectRoot: harness.tempDir,
				config: { enabled: true, maximumRecords: 3, maximumTextCharacters: 2_000, readerTimeoutMs: 200 },
			});
		const injected = await inject();
		expect(injected.injectedMemoryIds).toEqual([memory.id]);

		writeFileSync(join(harness.tempDir, "operations.txt"), "This file no longer verifies the previous owner.");
		await expect(searchMemory.execute("invalidated", { query }, undefined, undefined, ctx)).resolves.toMatchObject({
			details: { count: 0 },
		});
		const evicted = await inject(injected);
		expect(evicted.injectedMemoryIds).toEqual([]);
		expect(evicted.messages.every(({ role }) => role !== "custom")).toBe(true);
		await expect(searchDocs.execute("still-allowed", { query }, undefined, undefined, ctx)).resolves.toMatchObject({
			details: { count: 1 },
		});

		harness.settingsManager.setProjectTrusted(false);
		await expect(searchMemory.execute("untrusted", { query }, undefined, undefined, ctx)).resolves.toMatchObject({
			details: { count: 0 },
			isError: true,
		});
		await expect(searchDocs.execute("untrusted", { query }, undefined, undefined, ctx)).rejects.toThrow(
			"knowledge-disabled",
		);
		await expect(inject(injected)).resolves.toMatchObject({ injectedMemoryIds: [], errorCode: "memory-unavailable" });
	} finally {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

it.runIf(process.env.PI_ENHANCED_INTEGRATION_DOCKER === "1")(
	"shares the local E5 model and server with isolated workers and collections through outage, revocation and repair",
	async () => {
		const project = `pi-enhanced-integration-${randomUUID().slice(0, 8)}`;
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-integration-docker-"));
		const image = process.env.PI_MEMORY_V3_E5_IMAGE ?? "pi-memory-v3-e5:local";
		const memoryWorkerName = `${project}-memory`;
		const docsWorkerName = `${project}-docs`;
		const memoryWorker = dockerWorker(image, memoryWorkerName);
		const docsWorker = dockerWorker(image, docsWorkerName);
		const scope = createProjectScope({ cwd: root, agentDir: join(root, "agent") });
		let memory: MemoryService | undefined;
		let adapter: SemanticSearchAdapter | undefined;
		let docs: KnowledgeService | undefined;
		try {
			await reserveLoopbackPort(project);
			compose(project, "up", "-d", "--wait", "--wait-timeout", "30");
			const address = compose(project, "port", "qdrant", "6333");
			expect(address).toMatch(/^127\.0\.0\.1:\d+$/u);
			const endpoint = `http://${address}`;
			memory = await openMemoryService(scope);
			const memoryRecord = await verifyFileMemory(memory, root);
			const docsEmbedding = new E5EmbeddingProvider(() => docsWorker);
			const model = docsEmbedding.model;
			const memoryIndex = new QdrantVectorIndex({ model, endpoint, timeoutMs: 8_000 });
			const docsIndex = openDocumentIndex(endpoint, model);
			adapter = new SemanticSearchAdapter({
				service: memory,
				config: {
					enabled: true,
					mode: "hybrid",
					backend: "e5-qdrant",
					maximumSnapshotRecords: 30,
					rerankerEnabled: false,
					startupTimeoutMs: 20_000,
					requestTimeoutMs: 8_000,
					semanticCandidates: 10,
				},
				vectorIndex: memoryIndex,
				workerFactory: () => memoryWorker,
			});
			docs = new KnowledgeService({
				projectId: scope.projectId,
				filename: join(root, "knowledge.sqlite3"),
				mode: "hybrid",
				vectors: {
					collection: KNOWLEDGE_COLLECTION,
					index: docsIndex,
					embedding: docsEmbedding,
					close: () => docsWorker.close(),
				},
			});
			const audience = { audience: "agent" } as const;
			const source = "rollout.md";
			writeFileSync(join(root, source), `# Rollout\n\n${documentFact}`);
			const { documentId } = await docs.add(root, source, "release", "allow-external");
			const memoryHits = await adapter.search({ text: "生产发布由谁负责？" });
			const docHits = await docs.search("生产发布前需要什么审批？", audience, 5, "semantic");
			expect(memoryHits.mode).toBe("hybrid");
			expect(memoryHits.records.map(({ id }) => id)).toEqual([memoryRecord.id]);
			expect(docHits.mode).toBe("semantic");
			expect(docHits.hits.map(({ document }) => document.documentId)).toEqual([documentId]);
			const previousChunk = docHits.hits[0].chunk;
			const memoryRefs = await memoryIndex.list(scope.projectId);
			const docPoints = (await docsIndex.scroll()).points;
			expect(memoryRefs.points.map(({ memoryId }) => memoryId)).toEqual([memoryRecord.id]);
			expect(docPoints.map(({ payload }) => payload.documentId)).toEqual([documentId]);
			expect(inspect(memoryWorkerName, "{{.HostConfig.NetworkMode}} {{.Image}}")).toBe(
				inspect(docsWorkerName, "{{.HostConfig.NetworkMode}} {{.Image}}"),
			);
			expect(inspect(docsWorkerName, "{{.HostConfig.NetworkMode}}")).toBe("none");
			const docsContainer = inspect(docsWorkerName, "{{.Id}}");
			const response = await fetch(`${endpoint}/collections`);
			expect(response.ok).toBe(true);
			const collections = (await response.json()) as { result: { collections: { name: string }[] } };
			expect(collections.result.collections.map(({ name }) => name).sort()).toEqual(
				[MEMORY_VECTOR_COLLECTION, KNOWLEDGE_COLLECTION].sort(),
			);

			compose(project, "stop", "qdrant");
			await expect(adapter.search({ text: query })).resolves.toMatchObject({
				mode: "lexical",
				fallbackReason: "qdrant-unavailable",
				records: [expect.objectContaining({ id: memoryRecord.id })],
			});
			await expect(docs.search(query, audience)).resolves.toMatchObject({
				mode: "lexical",
				fallback: "qdrant-unavailable",
				hits: [expect.objectContaining({ chunk: expect.objectContaining({ chunkId: previousChunk.chunkId }) })],
			});
			await memory.archive(memoryRecord.id, memoryRecord.revision);
			writeFileSync(join(root, source), "# Rollout\n\nProduction rollout uses a second reviewer.");
			await expect(docs.add(root, source, "release", "local-only")).rejects.toMatchObject({
				code: "qdrant-unavailable",
			});
			await expect(docs.search(query, audience)).resolves.toMatchObject({ hits: [] });
			expect(() => docs!.read(previousChunk.chunkId, audience)).toThrow("document-not-found");
			await expect(adapter.search({ text: query })).resolves.toMatchObject({ records: [] });

			compose(project, "up", "-d", "--wait", "--wait-timeout", "30");
			await expect(docs.sync(documentId)).resolves.toEqual([{ documentId, outcome: "retried" }]);
			const active = await docs.search("second reviewer", { audience: "host" }, 5, "semantic");
			expect(active.mode).toBe("semantic");
			expect(active.hits[0].chunk.documentVersion).toBeGreaterThan(previousChunk.documentVersion);
			expect(active.hits[0].chunk.chunkId).not.toBe(previousChunk.chunkId);
			await expect(adapter.search({ text: query })).resolves.toMatchObject({ mode: "hybrid", records: [] });

			// Simulate late writes from both old index generations, after the new SQLite state is active.
			const [vector] = await docsEmbedding.encode([query], "query");
			await docsIndex.upsert(docPoints.map((point) => ({ ...point, vector })));
			await memoryIndex.upsert(memoryRefs.points.map((point) => ({ ...point, vector })));
			expect(await docsIndex.get(docPoints.map(({ id }) => id))).toHaveLength(1);
			expect(
				await memoryIndex.get(scope.projectId, [{ memoryId: memoryRecord.id, revision: memoryRecord.revision }]),
			).toHaveLength(1);
			await expect(docs.search(query, audience, 5, "semantic")).resolves.toMatchObject({
				mode: "semantic",
				hits: [],
			});
			expect(() => docs!.read(previousChunk.chunkId, { audience: "host" })).toThrow("document-not-found");
			await expect(adapter.search({ text: query })).resolves.toMatchObject({ mode: "hybrid", records: [] });
			await adapter.reconcileIndex();
			await docs.maintain();
			expect(await docsIndex.get(docPoints.map(({ id }) => id))).toEqual([]);
			expect(
				await memoryIndex.get(scope.projectId, [{ memoryId: memoryRecord.id, revision: memoryRecord.revision }]),
			).toEqual([]);

			await adapter.close();
			await expect.poll(() => dockerNames(memoryWorkerName), { timeout: 5_000 }).toBe("");
			expect(inspect(docsWorkerName, "{{.Id}}")).toBe(docsContainer);
			await expect(docs.search("second reviewer", { audience: "host" }, 5, "semantic")).resolves.toMatchObject({
				mode: "semantic",
				hits: [expect.objectContaining({ chunk: expect.objectContaining({ documentId }) })],
			});
		} finally {
			try {
				await Promise.allSettled([adapter?.close(), docs?.close()]);
				await Promise.allSettled([memoryWorker.close(), docsWorker.close(), memory?.close()]);
			} finally {
				compose(project, "down", "-v");
				rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		}
		await expect.poll(() => dockerNames(project), { timeout: 5_000 }).toBe("");
		expect(docker("volume", "ls", "--filter", `name=${project}`, "--format", "{{.Name}}")).toBe("");
		expect(docker("network", "ls", "--filter", `name=${project}`, "--format", "{{.Name}}")).toBe("");
	},
	100_000,
);

function dockerNames(filter: string): string {
	return docker("ps", "-a", "--filter", `name=${filter}`, "--format", "{{.Names}}");
}

function inspect(container: string, format: string): string {
	return docker("inspect", "--format", format, container);
}

function docker(...args: string[]): string {
	return execFileSync("docker", args, { encoding: "utf8", timeout: 15_000, windowsHide: true }).trim();
}
