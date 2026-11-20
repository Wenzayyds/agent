import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";
import { readSandboxAuditSnapshot } from "../../src/sandbox/audit.ts";

const repository = resolve(import.meta.dirname, "../../../..");
const runnerDir = join(repository, "packages/pi-enhanced/benchmarks/real-agent");
const available =
	spawnSync("docker", ["image", "inspect", CONTROLLED_IMAGE], { stdio: "ignore", timeout: 10_000 }).status === 0 &&
	existsSync(join(repository, "packages/coding-agent/dist/bundle/cli.js"));

function sse(name: string | null, args: Record<string, unknown>, count: number): string {
	return `data: ${JSON.stringify({ id: `stub-${count}`, choices: [{ index: 0, delta: name ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${count}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: "fixed" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`;
}
function launch(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", ...args], {
			cwd: repository,
			windowsHide: true,
			env: {
				...process.env,
				PI_ENHANCED_LOCAL_STUB_EVAL: "1",
				PI_ENHANCED_REAL_MODEL_EVAL: "1",
				MOCK_PROVIDER_KEY: "mock-upstream-key",
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (b: Buffer) => {
			stderr += b.toString();
		});
		child.stdout.on("data", () => {});
		child.once("close", (code) => done({ code, stderr }));
	});
}
type Message = { role: string; content: unknown };

