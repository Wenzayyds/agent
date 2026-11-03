import { describe, expect, it } from "vitest";
import { budgetExceeded, buildEvaluationPlan, classifyExecution, preflightView, redactEvaluationText, summarizeUsage } from "../../benchmarks/real-agent/evaluation-policy.ts";

const valid = { runId: "pilot_20261102", provider: "fixture", model: "fixture-v1", apiKeyEnv: "PI_EVAL_API_KEY", maxTotalCostUsd: "1", maxTasks: "1", maxTokensPerTask: "10000", maxCallsPerTask: "4", timeoutMs: "60000", concurrency: "1", budgetEnforcement: "external_gateway", outputDir: "evaluation-output", sandboxImage: "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293" };

describe("Batch F real model authorization and budget gate", () => {
	it("fails closed before reading or invoking a provider when any gate is missing", () => {
		for (const field of Object.keys(valid)) expect(() => buildEvaluationPlan({ ...valid, [field]: undefined }, { PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED: "1", PI_EVAL_API_KEY: "fake" })).toThrow(/EVAL_GATE_/u);
		expect(() => buildEvaluationPlan(valid, { PI_EVAL_API_KEY: "fake" })).toThrow("EVAL_GATE_UNAUTHORIZED");
		expect(() => buildEvaluationPlan(valid, { PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_EVAL_API_KEY: "fake" })).toThrow("EVAL_GATE_BUDGET_NOT_ENFORCED");
	});

	it("accepts only one concurrent task and bounded numeric limits", () => {
		const plan = buildEvaluationPlan(valid, { PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED: "1", PI_EVAL_API_KEY: "fake" });
		expect(plan).toMatchObject({ maxTasks: 1, concurrency: 1, maxCallsPerTask: 4 });
		expect(() => buildEvaluationPlan({ ...valid, concurrency: "2" }, { PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED: "1", PI_EVAL_API_KEY: "fake" })).toThrow("EVAL_GATE_INVALID:concurrency");
		expect(() => buildEvaluationPlan({ ...valid, sandboxImage: "node:latest" }, { PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED: "1", PI_EVAL_API_KEY: "fake" })).toThrow("EVAL_GATE_INVALID:sandboxImage");
		const local = buildEvaluationPlan(
			{ ...valid, provider: "deepseek", model: "deepseek-flash", budgetEnforcement: "local_hard_gateway" },
			{ PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_EVAL_API_KEY: "fake" },
		);
		expect(local.budgetEnforcement).toBe("local_hard_gateway");
		expect(() => buildEvaluationPlan(
			{ ...valid, provider: "other", budgetEnforcement: "local_hard_gateway" },
			{ PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_EVAL_API_KEY: "fake" },
		)).toThrow("EVAL_GATE_LOCAL_GATEWAY_MODEL_UNSUPPORTED");
	});

	it("preflight never reads a key and logs redact secrets and usage", () => {
		expect(JSON.stringify(preflightView(valid, 5))).not.toContain("fake-secret");
		expect(redactEvaluationText("token=fake-secret sk-example-123456789", ["fake-secret"])).not.toContain("fake-secret");
		expect(summarizeUsage('{"usage":{"input":10,"output":5,"cost":{"total":0.02}}}\n')).toEqual({ calls: 1, tokens: 15, costUsd: 0.02 });
	});

	it("stops on calls, tokens, or cost and classifies timeout and process errors separately", () => {
		const limits = { maxCallsPerTask: 2, maxTokensPerTask: 100, maxTotalCostUsd: 1 };
		expect(budgetExceeded({ calls: 3, tokens: 1 }, 0, limits)).toBe(true);
		expect(budgetExceeded({ calls: 1, tokens: 101 }, 0, limits)).toBe(true);
		expect(budgetExceeded({ calls: 1, tokens: 1 }, 1.01, limits)).toBe(true);
		expect(classifyExecution({ overBudget: false, timedOut: true, exitCode: null, verifierPassed: false })).toBe("timeout");
		expect(classifyExecution({ overBudget: false, timedOut: false, exitCode: 2, verifierPassed: false })).toBe("agent_error");
		expect(classifyExecution({ overBudget: false, timedOut: false, exitCode: 0, verifierPassed: true })).toBe("passed");
	});
});
