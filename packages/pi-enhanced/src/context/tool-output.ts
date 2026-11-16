import { redactMemoryOutput } from "../memory/output-safety.ts";
import type { ContextMessage } from "./contracts.ts";

const TRUNCATION_MARKER = "[pi-enhanced context view: tool output truncated";

export interface ToolOutputResult {
	messages: ContextMessage[];
	truncated: number;
}

export function truncatePairedToolOutputs(
	messages: readonly ContextMessage[],
	maximumTextCharacters: number,
	preserveDiagnostics = false,
): ToolOutputResult {
	const callIds = collectToolCallIds(messages);
	const resultCounts = new Map<string, number>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			resultCounts.set(message.toolCallId, (resultCounts.get(message.toolCallId) ?? 0) + 1);
		}
	}
	let truncated = 0;
	const next = messages.map((message): ContextMessage => {
		if (
			message.role !== "toolResult" ||
			(preserveDiagnostics && isDiagnostic(message)) ||
			!callIds.has(message.toolCallId) ||
			resultCounts.get(message.toolCallId) !== 1 ||
			message.content.some((block) => block.type !== "text")
		) {
			return message;
		}
		const originalText = message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		const text = redactMemoryOutput(originalText);
		if (text.length <= maximumTextCharacters || text.includes(TRUNCATION_MARKER))
			return text === originalText ? message : { ...message, content: [{ type: "text", text }] };
		const marker = `\n\n${TRUNCATION_MARKER}; toolCallId=${message.toolCallId}; removed=${text.length - maximumTextCharacters} characters; original remains in Session]\n\n`;
		const available = Math.max(0, maximumTextCharacters - marker.length);
		const head = Math.ceil(available * 0.7);
		const tail = available - head;
		const shortened = `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
		truncated += 1;
		return { ...message, content: [{ type: "text", text: shortened }] };
	});
	return { messages: next, truncated };
}

export function isDiagnostic(message: Extract<ContextMessage, { role: "toolResult" }>): boolean {
	if (message.isError || message.toolName === "run_tests") return true;
	const details = message.details as { exitCode?: unknown } | undefined;
	return typeof details?.exitCode === "number" && details.exitCode !== 0;
}

export function hasValidToolPairing(messages: readonly ContextMessage[]): boolean {
	const calls = collectToolCallIds(messages);
	const results = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
		if (!calls.has(message.toolCallId)) return false;
	}
	for (const callId of calls) if (results.get(callId) !== 1) return false;
	return true;
}

export function collectToolCallIds(messages: readonly ContextMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") ids.add(block.id);
	}
	return ids;
}
