import { describe, expect, it } from "vitest";
import { gatewayModelsConfig, isolatedAgentEnvironment } from "../../benchmarks/real-agent/gateway-integration.ts";

describe("Batch H gateway integration boundary", () => {
	it("overrides the built-in DeepSeek base URL and resolves only the gateway token", () => {
		expect(gatewayModelsConfig("http://127.0.0.1:43210")).toEqual({
			providers: { deepseek: { baseUrl: "http://127.0.0.1:43210", apiKey: "$PI_ENHANCED_GATEWAY_TOKEN" } },
		});
		expect(() => gatewayModelsConfig("https://api.deepseek.com")).toThrow("GATEWAY_URL_INVALID");
	});

	it("does not expose any real provider key to the Pi child", () => {
		const environment = isolatedAgentEnvironment(
			{ PATH: "bin", SystemRoot: "windows", DEEPSEEK_API_KEY: "real-secret", OPENAI_API_KEY: "other-secret" },
			{
				providerApiKeyEnv: "DEEPSEEK_API_KEY",
				gatewayToken: "one-time-token",
				agentDir: "agent",
				tempDir: "temp",
				evaluation: { PI_ENHANCED_EVAL_RUN_ID: "run" },
			},
		);
		expect(environment).toMatchObject({
			PI_OFFLINE: "1",
			PI_ENHANCED_GATEWAY_TOKEN: "one-time-token",
			PI_ENHANCED_EVAL_RUN_ID: "run",
		});
		expect(environment.DEEPSEEK_API_KEY).toBeUndefined();
		expect(environment.OPENAI_API_KEY).toBeUndefined();
	});
});
