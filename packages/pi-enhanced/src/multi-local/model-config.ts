import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BudgetGatewayModel,
	type BudgetGatewayPricing,
	isBudgetGatewayModel,
	isBudgetGatewayUpstreamAllowed,
} from "../../benchmarks/real-agent/budget-gateway.ts";
import { ENHANCED_CONFIG_FILE } from "../shared/config.ts";
import type { AgentRole } from "./protocol.ts";

export type RoleModelOverrides = Partial<Record<AgentRole, BudgetGatewayModel>>;

export interface RoleModelSelection {
	upstreamBaseUrl: string;
	strict: boolean;
	code: BudgetGatewayModel;
	test: BudgetGatewayModel;
}

function readModel(value: unknown): BudgetGatewayModel {
	if (!isBudgetGatewayModel(value)) throw new Error("MA1_MODEL_CONFIG_INVALID");
	const { modelId, contextWindow, maxOutputTokens, supportsTools, pricing } = value;
	return {
		modelId,
		contextWindow,
		maxOutputTokens,
		supportsTools,
		pricing: {
			inputUsdPerMillion: pricing.inputUsdPerMillion,
			outputUsdPerMillion: pricing.outputUsdPerMillion,
		},
	};
}

export function loadRoleModelOverrides(agentDir: string): RoleModelOverrides | undefined {
	let raw: string;
	try {
		raw = readFileSync(join(agentDir, ENHANCED_CONFIG_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const multiAgent: unknown = JSON.parse(raw)?.multiAgent;
	if (multiAgent === undefined) return;
	if (
		!multiAgent ||
		typeof multiAgent !== "object" ||
		Array.isArray(multiAgent) ||
		Object.keys(multiAgent).some((key) => key !== "code" && key !== "test")
	)
		throw new Error("MA1_MODEL_CONFIG_INVALID");
	const { code, test } = multiAgent as Record<string, unknown>;
	return {
		...(code === undefined ? {} : { code: readModel(code) }),
		...(test === undefined ? {} : { test: readModel(test) }),
	};
}

export function selectRoleModels(
	provider: { baseUrl: string; modelId: string; pricing: BudgetGatewayPricing },
	overrides?: RoleModelOverrides,
): RoleModelSelection {
	const fallback = {
		modelId: provider.modelId,
		pricing: provider.pricing,
		contextWindow: 128_000,
		maxOutputTokens: 128_000,
		supportsTools: true as const,
	};
	return restoreRoleModels(
		{
			upstreamBaseUrl: provider.baseUrl,
			strict: !!(overrides?.code || overrides?.test),
			code: overrides?.code ?? fallback,
			test: overrides?.test ?? fallback,
		},
		provider.baseUrl,
	);
}

export function restoreRoleModels(selection: RoleModelSelection, upstreamBaseUrl: string): RoleModelSelection {
	if (!isBudgetGatewayUpstreamAllowed(upstreamBaseUrl)) throw new Error("GATEWAY_UPSTREAM_NOT_ALLOWED");
	if (!selection || selection.upstreamBaseUrl !== upstreamBaseUrl) throw new Error("MA1_MODEL_ENDPOINT_CHANGED");
	const code = readModel(selection.code);
	const test = readModel(selection.test);
	const same = JSON.stringify(code) === JSON.stringify(test);
	if (typeof selection.strict !== "boolean" || ((!selection.strict || code.modelId === test.modelId) && !same))
		throw new Error("MA1_MODEL_CONFIG_CONFLICT");
	return { upstreamBaseUrl, strict: selection.strict, code, test };
}
