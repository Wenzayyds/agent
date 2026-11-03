export const SANDBOX_PROTOCOL_VERSION = 1 as const;
export const SANDBOX_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "write", "edit"] as const;

export type SandboxToolName = (typeof SANDBOX_ALLOWED_TOOLS)[number];

export interface SandboxRequest {
	protocolVersion: typeof SANDBOX_PROTOCOL_VERSION;
	runId: string;
	requestId: string;
	toolName: SandboxToolName;
	operation: string;
	args: Record<string, unknown>;
	deadlineMs: number;
}

export interface SandboxResponse {
	protocolVersion: typeof SANDBOX_PROTOCOL_VERSION;
	runId: string;
	requestId: string;
	toolName: SandboxToolName;
	status: "ok" | "error";
	result?: unknown;
	errorCode?: string;
	errorMessage?: string;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;

export function isSandboxToolName(value: unknown): value is SandboxToolName {
	return typeof value === "string" && (SANDBOX_ALLOWED_TOOLS as readonly string[]).includes(value);
}

export function assertRunId(value: string): void {
	if (!RUN_ID.test(value)) throw new Error("SANDBOX_INVALID_RUN_ID");
}

export function assertRequestId(value: string): void {
	if (!REQUEST_ID.test(value)) throw new Error("SANDBOX_INVALID_REQUEST_ID");
}

export function validateSandboxResponse(
	value: unknown,
	expected: Pick<SandboxRequest, "runId" | "requestId" | "toolName">,
	maxBytes: number,
): SandboxResponse {
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("SANDBOX_RESPONSE_TOO_LARGE");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SANDBOX_INVALID_RESPONSE");
	const response = value as Partial<SandboxResponse>;
	if (response.protocolVersion !== SANDBOX_PROTOCOL_VERSION) throw new Error("SANDBOX_PROTOCOL_MISMATCH");
	if (response.runId !== expected.runId) throw new Error("SANDBOX_RUN_ID_MISMATCH");
	if (response.requestId !== expected.requestId) throw new Error("SANDBOX_REQUEST_ID_MISMATCH");
	if (response.toolName !== expected.toolName) throw new Error("SANDBOX_TOOL_NAME_MISMATCH");
	if (response.status !== "ok" && response.status !== "error") throw new Error("SANDBOX_INVALID_STATUS");
	return response as SandboxResponse;
}

export function sanitizeSandboxError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	const known = message.match(/SANDBOX_[A-Z0-9_]+/u)?.[0] ?? "SANDBOX_EXECUTION_FAILED";
	return new Error(known);
}
