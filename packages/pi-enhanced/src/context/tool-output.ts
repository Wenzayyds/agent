import { preserveMemoryToolView } from "../memory/disclosure.ts";
import { redactMemoryOutput } from "../memory/output-safety.ts";
import type { ContextMessage } from "./contracts.ts";

const TRUNCATION_MARKER = "[pi-enhanced context view: tool output truncated";

export interface ToolOutputResult {
	messages: ContextMessage[];
	truncated: number;
}

const DIAGNOSTICS = [
	/\b(?:AssertionError|[A-Z][A-Za-z0-9_]{0,64}(?:Error|Exception)|FAILED)\b/u,
	/\b(?:Traceback|ERROR|FATAL)\b/u,
	/\b[\w.-]{1,96}\.(?:py|js|ts|tsx|rs|go|java):\d+\b/u,
];
interface Hit {
	start: number;
	end: number;
	line: number;
	at: number;
	priority: number;
	key: string;
}

function excerpt(line: string, at: number, width: number): string {
	if (line.length <= width) return line;
	const start = Math.max(0, Math.min(at - 12, line.length - width + 2));
	return `${(start ? "…" : "") + line.slice(start, start + width - 2)}…`;
}

function renderLines(lines: ReadonlyMap<number, string>): string {
	const sorted = [...lines].sort(([a], [b]) => a - b);
	let result = "";
	for (let i = 0; i < sorted.length; ) {
		const start = i++;
		while (i < sorted.length && sorted[i]![0] === sorted[i - 1]![0] + 1) i++;
		const group = sorted.slice(start, i);
		result += `\n[L${group[0]![0]}${group.length > 1 ? `–L${group.at(-1)![0]}` : ""}]\n`;
		result += `${group.map(([, text]) => text).join("\n")}\n`;
	}
	return result;
}

/** Project redacted text only. Session storage and tool message metadata stay with the caller. */
export function previewToolOutput(text: string, limit: number, notice: string, headFraction: number): string {
	const available = Math.max(0, limit - notice.length);
	const middle = Math.floor(available / 2);
	const head = Math.ceil((available - middle) * headFraction);
	const tail = available - middle - head;
	const hits: Hit[] = [];
	// Bound retained candidates even for a log with millions of distinct error lines.
	for (let start = 0, line = 1; middle >= 48 && start < text.length - tail; line++) {
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline;
		if (end > head) {
			const value = text.slice(start, end);
			for (const [priority, pattern] of DIAGNOSTICS.entries()) {
				const match = pattern.exec(value);
				if (!match) continue;
				const at = match.index;
				if (start + at >= head && start + at < text.length - tail) {
					const key = value
						.slice(Math.max(0, at - 16), at + 100)
						.replace(/\d+/gu, "#")
						.trim();
					if (!hits.some((hit) => hit.key === key) && (hits.length < 16 || priority < hits.at(-1)!.priority)) {
						hits.push({ start, end, line, at, priority, key });
						hits.sort((a, b) => a.priority - b.priority);
						if (hits.length > 16) hits.pop();
					}
				}
				break;
			}
		}
		start = end + 1;
	}
	const selected = new Map<number, string>();
	const width = Math.min(180, Math.floor(middle * 0.65));
	const add = (line: number, value: string) => {
		if (selected.has(line) || !value) return;
		selected.set(line, value);
		if (renderLines(selected).length > middle) selected.delete(line);
	};
	for (const hit of hits) {
		add(hit.line, excerpt(text.slice(hit.start, hit.end).trimEnd(), hit.at, width));
		if (!selected.has(hit.line)) continue;
		if (hit.start > 0) {
			const before = text.slice(Math.max(0, hit.start - 1 - 90), hit.start - 1);
			add(hit.line - 1, before.slice(before.lastIndexOf("\n") + 1).trimEnd());
		}
		const after = text.slice(hit.end + 1, hit.end + 91).split("\n", 1)[0]!;
		add(hit.line + 1, after.trimEnd());
	}
	const context = renderLines(selected);
	const prefix = Math.ceil((available - context.length) * headFraction);
	const suffix = available - context.length - prefix;
	return text.slice(0, prefix) + notice.slice(0, limit) + context + (suffix ? text.slice(-suffix) : "");
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
		if (text.length <= maximumTextCharacters)
			return text === originalText
				? message
				: preserveMemoryToolView(message, { ...message, content: [{ type: "text", text }] });
		const marker = `\n\n${TRUNCATION_MARKER}; toolCallId=${message.toolCallId}; removed=${text.length - maximumTextCharacters} characters; original remains in Session]\n\n`;
		const shortened = previewToolOutput(text, maximumTextCharacters, marker, 0.7);
		truncated += 1;
		return preserveMemoryToolView(message, { ...message, content: [{ type: "text", text: shortened }] });
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

const repeatableWorkspaceReads = new Set(["ls", "find", "grep", "read"]);
export const REPEATED_WORKSPACE_READ = "[This identical workspace read is retained in a later tool result.]";

type WireMessage = {
	role?: string;
	content?: unknown;
	tool_calls?: unknown;
	tool_call_id?: unknown;
};

// Only recognizes the OpenAI Chat Completions tool layout. Every call must have
// exactly one result in its original group before any output can be shortened.
export function deduplicateRuntimeReads(payload: unknown): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const body = payload as Record<string, unknown>;
	if (body.stream !== true || !Array.isArray(body.messages)) return;
	const messages = body.messages as WireMessage[];
	const calls = new Set<string>();
	const paired: { index: number; signature: string }[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message || typeof message !== "object" || message.role === "tool") return;
		if (message.role !== "assistant" || message.tool_calls === undefined) continue;
		if (!Array.isArray(message.tool_calls)) return;
		const current = new Map<string, string | undefined>();
		for (const call of message.tool_calls) {
			if (!call || typeof call.id !== "string" || !call.id || calls.has(call.id)) return;
			calls.add(call.id);
			const { name, arguments: args } = call.function ?? {};
			const eligible = call.type === "function" && repeatableWorkspaceReads.has(name) && typeof args === "string";
			current.set(call.id, eligible ? JSON.stringify([name, args]) : undefined);
		}
		while (current.size) {
			const result = messages[++index];
			if (
				!result ||
				result.role !== "tool" ||
				typeof result.tool_call_id !== "string" ||
				!current.has(result.tool_call_id)
			)
				return;
			const signature = current.get(result.tool_call_id);
			current.delete(result.tool_call_id);
			if (signature && typeof result.content === "string" && result.content.length > 80)
				paired.push({ index, signature: JSON.stringify([signature, result.content]) });
		}
	}
	const seen = new Set<string>();
	let projected: WireMessage[] | undefined;
	for (const { index, signature } of paired.reverse()) {
		if (seen.has(signature)) {
			projected ??= [...messages];
			projected[index] = { ...messages[index], content: REPEATED_WORKSPACE_READ };
		}
		seen.add(signature);
	}
	if (projected) return { ...body, messages: projected };
}
