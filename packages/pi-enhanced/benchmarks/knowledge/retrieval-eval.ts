import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startVectorLab } from "../../fixtures/knowledge/vector-lab.ts";
import { prepareKnowledgeDocument } from "../../src/knowledge/ingestion.ts";
import { createLocalKnowledgeReranker, RERANKER_REVISION } from "../../src/knowledge/reranker.ts";
import { KNOWLEDGE_RERANK_DEPTH, KnowledgeService } from "../../src/knowledge/service.ts";
import { DocumentStore, embeddingText, type SearchScope, type StoredChunk } from "../../src/knowledge/store.ts";
import {
	type EvidenceStatus, KNOWLEDGE_SEARCH, knowledgeSearchResult, projectKnowledgeToolContent,
} from "../../src/knowledge/tools.ts";
import { documentPointId, embeddingModelKey, openDocumentIndex, pointMetadata } from "../../src/knowledge/vector.ts";
import {
	BASE_DEPTH,
	type Candidates,
	percentile,
	quality,
	qualityAt10,
	reciprocalRanks,
	runRanking,
	type Scheme,
	TOP_K,
	VARIANTS,
	WEIGHTS,
	type Weight,
	WIDE_DEPTH,
} from "./ranking-experiments.ts";
import {
	development,
	documentText,
	evidenceChallenge,
	legacy,
	projectDocumentation,
	type QueryFixture,
	type RetrievalDataset,
	validation,
} from "./retrieval-datasets.ts";

const PROJECT = "evaluation";
const FOREIGN = "other-evaluation-project";
const REPETITIONS = 3;
const protocol = "hybrid-ranking-v1";
type Lab = Awaited<ReturnType<typeof startVectorLab>>;
type Index = ReturnType<typeof openDocumentIndex>;
type Points = Awaited<ReturnType<Index["search"]>>;

function describeHit({ document, chunk, source, score }: StoredChunk) {
	return {
		chunkId: chunk.chunkId,
		documentId: document.documentId,
		revision: chunk.documentVersion,
		corpusId: document.corpusId,
		projectId: document.projectId,
		accessPolicy: document.accessPolicy,
		file: source,
		heading: chunk.headingPath,
		chunkIndex: chunk.chunkIndex,
		score,
		lineStart: chunk.lineStart,
		lineEnd: chunk.lineEnd,
		page: chunk.pageNumber,
	};
}

function citationCheck(hits: StoredChunk[], store: DocumentStore, scope: SearchScope) {
	const content = projectKnowledgeToolContent(
		{
			toolName: KNOWLEDGE_SEARCH,
			content: [],
			details: {
				knowledgeReferences: {
					retrievalMode: "hybrid",
					truncated: false,
					hits: hits.map(({ chunk, document }) => ({
						chunkId: chunk.chunkId,
						documentId: document.documentId,
						documentVersion: chunk.documentVersion,
						corpusId: document.corpusId,
						accessPolicy: document.accessPolicy,
					})),
				},
			},
		},
		({ chunkId }) => store.chunk(chunkId, scope),
	);
	const block = content[0];
	ok(block?.type === "text");
	const parsed: {
		hits: {
			chunkId: string;
			documentId: string;
			documentVersion: number;
			corpusId: string;
			headingPath: string[];
			source: { path: string; lineStart?: number; lineEnd?: number; page?: number };
		}[];
	} = JSON.parse(block.text.slice(block.text.indexOf("\n") + 1));
	const correct = parsed.hits.filter((citation) => {
		const match = hits.find(({ chunk }) => chunk.chunkId === citation.chunkId);
		return (
			match &&
			citation.documentId === match.document.documentId &&
			citation.documentVersion === match.chunk.documentVersion &&
			citation.corpusId === match.document.corpusId &&
			citation.source.path === match.source &&
			citation.source.lineStart === match.chunk.lineStart &&
			citation.source.lineEnd === match.chunk.lineEnd &&
			citation.source.page === match.chunk.pageNumber &&
			JSON.stringify(citation.headingPath) === JSON.stringify(match.chunk.headingPath)
		);
	}).length;
	return { expected: hits.length, emitted: parsed.hits.length, correct, items: parsed.hits };
}

