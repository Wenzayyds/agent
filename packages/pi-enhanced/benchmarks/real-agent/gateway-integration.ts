import type { BudgetGatewayStatus } from "./budget-gateway.ts";

export function gatewayModelsConfig(gatewayUrl: string): Record<string, unknown> {
	if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(gatewayUrl)) throw new Error("GATEWAY_URL_INVALID");
	return {
		providers: {
			deepseek: {
				baseUrl: gatewayUrl,
				apiKey: "$PI_ENHANCED_GATEWAY_TOKEN",
			},
		},
	};
}

export function isolatedAgentEnvironment(
	parent: NodeJS.ProcessEnv,
	input: {
		providerApiKeyEnv: string;
		gatewayToken: string;
		agentDir: string;
		tempDir: string;
		evaluation: Record<string, string>;
	},
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		PATH: parent.PATH,
		SystemRoot: parent.SystemRoot,
		TEMP: input.tempDir,
		TMP: input.tempDir,
		HOME: input.agentDir,
		USERPROFILE: input.agentDir,
		PI_CODING_AGENT_DIR: input.agentDir,
		PI_OFFLINE: "1",
		PI_ENHANCED_GATEWAY_TOKEN: input.gatewayToken,
		...input.evaluation,
		PI_ENHANCED_SANDBOX_RUN_ROOT: input.tempDir,
	};
	delete environment[input.providerApiKeyEnv];
	delete environment.DEEPSEEK_API_KEY;
	delete environment.OPENAI_API_KEY;
	delete environment.ANTHROPIC_API_KEY;
	return environment;
}

export function gatewayEvidence(status: BudgetGatewayStatus): Record<string, unknown> {
	return {
		state: status.state,
		requestsStarted: status.requestsStarted,
		requestsCompleted: status.requestsCompleted,
		requestsRejected: status.requestsRejected,
		requestAttempts: status.requestAttempts,
		actualInputTokens: status.actualInputTokens,
		actualOutputTokens: status.actualOutputTokens,
		actualTotalTokens: status.actualTotalTokens,
		actualCostUsd: status.actualCostUsd,
		committedTokenUpperBound: status.committedTokenUpperBound,
		committedCostUpperBoundUsd: status.committedCostUpperBoundUsd,
		lastError: status.lastError,
		denials: status.denials,
	};
}
