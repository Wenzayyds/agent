import { describe, expect, it } from "vitest";
import { AuditTrail } from "../../src/mcp-policy/audit.ts";
import { classifyToolResult } from "../../src/mcp-policy/errors.ts";

function record(toolCallId: string, parentToolCallId?: string) {
	return {
		fullToolName: "mcp__fixture__read_symbol",
		server: "fixture",
		tool: "read_symbol",
		sessionIdOrScope: "session-1",
		toolCallId,
		...(parentToolCallId ? { parentToolCallId } : {}),
		decision: "allow" as const,
		ruleId: "allow-read",
	};
}

describe("MCP audit trail", () => {
	it("keeps a fixed-capacity redacted record list with parent call ids", () => {
		const audit = new AuditTrail(2);
		audit.recordComplete(record("one"), "success");
		audit.recordComplete(record("two", "parent"), "denied");
		audit.recordComplete(record("three"), "unknown");

		const snapshot = audit.snapshot();
		expect(snapshot.map((item) => item.toolCallId)).toEqual(["two", "three"]);
		expect(snapshot[0]?.parentToolCallId).toBe("parent");
		expect(JSON.stringify(snapshot)).not.toContain("arguments");
		expect(JSON.stringify(snapshot)).not.toContain("content");
	});

	it("completes denied calls without waiting for a tool result and clears session state", () => {
		const audit = new AuditTrail(2);
		audit.recordComplete(record("blocked"), "denied");
		expect(audit.pendingCount()).toBe(0);
		expect(audit.snapshot()[0]?.outcome).toBe("denied");
		audit.clear();
		expect(audit.snapshot()).toEqual([]);
	});

	it("bounds calls whose tool_result is lost and finalizes the oldest as unknown", () => {
		const audit = new AuditTrail(2);
		audit.start(record("aborted-one"));
		audit.start(record("aborted-two"));
		expect(audit.pendingCount()).toBe(2);

		audit.start(record("later-call"));
		expect(audit.pendingCount()).toBe(2);
		expect(audit.snapshot()).toEqual([
			expect.objectContaining({ toolCallId: "aborted-one", outcome: "unknown" }),
		]);

		audit.clear();
		expect(audit.pendingCount()).toBe(0);
		expect(audit.snapshot()).toEqual([]);
	});

	it("classifies only machine-readable result signals and leaves ambiguous errors unknown", () => {
		const event = {
			type: "tool_result" as const,
			toolName: "mcp__fixture__read_symbol",
			toolCallId: "call",
			input: {},
			content: [],
			details: { code: "timeout" },
			isError: true,
		};
		expect(classifyToolResult(event)).toBe("timeout");
		expect(classifyToolResult({ ...event, details: { message: "looks like timeout" } })).toBe("unknown");
		expect(classifyToolResult({ ...event, details: undefined, isError: false })).toBe("success");
	});
});