function summarize(samples: Sample[]) {
	const scopeViolations = samples.reduce((total, sample) => total + sample.scopeViolations.length, 0);
	const timings = samples.map(({ elapsedMs }) => elapsedMs);
	const memory = samples.map(({ rssBytes }) => rssBytes);
	const last = new Map(samples.map((sample) => [sample.queryId, sample]));
	const citations = samples.reduce(
		(sum, { citations }) => ({
			expected: sum.expected + citations.expected,
			emitted: sum.emitted + citations.emitted,
			correct: sum.correct + citations.correct,
		}),
		{ expected: 0, emitted: 0, correct: 0 },
	);
	const negative = [...last.values()].filter(({ queryType }) => queryType === "negative");
	return {
		...quality([...last.values()]),
		...(isRerank && qualityAt10([...last.values()])),
		scopeViolations,
		citations: { ...citations, accuracy: citations.expected ? citations.correct / citations.expected : null },
		negativeQueriesWithHits: negative.filter(({ actualIds }) => actualIds.length > 0).length,
		negativeHits: negative.reduce((sum, sample) => sum + sample.actualIds.length, 0),
		latencyMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95) },
		maxObservedRssBytes: Math.max(...memory),
		candidates: {
			lexicalP50: percentile(
				samples.map(({ candidateCounts }) => candidateCounts.lexical),
				0.5,
			),
			lexicalMax: Math.max(...samples.map(({ candidateCounts }) => candidateCounts.lexical)),
			semanticP50: percentile(
				samples.map(({ candidateCounts }) => candidateCounts.semantic),
				0.5,
			),
			semanticMax: Math.max(...samples.map(({ candidateCounts }) => candidateCounts.semantic)),
		},
	};
}

function loadWeight(text: string | undefined): Weight {
	const value = text === undefined ? 1 : Number(text);
	const weight = WEIGHTS.find((candidate) => candidate === value);
	if (weight === undefined) throw new Error("Unsupported experiment weight");
	return weight;
}

const fingerprint = createHash("sha256");
for (const file of [
	"dataset.ts",
	"retrieval-datasets.ts",
	"ranking-experiments.ts",
	"retrieval-eval.ts",
	"select-retrieval.ts",
]) {
	fingerprint.update(readFileSync(new URL(file, import.meta.url)));
}
const experimentSha256 = fingerprint.digest("hex");
const [action, option] = process.argv.slice(2);
const isHoldout = action === "holdout";
const isDevelopment = action === "dev";
const isReplay = action === "legacy";
const isEvidence = action === "k7";
const isRerank = action === "rerank";
const trialTopK = isRerank ? 10 : TOP_K;
const trialDepth = isRerank ? trialTopK * 8 : BASE_DEPTH;
const evidenceSets: Record<string, RetrievalDataset> = {
	fixed: legacy, dev: development, holdout: validation, challenge: evidenceChallenge,
};
if (((isEvidence || isRerank) && !Object.hasOwn(evidenceSets, option) && !(isRerank && option === "docs")) ||
	(!isEvidence && !isRerank && !isHoldout && !isDevelopment && !isReplay && action !== "legacy-compare"))
	throw new Error("Usage: retrieval-eval.ts legacy | dev | legacy-compare [weight] | holdout <lock.json> | k7|rerank fixed|dev|holdout|challenge|docs");

const locked: { protocol: string; experimentSha256: string; challenger: Scheme; weight: Weight } | undefined = isHoldout
	? JSON.parse(readFileSync(option, "utf8"))
	: undefined;
if (locked) {
	equal(locked.protocol, protocol);
	equal(locked.experimentSha256, experimentSha256);
	ok(["A", "B", "C", "D", "E"].includes(locked.challenger));
}
const weight = loadWeight(locked ? String(locked.weight) : (isEvidence || isRerank) ? undefined : option);
const dataset = isRerank && option === "docs" ? projectDocumentation() : (isEvidence || isRerank) ? evidenceSets[option] : isHoldout ? validation : isDevelopment ? development : legacy;
const schemes: Scheme[] = (isEvidence || isRerank) ? ["A"] : isHoldout
	? [...new Set<Scheme>(["A", locked!.challenger, "lexical", "semantic"])]
	: isReplay
		? ["A", "lexical", "semantic"]
		: [...VARIANTS];

