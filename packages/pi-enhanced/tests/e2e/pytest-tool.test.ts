import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxToolCall, getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../../../coding-agent/src/core/auth-storage.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../../coding-agent/test/model-runtime-test-utils.ts";
import { describe, expect, it, vi } from "vitest";
import { createHarness, createTestUiContext, getMessageText } from "../../../coding-agent/test/suite/harness.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { createTaskManagerExtension } from "../../src/task-manager/extension.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import { taskPytestSource, type TaskPytestSource } from "../../src/sandbox/task-evidence.ts";
import type { BudgetGatewayStatus } from "../../benchmarks/real-agent/budget-gateway.ts";
import { createContextExtension } from "../../src/context/extension.ts";
import { installCcrSessionBudget } from "../../src/context/session-budget.ts";
import { assessPytest } from "../../src/ccr/adaptive.ts";
import type { DockerSandboxBroker } from "../../src/sandbox/broker.ts";
import { loadSandboxConfig } from "../../src/sandbox/config.ts";
import { createSandboxExtension, sandboxToolAllowed } from "../../src/sandbox/extension.ts";
import { createPytestExecutor, isPytestConfig, type PytestConfig } from "../../src/sandbox/pytest.ts";
import { createSweTestFeedback, sweVerificationStatus } from "../../benchmarks/real-agent/swe-test-feedback.ts";
import { digest } from "../../benchmarks/real-agent/evaluation-identity.ts";
import { readSwePatch } from "../../benchmarks/real-agent/swe-patch.ts";
import { close, sandboxConfigForTesting, startStubProvider, textSse, toolCallSse } from "../fixtures/runner-support.ts";

const image = process.env.PI_TEST_PYTEST_IMAGE ?? "";
const policy = (files = ["calc.py", "test_calc.py"]): PytestConfig => ({ image, files, tests: ["test_calc.py"] });
const clean = (root: string) => {
	if (!root.startsWith(join(tmpdir(), "pi-pytest-test-"))) throw new Error("Unexpected test directory");
	rmSync(root, { recursive: true, force: true });
};

it("keeps run_tests disabled by default", () => {
	expect(sandboxToolAllowed("run_tests")).toBe(false);
	expect(sandboxToolAllowed("run_tests", false, false, true)).toBe(true);
});

it("accepts only policies whose default targets fit one call", () => {
	const tests = Array.from({ length: 17 }, (_, i) => `test_calc.py::test_${i}`);
	const config = { ...policy(), image: "sha256:" + "a".repeat(64) };
	expect(isPytestConfig({ ...config, tests: tests.slice(0, 16) })).toBe(true);
	expect(isPytestConfig({ ...config, tests })).toBe(false);
});

it("counts only distinct completed repairs with valid pytest failures for the same target", () => {
	const empty = { failures: 0, failedVersions: [] };
	const failed = { status: "failed", canRunAgain: true } as const;
	const initial = assessPytest(empty, failed, "initial", "test_calc.py", false);
	expect(initial).toMatchObject({ state: empty, eligible: false, reason: "no_new_repair" });
	const first = assessPytest(initial.state, failed, "revision-1", "test_calc.py", true);
	expect(first).toMatchObject({ state: { failures: 1 }, eligible: false });
	expect(assessPytest(first.state, failed, "revision-1", "test_calc.py", true).state).toEqual(first.state);
	expect(assessPytest(first.state, { status: "execution_error", canRunAgain: true }, "revision-2", "test_calc.py", true))
		.toMatchObject({ state: first.state, eligible: false });
	expect(assessPytest(first.state, { status: "passed", canRunAgain: true }, "revision-2", "test_calc.py", true))
		.toMatchObject({ state: empty, eligible: false });
	expect(assessPytest(first.state, failed, "revision-2", "other.py", true))
		.toMatchObject({ state: { failures: 1 }, eligible: false });
	expect(assessPytest(first.state, { ...failed, canRunAgain: false }, "revision-2", "test_calc.py", true))
		.toMatchObject({ state: { failures: 2 }, eligible: false, reason: "pytest_limit" });
	expect(assessPytest(first.state, failed, "revision-2", "test_calc.py", true))
		.toMatchObject({ state: { failures: 2 }, eligible: true });
});

