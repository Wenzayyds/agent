import { type McpToolIdentity, normalizeMcpNamePart } from "./identity.ts";

export type PolicyAction = "allow" | "ask" | "deny";
export type PolicyRuleSource = "user" | "project";

export interface PolicyRule {
	id: string;
	action: PolicyAction;
	server?: string;
	tool?: string;
	toolPattern?: string;
	priority: number;
	source: PolicyRuleSource;
	order: number;
}

export interface PolicyInput extends McpToolIdentity {
	annotations?: Readonly<Record<string, unknown>>;
	arguments: Readonly<Record<string, unknown>>;
}

export interface PolicyDecision {
	action: PolicyAction;
	ruleId: string;
	reason: string;
}

function patternRegExp(pattern: string): RegExp {
	const normalized = pattern.replace(/[^A-Za-z0-9_*]/g, "_");
	const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function matches(rule: PolicyRule, input: PolicyInput): boolean {
	if (rule.server && normalizeMcpNamePart(rule.server) !== normalizeMcpNamePart(input.server)) return false;
	if (rule.tool && normalizeMcpNamePart(rule.tool) !== input.tool) return false;
	if (rule.toolPattern && !patternRegExp(rule.toolPattern).test(input.tool)) return false;
	return true;
}

function specificity(rule: PolicyRule): number {
	if (rule.tool || rule.toolPattern) return 2;
	if (rule.server) return 1;
	return 0;
}

function compareRules(left: PolicyRule, right: PolicyRule): number {
	return right.priority - left.priority || left.order - right.order || left.id.localeCompare(right.id);
}

/**
 * Evaluate one MCP call. Deny always wins. Otherwise tool rules win over server rules, then the
 * configured default is used. MCP annotations are deliberately not authorization inputs.
 */
export function evaluatePolicy(
	input: PolicyInput,
	rules: readonly PolicyRule[],
	defaultAction: PolicyAction = "ask",
): PolicyDecision {
	const matching = rules.filter((rule) => matches(rule, input));
	const explicitDeny = matching.filter((rule) => rule.action === "deny").sort(compareRules)[0];
	if (explicitDeny) {
		return { action: "deny", ruleId: explicitDeny.id, reason: `Denied by rule ${explicitDeny.id}` };
	}

	for (const level of [2, 1, 0]) {
		const rule = matching.filter((candidate) => specificity(candidate) === level).sort(compareRules)[0];
		if (rule) return { action: rule.action, ruleId: rule.id, reason: `Matched rule ${rule.id}` };
	}

	return { action: defaultAction, ruleId: "default", reason: `No explicit rule matched; default is ${defaultAction}` };
}
