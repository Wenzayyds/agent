import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertIsolatedMount,
	close,
	dockerImageAvailable,
	type StubHandler,
	startStubProvider,
	textSse,
	toolCallSse,
} from "../fixtures/runner-support.ts";

const image = "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293";
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const runner = join(repositoryRoot, "packages", "pi-enhanced", "benchmarks", "real-agent", "run-real-agent.ts");
const cli = join(repositoryRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const dockerAvailable = dockerImageAvailable(image);
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.allSettled(servers.splice(0).map((server) => close(server)));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable || !existsSync(cli))("Batch I production real-agent runner", () => {
	it("uses the production fixture path through stub provider, gateway, Pi CLI, Docker, patch, and hidden verifier", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi enhanced runner 中文 "));
		roots.push(root);
		const output = join(root, "output");
		const sentinel = join(root, "outside-sentinel.txt");
		writeFileSync(sentinel, "unchanged", "utf8");
		const before = sha256(sentinel);
		const providerBodies: Array<Record<string, unknown>> = [];
		const provider = await startProvider((body, response) => {
			providerBodies.push(body);
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			switch (providerBodies.length) {
				case 1:
					response.end(toolCallSse("read", { path: "../outside-sentinel.txt" }, 100, 10));
					break;
				case 2:
					response.end(toolCallSse("read", { path: "math.js" }, 120, 10));
					break;
				case 3:
					response.end(
						toolCallSse(
							"edit",
							{
								path: "math.js",
								edits: [{ oldText: "n * (n - 1) / 2", newText: "n * (n + 1) / 2" }],
							},
							160,
							20,
						),
					);
					break;
				default:
					response.end(textSse("fixed", 180, 10));
			}
		});

		const result = await runRunner(provider.url, output);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(readFileSync(join(output, "batch_i_stub_runner", "run.json"), "utf8")) as {
			evaluationClass: string;
			authorization: string;
			summary: { passed: number; observedCostUsd: number };
			results: Array<{
				status: string;
				verifierPassed: boolean;
				patchSha256: string;
				gateway: { requestsStarted: number; denials: unknown[] };
				sandboxAudit: {
					evidence: { network: string; readOnlyRoot: boolean; mounts: unknown[] };
					audit: Array<{ toolName: string; status: string }>;
				};
			}>;
		};
		const task = report.results[0]!;
		expect(report).toMatchObject({
			evaluationClass: "simulated_provider_real_runner_task",
			authorization: "local_stub_only",
			summary: { passed: 1 },
		});
		expect(task).toMatchObject({
			status: "passed",
			verifierPassed: true,
			patchStatus: "passed",
			runStatus: "completed",
			agentReportedUsage: { calls: 4, tokens: 610 },
			usageSource: "local_hard_gateway",
		});
		expect(task.patchSha256).not.toBe(createHash("sha256").update("").digest("hex"));
		expect(task.gateway).toMatchObject({ requestsStarted: 4, denials: [] });
		assertIsolatedMount(task.sandboxAudit.evidence, true);
		expect(
			new Set(task.sandboxAudit.audit.filter((item) => item.status === "ok").map((item) => item.toolName)),
		).toEqual(new Set(["read", "edit"]));
		expect(
			readFileSync(join(output, "batch_i_stub_runner", "single-file-off-by-one", "patch.diff"), "utf8"),
		).toContain("n * (n + 1) / 2");
		expect(sha256(sentinel)).toBe(before);
		expect(providerBodies).toHaveLength(4);
		expect(result.stderr).not.toContain("SANDBOX_WORKSPACE_NOT_TEMPORARY");
		const duplicate = await runRunner(provider.url, output);
		expect(duplicate.status).not.toBe(0);
		expect(duplicate.stderr).toContain("EVAL_GATE_RUN_ID_ALREADY_EXISTS");
		expect(providerBodies).toHaveLength(4);
		const containers = spawnSync(
			"docker",
			["ps", "-a", "--filter", "name=pi-enhanced-tools-batch_i_stub_runner-", "--format", "{{.ID}}"],
			{
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		expect(containers.status, containers.stderr).toBe(0);
		expect(containers.stdout.trim()).toBe("");
		const evidencePath = process.env.PI_ENHANCED_BATCH_I_EVIDENCE_PATH;
		if (evidencePath) {
			writeFileSync(
				evidencePath,
				`${JSON.stringify(
					{
						schemaVersion: 1,
						generatedAt: "2026-11-03",
						status: "passed",
						evaluationClass: report.evaluationClass,
						providerTurns: providerBodies.length,
						patchSha256: task.patchSha256,
						patchValid: true,
						testPassed: task.verifierPassed,
						gateway: task.gateway,
						sandbox: task.sandboxAudit,
						externalSentinel: { beforeSha256: before, afterSha256: sha256(sentinel), unchanged: true },
						containerResidue: 0,
					},
					null,
					2,
				)}\n`,
			);
		}
	}, 120_000);

	it.each([
		{
			task: "single-file-off-by-one" as const,
			file: "math.js",
			initial: "n * (n - 1) / 2",
			firstEdit: "n * n",
			secondEdit: "n * (n + 1) / 2",
			initialFeedback: { stderr: expect.stringContaining("AssertionError") },
			failedRetest: { stderr: expect.stringContaining("9 !== 6") },
			passingRetest: { stdout: "PASS" },
		},
		{
			task: "config-default" as const,
			file: "config.js",
			initial: "input.timeoutMs || 1000",
			firstEdit: "5000",
			secondEdit: "input.timeoutMs ?? 5000",
			initialFeedback: {
				stdout: "PASS loadConfig({timeoutMs:7}).timeoutMs: 7",
				stderr: "FAIL loadConfig({}).timeoutMs: expected 5000, got 1000",
			},
			failedRetest: {
				stdout: "PASS loadConfig({}).timeoutMs: 5000",
				stderr: "FAIL loadConfig({timeoutMs:7}).timeoutMs: expected 7, got 5000",
			},
			passingRetest: {
				stdout: "PASS loadConfig({}).timeoutMs: 5000\nPASS loadConfig({timeoutMs:7}).timeoutMs: 7",
			},
		},
	])("delivers Docker test failure and passing retest to the next provider requests for $task", async (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-single-file-feedback-"));
		roots.push(root);
		let turns = 0;
		const provider = await startProvider((body, response) => {
			turns++;
			expect((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort())
				.toEqual(["edit", "find", "grep", "ls", "read", "run_tests", "write"]);
			const messages = body.messages as Array<{ role: string; content?: string; tool_call_id?: string; tool_calls?: { id: string }[] }>;
			expect(Buffer.byteLength(JSON.stringify(body.tools))).toBeLessThan(4_000);
			const historyCalls = messages.flatMap((message) => message.tool_calls ?? []);
			const historyResults = messages.filter((message) => message.role === "tool");
			expect(historyCalls).toHaveLength(turns - 1);
			expect(historyResults.map((message) => message.tool_call_id)).toEqual(historyCalls.map((call) => call.id));
			const last = messages.at(-1);
			function feedback(exitCode: number, output: { stdout?: string; stderr?: unknown }) {
				expect(last?.role).toBe("tool");
				expect(last?.tool_call_id).toBe(messages.at(-2)?.tool_calls?.[0]?.id);
				expect(last?.content).not.toContain("node:internal");
				expect(JSON.parse(last?.content ?? "")).toMatchObject({
					exitCode,
					status: exitCode === 0 ? "passed" : "verification_failed",
					...output,
				});
			}
			const edit = (oldText: string, newText: string) =>
				toolCallSse("edit", { path: scenario.file, edits: [{ oldText, newText }] }, 200 + turns, 20);
			let sse: string;
			switch (turns) {
				case 1:
					sse = toolCallSse("run_tests", {}, 201, 20);
					break;
				case 2:
					feedback(1, scenario.initialFeedback);
					sse = edit(scenario.initial, scenario.firstEdit);
					break;
				case 3:
					sse = toolCallSse("run_tests", {}, 203, 20);
					break;
				case 4:
					feedback(1, scenario.failedRetest);
					sse = edit(scenario.firstEdit, scenario.secondEdit);
					break;
				case 5:
					sse = toolCallSse("run_tests", {}, 205, 20);
					break;
				case 6:
					feedback(0, scenario.passingRetest);
					expect(JSON.parse(last?.content ?? "")).toEqual({ status: "passed", exitCode: 0, ...scenario.passingRetest });
					sse = textSse("Verified", 206, 20);
					break;
				default:
					throw new Error("Unexpected extra request");
			}
			response.writeHead(200, { "Content-Type": "text/event-stream" }).end(sse);
		});
		const runId = "approved_feedback_stub";
		const result = await runRunner(provider.url, root, image, runId, false, scenario.task);
		expect(result.status, result.stderr).toBe(0);
		expect(turns).toBe(6);
		const report = JSON.parse(readFileSync(join(root, runId, "run.json"), "utf8"));
		expect(report.results[0]).toMatchObject({
			status: "passed",
			verifierPassed: true,
			gateway: { requestsStarted: 6, requestsCompleted: 6, requestsRejected: 0 },
			verification: { status: "passed", cleanup: "removed", evidence: { network: "none", readOnlyRoot: true } },
		});
	}, 120_000);

	it.each(["reduced", "provider_error", "timeout"] as const)(
		"settles a config-default retest with %s",
		async (scenario) => {
			const root = mkdtempSync(join(tmpdir(), "pi-enhanced-config-budget-"));
			roots.push(root);
			let calls = 0;
			let cap: number | undefined;
			let feedback: Record<string, unknown> | undefined;
			const provider = await startProvider((body, response) => {
				calls++;
				if (calls === 3) {
					cap = Number(body.max_tokens);
					const messages = body.messages as Array<{ content?: string; role: string; tool_call_id?: string }>;
					const last = messages.at(-1);
					if (last?.role === "tool" && last.tool_call_id === "call-run_tests-" + retestInput)
						feedback = JSON.parse(last.content ?? "null");
					if (scenario === "timeout") return;
					if (scenario === "provider_error") {
						response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"stub provider unavailable"}');
						return;
					}
					response.writeHead(200, { "Content-Type": "text/event-stream" }).end(textSse("Verified", 120, 20));
					return;
				}
				if (calls > 3) {
					response.writeHead(500).end();
					return;
				}
				if (calls === 2 && scenario === "reduced") {
					const targetHeadroom = Buffer.byteLength(JSON.stringify(body)) + 4096 + 1050;
					retestInput = 20_000 - targetHeadroom - 2500 - 40;
				}
				const reply = calls === 1
					? toolCallSse("edit", {
						path: "config.js",
						edits: [{ oldText: "input.timeoutMs || 1000", newText: "input.timeoutMs ?? 5000" }],
					}, 2500, 20)
					: toolCallSse("run_tests", {}, retestInput, 20);
				response.writeHead(200, { "Content-Type": "text/event-stream" }).end(reply);
			});
			let retestInput = 800;
			const runId = `config_default_budget_${scenario}`;
			const result = await runRunner(provider.url, root, image, runId, false, "config-default", scenario === "timeout" ? 12_000 : 60_000);
			expect(result.status, result.stderr).toBe(0);
			const report = JSON.parse(readFileSync(join(root, runId, "run.json"), "utf8"));
			const task = report.results[0];
			expect(calls).toBe(3);
			expect(feedback).toEqual({
				status: "passed", exitCode: 0,
				stdout: "PASS loadConfig({}).timeoutMs: 5000\nPASS loadConfig({timeoutMs:7}).timeoutMs: 7",
			});
			expect(task).toMatchObject({
				verifierPassed: true, patchStatus: "passed", auditComplete: true,
				sandboxAudit: { state: "completed", pending: [] },
				hostLifecycle: { childClosed: true, containersRemoved: true, gatewayClosed: true, gatewayActiveRequests: 0 },
			});
			if (scenario === "reduced") {
				expect(cap).toBeGreaterThanOrEqual(256);
				expect(cap).toBeLessThan(2048);
				expect(task).toMatchObject({ status: "passed", runStatus: "completed", agentTermination: "normal" });
				expect(task.gateway.requestOutcomes[2]).toMatchObject({
					reservationDiagnostics: { outputTokenLimit: cap, outputLimitReduced: true },
					settlement: { committedTokens: 140, releasedTokens: expect.any(Number) },
				});
			} else {
				expect(report.summary.passed).toBe(0);
				expect(task).toMatchObject(scenario === "timeout"
					? { status: "timeout", runStatus: "timeout", agentTermination: "abnormal", gateway: { lastError: "GATEWAY_RUN_TIMEOUT" } }
					: { status: "agent_error", runStatus: "gateway_error", agentTermination: "abnormal", gateway: { lastError: "GATEWAY_UPSTREAM_HTTP_503" } });
			}
		},
		120_000,
	);

	it("finishes the file audit when the token budget blocks the request after a passing retest", async () => {
		const configured = process.env.PI_ENHANCED_V3_TEST_OUTPUT;
		const root = configured ? join(configured, "terminal") : mkdtempSync(join(tmpdir(), "pi-enhanced-budget-feedback-"));
		if (configured) mkdirSync(root, { recursive: true });
		else roots.push(root);
		let calls = 0;
		const provider = await startProvider((_body, response) => {
			calls++;
			const reply = calls === 1 ? toolCallSse("run_tests", {}, 3500, 20) : calls === 2
				? toolCallSse("edit", {
					path: "config.js",
					edits: [{ oldText: "input.timeoutMs || 1000", newText: "input.timeoutMs ?? 5000" }],
				}, 4700, 20)
				: toolCallSse("run_tests", {}, 5200, 20);
			response.writeHead(200, { "Content-Type": "text/event-stream" }).end(reply);
		});
		const runId = "config_default_budget_feedback";
		const result = await runRunner(provider.url, root, image, runId, false, "config-default", 60_000,
			["--v3-evaluation", "--variant", "task-only"]);
		expect(result.status, result.stderr).toBe(0);
		expect(calls).toBe(3);
		const report = JSON.parse(readFileSync(join(root, runId, "run.json"), "utf8"));
		expect(report.summary).toMatchObject({ passed: 0, patchPassed: 1, normallyCompleted: 0, budgetStopped: 1 });
		const task = report.results[0];
		expect(task).toMatchObject({
			status: "budget_exceeded",
			runStatus: "budget_stopped",
			terminationClassification: "gateway_budget_stop",
			agentTermination: "abnormal",
			timedOut: false,
			verifierPassed: true,
			taskTermination: { status: "budget_exhausted", checkpoint: { observation: { budgetTermination: {
				code: "GATEWAY_TOKEN_BUDGET", requestsStarted: 3, auditComplete: true, verifierPassed: true,
			} } } },
			gateway: {
				requestAttempts: 4,
				requestsStarted: 3,
				requestsCompleted: 3,
				requestsRejected: 1,
				denials: [{ code: "GATEWAY_TOKEN_BUDGET", requestSequence: 4, upstreamForwarded: false }],
			},
		});
		expect(task.toolTrace).toEqual([
			expect.objectContaining({ phase: "start", toolName: "run_tests" }),
			expect.objectContaining({ phase: "end", toolName: "run_tests", result: expect.objectContaining({
				details: expect.objectContaining({ status: "verification_failed", exitCode: 1 }),
			}) }),
			expect.objectContaining({ phase: "start", toolName: "edit" }),
			expect.objectContaining({ phase: "end", toolName: "edit", isError: false }),
			expect.objectContaining({ phase: "start", toolName: "run_tests" }),
			expect.objectContaining({
				phase: "end", toolName: "run_tests", isError: false,
				result: expect.objectContaining({ details: expect.objectContaining({ status: "passed", exitCode: 0 }) }),
			}),
		]);
		expect(task.auditComplete).toBe(true);
		expect(task.sandboxAudit).toMatchObject({ state: "completed", integrity: "valid", pending: [] });
		expect(task.sandboxAudit.audit).toEqual([
			expect.objectContaining({ toolName: "edit", operation: "access", status: "ok" }),
			expect.objectContaining({ toolName: "edit", operation: "read_file", status: "ok" }),
			expect.objectContaining({ toolName: "edit", operation: "write_file", status: "ok" }),
		]);
		const containers = spawnSync("docker", ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"], { encoding: "utf8" });
		expect(containers.status).toBe(0);
		expect(containers.stdout.split(/\r?\n/u)).not.toContain(task.sandboxAudit.evidence.containerId);
	}, 120_000);

	it("pauses after a real failing test and resumes in a second Runner without resetting budget or replaying the first test", async () => {
		const configured = process.env.PI_ENHANCED_V3_TEST_OUTPUT;
		const root = configured ? join(configured, "recovery") : mkdtempSync(join(tmpdir(), "pi-v3-runner-resume-"));
		if (configured) mkdirSync(root, { recursive: true });
		else roots.push(root);
		const runId = "config_v3_recovery";
		const bodies: Record<string, unknown>[] = [];
		const provider = await startProvider((body, response) => {
			bodies.push(body);
			const turns = [
				toolCallSse("run_tests", {}, 100, 20),
				textSse("Observed failing default check. Waiting at the explicit test boundary.", 160, 20),
				toolCallSse("edit", { path: "config.js", edits: [{ oldText: "input.timeoutMs || 1000", newText: "input.timeoutMs ?? 5000" }] }, 200, 20),
				toolCallSse("run_tests", {}, 240, 20),
				textSse("Both tests passed.", 270, 20),
			];
			response.writeHead(200, { "Content-Type": "text/event-stream" }).end(turns[bodies.length - 1] ?? textSse("unexpected", 300, 20));
		});
		const runPhase = (phase: string) => runRunner(provider.url, root, image, runId, false, "config-default", 90_000,
			["--v3-evaluation", "--variant", "task-only", "--v3-stub-recovery", phase]);
		const paused = await runPhase("pause");
		expect(paused.status, paused.stderr).toBe(0);
		const checkpoint = JSON.parse(paused.stdout);
		expect(checkpoint).toMatchObject({ state: "paused", requests: 2, inputTokens: 260, outputTokens: 40 });
		const resumed = await runPhase("resume");
		expect(resumed.status, resumed.stderr).toBe(0);
		const final = JSON.parse(readFileSync(join(root, runId, "run.json"), "utf8")).results[0];
		expect(final).toMatchObject({
			verifierPassed: true, runStatus: "completed", budgetDeadlineAt: checkpoint.budgetDeadlineAt,
			gateway: { requestsStarted: 5, requestsCompleted: 5, actualInputTokens: 970, actualOutputTokens: 100 },
			resumedTask: { task: { status: "completed" }, steps: [
				{ stepId: "reproduce", status: "completed", revision: 4 },
				{ stepId: "repair", status: "completed" },
			] },
		});
		expect(final.usage.costUsd).toBeGreaterThan(checkpoint.estimatedCostUsd);
		expect(bodies).toHaveLength(5);
		expect(JSON.stringify(bodies[2].messages)).toContain("failed");
		expect(final.toolTrace.filter((event: { phase: string; toolName: string }) =>
			event.phase === "start" && event.toolName === "run_tests")).toHaveLength(1);
		expect((await runPhase("resume")).status).not.toBe(0);
		expect(bodies).toHaveLength(5);
	}, 120_000);

	it("measures the same large-output fixture with each V3 module configuration", async () => {
		const configured = process.env.PI_ENHANCED_V3_TEST_OUTPUT;
		const root = configured ? join(configured, "ablation") : mkdtempSync(join(tmpdir(), "pi-v3-ablation-"));
		if (configured) mkdirSync(root, { recursive: true });
		else roots.push(root);
		const reportSizes = new Map<string, number>();
		let turn = 0;
		let variant = "";
		const provider = await startProvider((body, response) => {
			turn++;
			if (turn === 2) reportSizes.set(variant, Buffer.byteLength(JSON.stringify(body.messages)));
			const reply = turn === 1 ? toolCallSse("read", { path: "diagnostics.txt" }, 100, 20) :
				turn === 2 ? toolCallSse("edit", { path: "validate.js", edits: [{ oldText: "items.slice(0, 10).every", newText: "items.every" }] }, 200, 20) :
				textSse("Validation repair done.", 300, 20);
			response.writeHead(200, { "Content-Type": "text/event-stream" }).end(reply);
		});
		for (const group of ["baseline", "context-only", "memory-only", "task-only", "full"]) {
			variant = group;
			turn = 0;
			const result = await runRunner(provider.url, root, image, "v3_eval_" + group, false, undefined, 60_000,
				["--v3-evaluation", "--variant", group, "--task-id", "controlled-long-report", "--condition", "memory_seeded"]);
			expect(result.status, result.stderr).toBe(0);
			const task = JSON.parse(readFileSync(join(root, "v3_eval_" + group, "run.json"), "utf8")).results[0];
			expect(task).toMatchObject({ verifierPassed: true, v3Evaluation: { mode: "stub", agentCompleted: true, model: { requests: 3 } } });
			expect(turn).toBe(3);
		}
		expect(reportSizes.get("context-only")).toBeLessThan(reportSizes.get("baseline")!);
		expect(reportSizes.get("full")).toBeLessThan(reportSizes.get("task-only")!);
	}, 120_000);

	it("fails the Docker preflight before the local provider receives a request", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-runner-preflight-"));
		roots.push(root);
		let providerCalls = 0;
		const provider = await startProvider((_body, response) => {
			providerCalls += 1;
			response.writeHead(500).end();
		});
		const result = await runRunner(
			provider.url,
			join(root, "output"),
			`sha256:${"0".repeat(64)}`,
			"batch_i_preflight_failure",
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("SANDBOX_EXECUTION_FAILED");
		expect(providerCalls).toBe(0);
	}, 60_000);

	it.each(["early-exit", "isolated-attack"])(
		"keeps %s patch execution inside the production verifier container",
		async (scenario) => {
			const root = mkdtempSync(join(tmpdir(), "pi-verifier-runner-"));
			roots.push(root);
			const sentinel = join(root, "host-sentinel.txt");
			writeFileSync(sentinel, "unchanged");
			const source =
				scenario === "early-exit"
					? "process.exit(0);export const sumTo=()=>0;"
					: `import fs from 'node:fs';let safe=!process.env.MOCK_PROVIDER_KEY;try{fs.writeFileSync(${JSON.stringify(sentinel)},'escaped');safe=false}catch{}try{fs.writeFileSync('/workspace/unwanted.txt','escaped');safe=false}catch{}export const sumTo=n=>safe?n*(n+1)/2:0;`;
			let turns = 0;
			const provider = await startProvider((_body, response) => {
				turns++;
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.end(
					turns === 1
						? toolCallSse("write", { path: "math.js", content: source }, 100, 10)
						: textSse("done", 120, 10),
				);
			});
			const output = join(root, "output");
			const runId = `verifier_${scenario.replaceAll("-", "_")}`;
			const execution = await runRunner(provider.url, output, image, runId);
			expect(execution.status, execution.stderr).toBe(0);
			expect(turns).toBe(2);
			const record = JSON.parse(readFileSync(join(output, runId, "run.json"), "utf8")).results[0];
			expect(record).toMatchObject({
				runStatus: "completed",
				verification: {
					mode: "docker-readonly",
					cleanup: "removed",
					evidence: {
						network: "none",
						readOnlyRoot: true,
						mounts: [{ destination: "/workspace", readWrite: false }],
					},
				},
				gateway: { state: "ready", requestsStarted: 2, requestsCompleted: 2 },
			});
			if (scenario === "early-exit")
				expect(record).toMatchObject({
					patchStatus: "failed",
					terminationClassification: "sandbox_runtime_error",
					verification: { status: "protocol_error", exitCode: 0, passed: false },
				});
			else
				expect(record).toMatchObject({
					patchStatus: "passed",
					terminationClassification: "completed",
					verification: { passed: true },
				});
			expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
			if (process.env.PI_ENHANCED_VERIFIER_RUNNER_EVIDENCE_DIR)
				writeFileSync(
					join(process.env.PI_ENHANCED_VERIFIER_RUNNER_EVIDENCE_DIR, `${scenario}.json`),
					JSON.stringify(record, null, 2),
				);
		},
		90_000,
	);

	it.each([
		["reaches verified Memory and read-only Task tools through the production pilot", "legacy"],
		["reaches verified Memory and read-only Task tools through the V3 production pilot", "v3"],
	])("%s", async (_title, variant) => {
		const configured = variant === "v3" ? process.env.PI_ENHANCED_V3_TEST_OUTPUT : undefined;
		const root = configured ? join(configured, "memory") : mkdtempSync(join(tmpdir(), "pi-module-pilot-"));
		if (configured) mkdirSync(root, { recursive: true });
		else roots.push(root);
		let turns = 0;
		const provider = await startProvider((body, response) => {
			turns += 1;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			const finish = (sse: string) => {
				response.write(sse);
				setTimeout(() => response.end(), 200);
			};
			if (turns === 1) {
				expect(JSON.stringify(body.messages)).toContain("已验证的历史记忆数据");
				finish(toolCallSse("enhanced_memory_search", { query: "修复 normalizeKey 保留 API", limit: 2 }, 100, 10));
			} else if (turns === 2) {
				const taskId = JSON.stringify(body.messages).match(
					/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u,
				)?.[0];
				expect(taskId).toBeDefined();
				finish(toolCallSse("enhanced_task_get", { taskId }, 100, 10));
			} else if (turns === 3)
				finish(
					toolCallSse(
						"edit",
						{ path: "key.js", edits: [{ oldText: "value.trim()", newText: "value.trim().toLowerCase()" }] },
						100,
						10,
					),
				);
			else finish(textSse("fixed", 100, 10));
		});
		const output = join(root, "output");
		const result = await runRunner(provider.url, output, image, "module_pilot_stub", true, undefined, 60_000,
			variant === "v3" ? ["--v3-evaluation"] : []);

		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(readFileSync(join(output, "module_pilot_stub", "run.json"), "utf8"));
		expect(report.results[0]).toMatchObject({ patchStatus: "passed", runStatus: "completed", contextEnabled: true });
		expect(report.results[0].moduleToolEvents).toHaveLength(2);
		for (const event of report.results[0].moduleToolEvents) expect(event.isError).not.toBe(true);
		expect(report.results[0].moduleToolEvents[0].result.details).toMatchObject({
			count: 1,
			searchStrategy: "code-identifier",
		});
		expect(report.results[0].moduleToolCalls[0].args.query).toBe("修复 normalizeKey 保留 API");
		expect(
			report.results[0].contextAudit.diagnostics.some(
				(entry: { injectedMemoryIds: string[] }) => entry.injectedMemoryIds.length > 0,
			),
		).toBe(true);
		expect(
			report.results[0].contextAudit.diagnostics.every(
				(entry: { taskState: string }) => entry.taskState === "skipped",
			),
		).toBe(true);
		expect(report.results[0].memorySeed.verifiedHits).toBe(1);
		expect(
			report.results[0].gateway.requestOutcomes.every(
				(entry: { outcome: string }) => entry.outcome === "completed_done",
			),
		).toBe(true);
		expect(JSON.stringify(report.results[0].moduleToolEvents)).toContain("normalizeKey");
		if (variant === "legacy" && process.env.PI_ENHANCED_OFFLINE_REPRO_EVIDENCE_PATH)
			writeFileSync(process.env.PI_ENHANCED_OFFLINE_REPRO_EVIDENCE_PATH, JSON.stringify(report, null, 2));
	}, 120_000);
});

const startProvider = (handler: StubHandler) => startStubProvider(handler, servers);

function runRunner(
	providerUrl: string,
	output: string,
	sandboxImage = image,
	runId = "batch_i_stub_runner",
	readonlyModules = false,
	feedbackTask?: "single-file-off-by-one" | "config-default",
	timeoutMs = 60_000,
	extraArgs: string[] = [],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const v3 = extraArgs.includes("--v3-evaluation");
	const args = [
		"--experimental-strip-types",
		runner,
		"--execute",
		"--local-stub-url",
		providerUrl,
		"--run-id",
		runId,
		"--provider",
		"deepseek",
		"--model",
		"deepseek-flash",
		"--api-key-env",
		"MOCK_PROVIDER_KEY",
		"--max-total-cost-usd",
		feedbackTask || v3 ? "0.03" : "0.10",
		"--max-tasks",
		"1",
		"--max-tokens-per-task",
		feedbackTask ? "20000" : v3 ? "40000" : "200000",
		"--max-calls-per-task",
		"8",
		"--timeout-ms",
		String(timeoutMs),
		"--concurrency",
		"1",
		"--budget-enforcement",
		"local_hard_gateway",
		"--output-dir",
		output,
		"--sandbox-image",
		sandboxImage,
		...(feedbackTask
			? ["--task-id", feedbackTask, feedbackTask === "config-default" ? "--config-default-test-feedback" : "--single-file-test-feedback"]
			: []),
		...(readonlyModules
			? [
					"--readonly-module-tools",
					"--variant",
					"full",
					"--condition",
					"memory_seeded",
					"--task-id",
					"memory-guided-regression",
				]
			: []),
		...extraArgs,
	];
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, args, {
			cwd: repositoryRoot,
			env: {
				...process.env,
				PI_ENHANCED_REAL_MODEL_EVAL: "1",
				PI_ENHANCED_LOCAL_STUB_EVAL: "1",
				MOCK_PROVIDER_KEY: "mock-upstream-key",
			},
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("close", (status) =>
			resolveRun({
				status,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		);
	});
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
