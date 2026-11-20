import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { assertSandboxWorkspaceIdentity } from "../../src/sandbox/config.ts";
import { createSandboxExtension } from "../../src/sandbox/extension.ts";
import { pytestFileVersions } from "../../src/sandbox/pytest.ts";
import { type FeedbackFixture, runApprovedTestInDocker } from "./docker-verifier.ts";

export function createJsTestFeedback(taskId: FeedbackFixture) {
	const configDefault = taskId === "config-default";
	const file = configDefault ? "config.js" : taskId === "single-file-off-by-one" ? "math.js" : "key.js";
	return createSandboxExtension(undefined, undefined, undefined, false, (pi, config, isActive) => {
		const prior = process.env.PI_ENHANCED_V3_PRIOR_TEST_CALLS;
		let calls = prior === undefined ? 0 : (/^[0-3]$/u.test(prior) ? Number(prior) : 3);
		let running = false;
		const reply = (details: { status: string; stdout: string; stderr: string; exitCode: number | null }) => {
			const { status, exitCode, stdout, stderr } = details;
			const passed = status === "passed";
			const visible = passed
				? { status, exitCode, ...(stdout && { stdout: stdout.trimEnd() }), ...(stderr && { stderr }) }
				: details;
			return {
				content: [{ type: "text" as const, text: JSON.stringify(visible) }],
				details,
				isError: !passed,
			};
		};
		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "edit" && event.toolName !== "write") return;
			const path = event.input.path;
			if (!isActive() || typeof path !== "string" || resolve(ctx.cwd, path) !== join(ctx.cwd, file))
				return { block: true, reason: `This task permits writing only ${file}.` };
		});
		pi.registerTool({
			name: "run_tests",
			label: "Run approved JavaScript test",
			description: configDefault
				? "Test both timeout cases in read-only Docker. At most three calls."
				: taskId === "memory-guided-regression"
					? "Test the index key lookup in read-only Docker. At most three calls."
					: "Test sumTo in read-only Docker. At most three calls.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute(_id, _args, signal) {
				if (!isActive() || !config.trusted || !config.containerOwner || signal?.aborted || running || calls >= 3)
					return reply({ status: "unavailable", stdout: "", stderr: "Test unavailable or execution limit reached.", exitCode: null });
				calls++;
				running = true;
				let root: string | undefined;
				try {
					assertSandboxWorkspaceIdentity(config);
					root = mkdtempSync(join(config.runRoot, "single-file-test-"));
					const snapshot = join(root, "workspace");
					mkdirSync(snapshot, { mode: 0o755 });
					pytestFileVersions(config, { files: [file] }, snapshot);
					writeFileSync(join(snapshot, "package.json"), '{"type":"module"}', { flag: "wx", mode: 0o444 });
					const workspace = realpathSync(snapshot);
					const { dev, ino } = lstatSync(workspace);
					const { result, stdout, stderr } = await runApprovedTestInDocker(
						taskId,
						{ ...config, workspace, workspaceDevice: dev, workspaceInode: ino }, signal,
					);
					return reply({
						status: result.status,
						exitCode: result.containerExitCode ?? result.exitCode,
						stdout,
						stderr: stderr || (result.passed ? "" : (result.errorCode ?? "")),
					});
				} catch {
					return reply({ status: "runtime_error", stdout: "", stderr: "Approved test snapshot or execution failed.", exitCode: null });
				} finally {
					running = false;
					if (root) rmSync(root, { recursive: true, force: true });
				}
			},
		});
	}, {
		read: "Read a file, optionally by line range.",
		grep: "Search file contents by pattern.",
		find: "Find files by glob.",
		ls: "List directory entries.",
		write: `Replace the contents of ${file}.`,
		edit: `Replace exact, unique text in ${file}.`,
	});
}

export default createJsTestFeedback(
	process.env.PI_ENHANCED_V3_RECOVERY_PHASE && process.env.PI_ENHANCED_V3_TASK_ID && process.env.PI_ENHANCED_V3_JOINT_FIXTURE === "1"
		? "memory-guided-regression" : "single-file-off-by-one",
);
