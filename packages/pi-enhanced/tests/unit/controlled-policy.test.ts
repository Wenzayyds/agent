import { describe, expect, it } from "vitest";
import { CONTROLLED_CELLS, CONTROLLED_LIMITS, longReport } from "../../benchmarks/real-agent/controlled-cases.ts";
import {
	type ControlledResult,
	controlledStopReason,
	sweContinuationStopReason,
	verifyControlledCi,
} from "../../benchmarks/real-agent/controlled-policy.ts";
import { classifyTermination } from "../../benchmarks/real-agent/result-classification.ts";

function valid(): ControlledResult {
	return {
		patchStatus: "passed",
		runStatus: "completed",
		controlledCell: "m_inline",
		gateway: {
			state: "ready",
			requestsStarted: 1,
			requestsCompleted: 1,
			requestsRejected: 0,
			actualTotalTokens: 10,
			committedTokenUpperBound: 10,
			actualCostUsd: 0.001,
			committedCostUpperBoundUsd: 0.001,
		},
		sandboxAudit: {
			evidence: {
				network: "none",
				readOnlyRoot: true,
				user: "1000:1000",
				mounts: [{ destination: "/workspace", readWrite: true }],
			},
			audit: [],
		},
		contextAudit: { state: "disabled", diagnostics: [] },
		toolFailures: [],
	};
}
describe("Controlled six-cell experiment gates", () => {
	it("continues only SWE ordinary stops after independently bound host cleanup and settled usage", () => {
		const result = {
			...valid(),
			runId: "swe_task_unit_off",
			controlledCell: "off",
			runStatus: "budget_stopped",
			terminationClassification: "gateway_budget_stop",
			auditComplete: false,
			gateway: { ...valid().gateway, requestsRejected: 1 },
			gatewayRejections: [{ code: "GATEWAY_TOKEN_BUDGET", upstreamForwarded: false }],
			sandboxAudit: {
				...valid().sandboxAudit,
				integrity: "valid",
				runId: "swe_task_unit_off-swebench",
				workspaceSha256: "a".repeat(64),
				state: "running",
				pending: [],
			},
		};
		const host = {
			runId: result.runId,
			cell: "off",
			childClosed: true,
			childAbsent: true,
			containersRemoved: true,
			workspaceIdentityValid: true,
			gatewayClosed: true,
			privateRootRemoved: true,
			gatewayActiveRequests: 0,
			reservedTokens: 0,
			reservedCostUsd: 0,
			workspaceSha256: "a".repeat(64),
		};
		expect(sweContinuationStopReason(result, host, CONTROLLED_LIMITS)).toBeNull();
		expect(controlledStopReason(result)).toBe("gateway_budget_stop"); // Other profiles retain strict behavior.
		for (const key of [
			"childClosed",
			"childAbsent",
			"containersRemoved",
			"workspaceIdentityValid",
			"gatewayClosed",
			"privateRootRemoved",
		])
			expect(sweContinuationStopReason(result, { ...host, [key]: false }, CONTROLLED_LIMITS)).not.toBeNull();
		for (const partial of [
			{ gatewayActiveRequests: 1 },
			{ reservedTokens: 1 },
			{ reservedCostUsd: 0.001 },
			{ workspaceSha256: "b".repeat(64) },
			{ runId: "other" },
		])
			expect(sweContinuationStopReason(result, { ...host, ...partial }, CONTROLLED_LIMITS)).not.toBeNull();
		for (const partial of [
			{ integrity: "invalid" },
			{ runId: "other" },
			{ state: "limit_reached" },
			{ pending: [{ toolName: "write", operation: "write_file" }] },
		])
			expect(
				sweContinuationStopReason(
					{ ...result, sandboxAudit: { ...result.sandboxAudit, ...partial } },
					host,
					CONTROLLED_LIMITS,
				),
			).not.toBeNull();
		for (const terminationClassification of [
			"isolation_boundary_stop",
			"sandbox_runtime_error",
			"gateway_provider_error",
		])
			expect(
				sweContinuationStopReason({ ...result, terminationClassification }, host, CONTROLLED_LIMITS),
			).not.toBeNull();
		for (const code of [
			"GATEWAY_USAGE_MISSING",
			"GATEWAY_PROVIDER_USAGE_EXCEEDED_RESERVATION",
			"GATEWAY_ISOLATION_STOP",
			"GATEWAY_UPSTREAM_TIMEOUT",
		])
			expect(
				sweContinuationStopReason(
					{ ...result, gatewayRejections: [{ code, upstreamForwarded: false }] },
					host,
					CONTROLLED_LIMITS,
				),
			).not.toBeNull();
		expect(
			sweContinuationStopReason({ ...result, patchExportError: "SWE_PATCH_PATH_DENIED" }, host, CONTROLLED_LIMITS),
		).toBe("SWE_PATCH_PATH_DENIED");
	});
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
			(r: ControlledResult) => {
				r.gateway.state = "failed_closed";
			},
			(r: ControlledResult) => {
				r.gateway.requestsCompleted = 0;
			},
			(r: ControlledResult) => {
				r.gateway.requestsRejected = 1;
			},
			(r: ControlledResult) => {
				r.gateway.committedCostUpperBoundUsd = 0.031;
			},
			(r: ControlledResult) => {
				r.sandboxAudit.evidence.user = "0:0";
			},
			(r: ControlledResult) => {
				r.sandboxAudit.evidence.network = "bridge";
			},
			(r: ControlledResult) => {
				r.sandboxAudit.audit.push({ status: "error" });
			},
			(r: ControlledResult) => {
				r.controlledCell = "c_on";
			},
		]) {
			const result = valid();
			mutate(result);
			expect(controlledStopReason(result)).not.toBeNull();
		}
		const failedPatch = valid();
		failedPatch.patchStatus = "failed";
		expect(controlledStopReason(failedPatch)).toBeNull();
		const runtime = {
			events: [],
			lastError: null,
			gatewayState: "ready",
			rejected: 0,
			runStatus: "completed",
			verifierPassed: null,
			auditComplete: true,
		};
		const rejectedPatch = {
			...valid(),
			terminationClassification: classifyTermination(runtime),
			patchExportError: "SWE_PATCH_PATH_DENIED",
		};
		expect(rejectedPatch.terminationClassification).toBe("completed");
		expect(controlledStopReason(rejectedPatch)).toBe("SWE_PATCH_PATH_DENIED");
		const stoppedByBudget = {
			...rejectedPatch,
			terminationClassification: classifyTermination({
				...runtime,
				rejected: 1,
				runStatus: "budget_stopped",
				auditComplete: false,
			}),
		};
		expect(controlledStopReason(stoppedByBudget)).toBe("gateway_budget_stop");
	});
	it("requires all three CI jobs for exactly the current commit", () => {
		const evidence = {
			commit: "abc",
			conclusion: "success",
			runUrl: "https://github.com/Wenzayyds/agent/actions/runs/1",
			jobs: ["offline-engineering (ubuntu-latest)", "offline-engineering (windows-latest)", "docker-isolation"].map(
				(name) => ({ name, conclusion: "success" }),
			),
		};
		expect(() => verifyControlledCi(evidence, "abc")).not.toThrow();
		expect(() => verifyControlledCi(evidence, "other")).toThrow();
		expect(() => verifyControlledCi({ ...evidence, jobs: evidence.jobs.slice(1) }, "abc")).toThrow();
	});
});