describe.skipIf(!available)("Batch J production Runner and crash audit", () => {
	it.each(["recover", "fatal"])(
		"controls six-cell %s without retries or budget increases",
		async (mode) => {
			const root = mkdtempSync(join(tmpdir(), "pi-batch-j-six-"));
			const policy = join(root, "user-policy.json");
			writeFileSync(policy, JSON.stringify({ schemaVersion: 1, mode: "recover_readonly_denials", maxDenials: 1 }));
			let calls = 0;
			let receivedDenials = 0;
			const server = createServer((request, response) => {
				void (async () => {
					const chunks: Buffer[] = [];
					for await (const b of request) chunks.push(Buffer.from(b));
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Message[] };
					calls++;
					const user = JSON.stringify(body.messages.find((m) => m.role === "user")?.content);
					const results = body.messages.filter((m) => m.role === "tool");
					const file = user.includes("formatter")
						? "formatter.js"
						: user.includes("diagnostics.txt")
							? "validate.js"
							: "key.js";
					let name: string | null = mode === "fatal" ? "write" : "ls";
					let args: Record<string, unknown> =
						mode === "fatal" ? { path: "../forbidden.txt", content: "denied" } : { path: ".." };
					if (results.length === 1) {
						expect(JSON.stringify(results[0]?.content)).toContain("path-outside-workspace");
						receivedDenials++;
						name = "read";
						args = { path: file };
					} else if (results.length === 2) {
						name = "edit";
						args = {
							path: file,
							edits: [
								{
									oldText:
										file === "formatter.js"
											? "const formatName"
											: file === "validate.js"
												? "items.slice(0, 10).every"
												: "value.trim()",
									newText:
										file === "formatter.js"
											? "export const formatName"
											: file === "validate.js"
												? "items.every"
												: "value.trim().toLowerCase()",
								},
							],
						};
					} else if (results.length >= 3) {
						name = null;
						args = {};
					}
					response.writeHead(200, { "Content-Type": "text/event-stream" });
					response.end(sse(name, args, calls));
				})().catch((error: unknown) => {
					response.writeHead(500).end();
					console.error(error);
				});
			});
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("listen");
			try {
				const batchId = `batch_j_six_${mode}`;
				const result = await launch([
					join(runnerDir, "run-controlled.ts"),
					"--execute",
					"--batch-id",
					batchId,
					"--output-dir",
					root,
					"--local-stub-url",
					`http://127.0.0.1:${address.port}`,
					"--offline-denial-policy",
					policy,
				]);
				expect(result.code, result.stderr).toBe(0);
				const report = JSON.parse(readFileSync(join(root, batchId, "batch.json"), "utf8"));
				if (mode === "recover") {
					expect(report.stoppedReason).toBeNull();
					expect(receivedDenials).toBe(6);
					expect(calls).toBe(24);
					for (const cell of report.cells)
						expect(cell).toMatchObject({
							status: "run",
							resultStatus: "passed",
							result: { patchStatus: "passed", auditComplete: true, terminationClassification: "completed" },
						});
				} else {
					expect(calls).toBe(1);
					expect(report.stoppedReason).toBe("isolation_boundary_stop");
					expect(report.cells[0].resultStatus).toBe("stopped");
					for (const cell of report.cells.slice(1))
						expect(cell).toMatchObject({ status: "not_run", resultStatus: "not_run" });
				}
				expect(report.reservedMaximumUsd).toBeLessThanOrEqual(0.18);
				for (const cell of report.cells.filter((c: { result?: unknown }) => c.result)) {
					expect(cell.result.gateway.requestsStarted).toBeLessThanOrEqual(8);
					expect(cell.result.gateway.committedTokenUpperBound).toBeLessThanOrEqual(40000);
					expect(cell.result.gateway.committedCostUpperBoundUsd).toBeLessThanOrEqual(0.03);
				}
				if (process.env.PI_ENHANCED_BATCH_J_OUTPUT)
					writeFileSync(
						join(process.env.PI_ENHANCED_BATCH_J_OUTPUT, `six-${mode}.json`),
						JSON.stringify(report, null, 2),
					);
			} finally {
				await new Promise<void>((done) => server.close(() => done()));
				rmSync(root, { recursive: true, force: true });
			}
		},
		180_000,
	);

	it.for([
		"recover",
		"strict",
		"write",
		"edit",
		"limit",
		"identity",
		"container",
		"container-denial",
		"grep-input",
		"grep-worker-unavailable",
		"symlink",
		"unknown",
	])("enforces %s through real Pi, gateway and Docker", { timeout: 120_000 }, async (mode, context) => {
		const root = mkdtempSync(join(tmpdir(), "pi-batch-j-runner-"));
		const policy = join(root, "user-policy.json");
		writeFileSync(policy, JSON.stringify({ schemaVersion: 1, mode: "recover_readonly_denials", maxDenials: 1 }));
		const batchId = `batch_j_${mode}_test`;
		let calls = 0;
		let denialSeen = false;
		const grepFeedback: string[] = [];
		let firstContainer = "";
		let faultBlocked: unknown;
		const server = createServer((request, response) => {
			void (async () => {
				const chunks: Buffer[] = [];
				for await (const b of request) chunks.push(Buffer.from(b));
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Message[] };
				calls++;
				const results = body.messages.filter((m) => m.role === "tool");
				if (results.length) {
					const last = JSON.stringify(results.at(-1)?.content);
					if (last.includes("path-outside-workspace")) denialSeen = true;
					expect(last).not.toContain("offline-denial-policy.json");
				}
				let name: string | null = "ls";
				let args: Record<string, unknown> = { path: ".." };
				if (["identity", "container", "container-denial", "grep-worker-unavailable", "symlink"].includes(mode)) {
					const ids = execFileSync(
						"docker",
						["ps", "--filter", `name=pi-enhanced-tools-${batchId}_m_inline`, "--format", "{{.ID}}"],
						{ encoding: "utf8", timeout: 10_000 },
					).trim();
					firstContainer = ids;
					const inspected = JSON.parse(
						execFileSync("docker", ["inspect", ids], { encoding: "utf8", timeout: 10_000 }),
					)[0];
					const workspace = inspected.Mounts[0].Source as string;
					if (mode === "identity") {
						renameSync(workspace, `${workspace}-old`);
						cpSync(`${workspace}-old`, workspace, { recursive: true });
						name = "read";
						args = { path: "key.js" };
					}
					if (mode === "grep-worker-unavailable") {
						expect(inspected.State.Running).toBe(true);
						execFileSync("docker", ["kill", ids], { stdio: "ignore", timeout: 10_000 });
						expect(execFileSync("docker", ["inspect", ids, "--format", "{{.State.Running}} {{.State.ExitCode}}"], {
							encoding: "utf8",
							timeout: 10_000,
						}).trim()).toBe("false 137");
						name = "grep";
						args = { pattern: "trim", path: "key.js" };
					} else if (mode.startsWith("container")) {
						execFileSync("docker", ["rm", "-f", ids], { stdio: "ignore", timeout: 10_000 });
						if (mode === "container") {
							name = "read";
							args = { path: "key.js" };
						}
					}
					if (mode === "symlink") {
						symlinkSync(root, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
						args = { path: "escape" };
					}
				} else if (mode === "grep-input") {
					if (results.length) grepFeedback.push(JSON.stringify(results.at(-1)?.content));
					name = calls <= 2 ? "grep" : null;
					args = { pattern: calls === 1 ? "[" : "value\\.trim\\(", path: "key.js" };
				} else if (mode === "write") {
					name = "write";
					args = { path: "../forbidden.txt", content: "must not write" };
				} else if (mode === "edit") {
					name = "edit";
					args = { path: "../key.js", edits: [{ oldText: "old", newText: "new" }] };
				} else if (mode === "unknown") {
					name = "unauthorized_tool";
					args = {};
				} else if (mode === "limit") {
					args = { path: calls === 1 ? ".." : "../.." };
				} else if (mode === "recover" && calls === 2) {
					name = "read";
					args = { path: "key.js" };
				} else if (mode === "recover" && calls === 3) {
					name = "edit";
					args = { path: "key.js", edits: [{ oldText: "value.trim()", newText: "value.trim().toLowerCase()" }] };
				} else if (mode === "recover" && calls > 3) {
					name = null;
					args = {};
				}
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.end(sse(name, args, calls));
			})().catch((error: unknown) => {
				faultBlocked = error;
				response.writeHead(500).end();
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen");
		try {
			const runId = `${batchId}_m_inline`;
			const result = await launch(
				[
					join(runnerDir, "run-real-agent.ts"),
					"--execute",
					"--controlled-cell",
					"m_inline",
					"--run-id",
					runId,
					"--local-stub-url",
					`http://127.0.0.1:${address.port}`,
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
					"40000",
					"--max-calls-per-task",
					"8",
					"--timeout-ms",
					"60000",
					"--concurrency",
					"1",
					"--budget-enforcement",
					"local_hard_gateway",
					"--sandbox-image",
					CONTROLLED_IMAGE,
					"--output-dir",
					root,
					...(mode !== "strict" && !mode.startsWith("grep-") ? ["--offline-denial-policy", policy] : []),
				],
				{ PI_ENHANCED_RECOVER_READONLY_DENIALS: "1" },
			);
			expect(result.code, result.stderr).toBe(0);
			const task = JSON.parse(readFileSync(join(root, runId, "run.json"), "utf8")).results[0];
			if (
				mode === "identity" &&
				process.platform === "win32" &&
				faultBlocked &&
				typeof faultBlocked === "object" &&
				"code" in faultBlocked &&
				faultBlocked.code === "EBUSY"
			) {
				if (process.env.PI_ENHANCED_BATCH_J_OUTPUT)
					writeFileSync(
						join(process.env.PI_ENHANCED_BATCH_J_OUTPUT, "identity.json"),
						JSON.stringify({
							status: "blocked",
							reason: "Windows EBUSY prevents replacing the live Pi cwd",
							providerCalls: calls,
							injectedIdentityReplacement: false,
						}),
					);
				context.skip("Windows EBUSY prevents replacing the live Pi cwd; Linux CI must run this case");
			}
			if (process.env.PI_ENHANCED_BATCH_J_OUTPUT)
				writeFileSync(
					join(process.env.PI_ENHANCED_BATCH_J_OUTPUT, `${mode}.json`),
					JSON.stringify({ ...task, testProviderCalls: calls, runnerStderr: result.stderr }, null, 2),
				);
			if (mode === "grep-input") {
				expect(faultBlocked).toBeUndefined();
				expect(calls).toBe(3);
				expect(grepFeedback).toHaveLength(2);
				expect(grepFeedback[0]).toContain("Invalid grep regular expression");
				expect(grepFeedback[0]).toContain("literal");
				expect(grepFeedback[1]).toContain("value.trim()");
				expect(task.gateway).toMatchObject({ state: "ready", requestsCompleted: 3, requestsRejected: 0 });
				expect(task.auditComplete).toBe(true);
				expect(task.sandboxAudit.audit).toMatchObject([
					{ toolName: "grep", status: "error", errorCode: "SANDBOX_INVALID_GREP_PATTERN" },
					{ toolName: "grep", status: "ok" },
				]);
			} else if (mode === "recover") {
				expect(denialSeen).toBe(true);
				expect(calls).toBe(4);
				expect(task).toMatchObject({
					terminationClassification: "completed",
					patchGenerated: true,
					patchStatus: "passed",
					auditComplete: true,
					toolSafety: { deniedCount: 1 },
				});
				expect(task.toolSafety.events[0].classification).toBe("tool_denied_recoverable");
				expect(new Set(task.sandboxAudit.audit.map((a: { toolName: string }) => a.toolName))).toEqual(
					new Set(["read", "edit"]),
				);
			} else {
				expect(calls).toBe(mode === "limit" ? 2 : 1);
				expect(task.gateway.lastError).toBe("GATEWAY_ISOLATION_STOP");
				expect(task.terminationClassification).toBe(
					["container", "container-denial", "grep-worker-unavailable"].includes(mode)
						? "sandbox_runtime_error"
						: "isolation_boundary_stop",
				);
				expect(task.patchGenerated).toBe(false);
				expect(task.verifierPassed).toBe(false);
				if (["strict", "write", "symlink", "limit"].includes(mode)) expect(task.sandboxAudit.audit).toHaveLength(0);
				if (mode === "container" || mode === "grep-worker-unavailable")
					expect(task.sandboxAudit.audit[0]).toMatchObject({
						status: "error",
						errorCode: "SANDBOX_INVALID_RESPONSE",
					});
			}
			if (mode.startsWith("grep-")) {
				expect(faultBlocked).toBeUndefined();
				const id = task.sandboxAudit.evidence.containerId;
				expect(id).toMatch(/^[a-f0-9]{64}$/u);
				expect(task.sandboxAudit).toMatchObject({
					integrity: "valid",
					evidence: { network: "none", readOnlyRoot: true },
				});
				expect(task.sandboxAudit.audit.every((record: { containerId: string }) => record.containerId === id)).toBe(true);
				expect(spawnSync("docker", ["inspect", id], { stdio: "ignore", timeout: 10_000 }).status).toBe(1);
			}
			expect(task.gateway.requestsStarted).toBe(calls);
			expect(task.gateway.actualTotalTokens).toBe(calls * 110);
			expect(task.gateway.actualCostUsd).toBeLessThan(0.03);
			if (process.env.PI_ENHANCED_BATCH_J_OUTPUT)
				writeFileSync(join(process.env.PI_ENHANCED_BATCH_J_OUTPUT, `${mode}.json`), JSON.stringify(task, null, 2));
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
			if (firstContainer) spawnSync("docker", ["rm", "-f", firstContainer], { stdio: "ignore" });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["after-operation", "operation-in-flight"])(
		"recovers %s durable Docker events after SIGKILL in a fresh process",
		async (phase) => {
			const root = mkdtempSync(join(tmpdir(), "pi-batch-j-crash-"));
			mkdirSync(join(root, "project"));
			writeFileSync(join(root, "project/fixture.txt"), "body must never enter audit");
			const child = spawn(
				process.execPath,
				[
					"--experimental-strip-types",
					join(repository, "packages/pi-enhanced/tests/fixtures/sandbox-audit-child.ts"),
					root,
				],
				{ stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
			);
			let containerId = "";
			let stderr = "";
			child.stderr?.on("data", (b: Buffer) => {
				stderr += b.toString();
			});
			try {
				await new Promise<void>((done, reject) => {
					const timer = setTimeout(() => reject(new Error(`audit child timeout: ${stderr}`)), 30_000);
					child.once("error", reject);
					child.once("message", (message) => {
						clearTimeout(timer);
						containerId = (message as { containerId: string }).containerId;
						done();
					});
				});
				if (phase === "operation-in-flight") {
					const dispatched = new Promise<void>((done, reject) => {
						const timer = setTimeout(() => reject(new Error("worker write was not observed")), 10_000);
						child.once("message", (event) => {
							clearTimeout(timer);
							if (!(event as { completedWorkerWrite?: boolean }).completedWorkerWrite)
								return reject(new Error("unexpected audit worker message"));
							done();
						});
					});
					child.send("start-next-operation");
					await dispatched;
					expect(readFileSync(join(root, "project/uncertain.txt"), "utf8")).toBe("durable write before audit completion");
					expect(readSandboxAuditSnapshot(join(root, "audit.json")).pending).toHaveLength(1);
				}
				const exit = new Promise<void>((done) => child.once("exit", () => done()));
				child.kill("SIGKILL");
				await exit;
				const path = join(root, "audit.json");
				const report = readSandboxAuditSnapshot(path);
				expect(report).toMatchObject({
					complete: false,
					integrity: "valid",
					recoveryState: "interrupted_or_unfinished",
					unseenEventsPossible: true,
				});
				expect(report.audit).toMatchObject([{ status: "ok", toolName: "read", runId: "batch-j-crash" }]);
				if (phase === "operation-in-flight") {
					expect(report.pending).toHaveLength(1);
					expect(report.missingOperationResults).toHaveLength(1);
					expect(report.audit).toHaveLength(1);
				}
				expect(readFileSync(path, "utf8")).not.toContain("body must never enter audit");
				const module = pathToFileURL(join(repository, "packages/pi-enhanced/src/sandbox/audit.ts")).href;
				const restarted = spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						"--input-type=module",
						"-e",
						`import {readSandboxAuditSnapshot} from ${JSON.stringify(module)};process.stdout.write(JSON.stringify(readSandboxAuditSnapshot(process.argv[1])));`,
						path,
					],
					{ encoding: "utf8", windowsHide: true },
				);
				expect(restarted.status, restarted.stderr).toBe(0);
				expect(JSON.parse(restarted.stdout)).toEqual(report);
				if (process.env.PI_ENHANCED_BATCH_J_OUTPUT)
					writeFileSync(
						join(process.env.PI_ENHANCED_BATCH_J_OUTPUT, `crash-${phase}.json`),
						JSON.stringify({ childKilled: true, restartReaderExitCode: restarted.status, ...report }, null, 2),
					);
			} finally {
				child.kill();
				if (containerId) spawnSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
				rmSync(root, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
