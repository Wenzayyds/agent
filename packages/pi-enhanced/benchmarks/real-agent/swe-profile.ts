import { readFileSync } from "node:fs";
import { CONTROLLED_IMAGE } from "./controlled-cases.ts";
import { digest } from "./evaluation-identity.ts";
import { SWE_SOURCE_INSTRUCTIONS, swePrompt } from "./swebench.ts";

export const SWE_TASK_PROFILE = "swe-task-v1";
export const SWE_TASK_CELLS = ["off", "v1", "v2"].map((id) => ({
	id,
	taskId: "swebench",
	variant: id === "off" ? "baseline" : "task-only",
	module: "task",
	treatment: id !== "off",
}));
export const SWE_TASK_LIMITS = Object.freeze({
	maxRequests: 20,
	maxTokens: 200_000,
	maxCostUsd: 0.08,
	timeoutMs: 600_000,
	maxRuns: 3,
	maxBatchCostUsd: 0.24,
});
export const SWE_TASK_CONFIGURATION = Object.freeze({
	profile: SWE_TASK_PROFILE,
	cells: SWE_TASK_CELLS.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
	provider: "deepseek",
	model: "deepseek-flash",
	thinking: "off",
	memory: false,
	context: false,
	telemetry: true,
	recovery: "strict",
	concurrency: 1,
	retries: 0,
	maxOutputTokens: 2048,
	image: CONTROLLED_IMAGE,
	limits: SWE_TASK_LIMITS,
	instanceId: "astropy__astropy-13033",
	baseCommit: "298ccb478e6bf092953bca67a3d29dc6c35f6752",
	problemSha256: "a295c83e68ff62290947b0796b75659b94621b7f2340d6f0055512d04be3f1d1",
	userPromptSha256: digest(
		swePrompt(
			(
				JSON.parse(readFileSync(new URL("./swebench-verified.json", import.meta.url), "utf8")) as {
					instances: Array<{ instance_id: string; problem_statement?: string }>;
				}
			).instances.find((row) => row.instance_id === "astropy__astropy-13033")!.problem_statement!,
		),
	),
	sourcePolicySha256: digest(SWE_SOURCE_INSTRUCTIONS),
	continuationPolicy: "verified_host_cleanup_v1",
	moduleTools: { off: [], v1: ["enhanced_task_get"], v2: ["enhanced_task_get", "enhanced_task_plan_update"] },
});

export const SWE_PRO_OFF_PROFILE = "swe-pro-off-v1";
export const SWE_PRO_OFF_CELLS = [SWE_TASK_CELLS[0]!];
export const SWE_PRO_OFF_LIMITS = Object.freeze({
	maxRequests: 20,
	maxTokens: 200_000,
	maxCostUsd: 0.4,
	timeoutMs: 600_000,
	maxRuns: 1,
	maxBatchCostUsd: 0.4,
});
export const SWE_PRO_OFF_CONFIGURATION = Object.freeze({
	...SWE_TASK_CONFIGURATION,
	profile: SWE_PRO_OFF_PROFILE,
	cells: [{ id: "off", taskId: "swebench", variant: "baseline" }],
	model: "deepseek-v4-pro",
	limits: SWE_PRO_OFF_LIMITS,
	moduleTools: { off: [] },
});
