import { existsSync, readFileSync } from "node:fs";
import { getEnhancedConfigPaths } from "../shared/config.ts";
import type { MemoryGovernanceConfig } from "./governance.ts";

export const MEMORY_RETRIEVAL_MODES = ["lexical", "semantic", "hybrid"] as const;
export type MemoryRetrievalMode = (typeof MEMORY_RETRIEVAL_MODES)[number];

export interface MemoryIntelligenceConfig {
	enabled: boolean;
	mode: MemoryRetrievalMode;
	rerankerEnabled: boolean;
	startupTimeoutMs: number;
	requestTimeoutMs: number;
	maximumSnapshotRecords: number;
	semanticCandidates: number;
}

export interface MemoryModuleConfig {
	enabled: boolean;
	intelligence: MemoryIntelligenceConfig;
	governance: MemoryGovernanceConfig;
}

export interface LoadedMemoryConfig {
	config: MemoryModuleConfig;
	sources: readonly string[];
	errors: readonly string[];
}

const DEFAULT_CONFIG: MemoryModuleConfig = Object.freeze({
	enabled: false,
	intelligence: Object.freeze({
		enabled: false,
		mode: "lexical",
		rerankerEnabled: false,
		startupTimeoutMs: 5_000,
		requestTimeoutMs: 2_000,
		maximumSnapshotRecords: 2_000,
		semanticCandidates: 30,
	}),
	governance: Object.freeze({
		maximumScanRecords: 500,
		nearDuplicatePercent: 82,
		archiveAfterDays: 180,
		coreWarningBytes: 49_152,
	}),
});

interface MemoryConfigPatch {
	enabled?: boolean;
	intelligence?: Partial<MemoryIntelligenceConfig>;
	governance?: Partial<MemoryGovernanceConfig>;
}

export function loadMemoryConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): LoadedMemoryConfig {
	const config = structuredClone(DEFAULT_CONFIG);
	const errors: string[] = [];
	const sources: string[] = [];
	const paths = getEnhancedConfigPaths(options);
	for (const path of [paths.global, paths.project]) {
		if (!path || !existsSync(path)) continue;
		const patch = readPatch(path, errors);
		if (!patch) continue;
		if (patch.enabled !== undefined) config.enabled = patch.enabled;
		if (patch.intelligence) Object.assign(config.intelligence, patch.intelligence);
		if (patch.governance) Object.assign(config.governance, patch.governance);
		sources.push(path);
	}
	if (errors.length > 0) config.enabled = false;
	if (!config.intelligence.enabled) config.intelligence.mode = "lexical";
	return { config, sources, errors };
}

function readPatch(path: string, errors: string[]): MemoryConfigPatch | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!isRecord(value) || !isRecord(value.modules)) return undefined;
	const module = value.modules.memory;
	if (module === undefined) return {};
	if (!isRecord(module) || typeof module.enabled !== "boolean") {
		errors.push(`${path}: memory module must contain a boolean "enabled" field`);
		return undefined;
	}
	const patch: MemoryConfigPatch = { enabled: module.enabled };
	const moduleUnknown = Object.keys(module).find((key) => !["enabled", "intelligence", "governance"].includes(key));
	if (moduleUnknown) {
		errors.push(`${path}: unknown memory field "${moduleUnknown}"`);
		return undefined;
	}
	if (module.intelligence === undefined) {
		patch.governance = parseGovernance(path, module.governance, errors);
		return patch;
	}
	if (!isRecord(module.intelligence)) {
		errors.push(`${path}: memory.intelligence must be an object`);
		return undefined;
	}
	const intelligence = module.intelligence;
	const allowed = new Set([
		"enabled",
		"mode",
		"rerankerEnabled",
		"startupTimeoutMs",
		"requestTimeoutMs",
		"maximumSnapshotRecords",
		"semanticCandidates",
	]);
	const unknown = Object.keys(intelligence).find((key) => !allowed.has(key));
	if (unknown) {
		errors.push(`${path}: unknown memory.intelligence field "${unknown}"`);
		return undefined;
	}
	const parsed: Partial<MemoryIntelligenceConfig> = {};
	if (intelligence.enabled !== undefined) {
		if (typeof intelligence.enabled !== "boolean") return invalid(path, "enabled", errors);
		parsed.enabled = intelligence.enabled;
	}
	if (intelligence.mode !== undefined) {
		if (!MEMORY_RETRIEVAL_MODES.includes(intelligence.mode as MemoryRetrievalMode)) {
			return invalid(path, "mode", errors);
		}
		parsed.mode = intelligence.mode as MemoryRetrievalMode;
	}
	if (intelligence.rerankerEnabled !== undefined) {
		if (typeof intelligence.rerankerEnabled !== "boolean") return invalid(path, "rerankerEnabled", errors);
		parsed.rerankerEnabled = intelligence.rerankerEnabled;
	}
	for (const [name, minimum, maximum] of [
		["startupTimeoutMs", 100, 30_000],
		["requestTimeoutMs", 100, 30_000],
		["maximumSnapshotRecords", 1, 2_000],
		["semanticCandidates", 1, 50],
	] as const) {
		const candidate = intelligence[name];
		if (candidate === undefined) continue;
		if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
			return invalid(path, name, errors);
		}
		parsed[name] = candidate as number;
	}
	patch.intelligence = parsed;
	patch.governance = parseGovernance(path, module.governance, errors);
	return patch;
}

function parseGovernance(path: string, value: unknown, errors: string[]): Partial<MemoryGovernanceConfig> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		errors.push(`${path}: memory.governance must be an object`);
		return undefined;
	}
	const limits = {
		maximumScanRecords: [10, 500],
		nearDuplicatePercent: [50, 100],
		archiveAfterDays: [1, 3_650],
		coreWarningBytes: [1_024, 65_536],
	} as const;
	const unknown = Object.keys(value).find((key) => !(key in limits));
	if (unknown) {
		errors.push(`${path}: unknown memory.governance field "${unknown}"`);
		return undefined;
	}
	const result: Partial<MemoryGovernanceConfig> = {};
	for (const [name, [minimum, maximum]] of Object.entries(limits)) {
		const candidate = value[name];
		if (candidate === undefined) continue;
		if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
			errors.push(`${path}: memory.governance.${name} is invalid`);
			return undefined;
		}
		result[name as keyof MemoryGovernanceConfig] = candidate as number;
	}
	return result;
}

function invalid(path: string, field: string, errors: string[]): undefined {
	errors.push(`${path}: memory.intelligence.${field} is invalid`);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
