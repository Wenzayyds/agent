import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startVectorLab } from "../../fixtures/knowledge/vector-lab.ts";
import type { EmbeddingProvider } from "../../src/shared/embedding/e5.ts";
import { KnowledgeService, type RetrievalMode } from "../../src/knowledge/service.ts";
import { openDocumentIndex } from "../../src/knowledge/vector.ts";
import { corpus, DATASET_VERSION, queries } from "./dataset.ts";

const repeats = 3;
const root = mkdtempSync(join(tmpdir(), "pi-knowledge-eval-"));
type Lab = Awaited<ReturnType<typeof startVectorLab>>;
let lab: Lab | undefined;
let service: KnowledgeService | undefined;

try {
	lab = await startVectorLab();
	const { embedding: local, collection, endpoint } = lab;
	const encoding: { purpose: string; elapsed: number }[] = [];
	const embedding: EmbeddingProvider = {
		model: local.model,
		async encode(texts, purpose) {
			const start = performance.now();
			const result = await local.encode(texts, purpose);
			encoding.push({ purpose, elapsed: performance.now() - start });
			return result;
		},
	};
	const index = openDocumentIndex(endpoint, embedding.model, collection);
	const filename = join(root, "eval.sqlite3");
	service = new KnowledgeService({ projectId: "evaluation", filename, mode: "hybrid", vectors: { collection, embedding, index } });
	const ids = new Map<string, string>();
	const duplicates: number[] = [];
	for (const document of corpus) {
		const contents = [
			`# ${document.title}`, ...document.sections.map(([heading, text]) => `## ${heading}\n\n${text}`),
		].join("\n\n");
		writeFileSync(join(root, document.file), contents, "utf8");
		const policy = ("private" in document) ? "local-only" : "allow-external";
		const { documentId } = await service.add(root, document.file, document.corpusId, policy);
		ids.set(document.file, documentId);
		const started = performance.now();
		if ((await service.add(root, document.file, document.corpusId, policy)).outcome !== "unchanged") {
			throw new Error("Identical file was reindexed");
		}
		duplicates.push(performance.now() - started);
	}
	const perMode = [];
	for (const mode of ["lexical", "semantic", "hybrid"] as const satisfies readonly RetrievalMode[]) {
		const timings: number[] = [];
		let totalRecall = 0;
		let totalRR = 0;
		let scopeFalseHits = 0;
		const samples = [];
		for (const query of queries) {
			let labels: string[] = [];
			for (let repetition = 0; repetition < repeats; repetition += 1) {
				const start = performance.now();
				const result = await service.search(query.text, {
					audience: "agent", corpusId: query.corpusId, documentId: query.onlyFile && ids.get(query.onlyFile),
				}, 5, mode);
				timings.push(performance.now() - start);
				if (result.mode !== mode) throw new Error(`Unexpected benchmark fallback: ${result.fallback}`);
				scopeFalseHits += result.hits.filter(({ document, source }) =>
					document.accessPolicy !== "allow-external" || (!!query.corpusId && document.corpusId !== query.corpusId) ||
					(!!query.onlyFile && source !== query.onlyFile)).length;
				if (!query.relevant.length) scopeFalseHits += result.hits.length;
				labels = result.hits.map(({ chunk, source }) => `${source}#${chunk.headingPath.at(-1)}`);
			}
			const rank = labels.findIndex((label) => query.relevant.includes(label));
			const recall = query.relevant.length ? labels.filter((label) => query.relevant.includes(label)).length / query.relevant.length : null;
			if (recall !== null) {
				totalRecall += recall;
				totalRR += rank === -1 ? 0 : 1 / (rank + 1);
			}
			samples.push({ text: query.text, relevant: query.relevant, actual: labels });
		}
		const positive = queries.filter(({ relevant }) => relevant.length).length;
		perMode.push({ mode, recallAt5: totalRecall / positive, mrrAt5: totalRR / positive,
			scopeFalseHits, p50Ms: quantile(timings, 0.5), p95Ms: quantile(timings, 0.95), samples });
	}
	const chunks = service.status().storedChunks;
	const vectorBytes = lab.vectorBytes();
	const memory = lab.memory();
	await service.close();
	service = undefined;
	console.log(JSON.stringify({
		datasetVersion: DATASET_VERSION, documents: corpus.length, queryCount: queries.length, repeats, chunks,
		sqliteBytes: statSync(filename).size, qdrantStorageBytes: vectorBytes, memory,
		coldPassageMs: encoding[0]?.elapsed,
		queryEmbeddingP50Ms: quantile(encoding.filter(({ purpose }) => purpose === "query").map(({ elapsed }) => elapsed), 0.5),
		duplicateP50Ms: quantile(duplicates, 0.5), duplicateP95Ms: quantile(duplicates, 0.95), perMode,
	}, null, 2));
} finally {
	try {
		await service?.close();
	} finally {
		await lab?.close();
		rmSync(root, { recursive: true, force: true });
	}
}

function quantile(samples: number[], fraction: number): number {
	const ordered = [...samples].sort((a, b) => a - b);
	return ordered[Math.ceil(ordered.length * fraction) - 1];
}
