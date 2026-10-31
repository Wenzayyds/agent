import { existsSync, readFileSync } from "node:fs";
import { getEnhancedConfigPaths } from "../shared/config.ts";
import type { PolicyAction, PolicyRule, PolicyRuleSource } from "./policy.ts";

const DEFAULT_AUDIT_CAPACITY = 200;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;
const MODULE_FIELDS = new Set(["enabled", "defaultAction", "rules", "audit", "approvalTimeoutMs"]);
const RULE_FIELDS = new Set(["id", "action", "server", "tool", "toolPattern", "priority"]);

export interface McpPolicyAuditConfig {
	enabled: boolean;
	maxRecent: number;
}

export interface McpPolicyConfig {
	enabled: boolean;
	defaultAction: PolicyAction;
	rules: readonly PolicyRule[];
	audit: McpPolicyAuditConfig;
	approvalTimeoutMs: number;
}

export interface LoadedMcpPolicyConfig {
	config: McpPolicyConfig;
	sources: string[];
	errors: string[];
	failClosed: boolean;
}

interface PolicyLayer {
	enabled?: boolean;
	defaultAction?: PolicyAction;
	rules: PolicyRule[];
	auditEnabled?: boolean;
	auditMaxRecent?: number;
	approvalTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is PolicyAction {
	return value === "allow" || value === "ask" || value === "deny";
}

function readOptionalString(
	value: Record<string, unknown>,
	field: "server" | "tool" | "toolPattern",
	path: string,
	errors: string[],
): string | undefined {
	const candidate = value[field];
	if (candidate === undefined) return undefined;
	if (typeof candidate !== "string" || candidate.trim().length === 0) {
		errors.push(`${path}: rule field "${field}" must be a non-empty string`);
		return undefined;
	}
	return candidate.trim();
}

function parseRule(
	value: unknown,
	path: string,
	source: PolicyRuleSource,
	order: number,
	errors: string[],
): PolicyRule | undefined {
	if (!isRecord(value)) {
		errors.push(`${path}: rule must be an object`);
		return undefined;
	}
	for (const field of Object.keys(value)) {
		if (!RULE_FIELDS.has(field)) errors.push(`${path}: unknown rule field "${field}"`);
	}
	if (typeof value.id !== "string" || value.id.trim().length === 0) {
		errors.push(`${path}: rule id must be a non-empty string`);
		return undefined;
	}
	if (!isAction(value.action)) {
		errors.push(`${path}: rule action must be allow, ask, or deny`);
		return undefined;
	}
	const server = readOptionalString(value, "server", path, errors);
	const tool = readOptionalString(value, "tool", path, errors);
	const toolPattern = readOptionalString(value, "toolPattern", path, errors);
	if (tool && toolPattern) {
		errors.push(`${path}: rule cannot contain both "tool" and "toolPattern"`);
		return undefined;
	}
	if (
		value.priority !== undefined &&
		(!Number.isInteger(value.priority) || Math.abs(Number(value.priority)) > 10_000)
	) {
		errors.push(`${path}: rule priority must be an integer between -10000 and 10000`);
		return undefined;
	}
	return {
		id: value.id.trim(),
		action: value.action,
		...(server ? { server } : {}),
		...(tool ? { tool } : {}),
		...(toolPattern ? { toolPattern } : {}),
		priority: typeof value.priority === "number" ? value.priority : 0,
		source,
		order,
	};
}

function parseLayer(path: string, source: PolicyRuleSource, errors: string[]): PolicyLayer | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.modules)) {
		errors.push(`${path}: expected an object with a "modules" object`);
		return undefined;
	}
	const module = parsed.modules["mcp-policy"];
	if (module === undefined) return { rules: [] };
	if (!isRecord(module)) {
		errors.push(`${path}: module "mcp-policy" must be an object`);
		return undefined;
	}
	for (const field of Object.keys(module)) {
		if (!MODULE_FIELDS.has(field)) errors.push(`${path}: unknown mcp-policy field "${field}"`);
	}
	const layer: PolicyLayer = { rules: [] };
	if (typeof module.enabled !== "boolean") errors.push(`${path}: mcp-policy.enabled must be boolean`);
	else layer.enabled = module.enabled;
	if (module.defaultAction !== undefined) {
		if (module.defaultAction === "ask" || module.defaultAction === "deny") layer.defaultAction = module.defaultAction;
		else errors.push(`${path}: mcp-policy.defaultAction must be ask or deny`);
	}
	if (module.rules !== undefined) {
		if (!Array.isArray(module.rules)) errors.push(`${path}: mcp-policy.rules must be an array`);
		else {
			for (const [index, value] of module.rules.entries()) {
				const rule = parseRule(value, `${path}: rules[${index}]`, source, index, errors);
				if (rule) layer.rules.push(rule);
			}
		}
	}
	if (module.audit !== undefined) {
		if (!isRecord(module.audit)) errors.push(`${path}: mcp-policy.audit must be an object`);
		else {
			for (const field of Object.keys(module.audit)) {
				if (field !== "enabled" && field !== "maxRecent") errors.push(`${path}: unknown audit field "${field}"`);
			}
			if (module.audit.enabled !== undefined) {
				if (typeof module.audit.enabled === "boolean") layer.auditEnabled = module.audit.enabled;
				else errors.push(`${path}: mcp-policy.audit.enabled must be boolean`);
			}
			if (module.audit.maxRecent !== undefined) {
				if (
					Number.isInteger(module.audit.maxRecent) &&
					Number(module.audit.maxRecent) >= 1 &&
					Number(module.audit.maxRecent) <= 10_000
				) {
					layer.auditMaxRecent = Number(module.audit.maxRecent);
				} else errors.push(`${path}: mcp-policy.audit.maxRecent must be an integer between 1 and 10000`);
			}
		}
	}
	if (module.approvalTimeoutMs !== undefined) {
		if (
			Number.isInteger(module.approvalTimeoutMs) &&
			Number(module.approvalTimeoutMs) >= 1_000 &&
			Number(module.approvalTimeoutMs) <= 300_000
		) {
			layer.approvalTimeoutMs = Number(module.approvalTimeoutMs);
		} else errors.push(`${path}: mcp-policy.approvalTimeoutMs must be an integer between 1000 and 300000`);
	}
	return layer;
}