async function catalog(dataset: RetrievalDataset, root: string, service: KnowledgeService, foreign: KnowledgeService) {
	const labels = new Map<string, ReturnType<typeof describeHit>>();
	const files = new Map<string, string>();
	const forbidden = new Set<string>();
	const stalePoints: StoredChunk[] = [];
	const indexed = [];
	for (const fixture of dataset.documents) {
		const owner = fixture.visibility === "foreign-project" ? foreign : service;
		const initial = fixture.visibility === "private" ? "local-only" : "allow-external";
		writeFileSync(join(root, fixture.file), documentText(fixture));
		const added = await owner.add(root, fixture.file, fixture.corpusId, initial);
		files.set(fixture.file, added.documentId);

		const prepared = await prepareKnowledgeDocument({
			root,
			source: fixture.file,
			projectId: owner.projectId,
			corpusId: fixture.corpusId,
			version: 1,
			accessPolicy: initial,
		});
		const chunks = prepared.chunks.map((chunk) => {
			const label = `${fixture.file}#${chunk.headingPath.at(-1)}`;
			const { match } = owner.read(chunk.chunkId, { audience: "host" });
			const hit = describeHit(match);
			ok(!labels.has(label), `Duplicate label ${label}`);
			labels.set(label, hit);
			if (fixture.visibility) forbidden.add(chunk.chunkId);
			if (fixture.visibility === "superseded" || fixture.visibility === "deleted") stalePoints.push(match);
			return { label, ...hit };
		});
		indexed.push({ file: fixture.file, state: fixture.visibility ?? "visible", chunks });
		if (fixture.visibility === "deleted") await owner.remove(added.documentId);
		if (fixture.visibility === "revoked") await owner.add(root, fixture.file, fixture.corpusId, "local-only");
		if (fixture.visibility === "superseded") {
			writeFileSync(
				join(root, fixture.file),
				`# ${fixture.title}\n\n## Current setting\n\nSee the active timer reference.`,
			);
			await owner.add(root, fixture.file, fixture.corpusId, initial);
		}
	}
	return { labels, files, forbidden, indexed, stalePoints };
}

type Sample = {
	queryId: string;
	queryType: QueryFixture["type"];
	scheme: Scheme;
	weight: Weight;
	repetition: number;
	relevantIds: string[];
	actualIds: string[];
	elapsedMs: number;
	rssBytes: number;
	scopeViolations: string[];
	candidateCounts: { lexical: number; semantic: number; rawSemantic: number; union: number; requestedPerLeg: number };
	citations: ReturnType<typeof citationCheck>;
	hits: ReturnType<typeof describeHit>[];
};

