import type { StoredChunk } from "../../src/knowledge/store.ts";

export const TOP_K = 5;
export const BASE_DEPTH = TOP_K * 8;
export const WIDE_DEPTH = TOP_K * 16;
export const WEIGHTS = [1, 0.5, 2, 4, 8, 16, 32] as const;
export type Weight = (typeof WEIGHTS)[number];
export type Scheme = "A" | "B" | "C" | "D" | "E" | "lexical" | "semantic";
export const VARIANTS: readonly Scheme[] = ["A", "B", "C", "D", "E", "lexical", "semantic"];

export interface Candidates {
	lexical: readonly StoredChunk[];
	semantic: readonly StoredChunk[];
}

export interface RankEntry {
	hit: StoredChunk;
	lexicalRank: number | null;
	semanticRank: number | null;
	lexicalContribution: number;
	semanticContribution: number;
	score: number;
}

export function reciprocalRanks(candidates: Candidates, semanticWeight: Weight = 1): RankEntry[] {
	const ranks = new Map<string, RankEntry>();
	for (const name of ["lexical", "semantic"] as const) {
		const ranking = candidates[name];
		for (const [index, hit] of ranking.entries()) {
			const id = hit.chunk.chunkId;
			const entry = ranks.get(id) ?? {
				hit,
				lexicalRank: null,
				semanticRank: null,
				lexicalContribution: 0,
				semanticContribution: 0,
				score: 0,
			};
			const rank = index + 1;
			if (name === "lexical") {
				entry.lexicalRank = rank;
				entry.lexicalContribution = 1 / (60 + rank);
			} else {
				entry.semanticRank = rank;
				entry.semanticContribution = semanticWeight / (60 + rank);
			}
			entry.score = entry.lexicalContribution + entry.semanticContribution;
			entry.hit = hit;
			ranks.set(id, entry);
		}
	}
	return [...ranks.values()].sort(
		(left, right) =>
			right.score - left.score ||
			left.hit.source.localeCompare(right.hit.source, "en") ||
			left.hit.chunk.chunkIndex - right.hit.chunk.chunkIndex ||
			left.hit.chunk.chunkId.localeCompare(right.hit.chunk.chunkId),
	);
}

// Try the best result per document first. If the corpus has fewer documents than
// requested slots, restore deferred chunks in their original rank order.
export function groupDocuments(ranks: readonly StoredChunk[], limit: number): StoredChunk[] {
	const seen = new Set<string>();
	const first: StoredChunk[] = [];
	const rest: StoredChunk[] = [];
	for (const hit of ranks) {
		const id = hit.document.documentId;
		(seen.has(id) ? rest : first).push(hit);
		seen.add(id);
	}
	return [...first, ...rest].slice(0, limit);
}

const SYMBOL = /\/[\w{}-]+(?:\/[\w{}-]+)*|[a-zA-Z][\w]*\(\)|[a-zA-Z][\w]*(?:[_.-][a-zA-Z\d]+)+|[A-Z]{2,}\d{2,}/gu;
export function exactAnchors(query: string): string[] {
	return [...new Set((query.normalize("NFKC").match(SYMBOL) ?? []).map((value) => value.toLowerCase()))];
}

function anchorCount(hit: StoredChunk, anchors: readonly string[]): number {
	const searchable = [...hit.chunk.headingPath, hit.chunk.content].join("\n").normalize("NFKC").toLowerCase();
	const literals = new Set(
		searchable.match(/[a-z\d_/{}.-]+(?:\(\))?/gu)?.map((value) => value.replace(/[.-]+$/u, "")),
	);
	return anchors.filter((anchor) => literals.has(anchor)).length;
}

export function runRanking(
	scheme: Scheme,
	query: string,
	candidates: Candidates,
	weight: Weight,
	limit = TOP_K,
): StoredChunk[] {
	if (scheme === "lexical") return candidates.lexical.slice(0, limit);
	if (scheme === "semantic") return candidates.semantic.slice(0, limit);
	if (scheme === "E" && exactAnchors(query).length === 0)
		return (candidates.semantic.length ? candidates.semantic : candidates.lexical).slice(0, limit);
	const ranks = reciprocalRanks(candidates, scheme === "C" ? weight : 1).map(({ hit, score }) => ({ ...hit, score }));
	if (scheme === "D") return groupDocuments(ranks, limit);
	if (scheme === "E") {
		const anchors = exactAnchors(query);
		return ranks
			.map((hit) => ({ hit, count: anchorCount(hit, anchors) }))
			.sort((a, b) => b.count - a.count)
			.slice(0, limit)
			.map(({ hit }) => hit);
	}
	return ranks.slice(0, limit);
}

export interface QualitySample {
	relevantIds: readonly string[];
	actualIds: readonly string[];
}

export function quality(samples: readonly QualitySample[]) {
	const positive = samples.filter(({ relevantIds }) => relevantIds.length);
	const average = (values: readonly number[]) =>
		values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
	const counts = positive.map(({ relevantIds, actualIds }) => {
		const expected = new Set(relevantIds);
		const returned = actualIds.slice(0, TOP_K);
		const first = returned.findIndex((id) => expected.has(id));
		const hits = new Set(returned.filter((id) => expected.has(id))).size;
		return { first, hits, expected: expected.size };
	});
	return {
		queryCount: samples.length,
		positiveCount: positive.length,
		multiRelevantCount: counts.filter(({ expected }) => expected > 1).length,
		recallAt1: average(counts.map(({ first, expected }) => Number(first === 0) / expected)),
		recallAt5: average(counts.map(({ hits, expected }) => hits / expected)),
		mrrAt5: average(counts.map(({ first }) => (first === -1 ? 0 : 1 / (first + 1)))),
		precisionAt5: average(counts.map(({ hits }) => hits / TOP_K)),
		multiRelevantPrecisionAt5: average(counts.filter(({ expected }) => expected > 1).map(({ hits }) => hits / TOP_K)),
	};
}

export function qualityAt10(samples: readonly QualitySample[]) {
	const positive = samples.filter(({ relevantIds }) => relevantIds.length);
	if (!positive.length) return { mrrAt10: null, ndcgAt10: null };
	const discount = (index: number) => 1 / Math.log2(index + 2);
	let reciprocalRank = 0;
	let normalizedGain = 0;
	for (const { relevantIds, actualIds } of positive) {
		const expected = new Set(relevantIds);
		const returned = actualIds.slice(0, 10);
		const first = returned.findIndex((id) => expected.has(id));
		if (first >= 0) reciprocalRank += 1 / (first + 1);
		const seen = new Set<string>();
		const gain = returned.reduce((sum, id, index) => {
			if (!expected.has(id) || seen.has(id)) return sum;
			seen.add(id);
			return sum + discount(index);
		}, 0);
		const ideal = Array.from({ length: Math.min(10, expected.size) }, (_, index) => discount(index))
			.reduce((sum, value) => sum + value, 0);
		normalizedGain += gain / ideal;
	}
	return { mrrAt10: reciprocalRank / positive.length, ndcgAt10: normalizedGain / positive.length };
}

export function percentile(samples: readonly number[], fraction: number): number | null {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}
