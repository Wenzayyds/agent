import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";
import type { MemoryIntelligenceConfig } from "../src/memory/config.ts";
import type { MemoryKind } from "../src/memory/contracts.ts";
import { createProjectScope } from "../src/memory/project-scope.ts";
import { LocalMemoryProvider } from "../src/memory/provider.ts";
import { PythonMemoryWorkerClient } from "../src/memory/python-worker-client.ts";
import { SemanticSearchAdapter } from "../src/memory/semantic-search-adapter.ts";
import { MemoryService } from "../src/memory/service.ts";
import { ensureProjectStorage } from "../src/memory/storage.ts";
import { estimateContextMessages } from "../src/context/budget.ts";
import type { ContextModuleConfig } from "../src/context/contracts.ts";
import { selectContextMessages } from "../src/context/selector.ts";

const root = mkdtempSync(join(tmpdir(), "pi-enhanced-release-benchmark-"));
const project = join(root, "project");
mkdirSync(project);
const scope = createProjectScope({ cwd: project, agentDir: join(root, "agent") });
ensureProjectStorage(scope);
const provider = new LocalMemoryProvider(scope);
const service = new MemoryService(scope, provider);

const config: MemoryIntelligenceConfig = {
	enabled: true,
	mode: "hybrid",
	rerankerEnabled: false,
	startupTimeoutMs: 5_000,
	requestTimeoutMs: 2_000,
	maximumSnapshotRecords: 500,
	semanticCandidates: 20,
};

const contextConfig: ContextModuleConfig = {
	enabled: true,
	mode: "select",
	budget: { maximumEstimatedTokens: 4_000, reserveEstimatedTokens: 1_000, recentMessagesToKeep: 4 },
	toolOutput: { enabled: true, maximumTextCharacters: 1_000 },
	memoryInjection: { enabled: false, maximumRecords: 3, maximumTextCharacters: 3_000, readerTimeoutMs: 250 },
	pythonScoring: { enabled: false },
};

function percentile(values: readonly number[], ratio: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

async function addMemory(content: string, kind: MemoryKind, index: number): Promise<string> {
	const normalized = content.normalize("NFKC").replace(/\s+/gu, " ").trim();
	const candidate = await provider.saveCandidate({
		kind,
		content,
		normalizedContent: normalized,
		contentHash: createHash("sha256").update(normalized).digest("hex"),
		source: { type: "test", ref: `benchmark-${index}`, observedAt: Date.now() },
		now: Date.now(),
	});
	return (
		await provider.setStatus({
			id: candidate.id,
			status: "verified",
			verification: {
				id: randomUUID(),
				type: "test_passed",
				evidenceRef: "release-benchmark",
				evidenceVersion: "v1",
				verifiedAt: Date.now(),
			},
			expectedRevision: candidate.revision,
			now: Date.now(),
		})
	).id;
}

function workerRss(pid: number | undefined): number | null {
	if (!pid || process.platform !== "win32") return null;
	try {
		return Number(
			execFileSync(
				"powershell.exe",
				["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`],
				{ encoding: "utf8", timeout: 2_000 },
			).trim(),
		);
	} catch {
		return null;
	}
}

function user(content: string, timestamp: number): AgentMessage {
	return { role: "user", content, timestamp };
}

try {
	const topics = [
		["release", "production publishing requires operator approval and a release gate"],
		["database", "database migration rollback uses a verified backup checkpoint"],
		["security", "security review validates access boundaries before deployment"],
		["testing", "regression testing runs integration suites before merging"],
		["context", "context selection retains recent turns and complete tool pairs"],
	] as const;
	const expected = new Map<string, Set<string>>();
	for (let index = 0; index < 100; index += 1) {
		const [topic, sentence] = topics[index % topics.length];
		const id = await addMemory(`${sentence}; evidence item ${index}.`, index % 3 === 0 ? "decision" : "fact", index);
		const relevant = expected.get(topic) ?? new Set<string>();
		relevant.add(id);
		expected.set(topic, relevant);
	}

	let client: PythonMemoryWorkerClient | undefined;
	const adapter = new SemanticSearchAdapter({
		service,
		config,
		workerFactory: () => {
			client = new PythonMemoryWorkerClient({ startupTimeoutMs: 5_000, requestTimeoutMs: 2_000 });
			return client;
		},
	});
	const coldStart = performance.now();
	const coldResult = await adapter.search({ text: "operator authorization for production publishing", limit: 5 });
	const coldMs = performance.now() - coldStart;
	const queries = [
		["release", "operator authorization before publishing"],
		["database", "restore plan for schema changes"],
		["security", "permission boundary assessment"],
		["testing", "integration verification before merge"],
		["context", "keep recent conversation tool results"],
	] as const;
	const warm: number[] = [];
	let hits = 0;
	for (let round = 0; round < 6; round += 1) {
		for (const [topic, query] of queries) {
			const started = performance.now();
			const result = await adapter.search({ text: query, limit: 5 });
			warm.push(performance.now() - started);
			if (result.records.some((record) => expected.get(topic)?.has(record.id))) hits += 1;
		}
	}
	const rss = workerRss(client?.processId);

	const failedAdapter = new SemanticSearchAdapter({
		service,
		config,
		workerFactory: () =>
			new PythonMemoryWorkerClient({
				startupTimeoutMs: 300,
				requestTimeoutMs: 300,
				command: `pi-enhanced-missing-${process.pid}.exe`,
			}),
	});
	const fallbackStarted = performance.now();
	const fallback = await failedAdapter.search({ text: "release gate", limit: 5 });
	const fallbackMs = performance.now() - fallbackStarted;

	const messages: AgentMessage[] = [];
	for (let index = 0; index < 80; index += 1) messages.push(user(`historic turn ${index} ${"x".repeat(600)}`, index));
	messages.push(user("latest request must remain", 100));
	const inputTokensBefore = estimateContextMessages(messages);
	const samples: number[] = [];
	let selected: AgentMessage[] = messages;
	for (let index = 0; index < 100; index += 1) {
		const started = performance.now();
		selected = selectContextMessages(messages, {
			budget: contextConfig.budget,
			toolOutput: contextConfig.toolOutput,
			contextWindow: 8_000,
		}).messages;
		samples.push(performance.now() - started);
	}
	const inputTokensAfter = estimateContextMessages(selected);

	console.log(
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				environment: { node: process.version, platform: `${process.platform}-${process.arch}`, records: 100 },
				p2: {
					coldStartMs: Number(coldMs.toFixed(3)),
					warmQueryP50Ms: Number(percentile(warm, 0.5).toFixed(3)),
					warmQueryP95Ms: Number(percentile(warm, 0.95).toFixed(3)),
					workerRssBytes: rss,
					recallAt5: hits / warm.length,
					coldMode: coldResult.mode,
					fallback: { mode: fallback.mode, reason: fallback.fallbackReason, durationMs: Number(fallbackMs.toFixed(3)) },
				},
				p3: {
					fixtureMessages: messages.length,
					selectedMessages: selected.length,
					inputTokensBefore,
					inputTokensAfter,
					latestUserRetained: selected.at(-1)?.role === "user" && selected.at(-1)?.content === "latest request must remain",
					selectionP50Ms: Number(percentile(samples, 0.5).toFixed(3)),
					selectionP95Ms: Number(percentile(samples, 0.95).toFixed(3)),
				},
			},
			null,
			2,
		),
	);
	await failedAdapter.close();
	await adapter.close();
} finally {
	await service.close();
	rmSync(root, { recursive: true, force: true });
}