async function evaluate(lab: Lab, root: string, resources: KnowledgeService[]) {
	const index = openDocumentIndex(lab.endpoint, lab.embedding.model, lab.collection);
	const modelKey = embeddingModelKey(lab.embedding.model);
	const realSearch = index.search.bind(index);
	let lastPoints: Points = [];
	let requested = 0;
	index.search = async (vector, args) => {
		requested = args.limit;
		lastPoints = await realSearch(vector, args);
		return lastPoints;
	};
	const file = join(root, "eval.sqlite3");
	const options = {
		mode: "hybrid",
		vectors: { collection: lab.collection, embedding: lab.embedding, index },
	} as const;
	const service = new KnowledgeService({ ...options, projectId: PROJECT, filename: file });
	resources.push(service);
	const ranked = isRerank ? new KnowledgeService({
		...options, projectId: PROJECT, filename: file, reranker: createLocalKnowledgeReranker(),
	}) : undefined;
	if (ranked) resources.push(ranked);
	const rerankSamples: (Sample & { state: string; candidateRecall: number | null; baselineMs: number })[] = [];
	const foreign = new KnowledgeService({ ...options, projectId: FOREIGN, filename: join(root, "foreign.sqlite3") });
	resources.push(foreign);
	const fixture = await catalog(dataset, root, service, foreign);
	if (fixture.stalePoints.length) {
		// Leave stale points in Qdrant, even if indexing later fixtures has cleaned
		// the original points. The authorized SQLite revision must still win.
		const vectors = await lab.embedding.encode(
			fixture.stalePoints.map(({ chunk }) => embeddingText(chunk)),
			"passage",
		);
		await index.upsert(
			fixture.stalePoints.map(({ chunk, document }, i) => ({
				id: documentPointId(chunk.chunkId, modelKey),
				payload: pointMetadata(document, chunk, modelKey),
				vector: vectors[i],
			})),
		);
	}
	for (const id of fixture.forbidden) {
		throws(() => service.read(id, { audience: "agent" }), /document-not-found/u);
	}
	const store = new DocumentStore(file, PROJECT);
	try {
		const memoryBefore = process.memoryUsage();
		const samples: Sample[] = [];
		const traces = [];
		const evidenceChecks = [];
		const weightSamples = WEIGHTS.map((candidate) => ({ candidate, samples: [] as Sample[] }));
		const labeled = dataset.queries.map((query) => {
			const relevant = query.relevant.map((label) => {
				const match = fixture.labels.get(label);
				ok(match, `No indexed chunk for ${query.id}: ${label}`);
				ok(!fixture.forbidden.has(match.chunkId) && (!query.corpusId || query.corpusId === match.corpusId));
				return { label, ...match };
			});
			const documentId = query.onlyFile ? fixture.files.get(query.onlyFile) : undefined;
			ok(!query.onlyFile || documentId, "Unknown scope fixture");
			const scope = { audience: "agent", corpusId: query.corpusId, documentId } as const;
			return { ...query, scope, labels: relevant };
		});
		const gather = async (query: (typeof labeled)[number], scheme: Scheme): Promise<Candidates> => {
			const depth = scheme === "B" ? WIDE_DEPTH : trialDepth;
			lastPoints = [];
			requested = 0;
			const lexical =
				scheme === "semantic" ? [] : store.lexical(query.text, query.scope, scheme === "lexical" ? TOP_K : depth);
			if (scheme === "lexical") return { lexical, semantic: [] };
			const native = await service.search(query.text, query.scope, depth / 8, "semantic");
			equal(native.mode, "semantic", native.fallback);
			if (requested) equal(requested, depth);
			const semantic = lastPoints.flatMap(({ id, payload, score }) => {
				const live = store.chunk(payload.chunkId, query.scope);
				if (!live || id !== documentPointId(payload.chunkId, modelKey)) return [];
				const expected = pointMetadata(live.document, live.chunk, modelKey);
				if (!Object.entries(expected).every(([key, value]) => payload[key as keyof typeof payload] === value))
					return [];
				return [{ ...live, score }];
			});
			deepStrictEqual(
				semantic.slice(0, depth / 8),
				native.hits,
				"Benchmark candidates diverged from native semantic",
			);
			return { lexical, semantic };
		};
		function liveRanking(
			query: (typeof labeled)[number],
			scheme: Scheme,
			candidates: Candidates,
			selectedWeight: Weight,
		) {
			return runRanking(
				scheme,
				query.text,
				candidates,
				selectedWeight,
				Math.max(TOP_K, candidates.lexical.length + candidates.semantic.length),
			)
				.flatMap(({ chunk, score }) => {
					const live = store.chunk(chunk.chunkId, query.scope);
					return live ? [{ ...live, score }] : [];
				})
				.slice(0, trialTopK);
		}
		function sample(
			query: (typeof labeled)[number],
			scheme: Scheme,
			selectedWeight: Weight,
			repetition: number,
			candidates: Candidates,
			start: number,
		): Sample {
			const hits = liveRanking(query, scheme, candidates, selectedWeight);
			const elapsedMs = performance.now() - start;
			const actualIds = hits.map(({ chunk }) => chunk.chunkId);
			const scopeViolations = hits
				.filter(
					({ chunk, document }) =>
						fixture.forbidden.has(chunk.chunkId) ||
						document.projectId !== PROJECT ||
						document.accessPolicy !== "allow-external" ||
						(query.scope.documentId && document.documentId !== query.scope.documentId) ||
						(query.corpusId && document.corpusId !== query.corpusId),
				)
				.map(({ chunk }) => chunk.chunkId);
			return {
				queryId: query.id,
				queryType: query.type,
				scheme,
				weight: scheme === "C" ? selectedWeight : 1,
				repetition,
				relevantIds: query.labels.map(({ chunkId }) => chunkId),
				elapsedMs,
				rssBytes: process.memoryUsage.rss(),
				actualIds,
				scopeViolations,
				citations: citationCheck(hits, store, query.scope),
				hits: hits.map(describeHit),
				candidateCounts: {
					requestedPerLeg: scheme === "lexical" ? TOP_K : scheme === "B" ? WIDE_DEPTH : trialDepth,
					lexical: candidates.lexical.length,
					semantic: candidates.semantic.length,
					rawSemantic: lastPoints.length,
					union: new Set([...candidates.lexical, ...candidates.semantic].map(({ chunk }) => chunk.chunkId)).size,
				},
			};
		}
		for (const query of labeled) {
			for (let repetition = 0; repetition < REPETITIONS; repetition++) {
				// Rotate run order to avoid consistently favoring one candidate with warm caches.
				const offset = (repetition + labeled.indexOf(query)) % schemes.length;
				const ordered = [...schemes.slice(offset), ...schemes.slice(0, offset)];
				for (const scheme of ordered) {
					const start = performance.now();
					const candidates = await gather(query, scheme);
					const current = sample(query, scheme, weight, repetition, candidates, start);
					samples.push(current);
					if (ranked) {
						const baselineStarted = performance.now();
						const baseline = await service.search(query.text, query.scope, trialTopK);
						const baselineMs = performance.now() - baselineStarted;
						equal(baseline.mode, "hybrid", baseline.fallback);
						deepStrictEqual(baseline.hits.map(describeHit), current.hits);
						const before = performance.now();
						const reranked = await ranked.search(query.text, query.scope, trialTopK);
						const elapsedMs = performance.now() - before;
						equal(reranked.mode, "hybrid", reranked.fallback);
						const pool = runRanking("A", query.text, candidates, 1, KNOWLEDGE_RERANK_DEPTH)
							.map(({ chunk }) => chunk.chunkId);
						const actualIds = reranked.hits.map(({ chunk }) => chunk.chunkId);
						const scopeViolations = actualIds.filter((id) => fixture.forbidden.has(id) || !store.chunk(id, query.scope));
						equal(scopeViolations.length, 0);
						rerankSamples.push({
							...current, actualIds, scopeViolations, elapsedMs, baselineMs,
							hits: reranked.hits.map(describeHit), citations: citationCheck(reranked.hits, store, query.scope),
							state: reranked.rerank ?? "not-needed",
							candidateRecall: current.relevantIds.length
								? current.relevantIds.filter((id) => pool.includes(id)).length / current.relevantIds.length
								: null,
						});
					}
					if (isEvidence) {
						const before = performance.now();
						const live = await service.search(query.text, query.scope, trialTopK, "hybrid");
						const nativeMs = performance.now() - before;
						deepStrictEqual(live.hits.map(describeHit), current.hits);
						const project = (evidenceOnly: boolean) => {
							const start = performance.now();
							const result = knowledgeSearchResult(query.text, live, evidenceOnly);
							const [block] = projectKnowledgeToolContent({ ...result, toolName: KNOWLEDGE_SEARCH },
								({ chunkId }) => store.chunk(chunkId, query.scope));
							const elapsedMs = performance.now() - start;
							ok(block?.type === "text");
							const response = JSON.parse(block.text.slice(block.text.indexOf("\n") + 1)) as {
								evidenceStatus: EvidenceStatus; candidateCount: number;
								hits: { chunkId: string; documentId: string; documentVersion: number; evidence: string }[];
							};
							for (const hit of response.hits) {
								const found = live.hits.find(({ chunk }) => chunk.chunkId === hit.chunkId);
								ok(found && found.document.documentId === hit.documentId &&
									found.chunk.documentVersion === hit.documentVersion && !fixture.forbidden.has(hit.chunkId));
							}
							return { elapsedMs, response };
						};
						const search = project(false);
						const only = project(true);
						deepStrictEqual(search.response.hits.map(({ chunkId }) => chunkId), current.actualIds);
						ok(only.response.hits.every(({ evidence }) => evidence === "exact-reference"));
						evidenceChecks.push({
							queryId: query.id, queryType: query.type, repetition,
							relevantIds: current.relevantIds, nativeMs, search, evidenceOnly: only,
						});
					}
					if (scheme === "A" && repetition === 0) {
						const live = await service.search(query.text, query.scope, trialTopK, "hybrid");
						equal(live.mode, "hybrid");
						deepStrictEqual(live.hits.map(describeHit), current.hits, "Baseline fusion diverged from production");
						const rrf = reciprocalRanks(candidates).map(({ hit, ...rank }, i) => ({
							...describeHit(hit),
							...rank,
							fusedRank: i + 1,
							inTopK: i < trialTopK,
						}));
						traces.push({
							queryId: query.id,
							text: query.text,
							scope: query.scope,
							relevant: query.labels,
							topK: trialTopK,

							requestedPerLeg: BASE_DEPTH,
							lexical: candidates.lexical.map((hit, i) => ({ rank: i + 1, ...describeHit(hit) })),
							semantic: candidates.semantic.map((hit, i) => ({ rank: i + 1, ...describeHit(hit) })),
							fusion: rrf,
						});
					}
					if (isDevelopment && scheme === "A" && repetition === 0) {
						for (const profile of weightSamples) {
							profile.samples.push(
								sample(query, "C", profile.candidate, repetition, candidates, performance.now()),
							);
						}
					}
				}
			}
		}
		// A benchmark may return unrelated visible hits for negative queries. Authorization
		// failures and mismatched citations are independently fatal.
		ok(
			samples.every((row) => row.scopeViolations.length === 0),
			"Authorization scope violation",
		);
		ok(
			samples.every(
				({ citations }) => citations.correct === citations.expected && citations.emitted === citations.expected,
			),
			"Invalid or missing source citation",
		);
		return {
			protocol,
			experimentSha256,
			dataset: dataset.id,
			datasetSha256: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"),
			action,
			topK: trialTopK,
			repetitions: REPETITIONS,
			model: lab.embedding.model,
			qdrant: "1.15.5",
			host: {
				platform: process.platform,
				node: process.version,
				memoryBefore,
				memoryAfter: process.memoryUsage(),
				processPeakRssKiB: process.resourceUsage().maxRSS,
			},
			dockerMemory: lab.memory(),
			workerNetwork: lab.workerNetwork(),
			collections: 1,
			indexed: fixture.indexed,
			staleQdrantPoints: fixture.stalePoints.map(describeHit),
			queries: labeled,
			samples,
			traces,
			...(isEvidence && { evidenceChecks }),
			...(ranked && {
				rerank: {
					revision: RERANKER_REVISION, depth: KNOWLEDGE_RERANK_DEPTH,
					candidateRecall: (() => {
						const positives = rerankSamples.flatMap((row) => row.candidateRecall === null ? [] : [row.candidateRecall]);
						return positives.length ? positives.reduce((sum, recall) => sum + recall, 0) / positives.length : null;
					})(),
					...summarize(rerankSamples), samples: rerankSamples,
					pairedBaselineLatencyMs: {
						p50: percentile(rerankSamples.map((row) => row.baselineMs), 0.5),
						p95: percentile(rerankSamples.map((row) => row.baselineMs), 0.95),
					},
				},
			}),
			perScheme: schemes.map((scheme) => {
				const selected = samples.filter((row) => row.scheme === scheme);
				const groups = [...new Set(selected.map(({ queryType }) => queryType))].map((type) => ({
					type,
					...summarize(selected.filter((row) => row.queryType === type)),
				}));
				return { scheme, weight: scheme === "C" ? weight : 1, ...summarize(selected), groups };
			}),
			...(isDevelopment && {
				weightGrid: weightSamples.map(({ candidate, samples }) => ({
					weight: candidate,
					quality: quality(samples),
					perQuery: samples.map(({ queryId, actualIds, relevantIds }) => ({
						queryId,
						actualIds,
						relevantIds,
					})),
				})),
			}),
		};
	} finally {
		store.close();
	}
}

const root = mkdtempSync(join(tmpdir(), "pi-rag-ranking-"));
let lab: Lab | undefined;
const services: KnowledgeService[] = [];
try {
	lab = await startVectorLab();
	console.log(JSON.stringify(await evaluate(lab, root, services), null, 2));
} finally {
	try {
		await Promise.all(services.map((service) => service.close()));
	} finally {
		try {
			await lab?.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
}