/** Load security policy layers without allowing project settings to disable user protection. */
export function loadMcpPolicyConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): LoadedMcpPolicyConfig {
	const errors: string[] = [];
	const sources: string[] = [];
	const paths = getEnhancedConfigPaths(options);
	const user = parseLayer(paths.global, "user", errors);
	if (existsSync(paths.global)) sources.push(paths.global);
	const project = paths.project ? parseLayer(paths.project, "project", errors) : undefined;
	if (paths.project && existsSync(paths.project)) sources.push(paths.project);

	const rules = [...(user?.rules ?? []), ...(project?.rules ?? [])];
	const ids = new Set<string>();
	for (const rule of rules) {
		if (ids.has(rule.id)) errors.push(`duplicate mcp-policy rule id "${rule.id}"`);
		ids.add(rule.id);
	}
	return {
		config: {
			enabled: Boolean(user?.enabled || project?.enabled),
			defaultAction: project?.defaultAction ?? user?.defaultAction ?? "ask",
			rules,
			audit: {
				enabled: user?.auditEnabled ?? project?.auditEnabled ?? true,
				maxRecent: user?.auditMaxRecent ?? project?.auditMaxRecent ?? DEFAULT_AUDIT_CAPACITY,
			},
			approvalTimeoutMs: user?.approvalTimeoutMs ?? project?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
		},
		sources,
		errors,
		failClosed: errors.length > 0,
	};
}
