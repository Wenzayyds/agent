import { describe, expect, it } from "vitest";
import type { ContextMessage } from "../../src/context/contracts.ts";
import { selectContextMessages } from "../../src/context/selector.ts";
import { hasValidToolPairing, truncatePairedToolOutputs } from "../../src/context/tool-output.ts";

const budget = {
	maximumEstimatedTokens: 1_000,
	reserveEstimatedTokens: 0,
	recentMessagesToKeep: 1,
};

function user(content: string, timestamp: number): ContextMessage {
	return { role: "user", content, timestamp };
}

function assistantText(content: string, timestamp: number): ContextMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	};
}

function toolAssistant(ids: readonly string[]): ContextMessage {
	return {
		...assistantText("calling tools", 2),
		content: ids.map((id) => ({ type: "toolCall" as const, id, name: "fixture", arguments: { id } })),
	};
}

function toolResult(id: string, text: string): ContextMessage {
	return { role: "toolResult", toolCallId: id, toolName: "fixture", content: [{ type: "text", text }], isError: false, timestamp: 3 };
}

describe("P3 Context selector", () => {
	it("removes old complete turns but always keeps the latest user request", () => {
		const old = "old history ".repeat(1_000);
		const messages = [user(old, 1), assistantText(old, 2), user("latest request", 3)];
		const selected = selectContextMessages(messages, { budget, toolOutput: { enabled: false, maximumTextCharacters: 1_000 } });
		expect(selected.messages).toEqual([messages[2]]);
		expect(selected.removedMessages).toBe(2);
		expect(selected.afterEstimatedTokens).toBeLessThan(selected.beforeEstimatedTokens);
	});

	it("deterministically compacts old assistant output and keeps user constraints and diagnostic pairs", () => {
		const constraints = user("Keep network disabled and edit only fixture.txt.", 1);
		const diagnostic = { ...toolResult("failed", "diagnostic " + "x".repeat(2_000)), isError: true };
		const history = [
			constraints, assistantText("unverified guess ".repeat(1_000), 2), user("verify", 3),
			toolAssistant(["failed"]), diagnostic, user("continue", 4),
		];
		const options = { budget, compact: true, toolOutput: { enabled: true, maximumTextCharacters: 500 } };
		const selected = selectContextMessages(history, options);
		expect(selected.messages).toEqual(expect.arrayContaining([constraints, diagnostic, history.at(-1)]));
		expect(JSON.stringify(selected.messages)).not.toContain("unverified guess");
		expect(hasValidToolPairing(selected.messages)).toBe(true);
		expect(selected.removedMessages).toBe(1);
		expect(selectContextMessages(selected.messages, options).messages).toEqual(selected.messages);
	});

	it("keeps compaction summaries even when the estimated target cannot be reached", () => {
		const summary: ContextMessage = { role: "compactionSummary", summary: "important ".repeat(1_000), tokensBefore: 9_000, timestamp: 1 };
		const selected = selectContextMessages([summary, user("latest", 2)], { budget, toolOutput: { enabled: false, maximumTextCharacters: 1_000 } });
		expect(selected.messages).toContain(summary);
		expect(selected.preservedUnsafeGroups).toBeGreaterThan(0);
	});

	it("truncates only paired, text-only tool results without changing IDs or roles", () => {
		const firstResult = {
			...toolResult("call-a", "A".repeat(2_000)),
			details: { nestedCalls: [{ toolCallId: "nested", toolName: "child" }] },
		} as ContextMessage;
		const messages = [user("run", 1), toolAssistant(["call-a", "call-b"]), firstResult, toolResult("call-b", "B".repeat(2_000))];
		const view = truncatePairedToolOutputs(messages, 600);
		expect(view.truncated).toBe(2);
		expect(hasValidToolPairing(view.messages)).toBe(true);
		expect(view.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call-a" });
		expect(JSON.stringify(view.messages[2])).toContain("original remains in Session");
		expect((view.messages[2] as typeof firstResult).details).toEqual(firstResult.details);
		expect(truncatePairedToolOutputs(view.messages, 600).truncated).toBe(0);
	});

	it("does not truncate an unmatched result, image output, or unfinished tool call", () => {
		const image: ContextMessage = { role: "toolResult", toolCallId: "image", toolName: "fixture", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], isError: false, timestamp: 3 };
		const unmatched = toolResult("missing", "X".repeat(2_000));
		const unfinished = [user("run", 1), toolAssistant(["unfinished"]), image, unmatched];
		const view = truncatePairedToolOutputs(unfinished, 600);
		expect(view).toEqual({ messages: unfinished, truncated: 0 });
	});
});
