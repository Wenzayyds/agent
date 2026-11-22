import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { Scheme, Weight } from "./ranking-experiments.ts";

interface Metrics {
	recallAt1: number;
	recallAt5: number;
	mrrAt5: number;
	precisionAt5: number;
	multiRelevantPrecisionAt5: number | null;
}

interface EvaluationRow extends Metrics {
	scheme: Scheme;
	weight: Weight;
	scopeViolations: number;
	negativeHits: number;
	citations: { accuracy: number };
	latencyMs: { p95: number };
	groups: { type: string; recallAt5: number | null }[];
}

interface Evaluation {
	action: string;
	protocol: string;
	experimentSha256: string;
	perScheme: EvaluationRow[];
	weightGrid?: { weight: Weight; quality: Metrics }[];
}

const EPSILON = 1e-9;
const NOISE_FLOOR = 0.02;

function compareMetrics(left: Metrics, right: Metrics): number {
	return (
		right.recallAt5 - left.recallAt5 ||
		right.mrrAt5 - left.mrrAt5 ||
		right.recallAt1 - left.recallAt1 ||
		right.precisionAt5 - left.precisionAt5
	);
}

function chooseWeight(report: Evaluation): Weight {
	if (report.action !== "dev" || !report.weightGrid?.length) throw new Error("Expected development weight grid");
	return [...report.weightGrid].sort(
		(a, b) => compareMetrics(a.quality, b.quality) || Math.abs(Math.log2(a.weight)) - Math.abs(Math.log2(b.weight)),
	)[0].weight;
}

function compare(candidate: EvaluationRow, baseline: EvaluationRow) {
	const reasons: string[] = [];
	if (candidate.scopeViolations !== 0 || candidate.citations.accuracy !== 1) reasons.push("authorization-or-citation");
	if (candidate.recallAt5 + EPSILON < baseline.recallAt5) reasons.push("recall-at-5");
	if (
		candidate.recallAt1 + NOISE_FLOOR + EPSILON < baseline.recallAt1 ||
		candidate.mrrAt5 + NOISE_FLOOR + EPSILON < baseline.mrrAt5
	)
		reasons.push("first-hit-quality");
	if (
		candidate.precisionAt5 + NOISE_FLOOR + EPSILON < baseline.precisionAt5 ||
		(candidate.multiRelevantPrecisionAt5 ?? 0) + NOISE_FLOOR + EPSILON < (baseline.multiRelevantPrecisionAt5 ?? 0)
	)
		reasons.push("precision");
	for (const group of candidate.groups) {
		const previous = baseline.groups.find(({ type }) => type === group.type);
		if (
			group.recallAt5 !== null &&
			previous?.recallAt5 !== null &&
			previous?.recallAt5 !== undefined &&
			group.recallAt5 + EPSILON < previous.recallAt5
		)
			reasons.push(`group:${group.type}`);
	}
	if (candidate.negativeHits > baseline.negativeHits) reasons.push("more-unanswerable-hits");
	if (candidate.latencyMs.p95 > baseline.latencyMs.p95 * 1.3 + 5) reasons.push("p95");
	return reasons;
}

const [action, developmentPath, otherPath, lockPath] = process.argv.slice(2);
const load = (path: string) => {
	const bytes = readFileSync(path);
	return {
		report: JSON.parse(bytes.toString("utf8")) as Evaluation,
		dataSha256: createHash("sha256").update(bytes).digest("hex"),
	};
};
const dev = load(developmentPath);
const weight = chooseWeight(dev.report);
if (action === "weight") {
	console.log(weight);
} else if (action === "lock") {
	const fixed = load(otherPath);
	if (
		fixed.report.action !== "legacy-compare" ||
		fixed.report.experimentSha256 !== dev.report.experimentSha256 ||
		fixed.report.perScheme.find(({ scheme }) => scheme === "C")?.weight !== weight ||
		dev.report.perScheme.find(({ scheme }) => scheme === "C")?.weight !== weight
	)
		throw new Error("Run both comparisons with the development-selected weight");
	const baseline = dev.report.perScheme.find(({ scheme }) => scheme === "A")!;
	const fixedBaseline = fixed.report.perScheme.find(({ scheme }) => scheme === "A")!;
	const candidates = dev.report.perScheme
		.filter(({ scheme }) => ["B", "C", "D", "E"].includes(scheme))
		.map((row) => {
			const fixedRow = fixed.report.perScheme.find(({ scheme }) => scheme === row.scheme)!;
			const developmentReasons = compare(row, baseline);
			const fixedReasons = compare(fixedRow, fixedBaseline);
			if (fixedRow.recallAt5 <= fixedBaseline.recallAt5 + EPSILON) fixedReasons.push("original-recall-loss-remains");
			if (
				Math.max(
					row.recallAt5 - baseline.recallAt5,
					row.mrrAt5 - baseline.mrrAt5,
					row.recallAt1 - baseline.recallAt1,
				) +
					EPSILON <
				NOISE_FLOOR
			)
				developmentReasons.push("no-material-development-gain");
			return { row, fixedRow, developmentReasons, fixedReasons };
		})
		.sort((a, b) => compareMetrics(a.row, b.row));
	const eligible = candidates.filter(
		({ developmentReasons, fixedReasons }) => !developmentReasons.length && !fixedReasons.length,
	);
	const diagnostic = candidates.find(({ fixedRow }) => fixedRow.recallAt5 > fixedBaseline.recallAt5 + EPSILON);
	const challenger = eligible[0]?.row.scheme ?? diagnostic?.row.scheme ?? candidates[0].row.scheme;
	console.log(
		JSON.stringify(
			{
				protocol: dev.report.protocol,
				experimentSha256: dev.report.experimentSha256,
				challenger,
				weight,
				eligibleBeforeHoldout: eligible.some(({ row }) => row.scheme === challenger),
				inputs: [
					{ file: relative(process.cwd(), developmentPath), sha256: dev.dataSha256 },
					{ file: relative(process.cwd(), otherPath), sha256: fixed.dataSha256 },
				],
				decisions: candidates.map(({ row, developmentReasons, fixedReasons }) => ({
					scheme: row.scheme,
					developmentReasons,
					fixedReasons,
				})),
			},
			null,
			2,
		),
	);
} else if (action === "verify") {
	const holdout = load(otherPath);
	const locked: { protocol: string; experimentSha256: string; challenger: Scheme; eligibleBeforeHoldout: boolean } =
		JSON.parse(readFileSync(lockPath, "utf8"));
	if (
		holdout.report.action !== "holdout" ||
		holdout.report.experimentSha256 !== locked.experimentSha256 ||
		dev.report.experimentSha256 !== locked.experimentSha256 ||
		dev.report.protocol !== locked.protocol
	)
		throw new Error("Holdout and locked experiment disagree");
	const baseline = holdout.report.perScheme.find(({ scheme }) => scheme === "A")!;
	const candidate = holdout.report.perScheme.find(({ scheme }) => scheme === locked.challenger)!;
	const reasons = compare(candidate, baseline);
	console.log(
		JSON.stringify(
			{
				challenger: locked.challenger,
				validationReasons: reasons,
				selected: locked.eligibleBeforeHoldout && !reasons.length ? locked.challenger : "A",
				holdoutSha256: holdout.dataSha256,
			},
			null,
			2,
		),
	);
} else {
	throw new Error(
		"Usage: select-retrieval.ts weight <dev.json> | lock <dev.json> <fixed.json> | verify <dev.json> <holdout.json> <selection.json>",
	);
}
