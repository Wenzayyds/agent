import { CONTROLLED_IMAGE } from "./controlled-cases.ts";
import { digest } from "./evaluation-identity.ts";
import { frozenCases, frozenProfile, frozenSelectionSha256 } from "./swe-frozen-catalog.ts";
import { readSweManifest, SWE_SOURCE_INSTRUCTIONS, swePrompt } from "./swe-instance.ts";

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
const SWE_FLASH_DEFAULTS = {
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
} as const;
export const SWE_TASK_CONFIGURATION = Object.freeze({
	profile: SWE_TASK_PROFILE,
	cells: SWE_TASK_CELLS.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
	...SWE_FLASH_DEFAULTS,
	limits: SWE_TASK_LIMITS,
	instanceId: "astropy__astropy-13033",
	baseCommit: "298ccb478e6bf092953bca67a3d29dc6c35f6752",
	problemSha256: "a295c83e68ff62290947b0796b75659b94621b7f2340d6f0055512d04be3f1d1",
	userPromptSha256: digest(
		swePrompt(
			readSweManifest().instances.find((row) => row.instance_id === "astropy__astropy-13033")!.problem_statement!,
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

export const SWE_PRO_TASK_PROFILE = "swe-pro-task-v1";
export const SWE_PRO_TASK_CELLS = [SWE_TASK_CELLS[1]!, SWE_TASK_CELLS[2]!];
export const SWE_PRO_TASK_LIMITS = Object.freeze({
	...SWE_PRO_OFF_LIMITS,
	maxRuns: 2,
	maxBatchCostUsd: 0.8,
});
export const SWE_PRO_TASK_CONFIGURATION = Object.freeze({
	...SWE_PRO_OFF_CONFIGURATION,
	profile: SWE_PRO_TASK_PROFILE,
	cells: SWE_PRO_TASK_CELLS.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
	limits: SWE_PRO_TASK_LIMITS,
	moduleTools: { v1: ["enhanced_task_get"], v2: ["enhanced_task_get", "enhanced_task_plan_update"] },
});

export const SWE_FLASH_OFF_PROFILE = "swe-flash-off-v1";
const verifiedSelection = readSweManifest().instances;
function flashOffInstance(instanceId: string, issue: number) {
	const row = verifiedSelection.find((item) => item.instance_id === instanceId && item.role === "candidate");
	if (!row?.problem_statement || digest(row.problem_statement) !== row.problem_sha256)
		throw new Error("SWE_FLASH_OFF_INSTANCE_INVALID");
	return {
		instanceId,
		baseCommit: row.base_commit,
		problemSha256: row.problem_sha256,
		userPromptSha256: digest(swePrompt(row.problem_statement)),
		cellId: `off_${issue}`,
	};
}
const flashOffInstances = [13033, 13453, 14365, 14369, 14508].map((issue) => flashOffInstance("astropy__astropy-" + issue, issue));
const flashOffCells = flashOffInstances.map(({ cellId }) => ({ ...SWE_TASK_CELLS[0]!, id: cellId }));
export const SWE_FLASH_OFF_CONFIGURATION = Object.freeze({
	profile: SWE_FLASH_OFF_PROFILE,
	cells: flashOffCells.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
	...SWE_FLASH_DEFAULTS,
	limits: { ...SWE_TASK_LIMITS, maxRuns: 5, maxBatchCostUsd: 0.40 },
	instances: flashOffInstances,
	sourcePolicySha256: SWE_TASK_CONFIGURATION.sourcePolicySha256,
	continuationPolicy: SWE_TASK_CONFIGURATION.continuationPolicy,
	moduleTools: { off: [] },
});

export const SWE_FLASH_OFF_SINGLE_PROFILE = "swe-flash-off-single-v1";
const flashOffSingleInstance = flashOffInstances.find(({ instanceId }) => instanceId === "astropy__astropy-13033")!;
const flashOffSingleCells = flashOffCells.filter(({ id }) => id === flashOffSingleInstance.cellId);
export const SWE_FLASH_OFF_SINGLE_CONFIGURATION = Object.freeze({
	...SWE_FLASH_OFF_CONFIGURATION,
	profile: SWE_FLASH_OFF_SINGLE_PROFILE,
	cells: flashOffSingleCells.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
	limits: { ...SWE_FLASH_OFF_CONFIGURATION.limits, maxRuns: 1, maxBatchCostUsd: 0.08 },
	instances: [flashOffSingleInstance],
});

export const SWE_FLASH_OFF_PYTEST_SINGLE_PROFILE = "swe-flash-off-pytest-single-v1";
const pytestSingleInstance = flashOffInstance("astropy__astropy-7671", 7671);
const pytestSingleCells = [{ ...SWE_TASK_CELLS[0]!, id: pytestSingleInstance.cellId }];
export const SWE_FLASH_OFF_PYTEST_SINGLE_CONFIGURATION = Object.freeze({
	...SWE_FLASH_OFF_SINGLE_CONFIGURATION,
	profile: SWE_FLASH_OFF_PYTEST_SINGLE_PROFILE,
	cells: pytestSingleCells.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
	instances: [pytestSingleInstance],
});

export const SWE_FLASH_OFF_FOUR_PROFILE = "swe-flash-off-four-v1";
const flashOffFourInstances = [13453, 14365, 14369, 14508].map((issue) =>
	flashOffInstances.find(({ instanceId }) => instanceId === `astropy__astropy-${issue}`)!,
);
const flashOffFourCells = flashOffFourInstances.map(({ cellId }) => ({ ...SWE_TASK_CELLS[0]!, id: cellId }));
export const SWE_FLASH_OFF_FOUR_CONFIGURATION = Object.freeze({
	...SWE_FLASH_OFF_CONFIGURATION,
	profile: SWE_FLASH_OFF_FOUR_PROFILE,
	cells: flashOffFourCells.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
	limits: { ...SWE_FLASH_OFF_CONFIGURATION.limits, maxRuns: flashOffFourInstances.length, maxBatchCostUsd: 0.32 },
	instances: flashOffFourInstances,
	compactGrep: true,
	readResultMaxBytes: 4 * 1024,
});

const frozenProfiles = frozenCases.map((row) => {
	const instance = flashOffInstance(row.instanceId, row.order);
	if (instance.baseCommit !== row.baseCommit || instance.problemSha256 !== row.publicIssueSha256)
		throw new Error("SWE_FROZEN_CATALOG_MISMATCH");
	const cells = [{ ...SWE_TASK_CELLS[0]!, id: instance.cellId }];
	const profile = frozenProfile(row.order);
	return {
		configuration: Object.freeze({
			...SWE_FLASH_OFF_PYTEST_SINGLE_CONFIGURATION, profile, instances: [instance],
			cells: cells.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
			selectionSha256: frozenSelectionSha256,
			pytestPolicySha256: row.policy ? digest(row.policy) : null,
			officialImage: row.officialImage,
		}),
		cells,
		batchIdPattern: /^swe_frozen_[a-z0-9_]{4,24}$/u,
		admission: "instances" as const,
	};
});

// CLI and authorization share the same mode list, configuration and admission shape.
const profiles = [
	{
		configuration: SWE_TASK_CONFIGURATION,
		cells: SWE_TASK_CELLS,
		batchIdPattern: /^swe_task_[a-z0-9_]{4,20}$/u,
		admission: "all",
	},
	{
		configuration: SWE_PRO_OFF_CONFIGURATION,
		cells: SWE_PRO_OFF_CELLS,
		batchIdPattern: /^swe_pro_off_[a-z0-9_]{4,20}$/u,
		admission: "off",
	},
	{
		configuration: SWE_PRO_TASK_CONFIGURATION,
		cells: SWE_PRO_TASK_CELLS,
		batchIdPattern: /^swe_pro_task_[a-z0-9_]{4,20}$/u,
		admission: "task",
	},
	{
		configuration: SWE_FLASH_OFF_CONFIGURATION,
		cells: flashOffCells,
		batchIdPattern: /^swe_flash_off_[a-z0-9_]{4,20}$/u,
		admission: "instances",
	},
	{
		configuration: SWE_FLASH_OFF_SINGLE_CONFIGURATION,
		cells: flashOffSingleCells,
		batchIdPattern: /^swe_flash_single_[a-z0-9_]{4,20}$/u,
		admission: "instances",
		compactGrep: true,
	},
	{
		configuration: SWE_FLASH_OFF_PYTEST_SINGLE_CONFIGURATION,
		cells: pytestSingleCells,
		batchIdPattern: /^swe_flash_pytest_[a-z0-9_]{4,20}$/u,
		admission: "instances",
	},
	{
		configuration: SWE_FLASH_OFF_FOUR_CONFIGURATION,
		cells: flashOffFourCells,
		batchIdPattern: /^swe_flash_four_[a-z0-9_]{4,20}$/u,
		admission: "instances",
		compactGrep: SWE_FLASH_OFF_FOUR_CONFIGURATION.compactGrep,
	},
	...frozenProfiles,
] as const;

export type SweProfile = (typeof profiles)[number];
export type SweProfileName = SweProfile["configuration"]["profile"];

export function resolveSweProfile(name: string | undefined): SweProfile | undefined {
	return profiles.find(({ configuration }) => configuration.profile === name);
}
