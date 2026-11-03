import { describe, expect, it } from "vitest";
import { CONTROLLED_CELLS, CONTROLLED_LIMITS, longReport } from "../../benchmarks/real-agent/controlled-cases.ts";
import { controlledStopReason, type ControlledResult, verifyControlledCi } from "../../benchmarks/real-agent/controlled-policy.ts";

function valid(): ControlledResult {
	return { patchStatus: "passed", runStatus: "completed", controlledCell: "m_inline", gateway: { state: "ready", requestsStarted: 1, requestsCompleted: 1, requestsRejected: 0, actualTotalTokens: 10, committedTokenUpperBound: 10, actualCostUsd: 0.001, committedCostUpperBoundUsd: 0.001 }, sandboxAudit: { evidence: { network: "none", readOnlyRoot: true, user: "1000:1000", mounts: [{ destination: "/workspace", readWrite: true }] }, audit: [] }, contextAudit: { state: "disabled", diagnostics: [] }, toolFailures: [] };
}
describe("Controlled six-cell experiment gates", () => {
	it("fixes six independent cells and reserves no more than the authorized total", () => {
		expect(CONTROLLED_CELLS).toHaveLength(6);
		expect(new Set(CONTROLLED_CELLS.map((c) => c.id)).size).toBe(6);
		expect(CONTROLLED_CELLS.length * CONTROLLED_LIMITS.maxCostUsd).toBeLessThanOrEqual(0.18);
		expect(longReport()).toHaveLength(12_000);
		expect(longReport().slice(0, 1000)).toContain("validate.js");
		expect(longReport().slice(-500)).toContain("position 10");
	});
	it("stops on gateway failures, missing usage, denied requests, and isolation changes", () => {
		expect(controlledStopReason(valid())).toBeNull();
		for (const mutate of [
			(r: ControlledResult) => { r.gateway.state = "failed_closed"; },
			(r: ControlledResult) => { r.gateway.requestsCompleted = 0; },
			(r: ControlledResult) => { r.gateway.requestsRejected = 1; },
			(r: ControlledResult) => { r.gateway.committedCostUpperBoundUsd = 0.031; },
			(r: ControlledResult) => { r.sandboxAudit.evidence.user = "0:0"; },
			(r: ControlledResult) => { r.sandboxAudit.evidence.network = "bridge"; },
			(r: ControlledResult) => { r.sandboxAudit.audit.push({ status: "error" }); },
			(r: ControlledResult) => { r.controlledCell = "c_on"; },
		]) { const result = valid(); mutate(result); expect(controlledStopReason(result)).not.toBeNull(); }
		const failedPatch = valid(); failedPatch.patchStatus = "failed";
		expect(controlledStopReason(failedPatch)).toBeNull();
	});
	it("requires all three CI jobs for exactly the current commit", () => {
		const evidence = { commit: "abc", conclusion: "success", runUrl: "https://github.com/Wenzayyds/agent/actions/runs/1", jobs: ["offline-engineering (ubuntu-latest)", "offline-engineering (windows-latest)", "docker-isolation"].map((name) => ({ name, conclusion: "success" })) };
		expect(() => verifyControlledCi(evidence, "abc")).not.toThrow();
		expect(() => verifyControlledCi(evidence, "other")).toThrow();
		expect(() => verifyControlledCi({ ...evidence, jobs: evidence.jobs.slice(1) }, "abc")).toThrow();
	});
});
