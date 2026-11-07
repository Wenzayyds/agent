import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { digest } from "../../benchmarks/real-agent/batch-l-profile.ts";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";
import { loadSweTask } from "../../benchmarks/real-agent/swebench.ts";
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
				expect(text).toBe(task.issue.problem_statement);
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
