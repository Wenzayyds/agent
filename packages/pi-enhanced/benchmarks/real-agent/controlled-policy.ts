import { CONTROLLED_LIMITS } from "./controlled-cases.ts";

export interface ControlledResult {
	patchStatus: string;
	runStatus: string;
	controlledCell: string;
	gateway: { state: string; requestsStarted: number; requestsCompleted: number; requestsRejected: number; actualTotalTokens: number; committedTokenUpperBound: number; actualCostUsd: number; committedCostUpperBoundUsd: number };
	sandboxAudit: { evidence: { network: string; readOnlyRoot: boolean; user: string; mounts: Array<{ destination: string; readWrite: boolean }> }; audit: Array<{ status: string }> };
	contextAudit: { state?: string; diagnostics: unknown[] };
	toolFailures: Array<{ result: unknown }>;
	[key: string]: unknown;
}

export function controlledStopReason(result: ControlledResult): string | null {
	if (result.terminationClassification && !["completed", "verification_failed"].includes(String(result.terminationClassification))) return String(result.terminationClassification);
	if (result.auditComplete === false) return "sandbox_audit_incomplete";
	const g = result.gateway;
	if (!g || g.state !== "ready" || g.requestsRejected !== 0 || g.requestsStarted !== g.requestsCompleted) return "gateway_or_usage_failure";
	if (![g.requestsStarted, g.actualTotalTokens, g.committedTokenUpperBound, g.actualCostUsd, g.committedCostUpperBoundUsd].every((n) => Number.isFinite(n) && n >= 0)) return "invalid_budget_evidence";
	if (g.requestsStarted > CONTROLLED_LIMITS.maxRequests || g.committedTokenUpperBound > CONTROLLED_LIMITS.maxTokens || g.committedCostUpperBoundUsd > CONTROLLED_LIMITS.maxCostUsd + Number.EPSILON) return "budget_exceeded";
	const e = result.sandboxAudit?.evidence;
	if (!e || e.network !== "none" || !e.readOnlyRoot || !/^[1-9][0-9]*:[1-9][0-9]*$/u.test(e.user) || e.mounts.length !== 1 || e.mounts[0]?.destination !== "/workspace" || !e.mounts[0].readWrite) return "isolation_evidence_invalid";
	if (!Array.isArray(result.sandboxAudit.audit) || result.sandboxAudit.audit.some((entry) => entry.status !== "ok")) return "sandbox_operation_failure";
	if (!Array.isArray(result.toolFailures) || result.toolFailures.some((failure) => /SANDBOX_/u.test(JSON.stringify(failure)))) return "sandbox_tool_failure";
	if (result.runStatus !== "completed") return "run_not_completed";
	if (result.controlledCell === "c_on" && (!Array.isArray(result.contextAudit?.diagnostics) || !result.contextAudit.diagnostics.length)) return "context_audit_missing";
	return null;
}

export function verifyControlledCi(value: unknown, commit: string): void {
	if (!value || typeof value !== "object") throw new Error("CONTROLLED_CI_REQUIRED");
	const evidence = value as { commit?: string; conclusion?: string; runUrl?: string; jobs?: Array<{ name: string; conclusion: string }> };
	if (evidence.commit !== commit || evidence.conclusion !== "success" || !evidence.runUrl?.startsWith("https://github.com/Wenzayyds/agent/actions/runs/") || !["offline-engineering (ubuntu-latest)", "offline-engineering (windows-latest)", "docker-isolation"].every((name) => evidence.jobs?.some((job) => job.name === name && job.conclusion === "success"))) throw new Error("CONTROLLED_CI_NOT_PASSED_FOR_COMMIT");
}
