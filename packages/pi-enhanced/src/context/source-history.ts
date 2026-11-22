import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MEMORY_CUSTOM_TYPE, MEMORY_SEARCH_TOOL, memoryReferences, object } from "../memory/disclosure.ts";
import { sourceRegistry } from "./source-registry.ts";

export const CONTEXT_RESTORE = "enhanced_context_restore";
export const RESTORED_CUSTOM_TYPE = "pi-enhanced-restored-context";
export const POLICY = "memoryContext";
export const WITHHELD = "[Memory or Context source is no longer available.]";

export interface PageReference {
	kind: "context-page";
	audience: "tool" | "host";
	reference: string;
	taskId: string;
	offset: number;
	limit: number;
	digest: string;
}

export function pageReference(value: unknown): PageReference | undefined {
	const raw = object(value);
	if (!raw || raw.kind !== "context-page") return;
	const { audience, reference, taskId, digest, offset, limit } = raw;
	if (
		(audience !== "tool" && audience !== "host") ||
		typeof reference !== "string" ||
		!/^v1:[a-f0-9]{64}$/u.test(reference) ||
		typeof taskId !== "string" ||
		!taskId ||
		typeof digest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(digest) ||
		typeof offset !== "number" ||
		!Number.isSafeInteger(offset) ||
		typeof limit !== "number" ||
		!Number.isSafeInteger(limit)
	)
		return;
	return { kind: "context-page", audience, reference, taskId, digest, offset, limit };
}

export function isSourcedTool(message: Extract<AgentMessage, { role: "toolResult" }>): boolean {
	return message.toolName === MEMORY_SEARCH_TOOL || message.toolName === CONTEXT_RESTORE;
}

export function isSourcedCustom(message: AgentMessage): message is Extract<AgentMessage, { role: "custom" }> {
	return (
		message.role === "custom" &&
		(message.customType === MEMORY_CUSTOM_TYPE || message.customType === RESTORED_CUSTOM_TYPE)
	);
}

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;

const resultKey = (message: ToolResult) => JSON.stringify([message.toolName, message.toolCallId, message.timestamp]);

export function legacySourceBoundary(ctx: Pick<ExtensionContext, "sessionManager">): number {
	if (!ctx.sessionManager.getSessionFile()) return Infinity;
	let boundary = Infinity;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			!Array.isArray(entry.message.requestProvenance?.[POLICY])
		) {
			boundary = Math.min(boundary, entry.message.timestamp);
		}
		if (
			(entry.type === "compaction" || entry.type === "branch_summary") &&
			ctx.sessionManager.getHeader()?.parentSession
		)
			boundary = Math.min(boundary, new Date(entry.timestamp).getTime());
	}
	return boundary;
}

export function inspectSourceHistory(
	ctx: Pick<ExtensionContext, "sessionManager">,
	incoming: readonly AgentMessage[] = [],
	legacyAt = Infinity,
) {
	const entries = ctx.sessionManager.getEntries();
	const entryById = new Map(entries.map((entry) => [entry.id, entry]));
	const resultCalls = new Map<string, Assistant | null>();
	let affectedAt = legacyAt;
	function inspect(message: AgentMessage) {
		if (
			(message.role === "toolResult" &&
				((isSourcedTool(message) && !message.isError && memoryReferences(message.details)?.length !== 0) ||
					message.nestedCalls?.calls.some(
						({ name }) => name === MEMORY_SEARCH_TOOL || name === CONTEXT_RESTORE,
					))) ||
			isSourcedCustom(message)
		)
			affectedAt = Math.min(affectedAt, message.timestamp);
		if (message.role === "assistant") {
			const proof = message.requestProvenance?.[POLICY];
			if (Array.isArray(proof) && proof.length) affectedAt = Math.min(affectedAt, message.timestamp);
		}
	}
	for (const entry of entries) {
		if (entry.type === "message") {
			inspect(entry.message);
			const result = entry.message;
			if (result.role === "toolResult") {
				// Tool IDs can be reused on later turns or in sibling branches. Match the actual parent chain.
				let node = entry.parentId ? entryById.get(entry.parentId) : undefined;
				for (let parents = 0; node && parents < entries.length; parents++) {
					if (node.type === "message" && node.message.role === "assistant") {
						const call = node.message.content.some(
							(block) => block.type === "toolCall" && block.id === result.toolCallId,
						)
							? node.message
							: null;
						const key = resultKey(result);
						resultCalls.set(key, resultCalls.has(key) ? null : call);
						break;
					}
					node = node.parentId ? entryById.get(node.parentId) : undefined;
				}
			}
		}
		// Some fork formats carry a summary without the original branch's source entries.
		if (
			(entry.type === "branch_summary" && !entryById.has(entry.fromId)) ||
			(entry.type === "compaction" && ctx.sessionManager.getHeader()?.parentSession)
		)
			affectedAt = Math.min(affectedAt, new Date(entry.timestamp).getTime());
	}
	let incomingCall: Assistant | undefined;
	for (const message of incoming) {
		inspect(message);
		if (message.role === "assistant") incomingCall = message;
		if (
			message.role === "toolResult" &&
			!resultCalls.has(resultKey(message)) &&
			incomingCall?.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId)
		)
			resultCalls.set(resultKey(message), incomingCall);
	}
	const edited = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "context_edit" || !entry.replacement || new Date(entry.timestamp).getTime() < affectedAt)
			continue;
		const target = entryById.get(entry.targetId);
		if (target?.type === "message") edited.add(`${target.message.role}:${target.message.timestamp}`);
	}
	return { callFor: (message: ToolResult) => resultCalls.get(resultKey(message)), affectedAt, edited };
}

const legacyBoundaries = sourceRegistry.legacyBoundaries;
export function captureLegacySourceBoundary(ctx: Pick<ExtensionContext, "sessionManager">): void {
	legacyBoundaries.set(ctx.sessionManager, legacySourceBoundary(ctx));
}
export function rememberedLegacyBoundary(ctx: Pick<ExtensionContext, "sessionManager">): number | undefined {
	return legacyBoundaries.get(ctx.sessionManager);
}

/** A successful, non-nested read is an independently authorized workspace snapshot.
 * Its file content is produced by the host read tool, even if Memory helped choose the path.
 */
export function independentWorkspaceRead(message: ToolResult, call: Assistant | null | undefined): boolean {
	return (
		message.toolName === "read" &&
		!message.isError &&
		!message.nestedCalls &&
		Array.isArray(call?.requestProvenance?.[POLICY]) &&
		call.content.some(
			(block) =>
				block.type === "toolCall" &&
				block.id === message.toolCallId &&
				block.name === message.toolName &&
				!block.argumentsError &&
				typeof block.arguments.path === "string" &&
				Object.keys(block.arguments).every((name) => ["path", "offset", "limit"].includes(name)),
		)
	);
}

export function independentMemoryResults(ctx: Pick<ExtensionContext, "sessionManager">) {
	const { callFor, affectedAt, edited } = inspectSourceHistory(ctx, [], rememberedLegacyBoundary(ctx));
	return (message: ToolResult) => {
		if (isSourcedTool(message) || edited.has(`toolResult:${message.timestamp}`)) return false;
		if (message.nestedCalls?.calls.some(({ name }) => name === MEMORY_SEARCH_TOOL || name === CONTEXT_RESTORE))
			return false;
		const call = callFor(message);
		if (call === null) return false;
		if (independentWorkspaceRead(message, call)) return true;
		const proof = call?.requestProvenance?.[POLICY];
		return Array.isArray(proof) ? proof.length === 0 : (call?.timestamp ?? message.timestamp) < affectedAt;
	};
}
