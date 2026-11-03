import type { SafetyEvent } from "./controlled-stop.ts";

export function classifyTermination(input: {
	events: SafetyEvent[];
	lastError: string | null;
	gatewayState: string;
	rejected: number;
	runStatus: string;
	verifierPassed: boolean;
	auditComplete?: boolean;
}): string {
	const fatal = input.events.find((e) => e.classification !== "tool_denied_recoverable");
	if (fatal) return fatal.classification;
	const code = input.lastError ?? "";
	if (code === "GATEWAY_ISOLATION_STOP") return "isolation_boundary_stop";
	if (code === "GATEWAY_CLIENT_DISCONNECTED" || input.runStatus === "timeout") return "agent_execution_error";
	if (/GATEWAY_(?:USAGE_|PROVIDER_USAGE_)/u.test(code)) return "gateway_budget_stop";
	if (/GATEWAY_(?:UPSTREAM_|PROVIDER_)/u.test(code)) return "gateway_provider_error";
	if (input.gatewayState !== "ready" || input.rejected > 0) return "gateway_budget_stop";
	if (input.runStatus !== "completed") return "agent_execution_error";
	if (input.auditComplete === false) return "sandbox_runtime_error";
	return input.verifierPassed ? "completed" : "verification_failed";
}