it("blocks native edit when CCR auto has no trusted Sandbox", async () => {
	const harness = await createHarness({
		allowedToolNames: ["edit"],
		extensionFactories: [createSandboxExtension(loadSandboxConfig({}), undefined, undefined, true)],
	});
	try {
		const file = join(harness.tempDir, "calc.py");
		writeFileSync(file, "original = True\n");
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", {
				path: "calc.py", edits: [{ oldText: "original = True", newText: "original = False" }],
			})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Stopped."),
		]);
		await harness.session.prompt("Attempt the edit.");
		const result = harness.session.messages.find((m) => m.role === "toolResult");
		expect(getMessageText(result)).toContain("CCR auto requires a trusted Sandbox and pytest policy");
		expect(readFileSync(file, "utf8")).toBe("original = True\n");
	} finally {
		harness.cleanup();
	}
});

describe.skipIf(!image)("isolated pytest", () => {
	it("does not certify all-skipped or timed-out pytest, including misleading terminal text", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-pytest-test-"));
		const file = join(root, "test_calc.py");
		const cfg = sandboxConfigForTesting({ workspace: root });
		const run = createPytestExecutor(cfg, { ...policy(["test_calc.py"]), timeoutMs: 2200 });
		try {
			writeFileSync(file, "import pytest\ndef test_skip():\n    pytest.skip('1 passed')\n");
			let count: number | undefined;
			const skipped = await run(["test_calc.py"], undefined, (e) => { count = e.passesByTarget?.get("test_calc.py"); });
			expect(skipped).toMatchObject({ status: "skipped", passed: 0 });
			expect(count).toBe(0);
			writeFileSync(file, "import atexit, os, pytest\n" +
				"atexit.register(os.write, 2, b'late stderr diagnostic\\n')\n" +
				"def test_skip():\n    pytest.skip()\ndef test_pass():\n    assert True\n");
			const targets = ["test_calc.py::test_skip", "test_calc.py::test_pass"];
			const mixed = await run(targets, undefined, (e) => {
				expect(e.passesByTarget).toEqual(new Map([[targets[0], 0], [targets[1], 1]]));
			});
			expect(mixed).toMatchObject({ status: "passed", passed: 1 });
			expect(mixed.output).toContain("late stderr diagnostic");
			expect(mixed.output).not.toContain("pi-pytest-");
			writeFileSync(file, "import time\ndef test_wait():\n    time.sleep(40)\n");
			const timedOut = await run(["test_calc.py"], undefined, (e) => { count = e.passesByTarget?.get("test_calc.py"); });
			expect(timedOut.status).toBe("timeout");
			expect(count).toBeUndefined();
		} finally { clean(root); }
	}, 30_000);

	it("accepts only a current Docker result for the bound step across task connections", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-pytest-test-"));
		writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({ modules: { "task-manager": { enabled: true } } }));
		const binding = { taskId: "", stepId: "repair" };
		let source: () => TaskPytestSource | undefined = () => undefined;
		const harness = await createHarness({ extensionFactories: [
			createSandboxExtension((workspace) => sandboxConfigForTesting({ workspace }), undefined, policy()),
			createTaskManagerExtension({ agentDir, initialBinding: binding }),
			(pi) => { source = () => taskPytestSource(pi.events, scope.rootPath); },
		] });
		const scope = createProjectScope({ cwd: harness.tempDir, agentDir });
		const storage = createTaskStorageScope(scope, agentDir);
		const connections: TaskService[] = [];
		const connect = (withSandbox: boolean) => {
			const service = new TaskService(new TaskProvider(storage), 20, withSandbox ? source : undefined);
			connections.push(service);
			return service;
		};
		try {
			const service = connect(true);
			const testFile = "from calc import value\n\ndef test_value():\n    assert value == 1\n";
			const validation = { kind: "pytest" as const, target: "test_calc.py",
				expectedSha256: createHash("sha256").update(testFile).digest("hex") };
			writeFileSync(join(scope.rootPath, validation.target), testFile);
			const edit = (value: number) => writeFileSync(join(scope.rootPath, "calc.py"), `value = ${value}\n`);
			edit(0);
			const plan = service.create("repair value", [{ stepId: binding.stepId, title: "test", expectedOutcome: "pass", validation }], "host", null);
			const id = binding.taskId = plan.task.taskId;
			service.transitionTask(id, 1, "queued");
			service.transitionTask(id, 2, "running");
			harness.settingsManager.setProjectTrusted(true);
			await harness.session.bindExtensions({});
			service.transitionStep(id, binding.stepId, 1, "running");
			service.transitionStep(id, binding.stepId, 2, "verifying");
			const complete = (s: TaskService) => s.transitionStep(id, binding.stepId, 3, "completed");
			await harness.session.extensionRunner.emit({ type: "tool_execution_start", toolName: "run_tests", toolCallId: "fabricated", args: { targets: [validation.target] } });
			await harness.session.extensionRunner.emit({ type: "tool_execution_end", toolName: "run_tests", toolCallId: "fabricated",
				isError: false, durationMs: 1, result: { details: { status: "passed", exitCode: 0, completedPasses: 1 } } });
			expect(() => complete(service)).toThrow(/pytest/i);
			const run = async (target: string) => {
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("run_tests", { targets: [target] })], { stopReason: "toolUse" }),
					fauxAssistantMessage("Test result received."),
				]);
				await harness.session.prompt("Check the selected public test.");
				return service.get(id)!.evidence.filter((e) => e.kind === "sandbox_pytest").at(-1);
			};
			expect(await run(validation.target)).toMatchObject({ pytest: { status: "failed", exitCode: 1, failed: 1 } });
			expect(() => complete(service)).toThrow(/pytest/i);
			edit(1);
			expect(await run("test_calc.py::test_value")).toMatchObject({ pytest: { status: "passed" }, confidenceClass: "observed" });
			expect(() => complete(service)).toThrow(/pytest/i);
			const passed = await run(validation.target);
			expect(passed).toMatchObject({ taskId: id, stepId: binding.stepId, toolCallId: expect.any(String),
				attemptId: expect.any(String), confidenceClass: "validated", pytest: { exitCode: 0, passed: 1, target: validation.target } });
			writeFileSync(join(scope.rootPath, validation.target), testFile + "# changed\n");
			expect(() => complete(service)).toThrow(/pytest/i);
			writeFileSync(join(scope.rootPath, validation.target), testFile);
			edit(2);
			expect(() => complete(service)).toThrow(/pytest/i);
			edit(1);
			expect(() => complete(connect(false))).toThrow(/pytest/i);
			const beforePause = service.get(id)!;
			const paused = service.transitionTask(id, beforePause.task.revision, "paused");
			expect(() => complete(service)).toThrow(/pytest/i);
			const queued = service.transitionTask(id, paused.task.revision, "queued");
			service.transitionTask(id, queued.task.revision, "running");
			const child = fileURLToPath(new URL("../fixtures/task-pytest-complete-child.ts", import.meta.url));
			const accept = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", child,
				scope.rootPath, agentDir, id, image], { timeout: 15_000, windowsHide: true });
			const outcomes = await Promise.all([accept(), accept()]);
			expect(outcomes.map((result) => result.stdout).sort()).toEqual(["completed", "revision_conflict"]);
			expect(service.get(id)!.steps[0]?.status).toBe("completed");
			expect(() => complete(service)).toThrow(/changed/i);
			expect(service.get(id)!.task.status).toBe("running");
		} finally {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			for (const s of connections) s.close();
			harness.cleanup();
			clean(agentDir);
		}
	}, 90_000);

	it("feeds a failed SWE patch back to Pi and binds a later pass to the exported revision", async () => {
		const sandbox = (cwd: string) => sandboxConfigForTesting({ workspace: cwd, runId: "swe-pytest-loop" });
		const harness = await createHarness({ extensionFactories: [createSweTestFeedback({
			...policy(), tests: ["test_calc.py::test_negative", "test_calc.py::test_positive"],
			instanceId: "example__example-100", baseCommit: "a".repeat(40),
		}, sandbox)] });
		const cwd = harness.tempDir;
		const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
		try {
			writeFileSync(join(cwd, "calc.py"), "def clamp(x):\n    return 0\n");
			writeFileSync(join(cwd, "test_calc.py"), "from calc import clamp\ndef test_positive():\n    assert clamp(4) == 4\ndef test_negative():\n    assert clamp(-2) == 0\n");
			git("init");
			git("add", "calc.py", "test_calc.py");
			git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
			await harness.session.bindExtensions({});
			const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			const edit = (oldText: string, newText: string) => call("edit", { path: "calc.py", edits: [{ oldText, newText }] });
			harness.setResponses([
				call("run_tests", { targets: ["test_calc.py"] }),
				edit("return 0", "return x"),
				call("run_tests", { targets: ["test_calc.py::test_negative"] }),
				edit("return x", "return max(0, x)"),
				call("run_tests", { targets: ["test_calc.py::test_negative", "test_calc.py::test_positive"] }),
				fauxAssistantMessage("Finished after both public tests passed."),
			]);
			await harness.session.prompt("Fix clamp and verify the public tests.");
			const results = harness.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "run_tests").map((m) => JSON.parse(getMessageText(m)));
			expect(results).toHaveLength(3);
			expect(results[0]).toMatchObject({ status: "unavailable", reason: "unsupported", exitCode: null });
			expect(results[1]).toMatchObject({ status: "failed", exitCode: 1, failed: 1, canRunAgain: true });
			expect(results[1].output).toContain("assert -2 == 0");
			expect(results[2]).toMatchObject({ status: "passed", exitCode: 0, passed: 2 });
			expect(results[2].patchSha256).not.toBe(results[1].patchSha256);
			const verification = () => sweVerificationStatus(sandbox(cwd).runRoot, digest(readSwePatch(cwd)));
			expect(verification()).toMatchObject({ status: "passed", targets: ["test_calc.py::test_negative", "test_calc.py::test_positive"] });
			writeFileSync(join(cwd, "calc.py"), "def clamp(x):\n    return x\n");
			expect(verification()).toMatchObject({ status: "failed", targets: ["test_calc.py::test_negative"] });
			writeFileSync(join(cwd, "calc.py"), "def clamp(x):\n    return -1\n");
			expect(verification()).toMatchObject({ status: "unavailable", reason: "patch_changed_or_unavailable" });
		} finally {
			try {
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				harness.cleanup();
			}
		}
	}, 60_000);

	it("keeps skipped tests and the Requests smoke check distinct from issue verification", async () => {
		const target = "test_requests.py::RequestsTestCase::test_basic_building";
		const sandbox = (workspace: string) => sandboxConfigForTesting({ workspace, runId: "swe-public-check" });
		const harness = await createHarness({ extensionFactories: [createSweTestFeedback({
			...policy(["calc.py", "test_requests.py"]), tests: [target],
			instanceId: "psf__requests-1142", baseCommit: "a".repeat(40),
		}, sandbox)] });
		const cwd = harness.tempDir;
		const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
		try {
			writeFileSync(join(cwd, "calc.py"), "enabled = False\n");
			writeFileSync(join(cwd, "test_requests.py"),
				"import unittest\nfrom calc import enabled\nclass RequestsTestCase(unittest.TestCase):\n" +
				"    @unittest.skipUnless(enabled, 'disabled')\n    def test_basic_building(self):\n        self.assertTrue(enabled)\n");
			git("init");
			git("add", "calc.py", "test_requests.py");
			git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
			await harness.session.bindExtensions({});
			for (const [source, status, reason] of [
				["enabled = 0", "skipped", "pytest"], ["enabled = True", "passed", "request_construction_only_issue_unverified"],
			]) {
				writeFileSync(join(cwd, "calc.py"), source + "\n");
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("run_tests", { targets: [target] })], { stopReason: "toolUse" }),
					fauxAssistantMessage("Checked the public target."),
				]);
				await harness.session.prompt("Run the public test.");
				const message = harness.session.messages.findLast((m) => m.role === "toolResult" && m.toolName === "run_tests");
				expect(JSON.parse(getMessageText(message))).toMatchObject({ status, reason });
				expect(sweVerificationStatus(sandbox(cwd).runRoot, digest(readSwePatch(cwd)))).toMatchObject({ status, reason });
			}
		} finally {
			try { await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
			finally { harness.cleanup(); }
		}
	});

	it("does not register run_tests without trusted opt-in", async () => {
		let broker: DockerSandboxBroker | undefined;
		const harness = await createHarness({ extensionFactories: [createSandboxExtension(
			(cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "pytest-disabled" }),
			(value) => { broker = value; },
		)] });
		try {
			await harness.session.bindExtensions({});
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("run_tests");
		} finally { broker?.stop(); harness.cleanup(); }
	});
	it.each(["{", '{"image":42,"files":{}}'])("keeps Docker file tools active with invalid pytest configuration %s", async (value) => {
		let broker: DockerSandboxBroker | undefined;
		vi.stubEnv("PI_ENHANCED_PYTEST_ENABLED", "1");
		vi.stubEnv("PI_ENHANCED_PYTEST_CONFIG_JSON", value);
		const factory = (() => {
			try {
				return createSandboxExtension(
					(cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "pytest-invalid" }),
					(value) => { broker = value; },
				);
			} finally {
				vi.unstubAllEnvs();
			}
		})();
		const harness = await createHarness({ extensionFactories: [factory] });
		try {
			await harness.session.bindExtensions({});
			expect(broker?.getEvidence()?.network).toBe("none");
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("run_tests");
		} finally {
			broker?.stop();
			harness.cleanup();
		}
	});
	it("uses real failure feedback and fresh code through the native Pi loop", async () => {
		let broker: DockerSandboxBroker | undefined;
		const harness = await createHarness({ allowedToolNames: ["read", "edit", "run_tests"], extensionFactories: [
			createSandboxExtension((cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "pytest-loop" }), (value) => { broker = value; }, policy()),
		] });
		try {
			writeFileSync(join(harness.tempDir, "calc.py"), "def clamp(x):\n    return 0\n");
			writeFileSync(join(harness.tempDir, "test_calc.py"), "from calc import clamp\ndef test_positive():\n    assert clamp(4) == 4\ndef test_negative():\n    assert clamp(-2) == 0\n");
			await harness.session.bindExtensions({});
			const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			harness.setResponses([
				call("read", { path: "calc.py" }), call("read", { path: "test_calc.py" }),
				call("edit", { path: "calc.py", edits: [{ oldText: "return 0", newText: "return x" }] }),
				call("run_tests", { targets: ["test_calc.py"] }),
				call("edit", { path: "calc.py", edits: [{ oldText: "return x", newText: "return max(0, x)" }] }),
				call("run_tests", {}), fauxAssistantMessage("The second test run passed."),
			]);
			await harness.session.prompt("Fix clamp so negative values become zero and positive values are unchanged. Run the approved tests.");
			const results = harness.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "run_tests").map((m) => JSON.parse(getMessageText(m)));
			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({ status: "failed", passed: 1, failed: 1, exitCode: 1 });
			expect(results[0].output).toContain("test_negative");
			expect(results[0].output).toContain("assert -2 == 0");
			expect(results[1]).toMatchObject({ status: "passed", targets: ["test_calc.py"], passed: 2, failed: 0, exitCode: 0 });
			expect(readFileSync(join(harness.tempDir, "calc.py"), "utf8")).toContain("max(0, x)");
		} finally { broker?.stop(); harness.cleanup(); }
	}, 60_000);

	it.each([
		{ mode: "approved", baseline: false, approve: true, confirm: true, usePro: true },
		{ mode: "declined", baseline: false, approve: false, confirm: true, usePro: false },
		{ mode: "spent", baseline: true, approve: true, confirm: false, usePro: false },
		{ mode: "manual", baseline: false, approve: true, confirm: false, usePro: false },
		{ mode: "strong", baseline: false, approve: true, confirm: false, usePro: false },
	])("routes after real pytest feedback only with confirmation and a remaining call ($mode)", async (scenario) => {
		let broker: DockerSandboxBroker | undefined;
		const flash = "DeepSeek/deepseek-flash";
		const pro = "DeepSeek/deepseek-v4-pro";
		const initial = scenario.mode === "strong" ? pro : flash;
		const other = initial === pro ? flash : pro;
		const harness = await createHarness({
			provider: "local-ccr", models: [{ id: initial }, { id: other }],
			...(scenario.mode === "manual" ? { allowedToolNames: ["edit", "run_tests"] } : { initialActiveToolNames: [] }),
			extensionFactories: [createSandboxExtension(
				(cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "ccr-adaptive" }),
				(value) => { broker = value; }, policy(), scenario.mode !== "manual",
			)],
		});
		const confirm = vi.fn(async () => scenario.approve);
		try {
			writeFileSync(join(harness.tempDir, "calc.py"), "def clamp(x):\n    return 0\n");
			writeFileSync(join(harness.tempDir, "test_calc.py"), "from calc import clamp\ndef test_clamp(): assert clamp(4) == 4\n");
			harness.session.setScopedModels(harness.models.map((model) => ({ model })));
			await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ confirm }) });
			const test = () => fauxAssistantMessage([fauxToolCall("run_tests", { targets: ["test_calc.py"] })], { stopReason: "toolUse" });
			const edit = (oldText: string, newText: string) => fauxAssistantMessage([
				fauxToolCall("edit", { path: "calc.py", edits: [{ oldText, newText }] }),
			], { stopReason: "toolUse" });
			harness.setResponses([
				...(scenario.baseline ? [test()] : []),
				edit("return 0", "return 1"), test(),
				(_context, _options, _state, model) => { expect(model.id).toBe(initial); return edit("return 1", "return 2"); },
				test(),
				(context, _options, _state, model) => {
					expect(model.id).toBe(scenario.usePro ? pro : initial);
					const last = context.messages.at(-1);
					const call = context.messages.at(-2);
					expect(last).toMatchObject({ role: "toolResult", toolName: "run_tests" });
					expect(call).toMatchObject({ role: "assistant", content: [expect.objectContaining({ id: last?.role === "toolResult" ? last.toolCallId : undefined })] });
					return scenario.usePro ? edit("return 2", "return max(0, x)") : fauxAssistantMessage("Stopping.");
				},
				...(scenario.usePro ? [test(), fauxAssistantMessage("Verified.")] : []),
			]);
			await harness.session.prompt("Repair clamp and verify with the approved pytest file.");
			expect(confirm).toHaveBeenCalledTimes(scenario.confirm ? 1 : 0);
			if (scenario.confirm) expect(confirm.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining("Token")]));
			const results = harness.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "run_tests")
				.map((m) => JSON.parse(getMessageText(m)).status);
			expect(results).toEqual(scenario.usePro ? ["failed", "failed", "passed"] : scenario.baseline ? ["failed", "failed", "failed"] : ["failed", "failed"]);
			expect(harness.session.model?.id).toBe(scenario.usePro ? pro : initial);
			const changes = harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change" && entry.modelId === pro);
			expect(changes).toHaveLength(scenario.usePro ? 1 : 0);
			if (scenario.usePro) expect(readFileSync(join(harness.tempDir, "calc.py"), "utf8")).toContain("return max(0, x)");
		} finally { broker?.stop(); harness.cleanup(); }
	}, 60_000);


	it.each([false, true])("shares one durable Gateway budget when CCR switches from Flash to Pro after Docker pytest (retry %s)", async (retry) => {
		const root = mkdtempSync(join(tmpdir(), "pi-pytest-test-ccr-budget-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const flash = "DeepSeek/deepseek-flash";
		const pro = "DeepSeek/deepseek-v4-pro";
		const calls: Record<string, unknown>[] = [];
		const edit = (oldText: string, newText: string, input: number) => toolCallSse(
			"edit", { path: "calc.py", edits: [{ oldText, newText }] }, input, 20,
		);
		const test = (input: number) => toolCallSse("run_tests", { targets: ["test_calc.py"] }, input, 20);
		const responses = [
			edit("return 0", "return 1", 101), test(102), edit("return 1", "return 2", 103), test(104),
			edit("return 2", "return max(0, x)", 105), test(106), textSse("Verified through Pro.", 107, 20),
		];
		const stub = await startStubProvider((body, response) => {
			const sse = responses[calls.length];
			calls.push(body);
			if (!sse) { response.writeHead(500).end(); return; }
			response.writeHead(200, { "Content-Type": "text/event-stream" }).end(
				sse.replaceAll('"model":"deepseek-flash"', '"model":' + JSON.stringify(body.model)),
			);
		});
		const baseUrl = stub.url + "/v1";
		const maxRequests = retry ? 8 : 7;
		let connectAttempts = 0;
		const ledger = () => {
			const db = new DatabaseSync(join(agentDir, "pi-enhanced-budget.sqlite3"), { readOnly: true });
			try {
				return (db.prepare("SELECT id, body FROM gateway_budget_runs").all() as { id: string; body: string }[])
					.map(({ id, body }) => ({ id, ...JSON.parse(body) as { deadlineAt: number; status: BudgetGatewayStatus } }));
			} finally { db.close(); }
		};
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let broker: DockerSandboxBroker | undefined;
		try {
			vi.stubEnv("PI_ENHANCED_CCR_BUDGET", JSON.stringify({ baseUrl, models: [flash, pro] }));
			vi.stubEnv("PI_ENHANCED_CCR_BUDGET_KEY", "mock-upstream-key");
			writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({ budget: { maxRequests } }));
			if (retry) {
				const send = globalThis.fetch;
				vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					if (input === `${baseUrl}/chat/completions` && ++connectAttempts === 2) {
						// The first edit has already committed. The retried request asks the model for the next action.
						expect(readFileSync(join(root, "calc.py"), "utf8")).toContain("return 1");
						throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
					}
					return send(input, init);
				});
			}
			writeFileSync(join(root, "calc.py"), "def clamp(x):\n    return 0\n");
			writeFileSync(join(root, "test_calc.py"), "from calc import clamp\ndef test_clamp(): assert clamp(4) == 4\n");

			const auth = AuthStorage.inMemory();
			const registry = await createInMemoryModelRegistry(auth);
			registry.registerProvider("local-ccr", {
				baseUrl, api: "openai-completions", apiKey: "deliberately-invalid-sdk-token",
				models: [flash, pro].map((id) => ({ ...getModel("openai", "gpt-4o"), id, name: id, baseUrl, provider: "local-ccr", api: "openai-completions" as const })),
			});
			const models = [registry.find("local-ccr", flash)!, registry.find("local-ccr", pro)!];
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } });
			settingsManager.setProjectTrusted(true);
			const resourceLoader = new DefaultResourceLoader({
				cwd: root, agentDir, settingsManager, noExtensions: true,
				extensionFactories: [
					(pi) => installCcrSessionBudget(pi, agentDir),
					createContextExtension({ agentDir }),
					createSandboxExtension((cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "ccr-shared-budget" }),
						(value) => { broker = value; }, policy(), true),
				],
			});
			await resourceLoader.reload();
			expect(process.env.PI_ENHANCED_CCR_BUDGET_KEY).toBeUndefined();
			({ session } = await createAgentSession({
				cwd: root, agentDir, modelRuntime: getModelRuntime(registry), model: models[0]!,
				settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(), noBuiltinTools: true,
			}));
			let before: ReturnType<typeof ledger> | undefined;
			const confirm = vi.fn(async () => { before = ledger(); return true; });
			session.setScopedModels(models.map((model) => ({ model })));
			await session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ confirm }) });
			await session.prompt("Repair clamp and run the approved pytest case.");
			expect(confirm, JSON.stringify({ calls: calls.map(({ model }) => model),
				last: session.messages.at(-1), tools: session.messages.filter((m) => m.role === "toolResult").map(getMessageText), audit: session.sessionManager.getEntries().filter(
					(entry) => entry.type === "custom" && entry.customType === "ccr-adaptive",
				),
			})).toHaveBeenCalledTimes(1);
			expect(before).toHaveLength(1);
			const [flashRow] = before!;
			expect(flashRow?.status).toMatchObject({ requestsStarted: retry ? 5 : 4, requestsCompleted: 4, actualTotalTokens: 490,
				actualCostUsd: 0.000219, reservedCostUsd: 0 });
			const rows = ledger();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ id: flashRow?.id, deadlineAt: flashRow?.deadlineAt,
				status: { requestsStarted: maxRequests, requestsCompleted: 7, actualTotalTokens: 868, reservedCostUsd: 0 } });
			expect(rows[0]!.status.actualCostUsd).toBeCloseTo(0.00087636, 12);
			const verdicts = rows[0]!.status.requestOutcomes;
			expect(verdicts.filter(({ usageSeen }) => usageSeen).map(({ modelId }) => modelId))
				.toEqual([flash, flash, flash, flash, pro, pro, pro]);
			if (retry) {
				expect(connectAttempts).toBe(8);
				expect(verdicts[1]).toMatchObject({ outcome: "GATEWAY_UPSTREAM_CONNECT_TIMEOUT",
					settlement: { committedTokens: 0, committedCostUsd: 0 } });
			}
			const editResults = session.messages.filter((m) => m.role === "toolResult" && m.toolName === "edit");
			expect(editResults).toHaveLength(3);
			expect(editResults.every((m) => m.role === "toolResult" && !m.isError)).toBe(true);
			expect(calls.map(({ model }) => model)).toEqual([flash, flash, flash, flash, pro, pro, pro]);
			expect(calls.every(({ max_tokens, stream_options }) =>
				Number(max_tokens) <= 512 && (stream_options as { include_usage?: boolean }).include_usage)).toBe(true);
			const outcomes = session.messages.filter((m) => m.role === "toolResult" && m.toolName === "run_tests")
				.map((message) => JSON.parse(getMessageText(message)).status);
			expect(outcomes).toEqual(["failed", "failed", "passed"]);
			expect(getMessageText(session.messages.at(-1))).toBe("Verified through Pro.");
			await session.prompt("One more request after reaching the shared count.");
			expect(calls).toHaveLength(7);
			expect(ledger()[0]?.status.denials.at(-1)).toMatchObject({ code: "GATEWAY_REQUEST_LIMIT", upstreamForwarded: false });
		} finally {
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown" });
				session.dispose();
			}
			await broker?.stop();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await close(stub.server);
			clean(root);
		}
	}, 90_000);

	it("denies host data, writes, network and Docker socket; caps output and call count", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-pytest-test-"));
		try {
			writeFileSync(join(root, ".env"), "HOST_SECRET=never-copy");
			writeFileSync(join(root, "calc.py"), "ORIGINAL = True\n");
			writeFileSync(join(root, "test_calc.py"), `import os, socket, pathlib, pytest
def test_isolation():
    assert not pathlib.Path('/workspace/.env').exists()
    assert not pathlib.Path('/var/run/docker.sock').exists()
    assert 'HOST_SECRET' not in os.environ
    assert os.getuid() != 0
    status = pathlib.Path('/proc/self/status').read_text()
    assert 'CapEff:\t0000000000000000' in status
    assert 'NoNewPrivs:\t1' in status
    with pytest.raises(OSError): pathlib.Path('/workspace/calc.py').write_text('changed')
    with pytest.raises(OSError): pathlib.Path('/etc/escape').write_text('changed')
    with pytest.raises(OSError): socket.create_connection(('1.1.1.1', 443), timeout=1)
def test_output():
    assert False, 'x' * 20000
`);
			const execute = createPytestExecutor(sandboxConfigForTesting({ workspace: root, runId: "pytest-safety" }), policy());
			expect((await execute(["test_calc.py; id"])).status).toBe("unsupported");
			expect((await execute(["../test_calc.py"])).status).toBe("unsupported");
			const result = await execute(["test_calc.py"]);
			expect(result).toMatchObject({ status: "failed", passed: 1, failed: 1, truncated: true });
			expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
			expect(readFileSync(join(root, "calc.py"), "utf8")).toBe("ORIGINAL = True\n");
			writeFileSync(join(root, "test_calc.py"), "import missing_dependency\n");
			expect((await execute(["test_calc.py"])).status).toBe("unsupported");
			writeFileSync(join(root, "test_calc.py"), "def test_ok(): assert True\n");
			expect((await execute(["test_calc.py"])).status).toBe("passed");
			expect((await execute(["test_calc.py"])).status).toBe("sandbox_error");
		} finally { clean(root); }
	}, 60_000);

	it("rejects protected paths and junctions and cleans timed-out containers", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-pytest-test-"));
		try {
			const config = sandboxConfigForTesting({ workspace: root, runId: "pytest-negative" });
			for (const path of [".env", ".git/config", "../test_calc.py", "secrets.txt", "data.sqlite"])
				expect(() => createPytestExecutor(config, { image, files: [path], tests: [path] })).toThrow();
			mkdirSync(join(root, "actual"));
			writeFileSync(join(root, "actual", "test_calc.py"), "def test_ok(): pass\n");
			symlinkSync(join(root, "actual"), join(root, "linked"), "junction");
			const link = "linked/test_calc.py";
			expect((await createPytestExecutor(config, { image, files: [link], tests: [link] })([link])).status).toBe("sandbox_error");
			writeFileSync(join(root, "test_calc.py"), "import time\ndef test_wait(): time.sleep(60)\n");
			const execute = createPytestExecutor(config, { ...policy(["test_calc.py"]), timeoutMs: 1500 });
			expect((await execute(["test_calc.py"])).status).toBe("timeout");
			expect(execFileSync("docker", ["ps", "-aq", "--filter", "name=pi-pytest-"], { encoding: "utf8" }).trim()).toBe("");
		} finally { clean(root); }
	}, 30_000);
});
