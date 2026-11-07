import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { digest } from "../../benchmarks/real-agent/batch-l-profile.ts";
import { saveRunReport } from "../../benchmarks/real-agent/runner-results.ts";
import {
	assessSwePrediction,
	exportSwePrediction,
	harnessCommand,
	officialOutcome,
	publicInstance,
	safeBasePath,
	safePatchPath,
	windowsDockerStorage,
} from "../../benchmarks/real-agent/swebench.ts";

describe("SWE-bench Verified adapter", () => {
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
		for (const status of ["resolved", "unresolved", "not_run", "timeout", "evaluation_error"])
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
			expect(() => exportSwePrediction(task, cwd, target, "fixture")).toThrow("SWE_PATCH_UNSAFE");
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
			expect(() => exportSwePrediction(task, cwd, join(root, "denied.jsonl"), "fixture")).toThrow(
				"SWE_PATCH_PATH_DENIED",
			);
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
		expect(first.reportFile).toBe(`gold.${first.runId}.json`);
		const predicted = harnessCommand({ ...input, prediction: resolve("predictions.jsonl"), modelName: "offline" });
		expect(predicted.reportFile).toBe(`offline.${predicted.runId}.json`);
		expect(() => harnessCommand({ ...input, prediction: resolve("predictions.jsonl") })).toThrow();
		expect(() =>
			harnessCommand({ ...input, prediction: resolve("predictions.jsonl"), modelName: "../bad" }),
		).toThrow();
		expect(() => harnessCommand({ ...input, datasetPath: "../dataset.json" })).toThrow();
	});
	it("allows only normalized source paths outside repository metadata", () => {
		expect(safePatchPath("src/package/module.py")).toBe(true);
		for (const name of ["../file", "/file", "C:/file", "src\\file", "src/.git/config", ".env", "test/hidden.py"])
			expect(safePatchPath(name)).toBe(false);
	});
	it("distinguishes actual Harness resolution from errors, timeouts and missing evidence", () => {
		const id = "org__project-1";
		expect(officialOutcome({ resolved_ids: [id], unresolved_ids: [], error_ids: [] }, id)).toBe("resolved");
		expect(officialOutcome({ resolved_ids: [], unresolved_ids: [id], error_ids: [] }, id)).toBe("unresolved");
		expect(officialOutcome({ resolved_ids: [], unresolved_ids: [], error_ids: [id] }, id)).toBe("evaluation_error");
		expect(officialOutcome(null, id, true)).toBe("timeout");
		expect(officialOutcome({ resolved_ids: [], unresolved_ids: [], error_ids: [] }, id)).toBe("not_run");
		expect(() => officialOutcome({ resolved_ids: [id], unresolved_ids: [id], error_ids: [] }, id)).toThrow();
	});
});
