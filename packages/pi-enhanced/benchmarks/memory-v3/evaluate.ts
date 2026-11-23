import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { compose, dockerWorker, reserveLoopbackPort } from "../../fixtures/memory-v3/lab.ts";
import { MULTILINGUAL_E5_SMALL } from "../../src/memory/embedding-provider.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import type { MemoryWorkerClientLike } from "../../src/memory/python-worker-client.ts";
import { QdrantVectorIndex } from "../../src/memory/qdrant-vector-index.ts";
import { SemanticSearchAdapter } from "../../src/memory/semantic-search-adapter.ts";
import { openMemoryService } from "../../src/memory/service.ts";
import { baseCases, baseFixtures, cases, type Case, fixtures, version } from "./dataset-v2.ts";

const stratified = process.argv.includes("--stratified");
const testCases = stratified ? cases : baseCases;
const split = (scenario: Case) => baseCases.includes(scenario) ? "development" : "holdout";
const datasetSha256 = createHash("sha256").update(JSON.stringify({ corpus: stratified ? fixtures : baseFixtures,
	queries: testCases.map((scenario) => ({ split: split(scenario), ...scenario })) })).digest("hex");
const corpus = stratified ? fixtures : baseFixtures;

const image = process.env.PI_MEMORY_V3_E5_IMAGE ?? "pi-memory-v3-e5:local";
const project = "pi-memory-v3-eval-" + randomUUID().slice(0, 8);
const tempRoot = realpathSync(tmpdir());
const workspace = mkdtempSync(join(tempRoot, "pi-memory-v3-eval-"));
const passes = 3;
const results = [];
const foreignRoot = join(workspace, "foreign-project");
mkdirSync(foreignRoot);
const foreign = await openMemoryService(createProjectScope({ cwd: foreignRoot, agentDir: join(workspace, "agent") }));
const store = await openMemoryService(createProjectScope({ cwd: workspace, agentDir: join(workspace, "agent") }));
try {
	await reserveLoopbackPort(project);
	compose(project, "up", "-d", "--wait", "--wait-timeout", "30");
	const endpoint = "http://" + compose(project, "port", "qdrant", "6333");
	const ids = new Map<string, string>();
	const foreignContent = "The LOCAL_PROJECT_ONLY_FOREIGN marker belongs only to a different project.";
	writeFileSync(join(foreignRoot, "foreign.md"), foreignContent);
	const foreignDraft = await foreign.saveCandidate({ kind: "fact", content: foreignContent, source: { type: "file", ref: "foreign.md" } });
	const foreignVerified = await foreign.verifyFileFact(foreignDraft.id,
		{ relativePath: "foreign.md", exactExcerpt: foreignContent }, foreignDraft.revision);
	const context = { hasUI: true, ui: { confirm: async () => true },
		sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionCommandContext;
	for (const { key, input, proof } of corpus) {
		const ref = key + ".txt";
		writeFileSync(join(workspace, ref), input.content);
		const candidate = await store.saveCandidate({ ...input, source: { type: "file", ref } });
		if (proof === "explicit") await new Promise((resolve) => setTimeout(resolve, 5));
		let verified = proof === "explicit"
			? await store.confirmByUser(candidate.id, candidate.revision, context)
			: await store.verifyFileFact(candidate.id, { relativePath: ref, exactExcerpt: input.content }, candidate.revision);
		if (proof === "withdrawn") writeFileSync(join(workspace, ref), input.content + " Withdrawn evidence.");
		if (proof === "archived") verified = await store.archive(verified.id, verified.revision);
		if (proof === "revised") {
			const content = input.content.replace("OBSOLETE_MANIFEST_V1", "CURRENT_MANIFEST_V2");
			writeFileSync(join(workspace, ref), content);
			const revised = await store.updateContent(verified.id, content, verified.revision);
			verified = await store.verifyFileFact(revised.id, { relativePath: ref, exactExcerpt: content }, revised.revision);
		}
		ids.set(key, verified.id);
	}
	const keys = new Map([...ids].map(([key, id]) => [id, key]));
	for (const [method, backend, mode] of [
		["FTS5", "tfidf-svd", "lexical"],
		["TF-IDF+SVD", "tfidf-svd", "semantic"],
		["E5+Qdrant", "e5-qdrant", "semantic"],
		["FTS5+E5+Qdrant RRF", "e5-qdrant", "hybrid"],
	] as const) {
		const requestTimes: Record<string, number[]> = {};
		const workerName = [project, mode, backend].join("-");
		const client = dockerWorker(image, workerName);
		const worker: MemoryWorkerClientLike = {
			close: () => client.close(),
			async request(op, payload) {
				const start = performance.now();
				try { return await client.request(op, payload); }
				finally {
					const tag = op === "encode_e5" ? op + ":" + payload?.purpose : op;
					(requestTimes[tag] ??= []).push(performance.now() - start);
				}
			},
		};
		const qdrant = backend === "e5-qdrant" ? new QdrantVectorIndex({
			endpoint, model: MULTILINGUAL_E5_SMALL, collection: "eval_" + mode, timeoutMs: 8_000,
		}) : undefined;
		const adapter = new SemanticSearchAdapter({
			service: store, vectorIndex: qdrant, workerFactory: () => worker,
			config: { enabled: true, backend, mode, maximumSnapshotRecords: 200, semanticCandidates: 18,
				startupTimeoutMs: 20_000, requestTimeoutMs: 30_000, rerankerEnabled: false },
		});
		try {
			const invoke = async ({ query }: Case) => {
				const reply = await adapter.search({ ...query, limit: 10 });
				if (reply.records.some((record) => record.projectId !== store.scope.projectId ||
					record.id === foreignVerified.id || record.content.includes("OBSOLETE_MANIFEST_V1")))
					throw new Error("Cross-project or obsolete revision returned");
				const direct = !query.text.trim() || query.preferenceKey || query.types?.every((type) =>
					type === "working" || type === "preference");
				const expectedMode = direct ? "lexical" : mode;
				if (reply.mode !== expectedMode || reply.fallbackReason) throw new Error("Unexpected fallback: " + reply.fallbackReason);
				return reply.records.map(({ id }) => id);
			};
			const started = performance.now();
			await invoke(testCases[0]);
			if (qdrant) await invoke(testCases[0]);
			const coldMs = performance.now() - started;
			await invoke({ stratum: "project-boundary", query: { text: "LOCAL_PROJECT_ONLY_FOREIGN" } });
			const observations: Observation[] = [];
			const hostCpu = process.cpuUsage();
			for (let pass = 0; pass < passes; pass++) {
				for (const [index, scenario] of testCases.entries()) {
					const start = performance.now();
					const found = await invoke(scenario);
					const actual = found.map((id) => keys.get(id) ?? "unmapped");
					const rank = scenario.expected ? found.indexOf(ids.get(scenario.expected)!) + 1 : undefined;
					const forbidden = (scenario.forbidden ?? []).filter((key) => found.includes(ids.get(key)!)).length;
					observations.push({ index, pass, split: split(scenario), stratum: scenario.stratum,
						ms: performance.now() - start, rank, forbidden, actual, expected: scenario.expected,
						negativeReturned: !scenario.expected && found.length > 0 });
				}
			}
			const cpu = process.cpuUsage(hostCpu);
			const latencies = observations.map(({ ms }) => ms);
			const byStratum = Object.fromEntries([...new Set(observations.map(({ stratum }) => stratum))]
				.map((stratum) => [stratum, measure(observations.filter((row) => row.stratum === stratum))]));
			results.push({
				method, ...measure(observations), byStratum,
				bySplit: Object.fromEntries([...new Set(observations.map((row) => row.split))]
					.map((partition) => [partition, measure(observations.filter((row) => row.split === partition))])),
				observations,
				coldMs, p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95),
				workerRequests: Object.fromEntries(Object.entries(requestTimes).map(([tag, times]) => [tag, {
					count: times.length, firstMs: times[0], ...(times.length > 1 ? { warmP50Ms: percentile(times.slice(1), 0.5) } : {}),
				}])),
				hostCpuMs: (cpu.user + cpu.system) / 1000, hostProcessPeakRssKiB: process.resourceUsage().maxRSS,
				workerResources: mode === "lexical" ? undefined : dockerResources(workerName),
				qdrantResources: qdrant ? dockerResources(compose(project, "ps", "-q", "qdrant")) : undefined,
			});
		} finally { await adapter.close(); }
	}
	console.log(JSON.stringify({ version: stratified ? version : "memory-v3-v1", embeddingModel: MULTILINGUAL_E5_SMALL,
		datasetSha256, corpus: corpus.length, queries: testCases.length, passes, node: process.version, platform: process.platform, results }, null, 2));
} catch (error) {
	try { console.error(compose(project, "logs", "--tail", "20", "qdrant")); } catch {}
	throw error;
} finally {
	await Promise.all([store.close(), foreign.close()]);
	try {
		compose(project, "down", "-v");
	} finally {
		const target = realpathSync(workspace);
		if (dirname(target) === tempRoot && basename(target).startsWith("pi-memory-v3-eval-"))
			rmSync(target, { recursive: true, force: true });
	}
}

