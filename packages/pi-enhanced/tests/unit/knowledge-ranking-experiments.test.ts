import { describe, expect, it } from "vitest";
import {
	exactAnchors,
	groupDocuments,
	quality,
	reciprocalRanks,
	runRanking,
} from "../../benchmarks/knowledge/ranking-experiments.ts";
import { development, legacy, validation } from "../../benchmarks/knowledge/retrieval-datasets.ts";
import type { StoredChunk } from "../../src/knowledge/store.ts";
import { KNOWLEDGE_SEARCH, knowledgeSearchResult, projectKnowledgeToolContent } from "../../src/knowledge/tools.ts";

function hit(id: string, documentId: string, text = id, index = 0): StoredChunk {
	return {
		source: `${documentId}.md`,
		score: 0,
		document: {
			documentId,
			projectId: "p",
			corpusId: "c",
			title: documentId,
			sourcePath: `${documentId}.md`,
			mimeType: "text/markdown",
			contentHash: "",
			version: 1,
			activeVersion: 1,
			status: "indexed",
			createdAt: 0,
			updatedAt: 0,
			accessPolicy: "allow-external",
		},
		chunk: {
			chunkId: id,
			documentId,
			documentVersion: 1,
			content: text,
			headingPath: [],
			chunkIndex: index,
			contentHash: "",
			parserVersion: "test",
			chunkerVersion: "test",
		},
	};
}

it.each([
	["What do butterflies eat?", ["Run inspect_relay()."], "insufficient-evidence", 0],
	["Which supervisor can reset the relay?", ["A supervisor can reset the relay."], "insufficient-evidence", 0],
	["How many watts does a backup relay need?", ["A backup relay handles 200 requests per minute."], "insufficient-evidence", 0],
	["inspect_relay()", ["Run inspect_relay()."], "supported", 1],
	["POST /v4/shipments warehouse_code", ["POST /v4/shipments accepts warehouse_code."], "supported", 1],
	["POST /v4/shipments warehouse_code", ["POST /v4/shipments creates a record.", "warehouse_code is a filter."], "insufficient-evidence", 0],
	["inspect_relay()", ["Run old_inspect_relay()."], "insufficient-evidence", 0],
	["warehouse_code", ["Use warehouse_code_default."], "insufficient-evidence", 0],
	["中继器故障后何时恢复？", ["A supervisor must reset the relay."], "insufficient-evidence", 0],
	["What happens after a checksum failure?", ["校验失败时，重新复制损坏的文件。", "值班员确认后才可恢复访问。"], "insufficient-evidence", 0],
	["Unknown", [], "no-candidates", 0],
] as const)("classifies %s and keeps the candidate search available", (query, passages, status, exactCount) => {
	const hits = passages.map((text, index) => hit(String(index + 1).repeat(64), "a".repeat(64), text, index));
	for (const evidenceOnly of [false, true]) {
		const stored = knowledgeSearchResult(query, { hits, mode: "hybrid" }, evidenceOnly);
		const [block] = projectKnowledgeToolContent({ ...stored, toolName: KNOWLEDGE_SEARCH }, ({ chunkId }) =>
			hits.find(({ chunk }) => chunk.chunkId === chunkId));
		if (block.type !== "text") throw new Error("Expected a text result");
		const response = JSON.parse(block.text.slice(block.text.indexOf("\n") + 1));
		expect(response).toMatchObject({ evidenceStatus: status, candidateCount: hits.length });
		expect(response.hits).toHaveLength(evidenceOnly ? exactCount : hits.length);
		expect(response.hits.filter((item: { evidence: string }) => item.evidence === "exact-reference")).toHaveLength(exactCount);
	}
});

it("reports degraded retrieval separately and removes support when the source is unavailable", () => {
	const live = hit("1".repeat(64), "a".repeat(64), "Use queue_reject_limit.");
	const cases = [
		{ hits: [live], mode: "lexical", fallback: "qdrant-unavailable", expected: "backend-unavailable", visible: live },
		{ hits: [live], mode: "hybrid", expected: "no-candidates", visible: undefined },
	] as const;
	for (const { expected, visible, ...search } of cases) {
		const stored = knowledgeSearchResult("queue_reject_limit", { ...search, hits: [...search.hits] });
		const [block] = projectKnowledgeToolContent({ ...stored, toolName: KNOWLEDGE_SEARCH }, () => visible);
		if (block.type !== "text") throw new Error("Expected a text result");
		expect(JSON.parse(block.text.slice(block.text.indexOf("\n") + 1))).toMatchObject({ evidenceStatus: expected });
	}
});
const ids = (hits: StoredChunk[]) => hits.map(({ chunk }) => chunk.chunkId);

