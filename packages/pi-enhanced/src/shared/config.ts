import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	ENHANCED_MODULE_NAMES,
	type EnhancedConfig,
	type EnhancedModuleName,
	type LoadedEnhancedConfig,
} from "./types.ts";

export const ENHANCED_CONFIG_FILE = "pi-enhanced.json";

const DEFAULT_MODULES: Record<EnhancedModuleName, { enabled: boolean }> = {
	"mcp-policy": { enabled: false },
	memory: { enabled: false },
	context: { enabled: false },
	"task-manager": { enabled: false },
};

function defaultConfig(): EnhancedConfig {
	return { modules: structuredClone(DEFAULT_MODULES) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ConfigPatch {
	modules: Partial<Record<EnhancedModuleName, { enabled: boolean }>>;
}

function readConfig(path: string, errors: string[]): ConfigPatch | undefined {
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

	const modules: ConfigPatch["modules"] = {};
	for (const [name, value] of Object.entries(parsed.modules)) {
		if (!ENHANCED_MODULE_NAMES.includes(name as EnhancedModuleName)) {
			errors.push(`${path}: unknown module "${name}"`);
			continue;
		}
		const enabled =
			name === "task-manager" && isRecord(value) && ["off", "v1", "v2"].includes(String(value.mode))
				? value.mode !== "off"
				: isRecord(value)
					? value.enabled
					: undefined;
		if (
			!isRecord(value) ||
			typeof enabled !== "boolean" ||
			(name === "task-manager" && typeof value.enabled === "boolean" && value.enabled !== enabled)
		) {
			errors.push(`${path}: module "${name}" must contain a boolean "enabled" field`);
			continue;
		}
		modules[name as EnhancedModuleName] = { enabled };
	}
	return { modules };
}

function applyPatch(config: EnhancedConfig, patch: ConfigPatch): void {
	for (const name of ENHANCED_MODULE_NAMES) {
		const module = patch.modules[name];
		if (module) config.modules[name] = module;
	}
}

export function getEnhancedConfigPaths(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
	global: string;
	project?: string;
} {
	return {
		global: join(options.agentDir, ENHANCED_CONFIG_FILE),
		...(options.projectTrusted ? { project: join(options.cwd, CONFIG_DIR_NAME, ENHANCED_CONFIG_FILE) } : {}),
	};
}

/** Load user settings, then override individual module switches from a trusted project. */
export function loadEnhancedConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): LoadedEnhancedConfig {
	const config = defaultConfig();
	const errors: string[] = [];
	const sources: string[] = [];
	const paths = getEnhancedConfigPaths(options);
	for (const path of [paths.global, paths.project]) {
		if (!path) continue;
		const patch = readConfig(path, errors);
		if (!patch) continue;
		applyPatch(config, patch);
		sources.push(path);
	}
	return { config, sources, errors };
}
