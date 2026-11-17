import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertFrozenDispatch, scheduleFrozenCases } from "../../benchmarks/real-agent/swe-frozen-batch.ts";
import { assertFrozenPytest, assertFrozenSelection, frozenCaseForProfile, frozenCases, frozenProfile } from "../../benchmarks/real-agent/swe-frozen-catalog.ts";
import { resolveSweProfile } from "../../benchmarks/real-agent/swe-profile.ts";

describe("frozen SWE public pytest batch", () => {
	it("registers precisely 5 + 15 cases and preserves each single-case budget", () => {
		expect(frozenCases.map(({ batch }) => batch)).toEqual([...Array(5).fill(1), ...Array(15).fill(2)]);
		expect(new Set(frozenCases.map(({ instanceId }) => instanceId)).size).toBe(20);
		for (const row of frozenCases) {
			const profile = frozenProfile(row.order);
			expect(frozenCaseForProfile(profile)).toBe(row);
			expect(resolveSweProfile(profile)?.configuration).toMatchObject({
				model: "deepseek-flash", retries: 0,
				instances: [{ instanceId: row.instanceId, baseCommit: row.baseCommit }],
				limits: { maxRuns: 1, maxRequests: 20, maxTokens: 200_000, timeoutMs: 600_000, maxCostUsd: 0.08, maxBatchCostUsd: 0.08 },
			});
		}
		expect(resolveSweProfile(frozenProfile(21))).toBeUndefined();
		expect(frozenCaseForProfile("swe-flash-frozen-7671")).toBeUndefined();
	});

	it("rejects a direct paid dispatch and changes to the selected cases or policy", () => {
		const temp = mkdtempSync(join(tmpdir(), "swe-frozen-auth-test-"));
		try {
			const file = join(temp, "selection.json");
			writeFileSync(file, JSON.stringify({ cases: frozenCases.map(({ instanceId }) => instanceId) }));
			expect(() => assertFrozenSelection(file)).toThrow("SWE_FROZEN_SELECTION_MISMATCH");
			expect(() => assertFrozenDispatch(undefined, temp, "commit", {})).toThrow("SWE_FROZEN_BATCH_UNAUTHORIZED");
			for (const row of frozenCases) {
				if (!row.policy || row.blockedReason) expect(() => assertFrozenPytest(row, undefined)).toThrow("SWE_FROZEN_CASE_BLOCKED");
				else {
					expect(() => assertFrozenPytest(row, row.policy!)).not.toThrow();
					expect(() => assertFrozenPytest(row, { ...row.policy!, timeoutMs: 100 })).toThrow("SWE_FROZEN_PYTEST_MISMATCH");
				}
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("reserves 8 cents before a run, continues after ordinary failure and stops at a global safety fault", () => {
		const rows = [
			{ instanceId: "unresolved", batch: 1 as const, blockedReason: null },
			{ instanceId: "blocked", batch: 1 as const, blockedReason: "missing runtime" },
			{ instanceId: "unsafe", batch: 2 as const, blockedReason: null },
			{ instanceId: "after-unsafe", batch: 2 as const, blockedReason: null },
		];
		const called: string[] = [];
		const reserved: number[] = [];
		const result = scheduleFrozenCases(rows, (id) => {
			called.push(id);
			return id === "unresolved" ? { continued: true, chargeUsd: 0.01 } :
				{ continued: false, chargeUsd: 0.02, reason: "isolation_evidence_invalid" };
		}, (state) => reserved.push(state.reservedCents));
		expect(called).toEqual(["unresolved", "unsafe"]);
		expect(reserved).toEqual([8, 16, 16]);
		expect(result.stoppedReason).toBe("isolation_evidence_invalid");
		expect(result.cases[1]).toMatchObject({ instanceId: "blocked", status: "blocked" });
	});

	it("caps total reserved budget and stops immediately on overcharge", () => {
		const rows = Array.from({ length: 21 }, (_, i) => ({
			instanceId: String(i), batch: i < 5 ? 1 as const : 2 as const, blockedReason: null,
		}));
		const full = scheduleFrozenCases(rows, () => ({ continued: true, chargeUsd: 0 }));
		expect(full.reservedCents).toBe(160);
		expect(full.cases).toHaveLength(20);
		expect(full.stoppedReason).toBe("batch_budget_exhausted");
		const over = scheduleFrozenCases(rows, () => ({ continued: true, chargeUsd: 0.0801 }));
		expect(over.cases).toHaveLength(1);
		expect(over.stoppedReason).toBe("batch_usage_invalid");
	});
});