describe("Knowledge retrieval experiment", () => {
	it("reports one-based ranks and the contributions of absent and shared candidates", () => {
		const linked = hit("shared", "doc-a");
		const dense = hit("dense-only", "doc-b");
		const ranks = reciprocalRanks({ lexical: [linked], semantic: [dense, linked] });
		expect(ranks.map(({ hit }) => hit.chunk.chunkId)).toEqual(["shared", "dense-only"]);
		expect(ranks[0]).toMatchObject({ lexicalRank: 1, semanticRank: 2, score: 1 / 61 + 1 / 62 });
		expect(ranks[1]).toMatchObject({ lexicalRank: null, semanticRank: 1, lexicalContribution: 0, score: 1 / 61 });
		expect(reciprocalRanks({ lexical: [], semantic: [dense] }, 4)[0].semanticContribution).toBe(4 / 61);
	});

	it("defers same-document results and backfills without dropping requested slots", () => {
		const ranks = [hit("a0", "a"), hit("a1", "a", "", 1), hit("b0", "b"), hit("a2", "a", "", 2)];
		expect(ids(groupDocuments(ranks, 3))).toEqual(["a0", "b0", "a1"]);
		expect(ids(groupDocuments(ranks, 1))).toEqual(["a0"]);
	});

	it("uses whole identifier matches and dense candidates for plain language", () => {
		const distractor = hit("prefix", "a", "Change the old resume_token_v1 now.");
		const related = hit("exact", "b", "To continue, send resume_token.");
		expect(exactAnchors("Please inspect trace_path() and GET /v3/jobs/{job_id}")).toEqual([
			"trace_path()",
			"/v3/jobs/{job_id}",
		]);
		expect(
			ids(
				runRanking(
					"E",
					"继续时传 resume_token 吗？",
					{ lexical: [distractor], semantic: [related, distractor] },
					1,
					1,
				),
			),
		).toEqual(["exact"]);
		expect(
			ids(runRanking("E", "How can it continue?", { lexical: [related], semantic: [distractor] }, 1, 1)),
		).toEqual(["prefix"]);
		expect(ids(runRanking("E", "How can it continue?", { lexical: [related], semantic: [] }, 1, 1))).toEqual([
			"exact",
		]);
	});

	it("counts multiple relevant chunks, duplicates and negative queries separately", () => {
		expect(
			quality([
				{ relevantIds: ["a", "b"], actualIds: ["m", "m", "a", "a", "b", "n"] },
				{ relevantIds: ["c"], actualIds: ["c"] },
				{ relevantIds: [], actualIds: ["d"] },
			]),
		).toEqual({
			queryCount: 3,
			positiveCount: 2,
			multiRelevantCount: 1,
			recallAt1: 0.5,
			recallAt5: 1,
			mrrAt5: (1 / 3 + 1) / 2,
			precisionAt5: (0.4 + 0.2) / 2,
			multiRelevantPrecisionAt5: 0.4,
		});
		expect(quality([{ relevantIds: [], actualIds: [] }]).recallAt5).toBeNull();
	});

	it("keeps the fixed set and separates development and validation titles and queries", () => {
		expect(legacy.documents).toHaveLength(8);
		expect(legacy.queries).toHaveLength(14);
		const devTitles = new Set(development.documents.map(({ title }) => title));
		const devQueries = new Set(development.queries.map(({ text }) => text));
		expect(validation.documents.every(({ title }) => !devTitles.has(title))).toBe(true);
		expect(validation.queries.every(({ text }) => !devQueries.has(text))).toBe(true);
		for (const data of [development, validation]) {
			const labels = new Set(
				data.documents
					.filter(({ visibility }) => !visibility)
					.flatMap(({ file, sections }) => sections.map(([heading]) => `${file}#${heading}`)),
			);
			expect(data.queries.every(({ relevant }) => relevant.every((label) => labels.has(label)))).toBe(true);
			expect(data.queries.filter(({ relevant }) => relevant.length > 1)).toHaveLength(3);
		}
	});
});
