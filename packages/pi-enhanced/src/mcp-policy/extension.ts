import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ToolCallEvent,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { requestApproval } from "./approval.ts";
import { AuditTrail } from "./audit.ts";
import { type LoadedMcpPolicyConfig, loadMcpPolicyConfig } from "./config.ts";
import { classifyToolResult } from "./errors.ts";
import { type McpToolIdentity, parseMcpToolIdentity } from "./identity.ts";
import { NativeToolGuard } from "./native-tool-guard.ts";
import { evaluatePolicy, type PolicyAction, type PolicyDecision } from "./policy.ts";

interface McpPolicyRuntimeState {
	loaded: LoadedMcpPolicyConfig;
	audit: AuditTrail;
	nativeGuard: NativeToolGuard;
	lastError?: string;
}

function loadState(ctx: ExtensionContext): McpPolicyRuntimeState {
	const loaded = loadMcpPolicyConfig({
		agentDir: getAgentDir(),
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});
	return {
		loaded,
		audit: new AuditTrail(loaded.config.audit.maxRecent),
		nativeGuard: new NativeToolGuard(loaded.config.nativeToolGuard),
	};
}

function auditBase(
	identity: McpToolIdentity,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	decision: PolicyAction,
	ruleId: string,
) {
	return {
		...identity,
		sessionIdOrScope: ctx.sessionManager.getSessionId(),
		toolCallId: event.toolCallId,
		...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
		decision,
		ruleId,
	};
}

function denialReason(identity: McpToolIdentity, decision: PolicyDecision): string {
	return `MCP policy blocked ${identity.server}/${identity.tool}: ${decision.reason}`;
}

function formatStatus(state: McpPolicyRuntimeState): string {
	const { loaded, audit, nativeGuard } = state;
	const enforcement = loaded.failClosed
		? "fail-closed (configuration error)"
		: loaded.config.enabled
			? "enabled"
			: "disabled";
	const sources = loaded.sources.length > 0 ? loaded.sources.join(", ") : "defaults";
	const records = audit.snapshot();
	const denied = records.filter((record) => record.outcome === "denied" || record.outcome === "cancelled").length;
	const nested = records.filter((record) => record.parentToolCallId !== undefined).length;
	const errors = [...loaded.errors, ...(state.lastError ? [state.lastError] : [])];
	return [
		`pi-enhanced mcp-policy: ${enforcement}`,
		`Configuration: ${sources}`,
		`Rules: ${loaded.config.rules.length}; default: ${loaded.config.defaultAction}`,
		`Audit: ${loaded.config.audit.enabled ? `enabled (${records.length} recent, ${denied} denied, ${nested} nested)` : "disabled"}`,
		`Native tool guard: ${loaded.config.nativeToolGuard.enabled ? `enabled (${nativeGuard.snapshot().length} recent)` : "disabled"}`,
		...(errors.length > 0 ? ["Recent errors:", ...errors.slice(-5)] : []),
	].join("\n");
}

export default function mcpPolicyExtension(pi: ExtensionAPI): void {
	let state: McpPolicyRuntimeState | undefined;
	const currentState = (ctx: ExtensionContext) => {
		if (!state) state = loadState(ctx);
		return state;
	};

	pi.on("session_start", (_event, ctx) => {
		state = loadState(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const current = currentState(ctx);
		if (!event.toolName.startsWith("mcp__")) return current.nativeGuard.evaluate(event, ctx);
		if (!current.loaded.config.enabled && !current.loaded.failClosed) return;
		const toolInfo = pi.getAllTools().find((tool) => tool.name === event.toolName);
		const identity = parseMcpToolIdentity(event.toolName, toolInfo);
		if (!identity) {
			current.lastError = `Invalid MCP tool name: ${event.toolName}`;
			return { block: true, reason: current.lastError };
		}
		const annotations = toolInfo?.annotations ? { ...toolInfo.annotations } : undefined;
		let decision: PolicyDecision;
		try {
			decision = current.loaded.failClosed
				? { action: "deny", ruleId: "configuration-error", reason: "Policy configuration is invalid" }
				: evaluatePolicy(
						{ ...identity, annotations, arguments: event.input },
						current.loaded.config.rules,
						current.loaded.config.defaultAction,
					);
		} catch (error) {
			current.lastError = `Policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
			decision = { action: "deny", ruleId: "policy-error", reason: current.lastError };
		}

		const audit = auditBase(identity, event, ctx, decision.action, decision.ruleId);
		if (decision.action === "deny") {
			if (current.loaded.config.audit.enabled) current.audit.recordComplete(audit, "denied");
			return { block: true, reason: denialReason(identity, decision) };
		}
		if (decision.action === "ask") {
			const approval = await requestApproval(identity, annotations, ctx, current.loaded.config.approvalTimeoutMs);
			if (approval !== "approved") {
				const reason =
					approval === "unavailable"
						? "MCP policy requires approval, but this session has no dialog-capable UI"
						: approval === "cancelled"
							? "MCP tool call was not approved"
							: "MCP approval failed";
				current.lastError = reason;
				if (current.loaded.config.audit.enabled) {
					current.audit.recordComplete(audit, approval === "cancelled" ? "cancelled" : "denied");
				}
				return { block: true, reason };
			}
		}
		if (current.loaded.config.audit.enabled) current.audit.start(audit);
		return undefined;
	});

	pi.on("tool_result", (event: ToolResultEvent, ctx) => {
		if (!event.toolName.startsWith("mcp__")) return;
		const current = currentState(ctx);
		if (!current.loaded.config.audit.enabled) return;
		current.audit.finish(event.toolCallId, classifyToolResult(event));
	});

	pi.on("session_shutdown", () => {
		state?.audit.clear();
		state?.nativeGuard.clear();
		state = undefined;
	});

	pi.registerCommand("enhanced-mcp-policy-status", {
		description: "Show MCP policy state, rule count, audit summary, and configuration errors",
		handler: async (_args, ctx) => {
			const current = currentState(ctx);
			ctx.ui.notify(formatStatus(current), current.loaded.errors.length > 0 ? "warning" : "info");
		},
	});
}
