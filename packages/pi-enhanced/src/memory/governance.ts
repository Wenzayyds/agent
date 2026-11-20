import { createHash } from "node:crypto";
import type {
	CoreMemoryName,
	MaintenanceProposal,
	MemoryCategory,
	MemoryDoctorReport,
	MemoryRecord,
} from "./contracts.ts";
import { classifyMemory, memoryTypeOf, recordScope } from "./contracts.ts";

export interface MemoryGovernanceConfig {
	maximumScanRecords: number;
	nearDuplicatePercent: number;
	archiveAfterDays: number;
	coreWarningBytes: number;
}

export interface GovernancePlan {
	report: MemoryDoctorReport;
	proposals: readonly MaintenanceProposal[];
}

export function planMemoryGovernance(options: {
	projectId: string;
	records: readonly MemoryRecord[];
	coreBytes: Readonly<Record<CoreMemoryName, number>>;
	config: MemoryGovernanceConfig;
	now?: number;
}): GovernancePlan {
	const now = options.now ?? Date.now();
	const records = options.records.slice(0, options.config.maximumScanRecords);
	const exactDuplicateGroups = groupBy(records, (record) => `${governanceScope(record)}:${record.contentHash}`)
		.filter((group) => group.length > 1)
		.map(ids);
	const conflictGroups = groupBy(
		records.filter(
			(record) =>
				(record.status === "verified" || record.status === "candidate") &&
				record.lifecycle === "active" &&
				record.subjectKey,
		),
		(record) => JSON.stringify([governanceScope(record), memoryTypeOf(record), record.subjectKey]),
	)
		.filter(
			(group) =>
				group.some((record) => record.status === "verified") &&
				new Set(group.map((record) => record.contentHash)).size > 1 &&
				overlapsValidity(group),
		)
		.map(ids);
	const nearDuplicateGroups = groupBy(records, governanceScope)
		.flatMap((scope) => collectNearDuplicates(scope, options.config.nearDuplicatePercent / 100))
		.map(ids)
		.filter(
			(group) =>
				!conflictGroups.some((conflict) => group.filter((memoryId) => conflict.includes(memoryId)).length > 1),
		);
	const expiredActive = records.filter(
		(record) => record.lifecycle === "active" && record.validUntil !== undefined && record.validUntil <= now,
	);
	const archiveBefore = now - options.config.archiveAfterDays * 24 * 60 * 60 * 1_000;
	const archiveCandidates = records.filter(
		(record) =>
			record.status === "verified" &&
			record.lifecycle === "active" &&
			record.kind === "experience" &&
			record.importance <= 1 &&
			record.useCount === 0 &&
			record.updatedAt < archiveBefore,
	);
	const uncategorized = records.filter((record) => record.category === "other");
	const deletePreviewCandidates = records.filter(
		(record) => record.status === "rejected" && record.lifecycle === "archived",
	);
	const warnings: string[] = [];
	for (const [name, bytes] of Object.entries(options.coreBytes)) {
		if (bytes > options.config.coreWarningBytes) warnings.push(`Core ${name} is ${bytes} bytes`);
	}
	if (records.length === options.config.maximumScanRecords) warnings.push("Governance scan reached its record limit");

	const proposals: MaintenanceProposal[] = [];
	for (const group of exactDuplicateGroups) {
		const source = records.filter((record) => group.includes(record.id));
		proposals.push(
			proposal(
				options.projectId,
				"keep",
				source,
				"Exact content duplicate across memory kinds; same-kind duplicates already coalesce in storage",
				undefined,
				undefined,
				now,
			),
		);
	}
	for (const group of nearDuplicateGroups) {
		if (
			records.some(
				(record) => group.includes(record.id) && (record.type === "preference" || record.type === "working"),
			)
		)
			continue;
		if (exactDuplicateGroups.some((exact) => group.every((id) => exact.includes(id)))) continue;
		const source = records.filter((record) => group.includes(record.id));
		proposals.push(
			proposal(
				options.projectId,
				"compress",
				source,
				"Lexical similarity candidate; similarity is not treated as factual identity",
				source
					.map((record) => record.content)
					.join("\n")
					.slice(0, 8_000),
				source[0]?.category,
				now,
			),
		);
	}
	for (const group of conflictGroups) {
		const source = records.filter((record) => group.includes(record.id));
		proposals.push(
			proposal(
				options.projectId,
				"keep",
				source,
				"Possible conflict for the same subjectKey; automatic consolidation is blocked",
				undefined,
				undefined,
				now,
			),
		);
	}
	for (const record of expiredActive) {
		proposals.push(
			proposal(
				options.projectId,
				"mark_stale",
				[record],
				"validUntil has passed; review before changing status",
				undefined,
				undefined,
				now,
			),
		);
	}
	for (const record of archiveCandidates) {
		proposals.push(
			proposal(
				options.projectId,
				"archive",
				[record],
				"Old low-importance unused experience; reversible archive only",
				undefined,
				undefined,
				now,
			),
		);
	}
	for (const record of uncategorized) {
		const category = suggestCategory(record.content);
		if (category !== "other")
			proposals.push(
				proposal(
					options.projectId,
					"retag",
					[record],
					"Deterministic keyword category suggestion",
					undefined,
					category,
					now,
				),
			);
	}
	if (deletePreviewCandidates.length > 0) {
		proposals.push(
			proposal(
				options.projectId,
				"delete",
				deletePreviewCandidates,
				"Batch delete preview only; Batch A forbids applying this proposal",
				undefined,
				undefined,
				now,
			),
		);
	}

	return {
		report: {
			recordCount: records.length,
			activeCount: records.filter((record) => record.lifecycle === "active").length,
			archivedCount: records.filter((record) => record.lifecycle === "archived").length,
			expiredActiveIds: expiredActive.map(({ id }) => id),
			exactDuplicateGroups,
			nearDuplicateGroups,
			conflictGroups,
			uncategorizedIds: uncategorized.map(({ id }) => id),
			archiveCandidateIds: archiveCandidates.map(({ id }) => id),
			coreBytes: options.coreBytes,
			warnings,
		},
		proposals,
	};
}

