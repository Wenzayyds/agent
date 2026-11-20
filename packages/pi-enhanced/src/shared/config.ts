import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_TASK_BUDGET_TIER,
	TASK_BUDGET_DEFAULTS,
	type TaskBudgetSettings,
	taskBudgetTier,
} from "./task-budget.ts";

export const ENHANCED_CONFIG_FILE = "pi-enhanced.json";

export function getEnhancedConfigPaths(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
	global: string;
	project?: string;
} {
	return {
		global: join(options.agentDir, ENHANCED_CONFIG_FILE),
		...(options.projectTrusted ? { project: join(options.cwd, CONFIG_DIR_NAME, ENHANCED_CONFIG_FILE) } : {}),
	};
}

export function loadTaskBudget(location: Parameters<typeof getEnhancedConfigPaths>[0]): TaskBudgetSettings {
	const settings: TaskBudgetSettings = { tier: DEFAULT_TASK_BUDGET_TIER, ...TASK_BUDGET_DEFAULTS };
	const { global, project } = getEnhancedConfigPaths(location);
	for (const path of [global, project]) {
		if (!path) continue;
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const root = JSON.parse(raw) as { budget?: unknown } | null;
		if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("GATEWAY_BUDGET_CONFIG_INVALID");
		if (root.budget === undefined) continue;
		const patch = root.budget;
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("GATEWAY_BUDGET_CONFIG_INVALID");
		for (const [name, value] of Object.entries(patch)) {
			if (name === "tier" && typeof value === "string") settings.tier = taskBudgetTier(value);
			else if (name === "maxTotalCostUsd" && typeof value === "number" && Number.isFinite(value) && value > 0)
				settings.maxTotalCostUsd = value;
			else if (
				(name === "maxRequests" || name === "timeoutMs" || name === "maxOutputTokensPerRequest") &&
				typeof value === "number" &&
				Number.isSafeInteger(value) &&
				value > 0 &&
				value < 2_147_483_000
			)
				settings[name] = value;
			else throw new Error(`GATEWAY_BUDGET_CONFIG_INVALID:${name}`);
		}
	}
	return settings;
}