interface Observation {
	index: number;
	pass: number;
	split: "development" | "holdout";
	stratum: string;
	ms: number;
	rank?: number;
	forbidden: number;
	actual: string[];
	expected?: string;
	negativeReturned: boolean;
}

function measure(observations: readonly Observation[]) {
	const ranks = observations.flatMap(({ rank }) => rank === undefined ? [] : [rank]);
	return {
		queries: observations.length / passes,
		positiveQueries: ranks.length / passes,
		recallAt5: ranks.length ? ranks.filter((rank) => rank > 0 && rank <= 5).length / ranks.length : null,
		recallAt10: ranks.length ? ranks.filter((rank) => rank > 0).length / ranks.length : null,
		mrrAt5: ranks.length ? ranks.reduce((sum, rank) => sum + (rank > 0 && rank <= 5 ? 1 / rank : 0), 0) / ranks.length : null,
		mrrAt10: ranks.length ? ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length : null,
		ndcgAt10: ranks.length ? ranks.reduce((sum, rank) => sum + (rank ? 1 / Math.log2(rank + 1) : 0), 0) / ranks.length : null,
		p50Ms: percentile(observations.map((row) => row.ms), 0.5),
		p95Ms: percentile(observations.map((row) => row.ms), 0.95),
		forbiddenHits: observations.reduce((sum, row) => sum + row.forbidden, 0),
		negativeQueriesReturningResults: observations.filter((row) => row.negativeReturned).length,
	};
}

function percentile(values: readonly number[], percent: number): number {
	return [...values].sort((a, b) => a - b)[Math.ceil(values.length * percent) - 1];
}

function dockerResources(container: string): string {
	return execFileSync("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}} CPU, {{.MemUsage}}", container],
		{ encoding: "utf-8", timeout: 10_000 }).trim();
}
