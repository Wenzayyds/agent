import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	digest,
	SWE_TASK_CONFIGURATION,
	SWE_TASK_PROFILE,
	TASK_PAIR_CONFIGURATION,
} from "../../benchmarks/real-agent/batch-l-profile.ts";
import {
	claimTaskPairAuthorization,
	claimTaskPairCell,
	loadTaskPairAuthorization,
} from "../../benchmarks/real-agent/task-pair-authorization.ts";

const root = resolve(import.meta.dirname, "../../../..");
const profile = ["--comparison-profile", "task-pair-v1"];

function invoke(entry: string, args: string[]) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", join(root, "packages/pi-enhanced/benchmarks/real-agent", entry), ...args],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
			env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
		},
	);
}

describe("Task pair offline entry", () => {
	it("binds SWE fingerprints, CI, budget and ordered single-use cells", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-swe-grant-")));
		try {
			const path = join(dir, "grant.json"),
				ciPath = join(dir, "ci.json");
			const input = {
				fixtureSha256: "a".repeat(64),
				fixtureCommit: SWE_TASK_CONFIGURATION.baseCommit,
				userPromptSha256: SWE_TASK_CONFIGURATION.problemSha256,
				systemPromptSha256: "b".repeat(64),
				toolSchemaSha256: "c".repeat(64),
				firstRequestSha256: "d".repeat(64),
			};
			const grant = {
				schemaVersion: 1,
				status: "authorized",
				authorizationId: "00000000-0000-4000-8000-000000000002",
				profile: SWE_TASK_PROFILE,
				commit: "1".repeat(40),
				batchId: "swe_task_fixture",
				outputBase: dir,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				ciRunId: 1,
				configurationSha256: digest(SWE_TASK_CONFIGURATION),
				input,
				modeInputs: {
					off: input,
					v1: { ...input, toolSchemaSha256: "e".repeat(64) },
					v2: { ...input, toolSchemaSha256: "f".repeat(64) },
				},
			};
			writeFileSync(
				ciPath,
				JSON.stringify({
					commit: grant.commit,
					conclusion: "success",
					runId: 1,
					runUrl: "https://github.com/Wenzayyds/agent/actions/runs/1",
					jobs: [
						"offline-engineering (ubuntu-latest)",
						"offline-engineering (windows-latest)",
						"docker-isolation",
					].map((name) => ({ name, conclusion: "success" })),
				}),
			);
			const load = () =>
				loadTaskPairAuthorization(path, root, grant.commit, grant.batchId, ciPath, SWE_TASK_PROFILE);
			for (const invalid of [
				{ ...grant, profile: "task-pair-v1" },
				{ ...grant, commit: "2".repeat(40) },
				{ ...grant, configurationSha256: digest(TASK_PAIR_CONFIGURATION) },
				{ ...grant, expiresAt: "2000-01-01T00:00:00Z" },
				{ ...grant, ciRunId: 2 },
				{ ...grant, modeInputs: { off: input, v1: input } },
				{ ...grant, modeInputs: { ...grant.modeInputs, v2: { ...input, userPromptSha256: "0".repeat(64) } } },
				{ ...grant, input: { ...input, firstRequestSha256: "0".repeat(64) } },
			]) {
				writeFileSync(path, JSON.stringify(invalid));
				expect(load).toThrow();
			}
			writeFileSync(path, JSON.stringify(grant));
			expect(() => loadTaskPairAuthorization(path, root, grant.commit, grant.batchId, ciPath)).toThrow();
			const parsed = load();
			claimTaskPairAuthorization(path, parsed);
			expect(() => claimTaskPairAuthorization(path, parsed)).toThrow();
			const batchDir = join(dir, grant.batchId);
			mkdirSync(batchDir);
			const batch = (states: string[], stoppedReason: string | null = null) =>
				writeFileSync(
					join(batchDir, "batch.json"),
					JSON.stringify({
						commit: grant.commit,
						batchId: grant.batchId,
						comparisonProfile: grant.profile,
						authorization: { id: grant.authorizationId },
						stoppedReason,
						cells: ["off", "v1", "v2"].map((id, i) => ({ id, resultStatus: states[i] })),
					}),
				);
			batch(["run", "not_run", "not_run"]);
			claimTaskPairCell(path, parsed, "off", batchDir);
			expect(() => claimTaskPairCell(path, parsed, "off", batchDir)).toThrow();
			batch(["run", "not_run", "run"]);
			expect(() => claimTaskPairCell(path, parsed, "v2", batchDir)).toThrow();
			batch(["run", "run", "not_run"], "isolation_boundary_stop");
			expect(() => claimTaskPairCell(path, parsed, "v1", batchDir)).toThrow();
			batch(["run", "run", "not_run"]);
			claimTaskPairCell(path, parsed, "v1", batchDir);
			batch(["run", "run", "run"]);
			claimTaskPairCell(path, parsed, "v2", batchDir);
			expect(() => claimTaskPairCell(path, parsed, "v2", batchDir)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("keeps real SWE closed without a fresh scoped grant and lists the fixed modes", () => {
		const args = [
			"--comparison-profile",
			SWE_TASK_PROFILE,
			"--swebench-id",
			SWE_TASK_CONFIGURATION.instanceId,
			"--swebench-mirror",
			root,
		];
		const dry = invoke("run-controlled.ts", args);
		expect(dry.status, dry.stderr).toBe(0);
		expect(JSON.parse(dry.stdout)).toMatchObject({
			status: "not_run",
			limits: { maxRuns: 3, maxBatchCostUsd: 0.09 },
			cells: [{ id: "off" }, { id: "v1" }, { id: "v2" }],
		});
		for (const entry of ["run-controlled.ts", "run-real-agent.ts"]) {
			const run = invoke(entry, [...args, "--execute", "--task-mode", "off", "--api-key-env", "DEEPSEEK_API_KEY"]);
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
		}
	});
	it("binds the host grant to configuration, CI, output and ordered single-use cells", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-task-grant-")));
		try {
			const grantPath = join(dir, "grant.json");
			const ciPath = join(dir, "ci.json");
			const grant = {
				schemaVersion: 1,
				status: "authorized",
				authorizationId: "00000000-0000-4000-8000-000000000001",
				profile: "task-pair-v1",
				commit: "1".repeat(40),
				batchId: "task_pair_fixture",
				outputBase: dir,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				ciRunId: 1,
				configurationSha256: digest(TASK_PAIR_CONFIGURATION),
				input: {
					fixtureSha256: "a".repeat(64),
					fixtureCommit: "b".repeat(40),
					userPromptSha256: "c".repeat(64),
					systemPromptSha256: "d".repeat(64),
					toolSchemaSha256: "e".repeat(64),
					firstRequestSha256: "f".repeat(64),
				},
			};
			const ci = {
				commit: grant.commit,
				conclusion: "success",
				runId: 1,
				runUrl: "https://github.com/Wenzayyds/agent/actions/runs/1",
				jobs: [
					"offline-engineering (ubuntu-latest)",
					"offline-engineering (windows-latest)",
					"docker-isolation",
				].map((name) => ({ name, conclusion: "success" })),
			};
			writeFileSync(ciPath, JSON.stringify(ci));
			const load = () => loadTaskPairAuthorization(grantPath, root, grant.commit, grant.batchId, ciPath);
			for (const invalid of [
				{ ...grant, configurationSha256: "0".repeat(64) },
				{ ...grant, commit: "2".repeat(40) },
				{ ...grant, expiresAt: "2000-01-01T00:00:00Z" },
				{ ...grant, ciRunId: 2 },
				{ ...grant, input: { ...grant.input, firstRequestSha256: "bad" } },
			]) {
				writeFileSync(grantPath, JSON.stringify(invalid));
				expect(load).toThrow();
			}
			writeFileSync(grantPath, JSON.stringify(grant));
			expect(() => loadTaskPairAuthorization(grantPath, dir, grant.commit, grant.batchId, ciPath)).toThrow(
				"TASK_PAIR_AUTHORIZATION_UNTRUSTED",
			);
			const parsed = load();
			const batchDir = join(dir, grant.batchId);
			mkdirSync(batchDir);
			const batch = (off: string, on: string, stoppedReason: string | null = null) =>
				writeFileSync(
					join(batchDir, "batch.json"),
					JSON.stringify({
						commit: grant.commit,
						batchId: grant.batchId,
						comparisonProfile: grant.profile,
						authorization: { id: grant.authorizationId },
						stoppedReason,
						cells: [
							{ id: "t_inline", resultStatus: off },
							{ id: "t_task", resultStatus: on },
						],
					}),
				);
			const claim = (id: string, output = batchDir) => claimTaskPairCell(grantPath, parsed, id, output);
			claimTaskPairAuthorization(grantPath, parsed);
			expect(() => claimTaskPairAuthorization(grantPath, parsed)).toThrow();
			batch("passed", "run");
			expect(() => claim("t_task")).toThrow();
			batch("run", "not_run");
			expect(() => claim("t_inline", dir)).toThrow();
			expect(() => claim("m_inline")).toThrow("TASK_PAIR_CELL_ORDER_INVALID");
			claim("t_inline");
			expect(() => claim("t_inline")).toThrow();
			batch("passed", "run", "isolation_boundary_stop");
			expect(() => claim("t_task")).toThrow("TASK_PAIR_CELL_ORDER_INVALID");
			batch("passed", "run");
			claim("t_task");
			expect(() => claim("t_task")).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("lists only Task off then on with the fixed budget", () => {
		const run = invoke("run-controlled.ts", profile);
		expect(run.status, run.stderr).toBe(0);
		const report = JSON.parse(run.stdout);
		expect(report.status).toBe("not_run");
		expect(report.cells.map(({ id }: { id: string }) => id)).toEqual(["t_inline", "t_task"]);
		expect(report.limits).toEqual({
			maxRequests: 12,
			maxTokens: 80_000,
			maxCostUsd: 0.03,
			timeoutMs: 180_000,
			maxRuns: 2,
			maxBatchCostUsd: 0.06,
		});
	});

	it.each(["run-controlled.ts", "run-real-agent.ts"])("keeps real execution closed at %s", (entry) => {
		const pair = invoke(entry, [...profile, "--execute"]);
		expect(pair.status).toBe(1);
		expect(pair.stderr).toContain("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
		const batchN = invoke(entry, ["--comparison-profile", "batch-n-v1", "--execute"]);
		expect(batchN.status).toBe(1);
		expect(batchN.stderr).toContain("BATCH_N_SEPARATE_AUTHORIZATION_REQUIRED");
	});

	it("rejects a non-Task cell and forbids recovery or historical grants", () => {
		const nonTask = invoke("run-real-agent.ts", [...profile, "--controlled-cell", "m_memory"]);
		expect(nonTask.status).toBe(1);
		expect(nonTask.stderr).toContain("TASK_PAIR_INVALID_CELL");
		for (const entry of ["run-real-agent.ts", "run-controlled.ts"]) {
			for (const arg of ["--offline-denial-policy", "--batch-l-authorization"]) {
				const result = invoke(entry, [...profile, arg, "unused.json"]);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain("TASK_PAIR_STRICT_STUB_ONLY");
			}
		}
	});
});
