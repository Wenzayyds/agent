import { existsSync, readFileSync } from "node:fs";
import { getEnhancedConfigPaths } from "../shared/config.ts";

export interface TaskManagerConfig {
	enabled: boolean;
	modelPlanTool: boolean;
	contextSummary: boolean;
	maximumTasks: number;
	maximumSteps: number;
	maximumEvents: number;
}

export interface LoadedTaskManagerConfig {
	config: TaskManagerConfig;
	sources: readonly string[];
	errors: readonly string[];
}

const DEFAULT_CONFIG: TaskManagerConfig = Object.freeze({
	enabled: false,
	modelPlanTool: false,
	contextSummary: false,
	maximumTasks: 200,
	maximumSteps: 100,
	maximumEvents: 10_000,
});

export function loadTaskManagerConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): LoadedTaskManagerConfig {
	const config = structuredClone(DEFAULT_CONFIG);
	const errors: string[] = [];
	const sources: string[] = [];
	const paths = getEnhancedConfigPaths(options);
	for (const path of [paths.global, paths.project]) {
		if (!path || !existsSync(path)) continue;
		let root: unknown;
		try {
			root = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!isRecord(root) || !isRecord(root.modules) || root.modules["task-manager"] === undefined) continue;
		const value = root.modules["task-manager"];
		if (!isRecord(value) || typeof value.enabled !== "boolean") {
			errors.push(`${path}: task-manager must contain a boolean enabled field`);
			continue;
		}
		const allowed = new Set([
			"enabled",
			"modelPlanTool",
			"contextSummary",
			"maximumTasks",
			"maximumSteps",
			"maximumEvents",
		]);
		const unknown = Object.keys(value).find((key) => !allowed.has(key));
		if (unknown) {
			errors.push(`${path}: unknown task-manager field "${unknown}"`);
			continue;
		}
		const candidate = { ...config, ...value } as Record<string, unknown>;
		if (
			typeof candidate.modelPlanTool !== "boolean" ||
			typeof candidate.contextSummary !== "boolean" ||
			!integer(candidate.maximumTasks, 1, 2_000) ||
			!integer(candidate.maximumSteps, 1, 500) ||
			!integer(candidate.maximumEvents, 100, 100_000)
		) {
			errors.push(`${path}: task-manager limits or switches are invalid`);
			continue;
		}
		Object.assign(config, candidate);
		sources.push(path);
	}
	if (errors.length > 0) config.enabled = false;
	return { config, sources, errors };
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
