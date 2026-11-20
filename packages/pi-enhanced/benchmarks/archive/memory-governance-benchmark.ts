import { createHash } from "node:crypto";
import type { CoreMemoryName, MemoryCategory, MemoryKind, MemoryRecord } from "../../src/memory/contracts.ts";
import { planMemoryGovernance } from "../../src/memory/governance.ts";

const now = Date.UTC(2026, 10, 1);
const projectId = "governance-benchmark";

function record(
	id: string,
	content: string,
	options: {
		kind?: MemoryKind;
		category?: MemoryCategory;
		subjectKey?: string;
		status?: MemoryRecord["status"];
		updatedAt?: number;
	} = {},
): MemoryRecord {
	return {
		id,
		projectId,
		kind: options.kind ?? "fact",
		content,
		status: options.status ?? "verified",
		category: options.category ?? "other",
		...(options.subjectKey ? { subjectKey: options.subjectKey } : {}),
		tags: [],
		importance: 1,
		lifecycle: "active",
		useCount: 0,
		sources: [{ type: "test", ref: "memory-governance-benchmark", observedAt: now }],
		verifications: [],
		contentHash: createHash("sha256").update(content).digest("hex"),
		revision: 1,
		contentRevision: 1,
		createdAt: options.updatedAt ?? now,
		updatedAt: options.updatedAt ?? now,
	};
}

const records: MemoryRecord[] = [
	record("node20", "Production Node runtime is version 20", { category: "environment", subjectKey: "runtime.node" }),
	record("node22", "Production Node runtime is version 22", { category: "environment", subjectKey: "runtime.node" }),
	record("near-a", "Release procedure requires approval gate before deployment", {
		kind: "experience",
		category: "procedure",
	}),
	record("near-b", "Release procedure requires approval gate prior to deployment", {
		kind: "experience",
		category: "procedure",
	}),
	record("class-architecture", "Architecture module owns the database schema"),
	record("class-dependency", "Dependency package npm version is pinned"),
	record("class-test", "Vitest regression test must pass"),
	record("class-bug", "Bug fix handles a timeout error"),
];

const started = performance.now();
const plan = planMemoryGovernance({
	projectId,
	records,
	coreBytes: { project: 200, architecture: 300, decisions: 100 } satisfies Record<CoreMemoryName, number>,
	config: { maximumScanRecords: 100, nearDuplicatePercent: 50, archiveAfterDays: 180, coreWarningBytes: 49_152 },
	now,
});
const durationMs = performance.now() - started;
const expected = new Map([
	["class-architecture", "architecture"],
	["class-dependency", "dependency"],
	["class-test", "test_insight"],
	["class-bug", "bug_fix"],
]);
const retags = new Map(
	plan.proposals
		.filter((proposal) => proposal.action === "retag")
		.map((proposal) => [proposal.sourceIds[0], proposal.proposedCategory]),
);
const classificationCorrect = [...expected].filter(([id, category]) => retags.get(id) === category).length;

console.log(
	JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			fixture: { records: records.length, synthetic: true, paidModelCalls: 0, downloadedModels: 0 },
			durationMs: Number(durationMs.toFixed(3)),
			classificationMacroF1: classificationCorrect / expected.size,
			conflict: {
				expectedGroups: 1,
				detectedGroups: plan.report.conflictGroups.length,
				precision: plan.report.conflictGroups.length === 1 ? 1 : 0,
				recall: plan.report.conflictGroups.some((group) => group.includes("node20") && group.includes("node22"))
					? 1
					: 0,
			},
			nearDuplicateGroups: plan.report.nearDuplicateGroups.length,
			proposalCount: plan.proposals.length,
			proposalActions: Object.fromEntries(
				[...new Set(plan.proposals.map(({ action }) => action))].map((action) => [
					action,
					plan.proposals.filter((proposal) => proposal.action === action).length,
				]),
			),
			automaticallyVerifiedTargets: 0,
			limitations: [
				"Small synthetic fixture; not evidence of coding-task success.",
				"Near-duplicate grouping is deterministic lexical Jaccard, not factual equivalence.",
				"Apply, FTS removal, rollback, and project isolation are measured by persistent integration tests instead.",
			],
		},
		null,
		2,
	),
);
