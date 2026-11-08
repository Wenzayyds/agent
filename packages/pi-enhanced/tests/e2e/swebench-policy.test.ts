import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";
import { SWE_TASK_LIMITS, SWE_TASK_PROFILE } from "../../benchmarks/real-agent/swe-profile.ts";
import { loadSweTask, swePrompt } from "../../benchmarks/real-agent/swebench.ts";
import { close, dockerImageAvailable, startStubProvider, textSse, toolCallSse } from "../fixtures/runner-support.ts";

const root = resolve(import.meta.dirname, "../../../..");
const mirror = process.env.PI_ENHANCED_SWE_LOCAL_MIRROR;
const available = Boolean(mirror) && dockerImageAvailable();
const cases = [
	...["off", "v1", "v2"].flatMap((mode) => [
		["edit_test", mode],
		["write_test", mode],
	]),
	["budget", "off"],
	["export_failure", "off"],
	["abnormal_session", "off"],
];

it.skipIf(!available).each(cases)(
	"SWE production policy %s in %s",
	async (scenario, mode) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-swe-policy-"));
		const task = loadSweTask("astropy__astropy-13033", mirror!);
		const sourcePath = "astropy/__init__.py",
			testPath = "astropy/timeseries/tests/test_sampled.py";
		const source = execFileSync("git", ["-C", task.mirror, "show", `${task.issue.base_commit}:${sourcePath}`], {
			encoding: "utf8",
		});
		const old = source.split(/\r?\n/u).find((line) => line.trim().length >= 16 && source.split(line).length === 2)!;
		const batch = scenario === "budget" || scenario === "export_failure";
		const id = `swe_task_${scenario}_${mode}`;
		let calls = 0,
			runnerPid: number | undefined;
		const provider = await startStubProvider((body, response) => {
			calls++;
			if (calls === 1) {
				const message = (body.messages as Array<{ role: string; content: unknown }>).find(
					(m) => m.role === "user",
				)?.content;
				const text = Array.isArray(message) ? message.map((part) => part.text).join("") : message;
				expect(text).toBe(swePrompt(task.issue.problem_statement));
			}
			let sse: string;
			if (scenario === "budget") sse = toolCallSse("read", { path: "astropy/units/quantity.py" }, 100 + calls, 10);
			else if (scenario === "export_failure")
				sse =
					calls === 1
						? toolCallSse(
								"edit",
								{
									path: sourcePath,
									edits: [
										{ oldText: old, newText: `${old}\npassword = "fixture-secret-not-for-diagnostics"` },
									],
								},
								100,
								10,
							)
						: textSse("Stub done", 100, 10);
			else if (calls === 1) sse = toolCallSse("read", { path: testPath, limit: 5 }, 100, 10);
			else if (scenario === "abnormal_session") {
				// Kill the actual Pi child, leaving the production Runner alive to collect interrupted evidence.
				const listing =
					process.platform === "win32"
						? execFileSync(
								"powershell.exe",
								[
									"-NoProfile",
									"-NonInteractive",
									"-Command",
									`Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${runnerPid}' | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
								],
								{ encoding: "utf8" },
							)
						: execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(runnerPid)], { encoding: "utf8" });
				let pid: number;
				if (process.platform === "win32") {
					const parsed = JSON.parse(listing);
					const children = Array.isArray(parsed) ? parsed : [parsed];
					const pi = children.filter((c) => /[\\/]dist[\\/]bundle[\\/]cli\.js/u.test(c.CommandLine));
					expect(pi).toHaveLength(1);
					pid = pi[0].ProcessId;
				} else {
					const pi = listing.split("\n").filter((line) => /[\\/]dist[\\/]bundle[\\/]cli\.js/u.test(line));
					expect(pi).toHaveLength(1);
					pid = Number(pi[0]!.trim().split(/\s+/u)[0]);
				}
				process.kill(pid, "SIGKILL");
				sse = textSse("Stub final after forced interruption", 100, 10);
			} else
				sse = toolCallSse(
					scenario === "edit_test" ? "edit" : "write",
					scenario === "edit_test"
						? { path: testPath, edits: [{ oldText: "irrelevant", newText: "must not execute" }] }
						: { path: testPath, content: "must not execute" },
					100,
					10,
				);
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(sse);
		});
		try {
			const args = [
				"--experimental-strip-types",
				join(root, `packages/pi-enhanced/benchmarks/real-agent/${batch ? "run-controlled" : "run-real-agent"}.ts`),
				"--execute",
				"--swebench-id",
				task.issue.instance_id,
				"--swebench-mirror",
				task.mirror,
				"--local-stub-url",
				provider.url,
				"--output-dir",
				directory,
				...(batch
					? ["--comparison-profile", SWE_TASK_PROFILE, "--batch-id", id]
					: [
							"--run-id",
							id,
							"--task-mode",
							mode!,
							"--provider",
							"deepseek",
							"--model",
							"deepseek-flash",
							"--api-key-env",
							"MOCK_PROVIDER_KEY",
							"--max-total-cost-usd",
							"0.03",
							"--max-tasks",
							"1",
							"--max-tokens-per-task",
							"80000",
							"--max-calls-per-task",
							"12",
							"--timeout-ms",
							"180000",
							"--concurrency",
							"1",
							"--budget-enforcement",
							"local_hard_gateway",
							"--sandbox-image",
							CONTROLLED_IMAGE,
						]),
			];
			const child = spawn(process.execPath, args, {
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
			});
			runnerPid = child.pid;
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const code = await new Promise<number | null>((done, reject) => {
				child.once("error", reject);
				child.once("close", done);
			});
			expect(code, stderr).toBe(0);
			const resultDir = join(directory, id, ...(batch ? [`${id}_off`] : []), "swebench");
			const result = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8"));
			if (process.env.PI_ENHANCED_SWE_STUB_EVIDENCE)
				writeFileSync(
					join(process.env.PI_ENHANCED_SWE_STUB_EVIDENCE, `policy-${scenario}-${mode}.json`),
					JSON.stringify({ scenario, mode, calls, result }, null, 2),
				);
			expect(result.officialHarnessStatus).toBe("not_run");
			expect(result.resolved).toBeNull();
			expect(existsSync(join(resultDir, "predictions.jsonl"))).toBe(false);
			expect(result.sandboxAudit.integrity).toBe("valid");
			if (batch) {
				const state = JSON.parse(readFileSync(join(directory, id, "batch.json"), "utf8"));
				expect(state.cells.map((cell: { resultStatus: string }) => cell.resultStatus)).toEqual(
					scenario === "budget" ? ["stopped", "stopped", "stopped"] : ["stopped", "not_run", "not_run"],
				);
				expect(state.stoppedReason).toBe(scenario === "budget" ? null : "SWE_PATCH_UNSAFE");
				if (scenario === "budget")
					expect(state.cells.every((cell: { continuationReady: boolean }) => cell.continuationReady)).toBe(true);
			}
			if (scenario === "budget") {
				expect(result.gateway.requestsStarted).toBeLessThan(20);
				expect(result.terminationClassification).toBe("gateway_budget_stop");
				expect(result.runStatus).toBe("budget_stopped");
				expect(result.agentCompleted).toBe(false);
				const denial = result.gatewayRejections.at(-1);
				expect(denial).toMatchObject({ code: "GATEWAY_TOKEN_BUDGET", upstreamForwarded: false });
				const d = denial.reservationDiagnostics;
				expect(d.inputTokenUpperBound).toBe(d.requestBodyBytes + 4096);
				expect(d.candidateReservedTokens).toBe(d.inputTokenUpperBound + d.outputTokenLimit);
				expect(d.candidateReservedTokens).toBeGreaterThan(d.remainingTokenHeadroom);
				expect(result.telemetry.requests.at(-1)).toMatchObject({
					totalTokens: null,
					upstreamForwarded: false,
					reservationDiagnostics: d,
				});
			} else if (scenario === "export_failure") {
				expect(calls).toBe(2);
				expect(result.agentCompleted).toBe(true);
				expect(result.auditComplete).toBe(true);
				expect(result.runStatus).toBe("completed");
				expect(result.terminationClassification).toBe("completed");
				expect(result.patchExportError).toBe("SWE_PATCH_UNSAFE");
				expect(result.patchDiagnostic).toMatchObject({
					status: "rejected",
					contentSaved: false,
					candidatePatchSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
				});
				expect(JSON.stringify(result.patchDiagnostic)).not.toContain("fixture-secret-not-for-diagnostics");
			} else if (scenario === "abnormal_session") {
				expect(calls).toBe(2);
				expect(result.agentCompleted).toBe(false);
				expect(result.auditComplete).toBe(false);
				expect(result.terminationClassification).toBe("agent_execution_error");
				expect(result.sandboxAudit.audit.length).toBeGreaterThan(0);
			} else {
				expect(calls).toBe(2);
				expect(result.agentCompleted).toBe(false);
				expect(result.toolFailures).toHaveLength(1);
				expect(JSON.stringify(result.toolFailures)).toContain("SWE_WRITE_PATH_DENIED");
				expect(result.sandboxAudit.audit.every((entry: { toolName: string }) => entry.toolName === "read")).toBe(
					true,
				);
				expect(result.patchDiagnostic.paths).toEqual([]);
			}
		} finally {
			await close(provider.server);
			rmSync(directory, { recursive: true, force: true });
		}
	},
	90000,
);

it
	.skipIf(!available)
	.each([
		"no_patch",
		"requests",
		"cost",
		"timeout",
		"usage_failure",
		"container_failure",
		"audit_corrupt",
		"batch_cap",
	])(
	"SWE independent continuation %s",
	async (scenario) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-swe-continue-"));
		const id = `swe_task_continue_${scenario}`;
		const limits: { -readonly [K in keyof typeof SWE_TASK_LIMITS]: number } = { ...SWE_TASK_LIMITS };
		if (scenario === "requests") limits.maxRequests = 1;
		if (scenario === "cost") limits.maxCostUsd = 0.01;
		if (scenario === "timeout") limits.timeoutMs = 6000;
		if (scenario === "batch_cap") limits.maxBatchCostUsd = limits.maxCostUsd;
		const { maxRuns: _, ...overrides } = limits;
		const limitsFile = join(directory, "stub-limits.json");
		writeFileSync(limitsFile, JSON.stringify(overrides));
		let calls = 0;
		let controlledPid: number | undefined;
		const modes: string[] = [];
		const provider = await startStubProvider((body, response) => {
			calls++;
			const tools = (body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
			const mode = tools.includes("enhanced_task_plan_update")
				? "v2"
				: tools.includes("enhanced_task_get")
					? "v1"
					: "off";
			const previous = (body.messages as Array<{ role: string }>).filter(
				(message) => message.role === "tool",
			).length;
			if (!previous) modes.push(mode);
			const containers = execFileSync(
				"docker",
				["ps", "--filter", `name=pi-enhanced-tools-${id}_${mode}-`, "--format", "{{.ID}}"],
				{ encoding: "utf8", timeout: 10000 },
			).trim();
			if (scenario === "container_failure")
				execFileSync("docker", ["rm", "-f", containers], { stdio: "ignore", timeout: 10000 });
			if (scenario === "audit_corrupt") {
				const info = JSON.parse(
					execFileSync("docker", ["inspect", containers], { encoding: "utf8", timeout: 10000 }),
				)[0];
				const workspace = info.Mounts[0].Source as string;
				// Docker Desktop exposes host paths under /run/desktop/mnt/host; use the Windows original.
				const hostPath =
					process.platform === "win32"
						? workspace.replace(
								/^\/run\/desktop\/mnt\/host\/([a-z])\//u,
								(_m, drive: string) => `${drive.toUpperCase()}:/`,
							)
						: workspace;
				const auditPath = join(dirname(hostPath), "swebench-sandbox-audit.json");
				rmSync(auditPath);
				mkdirSync(auditPath); // Force atomic journal writes and reads to fail, without faking a result object.
			}
			let sse =
				scenario === "requests" ||
				scenario === "cost" ||
				scenario === "timeout" ||
				scenario === "container_failure" ||
				scenario === "audit_corrupt"
					? toolCallSse(
							"read",
							{ path: scenario === "cost" ? "astropy/units/quantity.py" : "astropy/__init__.py" },
							100 + calls,
							10,
						)
					: textSse("No patch produced; Stub transport only.", 100, 10);
			if (scenario === "usage_failure") sse = sse.replace(/"usage":\{[^}]+\}/u, '"usage":{}');
			if (scenario === "timeout" && !previous)
				response.once("finish", () => {
					// Suspend the actual Pi process after its provider response has settled. The production
					// Runner's unchanged deadline must terminate it and prove cleanup, without an active API call.
					if (process.platform === "win32")
						execFileSync(
							"powershell.exe",
							[
								"-NoProfile",
								"-NonInteractive",
								"-Command",
								`
Add-Type 'using System; using System.Runtime.InteropServices; public class PiSuspend { [DllImport("kernel32.dll")] public static extern IntPtr OpenThread(uint a, bool b, uint c); [DllImport("kernel32.dll")] public static extern uint SuspendThread(IntPtr h); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); }';
$runner = Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${controlledPid}' | Where-Object { $_.CommandLine -match 'run-real-agent.ts' };
$pi = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($runner.ProcessId)" | Where-Object { $_.CommandLine -match 'dist[\\\\/]bundle[\\\\/]cli.js' });
if ($pi.Count -ne 1) { throw 'Pi fixture child identity mismatch' };
(Get-Process -Id $pi[0].ProcessId).Threads | ForEach-Object { $h = [PiSuspend]::OpenThread(2, $false, $_.Id); if ($h -eq [IntPtr]::Zero) { throw 'Pi fixture thread inaccessible' }; [void][PiSuspend]::SuspendThread($h); [void][PiSuspend]::CloseHandle($h) };
`,
							],
							{ stdio: "pipe", timeout: 10000, windowsHide: true },
						);
					else {
						const runners = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(controlledPid)], {
							encoding: "utf8",
						})
							.split("\n")
							.filter((line) => line.includes("run-real-agent.ts"));
						expect(runners).toHaveLength(1);
						const children = execFileSync(
							"ps",
							["-o", "pid=,args=", "--ppid", runners[0]!.trim().split(/\s+/u)[0]!],
							{ encoding: "utf8" },
						)
							.split("\n")
							.filter((line) => /dist\/bundle\/cli\.js/u.test(line));
						expect(children).toHaveLength(1);
						process.kill(Number(children[0]!.trim().split(/\s+/u)[0]), "SIGSTOP");
					}
				});
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(sse);
		});
		const run = () =>
			new Promise<{ code: number | null; stderr: string }>((done, reject) => {
				const child = spawn(
					process.execPath,
					[
						"--experimental-strip-types",
						join(root, "packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts"),
						"--execute",
						"--comparison-profile",
						SWE_TASK_PROFILE,
						"--swebench-id",
						"astropy__astropy-13033",
						"--swebench-mirror",
						mirror!,
						"--batch-id",
						id,
						"--output-dir",
						directory,
						"--local-stub-url",
						provider.url,
						"--swe-stub-limits",
						limitsFile,
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
				controlledPid = child.pid;
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				child.once("error", reject);
				child.once("close", (code) => done({ code, stderr }));
			});
		try {
			const child = await run();
			expect(child.code, child.stderr).toBe(0);
			const batch = JSON.parse(readFileSync(join(directory, id, "batch.json"), "utf8"));
			if (process.env.PI_ENHANCED_SWE_STUB_EVIDENCE)
				writeFileSync(
					join(process.env.PI_ENHANCED_SWE_STUB_EVIDENCE, `continuation-${scenario}.json`),
					JSON.stringify({ calls, modes, batch }, null, 2),
				);
			const ordinary = ["no_patch", "requests", "cost", "timeout"].includes(scenario);
			expect(batch.stoppedReason, JSON.stringify(batch.cells)).toBe(
				ordinary
					? null
					: scenario === "batch_cap"
						? "batch_budget_reservation"
						: scenario === "audit_corrupt"
							? "swe_host_cleanup_unconfirmed"
							: "swe_gateway_settlement_unconfirmed",
			);
			expect(modes).toEqual(ordinary ? ["off", "v1", "v2"] : ["off"]);
			for (const cell of batch.cells) {
				if (cell.status === "not_run") {
					expect(cell.notRunReason).toBe(batch.stoppedReason);
					continue;
				}
				if (scenario === "audit_corrupt") expect(cell.result.auditStatus.integrity).toBe("invalid_or_missing");
				expect(cell.result.officialHarnessStatus).toBe("not_run");
				expect(cell.result.resolved).toBeNull();
				if (ordinary) {
					expect(cell.continuationReady).toBe(true);
					const dir = join(directory, id, `${id}_${cell.id}`);
					expect(JSON.parse(readFileSync(join(dir, "host-cleanup.json"), "utf8"))).toMatchObject({
						childClosed: true,
						childAbsent: true,
						containersRemoved: true,
						privateRootRemoved: true,
						gatewayActiveRequests: 0,
					});
					expect(existsSync(join(dir, "swebench/predictions.jsonl"))).toBe(false);
					if (scenario === "requests" || scenario === "cost")
						expect(cell.result.gatewayRejections.at(-1).code).toBe(
							scenario === "requests" ? "GATEWAY_REQUEST_LIMIT" : "GATEWAY_COST_BUDGET",
						);
					if (scenario === "timeout") expect(cell.result.runStatus).toBe("timeout");
				}
			}
			const prior = calls;
			expect((await run()).code).not.toBe(0);
			expect(calls).toBe(prior); // Exclusive batch directory prevents retry, including resource-stopped cells.
		} finally {
			await close(provider.server);
			rmSync(directory, { recursive: true, force: true });
		}
	},
	120000,
);
