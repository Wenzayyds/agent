import { describe, expect, it } from "vitest";
import {
	budgetExceeded,
	buildEvaluationPlan,
	classifyExecution,
	executionOutcome,
	parseAgentEvents,
	preflightView,
	redactEvaluationText,
	summarizeUsage,
} from "../../benchmarks/real-agent/evaluation-policy.ts";

const valid = {
	runId: "pilot_20261102",
	provider: "fixture",
	model: "fixture-v1",
	apiKeyEnv: "PI_EVAL_API_KEY",
	maxTotalCostUsd: "1",
	maxTasks: "1",
	maxTokensPerTask: "10000",
	maxCallsPerTask: "4",
	timeoutMs: "60000",
	concurrency: "1",
	budgetEnforcement: "external_gateway",
	outputDir: "evaluation-output",
	sandboxImage: "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293",
};

describe("Batch F real model authorization and budget gate", () => {
	it("imports all Runner stages without starting tasks or reading a provider key", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-runner-import-"));
		try {
			const stages = [
				"run-real-agent.ts",
				"runner-preparation.ts",
				"runner-execution.ts",
				"runner-results.ts",
				"swe-results.ts",
			];
			const imports = stages
				.map(
					(name) =>
						`import ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../benchmarks/real-agent", name)).href)};`,
				)
				.join("\n");
			const child = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"-e",
					`${imports}\nconsole.log("STAGES_IMPORTED");`,
					"--",
					"--execute",
					"--comparison-profile",
					"batch-n-v1",
				],
				{
					cwd,
					windowsHide: true,
					timeout: 10_000,
					encoding: "utf8",
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						TEMP: cwd,
						TMP: cwd,
						HOME: cwd,
						USERPROFILE: cwd,
						PI_OFFLINE: "1",
					},
				},
			);
			expect(child.status, child.stderr).toBe(0);
			expect(child.stdout.trim()).toBe("STAGES_IMPORTED");
			expect(readdirSync(cwd)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("fails closed before reading or invoking a provider when any gate is missing", () => {
		for (const field of Object.keys(valid))
			expect(() =>
				buildEvaluationPlan(
					{ ...valid, [field]: undefined },
					{ PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED: "1", PI_EVAL_API_KEY: "fake" },
				),
			).toThrow(/EVAL_GATE_/u);
		expect(() => buildEvaluationPlan(valid, { PI_EVAL_API_KEY: "fake" })).toThrow("EVAL_GATE_UNAUTHORIZED");
		expect(() => buildEvaluationPlan(valid, { PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_EVAL_API_KEY: "fake" })).toThrow(
			"EVAL_GATE_BUDGET_NOT_ENFORCED",
		);
	});

	it("accepts only one concurrent task and bounded numeric limits", () => {
		const plan = buildEvaluationPlan(valid, {
			PI_ENHANCED_REAL_MODEL_EVAL: "1",
			PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED: "1",
			PI_EVAL_API_KEY: "fake",
		});
		expect(plan).toMatchObject({ maxTasks: 1, concurrency: 1, maxCallsPerTask: 4 });
		expect(() =>
			buildEvaluationPlan(
				{ ...valid, concurrency: "2" },
				{ PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED: "1", PI_EVAL_API_KEY: "fake" },
			),
		).toThrow("EVAL_GATE_INVALID:concurrency");
		expect(() =>
			buildEvaluationPlan(
				{ ...valid, sandboxImage: "node:latest" },
				{ PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED: "1", PI_EVAL_API_KEY: "fake" },
			),
		).toThrow("EVAL_GATE_INVALID:sandboxImage");
		const local = buildEvaluationPlan(
			{ ...valid, provider: "deepseek", model: "deepseek-flash", budgetEnforcement: "local_hard_gateway" },
			{ PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_EVAL_API_KEY: "fake" },
		);
		expect(local.budgetEnforcement).toBe("local_hard_gateway");
		expect(() =>
			buildEvaluationPlan(
				{ ...valid, provider: "other", budgetEnforcement: "local_hard_gateway" },
				{ PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_EVAL_API_KEY: "fake" },
			),
		).toThrow("EVAL_GATE_LOCAL_GATEWAY_MODEL_UNSUPPORTED");
	});

	it("preflight never reads a key and logs redact secrets and usage", () => {
		expect(JSON.stringify(preflightView(valid, 5))).not.toContain("fake-secret");
		expect(redactEvaluationText("token=fake-secret sk-example-123456789", ["fake-secret"])).not.toContain(
			"fake-secret",
		);
		const message = { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5, cost: { total: 0.02 } } };
		const events = [
			{ type: "message_update", message },
			{ type: "message_end", message },
			{ type: "turn_end", message },
			{ type: "agent_end", messages: [message] },
			{ type: "message_end", message: { ...message, stopReason: "error" } },
		];
		expect(summarizeUsage(events.map((event) => JSON.stringify(event)).join("\n"))).toEqual({
			calls: 1,
			tokens: 15,
			costUsd: 0.02,
		});
		const parsed = parseAgentEvents(
			`not json\nnull\n42\n${events.map((event) => JSON.stringify(event)).join("\r\n")}\n`,
		);
		expect(parsed).toEqual(events);
		expect(summarizeUsage(parsed)).toEqual(summarizeUsage(events.map((event) => JSON.stringify(event)).join("\n")));
		expect(summarizeUsage("not json\n{}")).toEqual({ calls: 0, tokens: 0, costUsd: null });
	});

	it("stops on calls, tokens, or cost and classifies timeout and process errors separately", () => {
		const limits = { maxCallsPerTask: 2, maxTokensPerTask: 100, maxTotalCostUsd: 1 };
		expect(budgetExceeded({ calls: 3, tokens: 1 }, 0, limits)).toBe(true);
		expect(budgetExceeded({ calls: 1, tokens: 101 }, 0, limits)).toBe(true);
		expect(budgetExceeded({ calls: 1, tokens: 1 }, 1.01, limits)).toBe(true);
		expect(classifyExecution({ overBudget: false, timedOut: true, exitCode: null, verifierPassed: false })).toBe(
			"timeout",
		);
		expect(classifyExecution({ overBudget: false, timedOut: false, exitCode: 2, verifierPassed: false })).toBe(
			"agent_error",
		);
		expect(classifyExecution({ overBudget: false, timedOut: false, exitCode: 0, verifierPassed: true })).toBe(
			"passed",
		);
		expect(
			executionOutcome({
				overBudget: false,
				budgetRejected: true,
				timedOut: false,
				exitCode: 0,
				verifierPassed: true,
			}),
		).toEqual({ patchStatus: "passed", runStatus: "budget_stopped" });
		expect(
			executionOutcome({
				overBudget: false,
				budgetRejected: true,
				gatewayFailed: true,
				timedOut: false,
				exitCode: 0,
				verifierPassed: false,
			}),
		).toEqual({ patchStatus: "failed", runStatus: "gateway_error" });
		expect(
			executionOutcome({
				overBudget: false,
				budgetRejected: false,
				timedOut: true,
				exitCode: null,
				verifierPassed: true,
			}),
		).toEqual({ patchStatus: "passed", runStatus: "timeout" });
		expect(
			executionOutcome({
				overBudget: false,
				budgetRejected: false,
				timedOut: false,
				exitCode: 0,
				verifierPassed: false,
			}),
		).toEqual({ patchStatus: "failed", runStatus: "completed" });
	});
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
