import { existsSync, readFileSync } from "node:fs";
import { getEnhancedConfigPaths } from "../shared/config.ts";
import type { ContextMode, ContextModuleConfig } from "./contracts.ts";

export interface LoadedContextConfig {
	config: ContextModuleConfig;
	sources: readonly string[];
	errors: readonly string[];
}

const DEFAULT_CONFIG: ContextModuleConfig = Object.freeze({
	enabled: false,
	mode: "observe",
	budget: Object.freeze({
		maximumEstimatedTokens: 60_000,
		reserveEstimatedTokens: 12_000,
		recentMessagesToKeep: 8,
	}),
	toolOutput: Object.freeze({ enabled: false, maximumTextCharacters: 12_000 }),
	memoryInjection: Object.freeze({
		enabled: false,
		maximumRecords: 3,
		maximumTextCharacters: 3_000,
		readerTimeoutMs: 250,
	}),
	taskInjection: Object.freeze({ enabled: false, maximumTextCharacters: 2_000, readerTimeoutMs: 250 }),
	pythonScoring: Object.freeze({ enabled: false }),
});

interface ContextConfigPatch {
	enabled?: boolean;
	mode?: ContextMode;
	budget?: Partial<ContextModuleConfig["budget"]>;
	toolOutput?: Partial<ContextModuleConfig["toolOutput"]>;
	memoryInjection?: Partial<ContextModuleConfig["memoryInjection"]>;
	taskInjection?: Partial<ContextModuleConfig["taskInjection"]>;
	pythonScoring?: Partial<ContextModuleConfig["pythonScoring"]>;
}

export function loadContextConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): LoadedContextConfig {
	const config = structuredClone(DEFAULT_CONFIG);
	const sources: string[] = [];
	const errors: string[] = [];
	const paths = getEnhancedConfigPaths(options);
	for (const path of [paths.global, paths.project]) {
		if (!path || !existsSync(path)) continue;
		const patch = readPatch(path, errors);
		if (!patch) continue;
		applyPatch(config, patch);
		sources.push(path);
	}
	if (errors.length > 0) config.enabled = false;
	return { config, sources, errors };
}

function readPatch(path: string, errors: string[]): ContextConfigPatch | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!isRecord(value) || !isRecord(value.modules)) return undefined;
	const module = value.modules.context;
	if (module === undefined) return {};
	if (!isRecord(module) || typeof module.enabled !== "boolean") {
		errors.push(`${path}: context module must contain a boolean "enabled" field`);
		return undefined;
	}
	const allowed = new Set([
		"enabled",
		"mode",
		"budget",
		"toolOutput",
		"memoryInjection",
		"taskInjection",
		"pythonScoring",
	]);
	const unknown = Object.keys(module).find((key) => !allowed.has(key));
	if (unknown) return invalid(path, `unknown context field "${unknown}"`, errors);
	const patch: ContextConfigPatch = { enabled: module.enabled };
	if (module.mode !== undefined) {
		if (module.mode !== "observe" && module.mode !== "select")
			return invalid(path, "context.mode is invalid", errors);
		patch.mode = module.mode as ContextMode;
	}
	patch.budget = parseObject(
		path,
		"budget",
		module.budget,
		{
			maximumEstimatedTokens: [1_000, 1_000_000],
			reserveEstimatedTokens: [0, 500_000],
			recentMessagesToKeep: [1, 100],
		},
		errors,
	) as Partial<ContextModuleConfig["budget"]> | undefined;
	patch.toolOutput = parseObject(
		path,
		"toolOutput",
		module.toolOutput,
		{ enabled: "boolean", maximumTextCharacters: [500, 100_000] },
		errors,
	) as Partial<ContextModuleConfig["toolOutput"]> | undefined;
	patch.memoryInjection = parseObject(
		path,
		"memoryInjection",
		module.memoryInjection,
		{
			enabled: "boolean",
			maximumRecords: [1, 10],
			maximumTextCharacters: [500, 20_000],
			readerTimeoutMs: [25, 5_000],
		},
		errors,
	) as Partial<ContextModuleConfig["memoryInjection"]> | undefined;
	patch.taskInjection = parseObject(
		path,
		"taskInjection",
		module.taskInjection,
		{ enabled: "boolean", maximumTextCharacters: [500, 10_000], readerTimeoutMs: [25, 5_000] },
		errors,
	) as Partial<ContextModuleConfig["taskInjection"]> | undefined;
	patch.pythonScoring = parseObject(path, "pythonScoring", module.pythonScoring, { enabled: "boolean" }, errors) as
		| Partial<ContextModuleConfig["pythonScoring"]>
		| undefined;
	return errors.some((error) => error.startsWith(`${path}:`)) ? undefined : patch;
}

type FieldRule = "boolean" | readonly [number, number];

function parseObject(
	path: string,
	name: string,
	value: unknown,
	rules: Readonly<Record<string, FieldRule>>,
	errors: string[],
): Record<string, boolean | number> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return invalid(path, `context.${name} must be an object`, errors);
	const unknown = Object.keys(value).find((key) => !(key in rules));
	if (unknown) return invalid(path, `unknown context.${name} field "${unknown}"`, errors);
	const result: Record<string, boolean | number> = {};
	for (const [field, rule] of Object.entries(rules)) {
		const candidate = value[field];
		if (candidate === undefined) continue;
		if (rule === "boolean") {
			if (typeof candidate !== "boolean") return invalid(path, `context.${name}.${field} is invalid`, errors);
			result[field] = candidate;
			continue;
		}
		if (!Number.isSafeInteger(candidate) || (candidate as number) < rule[0] || (candidate as number) > rule[1]) {
			return invalid(path, `context.${name}.${field} is invalid`, errors);
		}
		result[field] = candidate as number;
	}
	return result;
}

function applyPatch(config: ContextModuleConfig, patch: ContextConfigPatch): void {
	if (patch.enabled !== undefined) config.enabled = patch.enabled;
	if (patch.mode !== undefined) config.mode = patch.mode;
	if (patch.budget) Object.assign(config.budget, patch.budget);
	if (patch.toolOutput) Object.assign(config.toolOutput, patch.toolOutput);
	if (patch.memoryInjection) Object.assign(config.memoryInjection, patch.memoryInjection);
	if (patch.taskInjection) Object.assign(config.taskInjection, patch.taskInjection);
	if (patch.pythonScoring) Object.assign(config.pythonScoring, patch.pythonScoring);
}

function invalid(path: string, message: string, errors: string[]): undefined {
	errors.push(`${path}: ${message}`);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
