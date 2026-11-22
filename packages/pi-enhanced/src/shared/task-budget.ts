export const TASK_TOKEN_TIERS = { economy: 20_000, standard: 25_000, premium: 30_000 } as const;
export type TaskBudgetTier = keyof typeof TASK_TOKEN_TIERS;
export const DEFAULT_TASK_BUDGET_TIER: TaskBudgetTier = "standard";
export const TASK_BUDGET_DEFAULTS = {
	maxRequests: 8,
	timeoutMs: 180_000,
	maxTotalCostUsd: 0.03,
	maxOutputTokensPerRequest: 512,
} as const;

export function taskBudgetTier(input: string): TaskBudgetTier {
	const token = input.toLowerCase();
	if (!Object.hasOwn(TASK_TOKEN_TIERS, token)) throw new Error("GATEWAY_BUDGET_TIER_INVALID");
	return token as TaskBudgetTier;
}

export interface TaskBudgetSettings {
	tier: TaskBudgetTier;
	maxRequests: number;
	timeoutMs: number;
	maxTotalCostUsd: number;
	maxOutputTokensPerRequest: number;
}
