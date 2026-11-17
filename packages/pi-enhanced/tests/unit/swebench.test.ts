import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { digest } from "../../benchmarks/real-agent/evaluation-identity.ts";
import { saveRunReport } from "../../benchmarks/real-agent/runner-results.ts";
import { readSweEvaluationPrediction } from "../../benchmarks/real-agent/swe-evaluator.ts";
import {
	assessSwePrediction,
	exportSwePrediction,
	harnessCommand,
	officialOutcome,
	publicInstance,
	readOfficialOutcome,
	safeBasePath,
	safePatchPath,
	sweWritePathAllowed,
	windowsDockerStorage,
} from "../../benchmarks/real-agent/swebench.ts";
import { compactSweGrep } from "../../src/sandbox/tools.ts";

describe("SWE-bench Verified adapter", () => {
	it("deduplicates context, prioritizes matches and caps the JSON-encoded grep result", () => {
		const path = "a-file.py";
		const rows = Array.from({ length: 10 }, (_, line) => ({ path, line: line + 1, text: '汉字\\"'.repeat(250), match: false }));
		rows.push({ path, line: 2, text: "upgraded context", match: true }, { path, line: 12, text: "late match", match: true });
		const text = compactSweGrep(rows, "call-grep");
		expect(text).toContain("a-file.py:2: upgraded context");
		expect(text).not.toContain("a-file.py-2-");
		expect(text).toContain("a-file.py:12: late match");
		expect(text).toContain("[grep output truncated.");
		expect(Buffer.byteLength(JSON.stringify({ role: "tool", content: text, tool_call_id: "call-grep" }))).toBeLessThanOrEqual(8192);
		expect(compactSweGrep(rows.slice(-2), "call-grep")).toBe("a-file.py:2: upgraded context\na-file.py:12: late match");
	});
	it("binds the scoring evidence to the exact bytes parsed before the original files change", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-swe-scoring-input-")));
		const predictionPath = join(dir, "predictions.jsonl");
		const agentPath = join(dir, "result.json");
		const prediction = { instance_id: "astropy__astropy-13033", model_name_or_path: "stub", model_patch: "original" };
		const agent = { instanceId: prediction.instance_id, patchExportStatus: "exported", patchSha256: digest("original") };
		const predictionText = JSON.stringify(prediction, null, 2) + "\n";
		const agentText = JSON.stringify(agent, null, 2) + "\n";
		try {
			writeFileSync(predictionPath, predictionText);
			writeFileSync(agentPath, agentText);
			const input = readSweEvaluationPrediction(predictionPath, agentPath);
			writeFileSync(predictionPath, JSON.stringify({ ...prediction, model_patch: "changed" }));
			writeFileSync(agentPath, JSON.stringify({ ...agent, patchSha256: digest("changed") }));
			expect(input.prediction).toEqual(prediction);
			expect(input.agent).toEqual(agent);
			expect(input.predictionSha256).toBe(digest(predictionText));
			expect(input.agentResultSha256).toBe(digest(agentText));
			expect(assessSwePrediction(input.agent, input.prediction, "not_run").patchSha256).toBe(agent.patchSha256);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects non-object candidate input before official evaluation", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-swe-invalid-input-")));
		const predictionPath = join(dir, "predictions.jsonl");
		const agentPath = join(dir, "result.json");
		try {
			writeFileSync(predictionPath, "{}");
			writeFileSync(agentPath, "null");
			expect(() => readSweEvaluationPrediction(predictionPath, agentPath)).toThrow("SWE_AGENT_RESULT_UNTRUSTED");

			writeFileSync(predictionPath, "null");
			writeFileSync(agentPath, "{}");
			expect(() => readSweEvaluationPrediction(predictionPath, agentPath)).toThrow("SWE_PREDICTION_INVALID");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records a timeout or evaluation error without modifying an incomplete official report", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-swe-official-outcome-"));
		const report = join(dir, "report.json");
		const id = "astropy__astropy-13033";
		try {
			expect(readOfficialOutcome(report, id, null)).toBe("evaluation_error");
			writeFileSync(report, '{"resolved_ids":');
			expect(readOfficialOutcome(report, id, "timeout")).toBe("timeout");
			expect(readOfficialOutcome(report, id, null)).toBe("evaluation_error");
			expect(readFileSync(report, "utf8")).toBe('{"resolved_ids":');
			writeFileSync(report, JSON.stringify({ resolved_ids: [id], unresolved_ids: [], error_ids: [] }));
			expect(readOfficialOutcome(report, id, null)).toBe("resolved");
			const instance = join(dir, "instance");
			mkdirSync(instance);
			expect(readOfficialOutcome(report, id, null, instance)).toBe("evaluation_error");
			writeFileSync(join(instance, "report.json"), JSON.stringify({ [id]: { patch_successfully_applied: true, resolved: false } }));
			expect(readOfficialOutcome(report, id, null, instance)).toBe("evaluation_error");
			writeFileSync(join(instance, "report.json"), JSON.stringify({ [id]: { patch_successfully_applied: true, resolved: true } }));
			expect(readOfficialOutcome(report, id, null, instance)).toBe("resolved");
			writeFileSync(report, JSON.stringify({ resolved_ids: [], unresolved_ids: [], error_ids: [id] }));
			expect(readOfficialOutcome(report, id, null, instance)).toBe("evaluation_error");
			writeFileSync(join(instance, "test_output.txt"), "pytest output\n\nTimeout error: 1 seconds exceeded.");
			expect(readOfficialOutcome(report, id, null, instance)).toBe("timeout");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps real SWE output separate from the historical P5 report", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-swe-output-"));
		try {
			mkdirSync(join(dir, "docs"));
			const legacy = join(dir, "docs/p5-real-model-results.json");
			writeFileSync(legacy, "historical evidence");
			saveRunReport(
				{
					execute: true,
					variant: "baseline",
					condition: "cold",
					telemetryEnabled: true,
					packageRoot: dir,
					runOutput: dir,
					batchL: false,
					swebench: true,
				},
				[{ agentAttempted: true, status: "not_run", agentCompleted: true, resolved: null }],
				0,
			);
			expect(readFileSync(legacy, "utf8")).toBe("historical evidence");
			expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).summary).toMatchObject({
				run: 1,
				passed: 0,
				normallyCompleted: 1,
				notRun: 0,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("binds official scores to the exported patch independently of Agent completion", () => {
		const prediction = { instance_id: "org__project-1", model_patch: "safe patch" };
		const agent = {
			instanceId: prediction.instance_id,
			patchExportStatus: "exported",
			patchSha256: digest(prediction.model_patch),
			agentCompleted: false,
			auditComplete: false,
		};
		for (const status of ["resolved", "unresolved", "incomplete", "not_run", "timeout", "evaluation_error"])
			expect(assessSwePrediction(agent, prediction, status)).toMatchObject({
				officialHarnessStatus: status,
				resolved: status === "resolved" ? true : status === "unresolved" ? false : null,
				agentCompleted: false,
				auditComplete: false,
				evaluationAccepted: false,
			});
		expect(
			assessSwePrediction({ ...agent, agentCompleted: true, auditComplete: true }, prediction, "resolved")
				.evaluationAccepted,
		).toBe(true);
		for (const invalid of [
			{ ...agent, instanceId: "other" },
			{ ...agent, patchSha256: "0".repeat(64) },
			{ ...agent, patchExportStatus: "not_exported" },
		])
			expect(() => assessSwePrediction(invalid, prediction, "resolved")).toThrow(
				"SWE_AGENT_PREDICTION_BINDING_INVALID",
			);
	});
	it("measures the configured Docker disk after migration and refuses a missing configured disk", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-docker-storage-"));
		const local = join(root, "local");
		const app = join(root, "app");
		const original = join(local, "Docker", "wsl", "disk");
		const moved = join(root, "moved", "disk");
		try {
			mkdirSync(original, { recursive: true });
			mkdirSync(moved, { recursive: true });
			mkdirSync(join(app, "Docker"), { recursive: true });
			writeFileSync(join(original, "docker_data.vhdx"), "fixture");
			writeFileSync(join(moved, "docker_data.vhdx"), "fixture");
			expect(windowsDockerStorage(local, app)).toBe(original);
			const settings = join(app, "Docker", "settings-store.json");
			writeFileSync(settings, JSON.stringify({ CustomWslDistroDir: dirname(moved) }));
			expect(windowsDockerStorage(local, app)).toBe(moved);
			writeFileSync(settings, JSON.stringify({ CustomWslDistroDir: join(root, "missing") }));
			expect(windowsDockerStorage(local, app)).toBeNull();
			writeFileSync(settings, JSON.stringify({ CustomWslDistroDir: "relative" }));
			expect(windowsDockerStorage(local, app)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects empty, untracked and secret-bearing patches and never stages model output", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-swe-export-"));
		const cwd = join(root, "project");
		mkdirSync(cwd);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		try {
			git("init");
			git("config", "user.name", "Fixture");
			git("config", "user.email", "fixture@example.invalid");
			writeFileSync(join(cwd, "module.py"), "value = 1\n");
			writeFileSync(join(cwd, "independent.py"), "value = 3\n");
			writeFileSync(join(cwd, "test_private.py"), "value = 4\n");
			git("add", "--", "module.py", "independent.py", "test_private.py");
			git("commit", "-m", "fixture");
			const task = {
				issue: {
					instance_id: "org__project-1",
					repo: "org/project",
					base_commit: git("rev-parse", "HEAD"),
					problem_statement: "Public issue",
				},
				mirror: cwd,
			};
			const target = join(root, "predictions.jsonl");
			expect(exportSwePrediction(task, cwd, target, "fixture")).toEqual({
				status: "agent_failed",
				reason: "empty_patch",
			});
			writeFileSync(join(cwd, "module.py"), 'secret = "never-upload-this-credential"\n');
			const secretDiagnostic = join(root, "secret-diagnostic.json");
			expect(() => exportSwePrediction(task, cwd, target, "fixture", secretDiagnostic)).toThrow("SWE_PATCH_UNSAFE");
			expect(readFileSync(secretDiagnostic, "utf8")).not.toContain("never-upload-this-credential");
			expect(JSON.parse(readFileSync(secretDiagnostic, "utf8"))).toMatchObject({
				error: "SWE_PATCH_UNSAFE",
				candidatePatchSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
				contentSaved: false,
			});
			writeFileSync(join(cwd, "module.py"), "value = 2\n");
			writeFileSync(join(cwd, "untracked.txt"), "untracked");
			expect(() => exportSwePrediction(task, cwd, target, "fixture")).toThrow(
				"SWE_WORKSPACE_DRIFT_OR_UNTRACKED_FILES",
			);
			rmSync(join(cwd, "untracked.txt"));
			expect(exportSwePrediction(task, cwd, target, "fixture").status).toBe("not_run");
			expect(git("diff", "--cached", "--name-only")).toBe("");
			expect(JSON.parse(readFileSync(target, "utf8")).model_patch).toContain("+value = 2");
			writeFileSync(join(cwd, "independent.py"), "value = 5\n");
			expect(exportSwePrediction(task, cwd, join(root, "second.jsonl"), "fixture")).toMatchObject({
				changedFiles: ["independent.py", "module.py"],
			});
			writeFileSync(join(cwd, "test_private.py"), "value = 6\n");
			expect(sweWritePathAllowed(cwd, "module.py")).toBe(true);
			expect(sweWritePathAllowed(cwd, "test_private.py")).toBe(false);
			expect(sweWritePathAllowed(cwd, "new.py")).toBe(false);
			expect(sweWritePathAllowed(cwd, "../module.py")).toBe(false);
			const diagnostic = join(root, "denied-diagnostic.json");
			expect(() => exportSwePrediction(task, cwd, join(root, "denied.jsonl"), "fixture", diagnostic)).toThrow(
				"SWE_PATCH_PATH_DENIED",
			);
			expect(existsSync(join(root, "denied.jsonl"))).toBe(false);
			expect(JSON.parse(readFileSync(diagnostic, "utf8"))).toMatchObject({
				status: "rejected",
				error: "SWE_PATCH_PATH_DENIED",
				candidatePatchSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
				paths: expect.arrayContaining([{ path: "test_private.py", pathSha256: digest("test_private.py") }]),
				contentSaved: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects repository-local agent configuration and unsafe base entries", () => {
		for (const path of [".pi/settings.json", ".Pi/extensions/attack.ts", "src/../file", "src/NUL.py", ".git/config"])
			expect(safeBasePath(path)).toBe(false);
		expect(safeBasePath("astropy/io/ascii/html.py")).toBe(true);
	});
	it("projects only the issue fields and rejects a changed base or identity", () => {
		const identity = { instance_id: "org__project-1", repo: "org/project", base_commit: "a".repeat(40) };
		const row = { ...identity, problem_statement: "Repair the public issue.", patch: "answer", test_patch: "hidden" };
		expect(publicInstance(row, identity)).toEqual({ ...identity, problem_statement: row.problem_statement });
		expect(() => publicInstance({ ...row, base_commit: "b".repeat(40) }, identity)).toThrow();
		expect(() => publicInstance({ ...row, instance_id: "org__project-2" }, identity)).toThrow();
	});
	it("gives every patch evaluation a fresh run ID even for the same patch", () => {
		const input = {
			id: "org__project-1",
			datasetPath: resolve("dataset.json"),
			prediction: "gold",
			predictionHash: "a".repeat(64),
		};
		const first = harnessCommand(input);
		const second = harnessCommand(input);
		expect(first.runId).not.toBe(second.runId);
		expect(first.args.slice(0, 2)).toEqual(["-m", "swebench.harness.run_evaluation"]);
		expect(first.args).toContain("--max_workers");
		expect(first.args[first.args.indexOf("--max_workers") + 1]).toBe("1");
		expect(first.args[first.args.indexOf("--cache_level") + 1]).toBe("instance");
		expect(first.reportFile).toBe(`gold.${first.runId}.json`);
		const predicted = harnessCommand({ ...input, prediction: resolve("predictions.jsonl"), modelName: "offline" });
		expect(predicted.reportFile).toBe(`offline.${predicted.runId}.json`);
		expect(() => harnessCommand({ ...input, prediction: resolve("predictions.jsonl") })).toThrow();
		expect(() =>
			harnessCommand({ ...input, prediction: resolve("predictions.jsonl"), modelName: "../bad" }),
		).toThrow();
		expect(() => harnessCommand({ ...input, prediction: resolve("predictions.jsonl"), modelName: ".." })).toThrow();
		expect(() => harnessCommand({ ...input, datasetPath: "../dataset.json" })).toThrow();
	});
	it("allows only normalized source paths outside repository metadata", () => {
		expect(safePatchPath("src/package/module.py")).toBe(true);
		for (const name of [
			"../file",
			"/file",
			"C:/file",
			"src\\file",
			"src/.git/config",
			".env",
			"test/hidden.py",
			"test.py",
			"tests.py",
			"src/math.test.ts",
			"src/math.spec.ts",
			"conftest.py",
			"src/__tests__/module.py",
			"src/__specs__/module.ts",
		])
			expect(safePatchPath(name)).toBe(false);
	});
	it("distinguishes actual Harness resolution from errors, timeouts and missing evidence", () => {
		const id = "org__project-1";
		expect(officialOutcome({ resolved_ids: [id], unresolved_ids: [], error_ids: [] }, id)).toBe("resolved");
		expect(officialOutcome({ resolved_ids: [], unresolved_ids: [id], error_ids: [] }, id)).toBe("unresolved");
		expect(officialOutcome({ resolved_ids: [], unresolved_ids: [], error_ids: [id] }, id)).toBe("evaluation_error");
		expect(officialOutcome(null, id, true)).toBe("timeout");
		expect(officialOutcome({ resolved_ids: [], unresolved_ids: [], error_ids: [] }, id)).toBe("not_run");
		expect(officialOutcome({ resolved_ids: [], unresolved_ids: [], error_ids: [], incomplete_ids: [id] }, id)).toBe("incomplete");
		expect(officialOutcome({ resolved_ids: [], unresolved_ids: [], error_ids: [], empty_patch_ids: [id] }, id)).toBe("incomplete");
		expect(() => officialOutcome({ resolved_ids: [id], unresolved_ids: [id], error_ids: [] }, id)).toThrow();
	});
});
