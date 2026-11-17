import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";
import { digest } from "../../benchmarks/real-agent/evaluation-identity.ts";
import { SWE_FLASH_OFF_CONFIGURATION, SWE_FLASH_OFF_PROFILE } from "../../benchmarks/real-agent/swe-profile.ts";
import { loadSweTask, swePrompt } from "../../benchmarks/real-agent/swebench.ts";
import { readSweFlashOffInputs } from "../../benchmarks/real-agent/task-pair-authorization.ts";
import { close, dockerImageAvailable, startStubProvider, textSse, toolCallSse } from "../fixtures/runner-support.ts";

const mirror = process.env.PI_ENHANCED_SWE_LOCAL_MIRROR;
const root = resolve(import.meta.dirname, "../../../..");
const cases = [
	["astropy__astropy-13033", "off"],
	["astropy__astropy-13033", "v1"],
	["astropy__astropy-13033", "v2"],
	["astropy__astropy-13453", "off"],
	["astropy__astropy-14365", "v2"],
] as const;
const available = Boolean(mirror) && dockerImageAvailable();
const pairedInputs: Array<Record<string, unknown>> = [];

it.skipIf(!available)("runs all five Flash OFF instances with distinct admission, fixed budgets and clean shutdown", async () => {
	const evidence = process.env.PI_ENHANCED_SWE_FLASH_OFF_EVIDENCE;
	const dir = mkdtempSync(join(evidence ?? tmpdir(), "pi-swe-flash-off-"));
	const { instances } = SWE_FLASH_OFF_CONFIGURATION;
	const path = "astropy/__init__.py";
	const tasks = instances.map(({ instanceId }) => {
		const task = loadSweTask(instanceId, mirror!);
		const source = execFileSync("git", ["-C", task.mirror, "show", `${task.issue.base_commit}:${path}`], { encoding: "utf8" });
		const line = source.split(/\r?\n/u).find((item) => item.trim().length >= 16 && source.split(item).length === 2)!;
		return { instanceId, prompt: swePrompt(task.issue.problem_statement), line };
	});
	const calls: string[] = [];
	const provider = await startStubProvider((body, response) => {
		const messages = body.messages as Array<{ role: string; content: unknown }>;
		const user = messages.find((message) => message.role === "user")?.content;
		const prompt = Array.isArray(user) ? user.map((part) => part.text).join("") : user;
		const task = tasks.find((item) => item.prompt === prompt)!;
		expect(task).toBeDefined();
		calls.push(task.instanceId);
		expect(body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, max_tokens: 2048 });
		expect((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort())
			.toEqual(["edit", "find", "grep", "ls", "read", "write"]);
		const last = messages.findLast((message) => message.role === "tool");
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		if (last) {
			expect(JSON.stringify(last.content)).toContain("Successfully");
			response.end(textSse("Stub done.", 100, 10));
		} else {
			response.end(toolCallSse("edit", { path, edits: [{ oldText: task.line, newText: `${task.line}\n# Non-fix Flash OFF Stub for ${task.instanceId}.` }] }, 100, 10));
		}
	});
	const run = async (suffix: string, overrides: string[] = []) => {
		const id = `swe_flash_off_${suffix}`;
		const child = spawn(process.execPath, [
			"--experimental-strip-types", join(root, "packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts"),
			"--execute", "--comparison-profile", SWE_FLASH_OFF_PROFILE, "--swebench-mirror", mirror!,
			"--batch-id", id, "--output-dir", dir, "--local-stub-url", provider.url, ...overrides,
		], {
			cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
			env: {
				PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
				HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
				PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_LOCAL_STUB_EVAL: "1", MOCK_PROVIDER_KEY: "mock-upstream-key",
			},
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		const code = await new Promise<number | null>((done, reject) => {
			child.once("error", reject);
			child.once("close", done);
		});
		expect(code, stderr).toBe(0);
		return JSON.parse(readFileSync(join(dir, id, "batch.json"), "utf8"));
	};
	const resultDir = (suffix: string, cellId: string) => join(dir, `swe_flash_off_${suffix}`, `swe_flash_off_${suffix}_${cellId}`, "swebench");
	try {
		const capture = await run("capture");
		expect(capture).toMatchObject({ stoppedReason: null, reservedMaximumUsd: 0.4,
			limits: { maxCostUsd: 0.08, maxRuns: 5, maxBatchCostUsd: 0.4 },
			batchLimits: { maxRequests: 100, maxTokens: 1_000_000, maxCostUsd: 0.4 } });
		expect(calls).toEqual(instances.flatMap(({ instanceId }) => [instanceId, instanceId]));
		const inputs = readSweFlashOffInputs(Object.fromEntries(instances.map(({ instanceId, cellId, baseCommit }, index) => {
			const output = resultDir("capture", cellId);
			expect(capture.cells[index]).toMatchObject({ id: cellId, instanceId, continuationReady: true,
				result: { instanceId, repositoryCommit: baseCommit, taskMode: "off", patchExportStatus: "exported", resolved: null,
					configuration: { maxCostUsd: 0.08 }, gateway: { requestsStarted: 2, requestsCompleted: 2, requestsRejected: 0 } } });
			expect(JSON.parse(readFileSync(join(output, "predictions.jsonl"), "utf8"))).toMatchObject({
				instance_id: instanceId, model_patch: expect.stringContaining(`Non-fix Flash OFF Stub for ${instanceId}`),
			});
			return [instanceId, JSON.parse(readFileSync(join(output, "input-admission.json"), "utf8")).input];
		})));
		const expected = join(dir, "expected-inputs.json");
		writeFileSync(expected, JSON.stringify(inputs), { flag: "wx" });
		const lowerCap = join(dir, "lower-cap.json");
		const { maxRequests, maxTokens, maxCostUsd, timeoutMs } = SWE_FLASH_OFF_CONFIGURATION.limits;
		writeFileSync(lowerCap, JSON.stringify({ maxRequests, maxTokens, maxCostUsd, timeoutMs, maxBatchCostUsd: 0.39 }), { flag: "wx" });
		const limited = await run("limited", ["--task-pair-expected-input", expected, "--swe-stub-limits", lowerCap]);
		expect(limited).toMatchObject({ stoppedReason: "batch_budget_reservation", reservedMaximumUsd: 0.32 });
		expect(limited.cells[4]).toMatchObject({ status: "not_run", notRunReason: "batch_budget_reservation" });
		expect(calls.slice(10)).toEqual(instances.slice(0, 4).flatMap(({ instanceId }) => [instanceId, instanceId]));
		for (const { cellId } of instances.slice(0, 4)) {
			expect(JSON.parse(readFileSync(join(resultDir("limited", cellId), "input-admission.json"), "utf8")).status).toBe("matched");
		}

		const { cellId, instanceId } = instances[2]!;
		const mismatch = join(dir, "mismatched-inputs.json");
		writeFileSync(mismatch, JSON.stringify({ ...inputs, [instanceId]: { ...inputs[instanceId], firstRequestSha256: "0".repeat(64) } }), { flag: "wx" });
		const denied = await run("mismatch", ["--task-pair-expected-input", mismatch]);
		expect(denied.stoppedReason).toBe("task_pair_input_admission_failed");
		expect(denied.cells.map((cell: { status: string }) => cell.status)).toEqual(["run", "run", "execution_error", "not_run", "not_run"]);
		expect(calls.slice(18)).toEqual(instances.slice(0, 2).flatMap((item) => [item.instanceId, item.instanceId]));
		expect(JSON.parse(readFileSync(join(resultDir("mismatch", cellId), "input-admission.json"), "utf8"))).toMatchObject({
			status: "denied", upstreamForwarded: false, previouslyForwarded: 0,
		});
	} finally {
		await close(provider.server);
		if (!evidence) rmSync(dir, { recursive: true, force: true });
	}
}, 240_000);

afterAll(() => {
	if (!available) return;
	expect(pairedInputs).toHaveLength(3);
	for (const input of pairedInputs) expect(input).toEqual(pairedInputs[0]);
});

it.skipIf(!available).each(cases)(
	"exports an applicable non-Gold Stub patch for %s in %s",
	async (id, mode) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-swe-test-"));
		const runId = `swe_${id.split("-")[1]}_${mode}`;
		const task = loadSweTask(id, mirror!);
		const elaborate = mode === "v2" && id === "astropy__astropy-13033";
		// Same unrelated tracked file in every case. This is a transport smoke patch, never a proposed solution.
		const path = "astropy/__init__.py";
		const source = execFileSync("git", ["-C", task.mirror, "show", `${task.issue.base_commit}:${path}`], {
			encoding: "utf8",
		});
		const old = source.split(/\r?\n/u).find((line) => line.trim().length >= 16 && source.split(line).length === 2)!;
		let calls = 0;
		let sawReplan = false;
		let firstWireInput: Record<string, unknown> | undefined;
		const provider = await startStubProvider((body, response) => {
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const content = JSON.stringify(messages);
			const reply = (name: string, args: Record<string, unknown>) => toolCallSse(name, args, 100 + calls, 10);
			calls++;
			if (calls === 1) {
				const user = messages.find((m) => m.role === "user")?.content;
				const text = Array.isArray(user) ? user.map((part) => part.text).join("") : user;
				expect(text).toBe(swePrompt(task.issue.problem_statement));
				expect(text).toContain("允许读取工作区中的测试文件");
				expect(text).toContain("禁止修改、创建或删除测试文件");
				const baseTools = (body.tools as Array<{ function: { name: string } }>)
					.filter((tool) => ["read", "grep", "find", "ls", "write", "edit"].includes(tool.function.name))
					.sort((left, right) => left.function.name.localeCompare(right.function.name));
				firstWireInput = { model: body.model, maxTokens: body.max_tokens, baseToolSchemaSha256: digest(baseTools) };
				const schemas = (body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
				expect(schemas.sort()).toEqual(
					[
						"edit",
						"find",
						"grep",
						"ls",
						"read",
						"write",
						...(mode === "off" ? [] : ["enhanced_task_get"]),
						...(mode === "v2" ? ["enhanced_task_plan_update"] : []),
					].sort(),
				);
			}
			let sse: string;
			if (elaborate && calls === 1)
				sse = reply("enhanced_task_plan_update", {
					change: {
						action: "create",
						goal: "Prepare a non-Gold patch",
						steps: [{ id: "read", title: "Inspect", expectedOutcome: "Read source" }],
					},
				});
			else if (elaborate && calls >= 2 && calls <= 4) sse = reply("read", { path, limit: 6 });
			else if (elaborate && calls === 5) {
				const notice = messages
					.flatMap((m) =>
						Array.isArray(m.content)
							? m.content.map((part) => part?.text).filter((v) => typeof v === "string")
							: typeof m.content === "string"
								? [m.content]
								: [],
					)
					.findLast((v) => v.includes('"state":"replan_requested"'));
				expect(content).toContain("replan_requested");
				const parsed = JSON.parse(notice!);
				sawReplan = true;
				sse = reply("enhanced_task_plan_update", {
					change: {
						action: "replan",
						taskId: parsed.taskId,
						revision: parsed.revision,
						steps: [{ id: "adapt", title: "Change approach", expectedOutcome: "Produce a non-Gold patch" }],
					},
				});
			} else if (calls === (elaborate ? 6 : 1))
				sse = reply("edit", {
					path,
					edits: [{ oldText: old, newText: `${old}\n# Offline adapter smoke; deliberately not a fix.` }],
				});
			else sse = textSse("Stub finished.", 100 + calls, 10);
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(sse);
		});
		try {
			const args = [
				"--experimental-strip-types",
				join(root, "packages/pi-enhanced/benchmarks/real-agent/run-real-agent.ts"),
				"--execute",
				"--run-id",
				runId,
				"--swebench-id",
				id,
				"--swebench-mirror",
				task.mirror,
				"--task-mode",
				mode,
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
				"--output-dir",
				dir,
				"--sandbox-image",
				CONTROLLED_IMAGE,
				"--local-stub-url",
				provider.url,
			];
			const child = spawn(process.execPath, args, {
				cwd: root,
				env: {
					...process.env,
					MOCK_PROVIDER_KEY: "mock-upstream-key",
					PI_ENHANCED_REAL_MODEL_EVAL: "1",
					PI_ENHANCED_LOCAL_STUB_EVAL: "1",
				},
				stdio: ["ignore", "ignore", "pipe"],
				windowsHide: true,
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const code = await new Promise<number | null>((resolveChild, reject) => {
				child.once("error", reject);
				child.once("close", resolveChild);
			});
			expect(code, stderr).toBe(0);
			const resultDir = join(dir, runId, "swebench");
			const result = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8"));
			expect(result).toMatchObject({
				evaluationProtocol: "swebench_verified_source_restricted_v1",
				status: "not_run",
				reason: "official_harness_not_run",
				agentCompleted: true,
				auditComplete: true,
				resolved: null,
				instanceId: id,
				repositoryCommit: task.issue.base_commit,
				changedFiles: [path],
				taskSeeded: false,
				agentAttempted: true,
				patchExportStatus: "exported",
				officialHarnessStatus: "not_run",
			});
			const runReport = JSON.parse(readFileSync(join(dir, runId, "run.json"), "utf8"));
			expect(runReport.summary).toMatchObject({ run: 1, notRun: 0, normallyCompleted: 1, passed: 0 });
			expect(JSON.parse(readFileSync(join(resultDir, "sandbox-audit.json"), "utf8"))).toMatchObject({
				complete: true,
			});
			if (id === "astropy__astropy-13033") {
				pairedInputs.push({
					repositoryCommit: result.repositoryCommit,
					inputFixtureSha256: result.inputFixtureSha256,
					userPromptSha256: result.inputAudit.userPromptSha256,
					systemPromptSha256: result.inputAudit.canonicalSystemPromptSha256,
					baseToolSchemaSha256: result.inputAudit.baseToolSchemaSha256,
					configuration: result.configuration,
					firstWireInput,
				});
			}
			const prediction = JSON.parse(readFileSync(join(resultDir, "predictions.jsonl"), "utf8"));
			expect(Object.keys(prediction).sort()).toEqual(["instance_id", "model_name_or_path", "model_patch"]);
			expect(prediction.model_patch).toContain("deliberately not a fix.");
			if (elaborate) {
				expect(sawReplan).toBe(true);
				expect(result.telemetry.taskV2.updates.at(-1)).toMatchObject({ replans: 1, planUpdates: 2 });
			} else expect(result.telemetry.taskV2).toBeUndefined();
			if (process.env.PI_ENHANCED_SWE_STUB_EVIDENCE) {
				writeFileSync(
					join(process.env.PI_ENHANCED_SWE_STUB_EVIDENCE, `${runId}.json`),
					JSON.stringify(result, null, 2),
				);
				writeFileSync(
					join(process.env.PI_ENHANCED_SWE_STUB_EVIDENCE, `${runId}-predictions.jsonl`),
					`${JSON.stringify(prediction)}\n`,
				);
			}
		} finally {
			await close(provider.server);
			rmSync(dir, { recursive: true, force: true });
		}
	},
	90_000,
);