function governanceScope(record: MemoryRecord): string {
	const scope = recordScope(record);
	if (!scope) return `unbound:${record.id}`;
	if (scope.kind === "project") return classifyMemory(record);
	return JSON.stringify([scope.kind, scope.id]);
}

function proposal(
	projectId: string,
	action: MaintenanceProposal["action"],
	records: readonly MemoryRecord[],
	justification: string,
	proposedContent: string | undefined,
	proposedCategory: MemoryCategory | undefined,
	now: number,
): MaintenanceProposal {
	const sourceIds = records.map(({ id }) => id).sort();
	const expectedRevisions = sourceIds.map((id) => records.find((record) => record.id === id)?.revision ?? 0);
	const id = createHash("sha256")
		.update(JSON.stringify({ projectId, action, sourceIds, expectedRevisions, proposedContent, proposedCategory }))
		.digest("hex")
		.slice(0, 24);
	return {
		id: `mg-${id}`,
		projectId,
		action,
		sourceIds,
		expectedRevisions,
		...(proposedContent ? { proposedContent } : {}),
		...(proposedCategory ? { proposedCategory } : {}),
		justification,
		evidenceRefs: sourceIds.map((sourceId) => `memory:${sourceId}`),
		status: "draft",
		createdAt: now,
	};
}

function collectNearDuplicates(records: readonly MemoryRecord[], threshold: number): MemoryRecord[][] {
	const groups: MemoryRecord[][] = [];
	const used = new Set<string>();
	for (const left of records) {
		if (used.has(left.id)) continue;
		const group = [left];
		for (const right of records) {
			if (right.id === left.id || used.has(right.id) || right.kind !== left.kind) continue;
			if (jaccard(left.content, right.content) >= threshold) group.push(right);
		}
		if (group.length > 1) {
			for (const record of group) used.add(record.id);
			groups.push(group);
		}
	}
	return groups;
}

function jaccard(left: string, right: string): number {
	const a = tokens(left);
	const b = tokens(right);
	const intersection = [...a].filter((token) => b.has(token)).length;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : intersection / union;
}

function tokens(value: string): Set<string> {
	return new Set(
		value
			.normalize("NFKC")
			.toLocaleLowerCase("en-US")
			.split(/[^\p{L}\p{N}_]+/u)
			.filter(Boolean),
	);
}

function groupBy(records: readonly MemoryRecord[], key: (record: MemoryRecord) => string): MemoryRecord[][] {
	const groups = new Map<string, MemoryRecord[]>();
	for (const record of records) {
		const value = key(record);
		if (!value) continue;
		const group = groups.get(value) ?? [];
		group.push(record);
		groups.set(value, group);
	}
	return [...groups.values()];
}

function ids(records: readonly MemoryRecord[]): string[] {
	return records.map(({ id }) => id).sort();
}

function overlapsValidity(records: readonly MemoryRecord[]): boolean {
	for (let left = 0; left < records.length; left += 1) {
		for (let right = left + 1; right < records.length; right += 1) {
			const a = records[left];
			const b = records[right];
			if (
				(a.validUntil ?? Number.POSITIVE_INFINITY) >= (b.validFrom ?? 0) &&
				(b.validUntil ?? Number.POSITIVE_INFINITY) >= (a.validFrom ?? 0)
			)
				return true;
		}
	}
	return false;
}

function suggestCategory(content: string): MemoryCategory {
	const value = content.toLocaleLowerCase("en-US");
	if (/architect|module|database|schema|架构|模块/u.test(value)) return "architecture";
	if (/dependenc|package|version|npm|依赖/u.test(value)) return "dependency";
	if (/test|spec|vitest|pytest|测试/u.test(value)) return "test_insight";
	if (/bug|error|fix|故障|修复/u.test(value)) return "bug_fix";
	if (/step|run|command|procedure|步骤|命令/u.test(value)) return "procedure";
	return "other";
}
