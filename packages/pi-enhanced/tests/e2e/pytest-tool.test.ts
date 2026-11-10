import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../../../coding-agent/test/suite/harness.ts";
import type { DockerSandboxBroker } from "../../src/sandbox/broker.ts";
import { createSandboxExtension, sandboxToolAllowed } from "../../src/sandbox/extension.ts";
import { createPytestExecutor, type PytestConfig } from "../../src/sandbox/pytest.ts";
import { sandboxConfigForTesting } from "../fixtures/runner-support.ts";

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

describe.skipIf(!image)("isolated pytest", () => {
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
				call("run_tests", { targets: ["test_calc.py"] }), fauxAssistantMessage("The second test run passed."),
			]);
			await harness.session.prompt("Fix clamp so negative values become zero and positive values are unchanged. Run the approved tests.");
			const results = harness.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "run_tests").map((m) => JSON.parse(getMessageText(m)));
			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({ status: "failed", passed: 1, failed: 1, exitCode: 1 });
			expect(results[0].output).toContain("test_negative");
			expect(results[0].output).toContain("assert -2 == 0");
			expect(results[1]).toMatchObject({ status: "passed", passed: 2, failed: 0, exitCode: 0 });
			expect(readFileSync(join(harness.tempDir, "calc.py"), "utf8")).toContain("max(0, x)");
		} finally { broker?.stop(); harness.cleanup(); }
	}, 60_000);

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
