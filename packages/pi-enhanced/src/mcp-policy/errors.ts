import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

export type AuditOutcome =
	| "success"
	| "denied"
	| "cancelled"
	| "timeout"
	| "transport"
	| "server_error"
	| "timeout_after_invalid_frame"
	| "protocol_error"
	| "schema_error"
	| "unknown";

function detailCode(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null || !("code" in details)) return undefined;
	return typeof details.code === "string" ? details.code.toLowerCase() : undefined;
}

/** Classify only stable machine-readable signals; ambiguous text stays unknown. */
export function classifyToolResult(event: ToolResultEvent): AuditOutcome {
	if (!event.isError) return "success";
	const code = detailCode(event.details);
	if (code === "cancelled" || code === "canceled" || code === "abort_error") return "cancelled";
	if (code === "timeout" || code === "timeout_error") {
		const details = event.details;
		if (
			details &&
			typeof details === "object" &&
			"connectionDiagnostic" in details &&
			details.connectionDiagnostic === "invalid_protocol_frame"
		)
			return "timeout_after_invalid_frame";
		return "timeout";
	}
	if (code === "transport" || code === "connection_closed") return "transport";
	if (code === "schema_error" || code === "invalid_params") return "schema_error";
	if (code === "protocol_error") return "protocol_error";
	if (code === "server_error") return "server_error";
	return "unknown";
}
