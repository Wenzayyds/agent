import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_PAIR_INSTRUCTIONS } from "../../benchmarks/real-agent/batch-l-profile.ts";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";
import { SWE_TASK_CONFIGURATION, SWE_TASK_PROFILE } from "../../benchmarks/real-agent/swe-profile.ts";
import { loadSweTask } from "../../benchmarks/real-agent/swebench.ts";
import { readSweModeInputs, type TaskPairInput } from "../../benchmarks/real-agent/task-pair-authorization.ts";
import { assertIsolatedMount, close, startStubProvider, textSse, toolCallSse } from "../fixtures/runner-support.ts";

const root = resolve(import.meta.dirname, "../../../..");
const docker =
	spawnSync("docker", ["image", "inspect", CONTROLLED_IMAGE], { stdio: "ignore", timeout: 10000 }).status === 0;
it.skipIf(!docker || !process.env.PI_ENHANCED_SWE_LOCAL_MIRROR)(
	"runs the SWE three-mode batch through production admission and stops before a mismatched upstream request",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-swe-batch-"));
		const task = loadSweTask(SWE_TASK_CONFIGURATION.instanceId, process.env.PI_ENHANCED_SWE_LOCAL_MIRROR!);
		const path = "astropy/__init__.py";
		const source = execFileSync("git", ["-C", task.mirror, "show", `${task.issue.base_commit}:${path}`], {
			encoding: "utf8",
		});
		const old = source.split(/\r?\n/u).find((line) => line.trim().length >= 16 && source.split(line).length === 2)!;
		let calls = 0;
		const provider = await startStubProvider((body, response) => {
			calls++;
			const tools = (body.messages as Array<{ role: string }>).filter((message) => message.role === "tool");
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				tools.length
					? textSse("Stub done.", 100, 10)
					: toolCallSse(
							"edit",
							{ path, edits: [{ oldText: old, newText: `${old}\n# Stub transport only.` }] },
							100,
							10,
						),
			);
		});
		try {
			const run = async (id: string, expected?: string) => {
				const child = spawn(
					process.execPath,
					[
						"--experimental-strip-types",
						join(root, "packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts"),
						"--execute",
						"--comparison-profile",
						SWE_TASK_PROFILE,
						"--swebench-id",
						task.issue.instance_id,
						"--swebench-mirror",
						task.mirror,
						"--batch-id",
						id,
						"--output-dir",
						dir,
						"--local-stub-url",
						provider.url,
						...(expected ? ["--task-pair-expected-input", expected] : []),
					],
					{
						cwd: root,
						windowsHide: true,
						stdio: ["ignore", "ignore", "pipe"],
						env: {
							PATH: process.env.PATH,
							SystemRoot: process.env.SystemRoot,
							TEMP: process.env.TEMP,
							TMP: process.env.TMP,
							HOME: process.env.HOME,
							USERPROFILE: process.env.USERPROFILE,
							PI_ENHANCED_REAL_MODEL_EVAL: "1",
							PI_ENHANCED_LOCAL_STUB_EVAL: "1",
							MOCK_PROVIDER_KEY: "mock-upstream-key",
						},
					},
				);
				let stderr = "";
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				const code = await new Promise<number | null>((done, reject) => {
					child.once("error", reject);
					child.once("close", done);
				});
				expect(code, stderr).toBe(0);
				return JSON.parse(readFileSync(join(dir, id, "batch.json"), "utf8"));
			};
			const captureId = "swe_task_capture";
			const capture = await run(captureId);
			expect(capture.stoppedReason).toBeNull();
			expect(capture.cells.map((cell: { id: string }) => cell.id)).toEqual(["off", "v1", "v2"]);
			const inputs = readSweModeInputs(
				Object.fromEntries(
					["off", "v1", "v2"].map((mode) => [
						mode,
						JSON.parse(
							readFileSync(
								join(dir, captureId, `${captureId}_${mode}`, "swebench/input-admission.json"),
								"utf8",
							),
						).input,
					]),
				),
			);
			expect(new Set(Object.values(inputs).map((input) => input.toolSchemaSha256)).size).toBe(3);
			const expected = join(dir, "expected.json");
			writeFileSync(expected, JSON.stringify(inputs));
			const matched = await run("swe_task_matched", expected);
			expect(matched.stoppedReason).toBeNull();
			expect(calls).toBe(12);
			for (const batch of [capture, matched])
				for (const cell of batch.cells) {
					expect(cell.resultStatus).toBe("run");
					expect(cell.result).toMatchObject({
						status: "not_run",
						officialHarnessStatus: "not_run",
						resolved: null,
						agentCompleted: true,
						auditComplete: true,
						patchExportStatus: "exported",
						terminationClassification: "completed",
					});
					const resultDir = join(dir, batch.batchId, `${batch.batchId}_${cell.id}`, "swebench");
					expect(readFileSync(join(resultDir, "agent.stdout.jsonl"), "utf8")).toContain("Stub done.");
					expect(readFileSync(join(resultDir, "patch.diff"), "utf8")).toContain("Stub transport only");
				}
			const mismatched: Record<string, TaskPairInput> = {
				...inputs,
				v1: { ...inputs.v1, firstRequestSha256: "0".repeat(64) },
			};
			writeFileSync(expected, JSON.stringify(mismatched));
			const denied = await run("swe_task_mismatch", expected);
			expect(calls).toBe(14);
			expect(denied.stoppedReason).toBe("task_pair_input_admission_failed");
			expect(denied.cells.map((cell: { resultStatus: string }) => cell.resultStatus)).toEqual([
				"run",
				"stopped",
				"not_run",
			]);
			expect(
				JSON.parse(
					readFileSync(join(dir, "swe_task_mismatch/swe_task_mismatch_v1/swebench/input-admission.json"), "utf8"),
				),
			).toMatchObject({ status: "denied", upstreamForwarded: false, previouslyForwarded: 0 });
			if (process.env.PI_ENHANCED_BATCH_N_EVIDENCE)
				writeFileSync(
					join(process.env.PI_ENHANCED_BATCH_N_EVIDENCE, "swe-task-admission.json"),
					JSON.stringify({ capture, matched, denied, inputs, stubRequests: calls }, null, 2),
				);
		} finally {
			await close(provider.server);
			rmSync(dir, { recursive: true, force: true });
		}
	},
	180_000,
);
describe.skipIf(!docker)("Batch N production telemetry", () => {
	it.each(["complete", "request_limit", "strict_denial", "fingerprint_mismatch"])(
		"runs only the Task pair through the Stub (%s)",
		async (mode) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-task-pair-"));
			const initial: Array<{
				prompt: string;
				tools: unknown;
				model: unknown;
				thinking: unknown;
				outputCap: unknown;
			}> = [];
			let calls = 0;
			const provider = await startStubProvider((body, res) => {
				const messages = body.messages as Array<{ role: string; content: unknown }>;
				const toolResults = messages.filter((m) => m.role === "tool").length;
				if (!toolResults) {
					initial.push({
						prompt: JSON.stringify(messages.find((m) => m.role === "user")?.content),
						tools: body.tools,
						model: body.model,
						thinking: body.thinking,
						outputCap: body.max_tokens,
					});
				}
				calls++;
				const input = 100 + calls;
				const sse =
					mode === "request_limit"
						? toolCallSse("read", { path: "formatter.js" }, input, 10)
						: mode === "strict_denial"
							? toolCallSse("ls", { path: ".." }, input, 10)
							: toolResults === 0
								? toolCallSse("enhanced_task_get", { taskId: "current" }, input, 10)
								: toolResults === 1
									? toolCallSse("read", { path: "task-plan.json" }, input, 10)
									: toolResults === 2
										? toolCallSse(
												"edit",
												{
													path: "formatter.js",
													edits: [{ oldText: "const formatName", newText: "export const formatName" }],
												},
												input,
												10,
											)
										: textSse("fixed", input, 10);
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(sse);
			});
			try {
				const batchId = `task_pair_${mode}`;
				const expectedPath = join(dir, "expected.json");
				if (mode === "fingerprint_mismatch")
					writeFileSync(
						expectedPath,
						JSON.stringify({
							fixtureSha256: "0".repeat(64),
							fixtureCommit: "0".repeat(40),
							userPromptSha256: "0".repeat(64),
							systemPromptSha256: "0".repeat(64),
							toolSchemaSha256: "0".repeat(64),
							firstRequestSha256: "0".repeat(64),
						}),
					);
				const run = async (id: string, expected?: string) => {
					const child = spawn(
						process.execPath,
						[
							"--experimental-strip-types",
							join(root, "packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts"),
							"--execute",
							"--comparison-profile",
							"task-pair-v1",
							"--batch-id",
							id,
							"--output-dir",
							dir,
							"--local-stub-url",
							provider.url,
							...(expected ? ["--task-pair-expected-input", expected] : []),
						],
						{
							cwd: root,
							windowsHide: true,
							stdio: ["ignore", "ignore", "pipe"],
							env: {
								PATH: process.env.PATH,
								SystemRoot: process.env.SystemRoot,
								TEMP: process.env.TEMP,
								TMP: process.env.TMP,
								HOME: process.env.HOME,
								USERPROFILE: process.env.USERPROFILE,
								PI_ENHANCED_REAL_MODEL_EVAL: "1",
								PI_ENHANCED_LOCAL_STUB_EVAL: "1",
								MOCK_PROVIDER_KEY: "mock-upstream-key",
							},
						},
					);
					let stderr = "";
					child.stderr.on("data", (chunk) => {
						stderr += String(chunk);
					});
					const code = await new Promise<number | null>((done, reject) => {
						child.once("error", reject);
						child.once("close", done);
					});
					expect(code, stderr).toBe(0);
					return JSON.parse(readFileSync(join(dir, id, "batch.json"), "utf8"));
				};
				const report = await run(batchId, mode === "fingerprint_mismatch" ? expectedPath : undefined);
				const admission = (id: string, cell: string) =>
					JSON.parse(
						readFileSync(join(dir, id, `${id}_${cell}`, "cross-file-export", "input-admission.json"), "utf8"),
					);
				expect(report.evaluationClass).toBe("simulated_provider_real_runner_task");
				expect(report.cells.map(({ id }: { id: string }) => id)).toEqual(["t_inline", "t_task"]);
				const [off, on] = report.cells;
				const initialVerifications = report.cells
					.filter((cell: { resultStatus: string }) => cell.resultStatus !== "not_run")
					.map((cell: { id: string }) =>
						JSON.parse(
							readFileSync(
								join(dir, batchId, `${batchId}_${cell.id}`, "cross-file-export", "initial-verification.json"),
								"utf8",
							),
						),
					);
				for (const verification of initialVerifications) {
					expect(verification).toMatchObject({ status: "verification_failed", passed: false, cleanup: "removed" });
					assertIsolatedMount(verification.evidence, false);
				}
				if (mode === "complete") {
					expect(report.stoppedReason).toBeNull();
					expect(calls).toBe(8);
					expect(initial).toHaveLength(2);
					expect(initial[1]).toEqual(initial[0]);
					expect(initial[0]?.prompt.split(TASK_PAIR_INSTRUCTIONS)).toHaveLength(2);
					expect(initial[0]?.tools).toHaveLength(8);
					expect(initial[0]).toMatchObject({ model: "deepseek-flash", outputCap: 2048 });
					expect(off.result.fairness).toEqual(on.result.fairness);
					expect(off.result.fairness.inputAudit).toMatchObject({ thinking: "off", model: "deepseek-flash" });
					for (const cell of [off, on]) {
						expect(cell.result).toMatchObject({ evaluationAccepted: true, auditComplete: true });
						expect(cell.result.telemetry.complete).toBe(true);
						expect(cell.result.telemetry.requests).toHaveLength(4);
						assertIsolatedMount(cell.result.verification.evidence, false);
					}
					expect(off.result.telemetry.modules.task).toMatchObject({
						planReturned: false,
						before: "draft",
						after: "draft",
					});
					expect(on.result.telemetry.modules.task).toMatchObject({
						planReturned: true,
						before: "draft",
						after: "draft",
					});
					const offInput = admission(batchId, "t_inline").input;
					expect(admission(batchId, "t_task").input).toEqual(offInput);
					writeFileSync(expectedPath, JSON.stringify(offInput));
					const replayId = "task_pair_pin_match";
					const pinned = await run(replayId, expectedPath);
					expect(pinned.stoppedReason).toBeNull();
					expect(pinned.cells.map((c: { resultStatus: string }) => c.resultStatus)).toEqual(["passed", "passed"]);
					expect(admission(replayId, "t_inline")).toMatchObject({ status: "matched", input: offInput });
					expect(admission(replayId, "t_task")).toMatchObject({ status: "matched", input: offInput });
					expect(calls).toBe(16);
				} else {
					expect(on.resultStatus).toBe("not_run");
					if (mode === "request_limit") {
						expect(calls).toBe(12);
						expect(report.stoppedReason).toBe("gateway_budget_stop");
						expect(off.result.telemetry.requests.at(-1)).toMatchObject({
							requestSequence: 13,
							upstreamForwarded: false,
							totalTokens: null,
							outcome: "GATEWAY_REQUEST_LIMIT",
						});
					} else if (mode === "strict_denial") {
						expect(calls).toBe(1);
						expect(report.stoppedReason).toBe("isolation_boundary_stop");
					} else {
						expect(calls).toBe(0);
						expect(report.stoppedReason).toBe("task_pair_input_admission_failed");
						expect(admission(batchId, "t_inline")).toMatchObject({
							status: "denied",
							upstreamForwarded: false,
							previouslyForwarded: 0,
							reason: "TASK_PAIR_INPUT_FINGERPRINT_MISMATCH",
						});
					}
				}
				const evidenceDir = process.env.PI_ENHANCED_TASK_PAIR_STUB_EVIDENCE;
				if (evidenceDir)
					writeFileSync(
						join(evidenceDir, `stub-${mode}.json`),
						JSON.stringify(
							{
								evaluationClass: report.evaluationClass,
								commit: report.commit,
								limits: report.limits,
								stoppedReason: report.stoppedReason,
								stubCalls: calls,
								initialVerifications,
								admissions: report.cells
									.filter((c: { resultStatus: string }) => c.resultStatus !== "not_run")
									.map((c: { id: string }) => admission(batchId, c.id)),
								cells: report.cells.map(
									(cell: { id: string; resultStatus: string; result?: Record<string, unknown> }) => ({
										id: cell.id,
										status: cell.resultStatus,
										fairness: cell.result?.fairness,
										verification: cell.result?.verification,
										telemetry: cell.result?.telemetry,
										evaluationAccepted: cell.result?.evaluationAccepted,
									}),
								),
							},
							null,
							2,
						),
					);
			} finally {
				await close(provider.server);
				rmSync(dir, { recursive: true, force: true });
			}
		},
		150_000,
	);

	it("runs paired six-cell Stub with trusted tool correlation and identical patches when disabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-n-e2e-"));
		let calls = 0;
		let batchCalls = 0;
		let attack = false;
		let requestLimit = false;
		const server = createServer((req, res) => {
			void (async () => {
				const buffers: Buffer[] = [];
				for await (const b of req) buffers.push(Buffer.from(b));
				const body = JSON.parse(Buffer.concat(buffers).toString("utf8")) as {
					messages: Array<{ role: string; content: unknown }>;
				};
				calls++;
				batchCalls++;
				const user = JSON.stringify(body.messages.find((m) => m.role === "user")?.content);
				const memory = user.includes("normalizeKey"),
					task = user.includes("formatter.js");
				const results = body.messages.filter((m) => m.role === "tool");
				const tool = (name: string, args: Record<string, unknown>) => ({ name, args });
				let operations: Array<{ name: string; args: Record<string, unknown> }> = [];
				if (requestLimit) operations = [tool("read", { path: "key.js", offset: 1, limit: 10 })];
				else if (attack) operations = [tool("ls", { path: ".." })];
				else if (memory || task) {
					if (results.length === 0)
						operations = [
							tool(
								memory ? "enhanced_memory_search" : "enhanced_task_get",
								memory ? { query: "normalizeKey", limit: 3 } : { taskId: "current" },
							),
							tool("read", { path: memory ? "reference.md" : "task-plan.json", offset: 1, limit: 100 }),
						];
					else if (results.length === 2)
						operations = [tool("read", { path: memory ? "key.js" : "formatter.js", offset: 1, limit: 100 })];
					else if (results.length === 3)
						operations = [
							tool("edit", {
								path: memory ? "key.js" : "formatter.js",
								edits: [
									{
										oldText: memory ? "value.trim()" : "const formatName",
										newText: memory ? "value.trim().toLowerCase()" : "export const formatName",
									},
								],
							}),
						];
				} else {
					if (results.length === 0)
						operations = [tool("read", { path: "diagnostics.txt", offset: 1, limit: 200 })];
					else if (results.length === 1)
						operations = [
							tool("read", { path: "diagnostics.txt", offset: 201, limit: 100 }),
							tool("read", { path: "validate.js", offset: 1, limit: 10 }),
						];
					else if (results.length === 3)
						operations = [
							tool("edit", {
								path: "validate.js",
								edits: [{ oldText: "items.slice(0, 10).every", newText: "items.every" }],
							}),
						];
					else if (results.length === 4)
						operations = [tool("read", { path: "validate.js", offset: 1, limit: 10 })];
				}
				const delta = operations.length
					? {
							role: "assistant",
							tool_calls: operations.map((o, index) => ({
								index,
								id: `n-call-${calls}-${index}`,
								type: "function",
								function: { name: o.name, arguments: JSON.stringify(o.args) },
							})),
						}
					: { role: "assistant", content: "done" };
				const data = {
					id: `n-response-${calls}`,
					choices: [{ index: 0, delta, finish_reason: operations.length ? "tool_calls" : "stop" }],
				};
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(
					`data: ${JSON.stringify(data)}\n\ndata: ${JSON.stringify({ id: `n-response-${calls}`, choices: [], usage: { prompt_tokens: 100 + batchCalls, completion_tokens: 10 + batchCalls, total_tokens: 110 + 2 * batchCalls } })}\n\ndata: [DONE]\n\n`,
				);
			})().catch(() => res.writeHead(500).end());
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen");
		try {
			const reports: unknown[] = [];
			for (const enabled of [true, false, true, true]) {
				batchCalls = 0;
				attack = reports.length === 2;
				requestLimit = reports.length === 3;
				const batchId = requestLimit
					? "batch_n_request_limit"
					: attack
						? "batch_n_negative"
						: enabled
							? "batch_n_trace_on"
							: "batch_n_trace_off";
				const code = await new Promise<number | null>((done) => {
					const child = spawn(
						process.execPath,
						[
							"--experimental-strip-types",
							join(root, "packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts"),
							"--execute",
							"--comparison-profile",
							"batch-n-v1",
							"--batch-id",
							batchId,
							"--output-dir",
							dir,
							"--local-stub-url",
							`http://127.0.0.1:${address.port}`,
							...(enabled ? ["--evaluation-telemetry"] : []),
						],
						{
							cwd: root,
							env: {
								...process.env,
								PI_ENHANCED_REAL_MODEL_EVAL: "1",
								PI_ENHANCED_LOCAL_STUB_EVAL: "1",
								MOCK_PROVIDER_KEY: "stub-only",
							},
							windowsHide: true,
							stdio: ["ignore", "pipe", "pipe"],
						},
					);
					child.stdout.on("data", () => {});
					child.stderr.on("data", () => {});
					child.once("close", done);
				});
				expect(code).toBe(0);
				const report = JSON.parse(readFileSync(join(dir, batchId, "batch.json"), "utf8"));
				reports.push(report);
				if (process.env.PI_ENHANCED_BATCH_N_EVIDENCE)
					writeFileSync(
						join(process.env.PI_ENHANCED_BATCH_N_EVIDENCE, `${batchId}.json`),
						JSON.stringify(report, null, 2),
					);
				if (attack) {
					expect(report.stoppedReason).not.toBeNull();
					expect(batchCalls).toBe(1);
					expect(report.cells[0].result.gateway.requestsStarted).toBe(1);
					expect(report.cells.slice(1).every((c: { resultStatus: string }) => c.resultStatus === "not_run")).toBe(
						true,
					);
					continue;
				}
				if (requestLimit) {
					expect(report.stoppedReason).toBe("gateway_budget_stop");
					expect(batchCalls).toBe(8);
					expect(report.cells[0].result.telemetry.requests.at(-1)).toMatchObject({
						requestSequence: 9,
						upstreamForwarded: false,
						totalTokens: null,
						inputTokens: null,
						outputTokens: null,
						replyContentStatus: "not_generated",
						outcome: "GATEWAY_REQUEST_LIMIT",
					});
					expect(report.cells.slice(1).every((c: { resultStatus: string }) => c.resultStatus === "not_run")).toBe(
						true,
					);
					continue;
				}
				expect(report.stoppedReason).toBeNull();
				expect(report.cells.every((c: { resultStatus: string }) => c.resultStatus === "passed")).toBe(true);
				for (const cell of report.cells) {
					const r = cell.result;
					if (!enabled) {
						expect(r.telemetry).toBeUndefined();
						continue;
					}
					const t = r.telemetry;
					expect(r.evaluationAccepted).toBe(true);
					expect(t.complete).toBe(true);
					expect(
						t.requests.reduce((n: number, q: { totalTokens: number | null }) => n + (q.totalTokens ?? 0), 0),
					).toBe(r.gateway.actualTotalTokens);
					expect(t.tools.every((x: { requestSequence: number | null }) => x.requestSequence !== null)).toBe(true);
					expect(t.brokerLinks.length).toBeGreaterThan(0);
					expect(
						t.brokerLinks.every((x: { parentToolCallId: string | null }) => x.parentToolCallId !== null),
					).toBe(true);
					if (r.comparisonGroup === "memory_on")
						expect(t.modules.memory).toMatchObject({
							matched_seed: true,
							same_rule_file_accessed: true,
							patch_satisfies_rule: true,
						});
					if (r.comparisonGroup === "memory_off")
						expect(t.modules.memory).toMatchObject({ runtimeAvailable: false, matched_seed: false });
					if (r.comparisonGroup === "task_on")
						expect(t.modules.task).toMatchObject({
							planReturned: true,
							duplicatePlanSources: true,
							before: "draft",
							after: "draft",
						});
					if (r.comparisonGroup === "context_on") {
						expect(t.contextViews.some((v: { changed: unknown[] }) => v.changed.length > 0)).toBe(true);
						expect(
							t.tools.some(
								(x: { readClassification: string }) => x.readClassification === "nonoverlapping_pagination",
							),
						).toBe(true);
						expect(
							t.tools.some(
								(x: { readClassification: string }) => x.readClassification === "post_edit_verification_read",
							),
						).toBe(true);
					}
				}
			}
			const on = reports[0] as {
				cells: Array<{ result: { patchSha256: string; gateway: { actualTotalTokens: number } } }>;
			};
			const off = reports[1] as typeof on;
			expect(on.cells.map((c) => c.result.patchSha256)).toEqual(off.cells.map((c) => c.result.patchSha256));
			expect(on.cells.map((c) => c.result.gateway.actualTotalTokens)).toEqual(
				off.cells.map((c) => c.result.gateway.actualTotalTokens),
			);
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180000);
});
