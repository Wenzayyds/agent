import { readFileSync } from "node:fs";
import type { SwePytestPolicy } from "./swe-test-feedback.ts";
import { digest, digestBytes } from "./evaluation-identity.ts";

export interface FrozenSweCase {
	order: number;
	batch: 1 | 2;
	instanceId: string;
	baseCommit: string;
	publicIssueSha256: string;
	officialImage: string;
	policy: SwePytestPolicy | null;
	blockedReason: string | null;
}

export const FROZEN_CASE_COST_CENTS = 8;
export const FROZEN_TOTAL_COST_CENTS = 160;
const catalog = JSON.parse(readFileSync(new URL("./swe-frozen-20.json", import.meta.url), "utf8")) as {
	selectionSha256: string;
	cases: FrozenSweCase[];
};
if (catalog.cases.length !== 20 || new Set(catalog.cases.map(({ instanceId }) => instanceId)).size !== 20 ||
	catalog.cases.some((row, i) => row.order !== i + 1 || row.batch !== (i < 5 ? 1 : 2) ||
		Boolean(row.policy) === Boolean(row.blockedReason) ||
		(row.policy && (row.policy.instanceId !== row.instanceId || row.policy.baseCommit !== row.baseCommit))))
	throw new Error("SWE_FROZEN_CATALOG_MISMATCH");

export const frozenCases: readonly FrozenSweCase[] = catalog.cases;
export const frozenSelectionSha256 = catalog.selectionSha256;

export function frozenProfile(order: number) {
	return (`swe-flash-frozen-${order}`) as const;
}

export function frozenCaseForProfile(profile: string | undefined): FrozenSweCase | undefined {
	return frozenCases.find(({ order }) => frozenProfile(order) === profile);
}

export function assertFrozenSelection(path: string): void {
	if (digestBytes(readFileSync(path)) !== frozenSelectionSha256) throw new Error("SWE_FROZEN_SELECTION_MISMATCH");
}

export function assertFrozenPytest(row: FrozenSweCase, value: SwePytestPolicy | undefined): void {
	if (!row.policy || row.blockedReason) throw new Error("SWE_FROZEN_CASE_BLOCKED");
	if (!value || digest(value) !== digest(row.policy)) throw new Error("SWE_FROZEN_PYTEST_MISMATCH");
}
