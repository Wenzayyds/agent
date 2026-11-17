import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_PAIR_CONFIGURATION } from "../../benchmarks/real-agent/batch-l-profile.ts";
import { digest } from "../../benchmarks/real-agent/evaluation-identity.ts";
import { SWE_FLASH_OFF_CONFIGURATION, SWE_FLASH_OFF_PROFILE } from "../../benchmarks/real-agent/swe-profile.ts";
import { SWE_PRO_OFF_CONFIGURATION, SWE_PRO_OFF_PROFILE, SWE_PRO_TASK_CONFIGURATION, SWE_PRO_TASK_PROFILE, SWE_TASK_CONFIGURATION, SWE_TASK_PROFILE } from "../../benchmarks/real-agent/swe-profile.ts";
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
	it("authorizes all five Flash OFF fingerprints and consumes each instance only in order", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-swe-flash-grant-")));
		try {
			const path = join(dir, "grant.json");
			const ciPath = join(dir, "ci.json");
			const { instances } = SWE_FLASH_OFF_CONFIGURATION;
			const instanceInputs = Object.fromEntries(instances.map((instance) => [instance.instanceId, {
				fixtureSha256: digest(instance.baseCommit), fixtureCommit: instance.baseCommit,
				userPromptSha256: instance.userPromptSha256, systemPromptSha256: "b".repeat(64),
				toolSchemaSha256: "c".repeat(64), firstRequestSha256: digest(instance.instanceId),
			}]));
			const grant = {
				schemaVersion: 1, status: "authorized", authorizationId: "9dcabbd2-0d22-490a-8117-dfca027fc249",
				profile: SWE_FLASH_OFF_PROFILE, commit: "a".repeat(40), batchId: "swe_flash_off_fixture",
				outputBase: dir, expiresAt: new Date(Date.now() + 60_000).toISOString(), ciRunId: 921,
				configurationSha256: digest(SWE_FLASH_OFF_CONFIGURATION), instanceInputs,
			};
			writeFileSync(ciPath, JSON.stringify({
				commit: grant.commit, runId: grant.ciRunId, conclusion: "success",
				runUrl: `https://github.com/Wenzayyds/agent/actions/runs/${grant.ciRunId}`,
				jobs: ["offline-engineering (ubuntu-latest)", "offline-engineering (windows-latest)", "docker-isolation"]
					.map((name) => ({ name, conclusion: "success" })),
			}));
			const load = () => loadTaskPairAuthorization(path, root, grant.commit, grant.batchId, ciPath, SWE_FLASH_OFF_PROFILE);
			const first = instances[0]!;
			const second = instances[1]!;
			for (const invalid of [
				{ ...grant, configurationSha256: digest(SWE_TASK_CONFIGURATION) },
				{ ...grant, expiresAt: new Date(Date.now() - 10_000).toISOString() },
				{ ...grant, instanceInputs: { [first.instanceId]: instanceInputs[first.instanceId] } },
				{ ...grant, instanceInputs: { ...instanceInputs, [first.instanceId]: instanceInputs[second.instanceId] } },
			]) {
				writeFileSync(path, JSON.stringify(invalid));
				expect(load).toThrow();
			}
			writeFileSync(path, JSON.stringify(grant));
			const loaded = load();
			expect(loaded.instanceInputs).toEqual(instanceInputs);
			const batchDir = join(dir, grant.batchId);
			mkdirSync(batchDir);
			claimTaskPairAuthorization(path, loaded);
			expect(() => claimTaskPairAuthorization(path, loaded)).toThrow();
			const save = (index: number, changedInstance?: string) => writeFileSync(join(batchDir, "batch.json"), JSON.stringify({
				commit: grant.commit, batchId: grant.batchId, comparisonProfile: grant.profile,
				authorization: { id: grant.authorizationId }, stoppedReason: null,
				cells: instances.map((instance, position) => ({ id: instance.cellId,
					instanceId: position === index && changedInstance ? changedInstance : instance.instanceId,
					resultStatus: position > index ? "not_run" : "run", continuationReady: position < index })),
			}));
			save(0, second.instanceId);
			expect(() => claimTaskPairCell(path, loaded, first.cellId, batchDir)).toThrow("TASK_PAIR_CELL_ORDER_INVALID");
			save(1);
			expect(() => claimTaskPairCell(path, loaded, second.cellId, batchDir)).toThrow();
			for (const [index, instance] of instances.entries()) {
				save(index);
				claimTaskPairCell(path, loaded, instance.cellId, batchDir);
				expect(() => claimTaskPairCell(path, loaded, instance.cellId, batchDir)).toThrow();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("previews the fixed Flash OFF batch and rejects an unapproved paid launch or instance override", () => {
		const args = ["--comparison-profile", SWE_FLASH_OFF_PROFILE, "--swebench-mirror", root];
		const preview = invoke("run-controlled.ts", args);
		expect(preview.status, preview.stderr).toBe(0);
		expect(JSON.parse(preview.stdout)).toMatchObject({
			configurationSha256: digest(SWE_FLASH_OFF_CONFIGURATION), limits: { maxCostUsd: 0.08, maxBatchCostUsd: 0.4 },
			cells: SWE_FLASH_OFF_CONFIGURATION.instances.map(({ instanceId, cellId }) => ({ id: cellId, instanceId })),
		});
		expect(invoke("run-controlled.ts", [...args, "--execute"]).stderr).toContain("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
		expect(invoke("run-controlled.ts", [...args, "--swebench-id", "astropy__astropy-13033"]).stderr).toContain("SWE_EXPERIMENT_SCOPE_INVALID");
		expect(invoke("run-real-agent.ts", [...args, "--swebench-id", "astropy__astropy-12907", "--task-mode", "off", "--execute"]).stderr).toContain("SWE_EXPERIMENT_SCOPE_INVALID");
	});

	it("binds Pro V1/V2 to a distinct grant, two fingerprints and ordered one-use cells", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-swe-pro-task-grant-")));
		try {
			const path = join(dir, "grant.json"), ciPath = join(dir, "ci.json");
			const input = {
				fixtureSha256: "a".repeat(64), fixtureCommit: SWE_PRO_TASK_CONFIGURATION.baseCommit,
				userPromptSha256: SWE_PRO_TASK_CONFIGURATION.userPromptSha256,
				systemPromptSha256: "b".repeat(64), toolSchemaSha256: "c".repeat(64),
				firstRequestSha256: "d".repeat(64),
			};
			const grant = {
				schemaVersion: 1, status: "authorized", authorizationId: "00000000-0000-4000-8000-000000000004",
				profile: SWE_PRO_TASK_PROFILE, commit: "1".repeat(40), batchId: "swe_pro_task_fixture",
				outputBase: dir, expiresAt: new Date(Date.now() + 60_000).toISOString(), ciRunId: 1,
				configurationSha256: digest(SWE_PRO_TASK_CONFIGURATION), input,
				modeInputs: { v1: input, v2: { ...input, toolSchemaSha256: "e".repeat(64), firstRequestSha256: "f".repeat(64) } },
			};
			writeFileSync(ciPath, JSON.stringify({
				commit: grant.commit, conclusion: "success", runId: 1,
				runUrl: "https://github.com/Wenzayyds/agent/actions/runs/1",
				jobs: ["offline-engineering (ubuntu-latest)", "offline-engineering (windows-latest)", "docker-isolation"]
					.map((name) => ({ name, conclusion: "success" })),
			}));
			const load = () => loadTaskPairAuthorization(path, root, grant.commit, grant.batchId, ciPath, SWE_PRO_TASK_PROFILE);
			for (const invalid of [
				{ ...grant, profile: SWE_PRO_OFF_PROFILE },
				{ ...grant, profile: SWE_TASK_PROFILE },
				{ ...grant, configurationSha256: digest(SWE_PRO_OFF_CONFIGURATION) },
				{ ...grant, modeInputs: { ...grant.modeInputs, off: input } },
				{ ...grant, modeInputs: { v1: input, v2: input } },
				{ ...grant, modeInputs: { ...grant.modeInputs, v2: { ...input, fixtureCommit: "0".repeat(40) } } },
				{ ...grant, modeInputs: { ...grant.modeInputs, v2: { ...input, userPromptSha256: "0".repeat(64) } } },
				{ ...grant, input: { ...input, firstRequestSha256: "0".repeat(64) } },
				{ ...grant, expiresAt: "2000-01-01T00:00:00Z" },
			]) {
				writeFileSync(path, JSON.stringify(invalid));
				expect(load).toThrow();
			}
			writeFileSync(path, JSON.stringify(grant));
			expect(() => loadTaskPairAuthorization(path, root, grant.commit, grant.batchId, ciPath, SWE_PRO_OFF_PROFILE)).toThrow();
			const parsed = load();
			claimTaskPairAuthorization(path, parsed);
			expect(() => claimTaskPairAuthorization(path, parsed)).toThrow();
			const batchDir = join(dir, grant.batchId);
			mkdirSync(batchDir);
			const batch = (v1: string, v2: string, continuationReady: boolean, stoppedReason: string | null = null) =>
				writeFileSync(join(batchDir, "batch.json"), JSON.stringify({
					commit: grant.commit, batchId: grant.batchId, comparisonProfile: grant.profile,
					authorization: { id: grant.authorizationId }, stoppedReason,
					cells: [
						{ id: "v1", resultStatus: v1, continuationReady },
						{ id: "v2", resultStatus: v2 },
					],
				}));
			batch("not_run", "run", false);
			expect(() => claimTaskPairCell(path, parsed, "v2", batchDir)).toThrow();
			batch("run", "not_run", false);
			claimTaskPairCell(path, parsed, "v1", batchDir);
			expect(() => claimTaskPairCell(path, parsed, "v1", batchDir)).toThrow();
			batch("stopped", "run", false);
			expect(() => claimTaskPairCell(path, parsed, "v2", batchDir)).toThrow();
			batch("stopped", "run", true, "sandbox_operation_failure");
			expect(() => claimTaskPairCell(path, parsed, "v2", batchDir)).toThrow();
			batch("stopped", "run", true);
			claimTaskPairCell(path, parsed, "v2", batchDir);
			expect(() => claimTaskPairCell(path, parsed, "v2", batchDir)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("lists only Pro V1/V2 and rejects real execution before loading a key", () => {
		const args = ["--comparison-profile", SWE_PRO_TASK_PROFILE, "--swebench-id", SWE_PRO_TASK_CONFIGURATION.instanceId, "--swebench-mirror", root];
		const dry = invoke("run-controlled.ts", args);
		expect(dry.status, dry.stderr).toBe(0);
		expect(JSON.parse(dry.stdout)).toMatchObject({
			status: "not_run", configuration: { model: "deepseek-v4-pro", thinking: "off", retries: 0 },
			limits: { maxRuns: 2, maxRequests: 20, maxTokens: 200000, maxCostUsd: 0.4, maxBatchCostUsd: 0.8 },
			cells: [{ id: "v1" }, { id: "v2" }],
		});
		for (const entry of ["run-controlled.ts", "run-real-agent.ts"]) {
			const run = invoke(entry, [...args, "--execute", "--task-mode", "v1", "--api-key-env", "DEEPSEEK_API_KEY"]);
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
		}
		const off = invoke("run-real-agent.ts", [...args, "--task-mode", "off"]);
		expect(off.stderr).toContain("SWE_EXPERIMENT_SCOPE_INVALID");
	});
	it("binds a single Pro OFF grant to its profile, CI, input and one-use cell", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-swe-pro-grant-")));
		try {
			const path = join(dir, "grant.json"), ciPath = join(dir, "ci.json");
			const grant = {
				schemaVersion: 1,
				status: "authorized",
				authorizationId: "00000000-0000-4000-8000-000000000003",
				profile: SWE_PRO_OFF_PROFILE,
				commit: "1".repeat(40),
				batchId: "swe_pro_off_fixture",
				outputBase: dir,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				ciRunId: 1,
				configurationSha256: digest(SWE_PRO_OFF_CONFIGURATION),
				input: {
					fixtureSha256: "a".repeat(64),
					fixtureCommit: SWE_PRO_OFF_CONFIGURATION.baseCommit,
					userPromptSha256: SWE_PRO_OFF_CONFIGURATION.userPromptSha256,
					systemPromptSha256: "b".repeat(64),
					toolSchemaSha256: "c".repeat(64),
					firstRequestSha256: "d".repeat(64),
				},
			};
			writeFileSync(ciPath, JSON.stringify({
				commit: grant.commit, conclusion: "success", runId: 1,
				runUrl: "https://github.com/Wenzayyds/agent/actions/runs/1",
				jobs: ["offline-engineering (ubuntu-latest)", "offline-engineering (windows-latest)", "docker-isolation"]
					.map((name) => ({ name, conclusion: "success" })),
			}));
			const load = () => loadTaskPairAuthorization(path, root, grant.commit, grant.batchId, ciPath, SWE_PRO_OFF_PROFILE);
			for (const invalid of [
				{ ...grant, profile: SWE_TASK_PROFILE },
				{ ...grant, commit: "2".repeat(40) },
				{ ...grant, configurationSha256: digest(SWE_TASK_CONFIGURATION) },
				{ ...grant, ciRunId: 2 },
				{ ...grant, outputBase: root },
				{ ...grant, input: { ...grant.input, fixtureCommit: "0".repeat(40) } },
				{ ...grant, input: { ...grant.input, userPromptSha256: "0".repeat(64) } },
				{ ...grant, input: { ...grant.input, firstRequestSha256: "bad" } },
				{ ...grant, modeInputs: { off: grant.input } },
			]) {
				writeFileSync(path, JSON.stringify(invalid));
				expect(load).toThrow();
			}
			writeFileSync(path, JSON.stringify(grant));
			expect(() => loadTaskPairAuthorization(path, root, grant.commit, grant.batchId, ciPath, SWE_TASK_PROFILE)).toThrow();
			const parsed = load();
			claimTaskPairAuthorization(path, parsed);
			expect(() => claimTaskPairAuthorization(path, parsed)).toThrow();
			const batchDir = join(dir, grant.batchId);
			mkdirSync(batchDir);
			writeFileSync(join(batchDir, "batch.json"), JSON.stringify({
				commit: grant.commit, batchId: grant.batchId, comparisonProfile: grant.profile,
				authorization: { id: grant.authorizationId }, stoppedReason: null,
				cells: [{ id: "off", resultStatus: "run" }],
			}));
			claimTaskPairCell(path, parsed, "off", batchDir);
			expect(() => claimTaskPairCell(path, parsed, "off", batchDir)).toThrow();
			expect(() => claimTaskPairCell(path, parsed, "v1", batchDir)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("keeps Pro OFF closed without a new grant and lists only the fixed cell", () => {
		const args = ["--comparison-profile", SWE_PRO_OFF_PROFILE, "--swebench-id", SWE_PRO_OFF_CONFIGURATION.instanceId, "--swebench-mirror", root];
		const dry = invoke("run-controlled.ts", args);
		expect(dry.status, dry.stderr).toBe(0);
		expect(JSON.parse(dry.stdout)).toMatchObject({
			status: "not_run", configuration: { model: "deepseek-v4-pro", thinking: "off", retries: 0 },
			limits: { maxRuns: 1, maxCostUsd: 0.4, maxBatchCostUsd: 0.4 }, cells: [{ id: "off" }],
		});
		for (const entry of ["run-controlled.ts", "run-real-agent.ts"]) {
			const run = invoke(entry, [...args, "--execute", "--task-mode", "off", "--api-key-env", "DEEPSEEK_API_KEY"]);
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
		}
		const v1 = invoke("run-real-agent.ts", [...args, "--task-mode", "v1"]);
		expect(v1.stderr).toContain("SWE_EXPERIMENT_SCOPE_INVALID");
	});
	it("binds SWE fingerprints, CI, budget and ordered single-use cells", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-swe-grant-")));
		try {
			const path = join(dir, "grant.json"),
				ciPath = join(dir, "ci.json");
			const input = {
				fixtureSha256: "a".repeat(64),
				fixtureCommit: SWE_TASK_CONFIGURATION.baseCommit,
				userPromptSha256: SWE_TASK_CONFIGURATION.userPromptSha256,
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
			const batch = (states: string[], stoppedReason: string | null = null, continuationReady = true) =>
				writeFileSync(
					join(batchDir, "batch.json"),
					JSON.stringify({
						commit: grant.commit,
						batchId: grant.batchId,
						comparisonProfile: grant.profile,
						authorization: { id: grant.authorizationId },
						stoppedReason,
						cells: ["off", "v1", "v2"].map((id, i) => ({
							id,
							resultStatus: states[i],
							continuationReady: continuationReady && states[i] !== "not_run",
						})),
					}),
				);
			batch(["run", "not_run", "not_run"]);
			claimTaskPairCell(path, parsed, "off", batchDir);
			expect(() => claimTaskPairCell(path, parsed, "off", batchDir)).toThrow();
			batch(["run", "not_run", "run"]);
			expect(() => claimTaskPairCell(path, parsed, "v2", batchDir)).toThrow();
			batch(["run", "run", "not_run"], "isolation_boundary_stop");
			expect(() => claimTaskPairCell(path, parsed, "v1", batchDir)).toThrow();
			batch(["stopped", "run", "not_run"], null, false);
			expect(() => claimTaskPairCell(path, parsed, "v1", batchDir)).toThrow();
			batch(["stopped", "run", "not_run"]);
			claimTaskPairCell(path, parsed, "v1", batchDir);
			batch(["stopped", "failed", "run"]);
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
			limits: { maxRuns: 3, maxBatchCostUsd: 0.24 },
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
