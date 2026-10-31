import { describe, expect, it } from "vitest";
import { parseMcpToolIdentity } from "../../src/mcp-policy/identity.ts";
import { evaluatePolicy, type PolicyInput, type PolicyRule } from "../../src/mcp-policy/policy.ts";

const input: PolicyInput = {
	server: "serena",
	tool: "find_symbol",
	fullToolName: "mcp__serena__find_symbol",
	arguments: Object.freeze({ name: "AgentSession" }),
};

function rule(value: Partial<PolicyRule> & Pick<PolicyRule, "id" | "action">): PolicyRule {
	return { priority: 0, source: "user", order: 0, ...value };
}

describe("MCP policy evaluation", () => {
	it("gives an explicit deny precedence over a tool allow", () => {
		const decision = evaluatePolicy(input, [
			rule({ id: "allow-symbol", action: "allow", tool: "find_symbol", priority: 100 }),
			rule({ id: "deny-serena", action: "deny", server: "serena", priority: -100 }),
		]);
		expect(decision).toMatchObject({ action: "deny", ruleId: "deny-serena" });
	});

	it("uses tool rules before server rules and fixes same-tier order by priority then declaration", () => {
		const rules = [
			rule({ id: "server-ask", action: "ask", server: "serena", priority: 100 }),
			rule({ id: "later-tool", action: "ask", toolPattern: "find_*", priority: 10, order: 2 }),
			rule({ id: "first-tool", action: "allow", tool: "find_symbol", priority: 10, order: 1 }),
		];
		expect(evaluatePolicy(input, rules)).toMatchObject({ action: "allow", ruleId: "first-tool" });
	});

	it("asks for unknown tools and ignores untrusted read-only annotations", () => {
		const annotated = { ...input, annotations: { readOnlyHint: true, destructiveHint: false } };
		expect(evaluatePolicy(annotated, [])).toMatchObject({ action: "ask", ruleId: "default" });
	});

	it("does not modify the read-only arguments object", () => {
		const before = JSON.stringify(input.arguments);
		evaluatePolicy(input, [rule({ id: "allow", action: "allow", toolPattern: "find_*" })]);
		expect(JSON.stringify(input.arguments)).toBe(before);
	});

	it("parses valid MCP names and rejects non-MCP or incomplete names", () => {
		expect(parseMcpToolIdentity("mcp__context7__query_docs")).toEqual({
			server: "context7",
			tool: "query_docs",
			fullToolName: "mcp__context7__query_docs",
		});
		expect(parseMcpToolIdentity("read")).toBeUndefined();
		expect(parseMcpToolIdentity("mcp__missing")).toBeUndefined();
	});
});
