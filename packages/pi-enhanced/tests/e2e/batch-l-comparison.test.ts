import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	claimBatchLAuthorization,
	claimBatchLCell,
	loadBatchLAuthorization,
} from "../../benchmarks/real-agent/batch-l-authorization.ts";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";

const root = resolve(import.meta.dirname, "../../../..");
const runner = join(root, "packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts");
const docker =
	spawnSync("docker", ["image", "inspect", CONTROLLED_IMAGE], { stdio: "ignore", timeout: 10_000 }).status === 0;

describe.skipIf(!docker)("Batch L paired comparison", () => {
	it("uses equal prompts, inputs and tool schemas, measures activation, and blocks unapproved real execution", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-batch-l-"));
		const grantPath = join(dir, "test-only-authorization.json");
		const testGrant = {
			schemaVersion: 1,
			status: "authorized",
			authorizationId: "00000000-0000-0000-0000-000000000000",
			batchId: "batch_l_fixture",
			commit: "0".repeat(40),
			profile: "batch-l-v1",
			provider: "deepseek",
			model: "deepseek-flash",
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
			recovery: "readonly_denials_max2",
			maxRequestsPerRun: 8,
			maxTokensPerRun: 80000,
			maxCostPerRunUsd: 0.03,
			maxBatchCostUsd: 0.18,
			maxRuns: 6,
			timeoutMs: 180000,
		};
		writeFileSync(grantPath, JSON.stringify({ ...testGrant, status: "pending" }));
		expect(() => loadBatchLAuthorization(grantPath, root, testGrant.commit, testGrant.batchId)).toThrow();
		writeFileSync(grantPath, JSON.stringify(testGrant));
		const parsedGrant = loadBatchLAuthorization(grantPath, root, testGrant.commit, testGrant.batchId);
		expect(() => loadBatchLAuthorization(grantPath, root, "f".repeat(40), testGrant.batchId)).toThrow();
		claimBatchLAuthorization(grantPath, parsedGrant, dir);
		expect(() => claimBatchLAuthorization(grantPath, parsedGrant, dir)).toThrow();
		claimBatchLCell(grantPath, parsedGrant, "m_inline", dir);
		expect(() => claimBatchLCell(grantPath, parsedGrant, "m_inline", dir)).toThrow();
		const initial: Array<{ user: string; tools: string }> = [];
		let calls = 0;
		const server = createServer((req, res) => {
			void (async () => {
				const chunks: Buffer[] = [];
				for await (const b of req) chunks.push(Buffer.from(b));
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
					messages: Array<{ role: string; content: unknown }>;
					tools: unknown;
				};
				calls++;
				const user = JSON.stringify(body.messages.find((m) => m.role === "user")?.content);
				const results = body.messages.filter((m) => m.role === "tool");
				if (!results.length) initial.push({ user, tools: JSON.stringify(body.tools) });
				const memory = user.includes("normalizeKey");
				const task = user.includes("formatter.js");
				const unavailable = results.some((r) =>
					/unavailable|disabled for this experimental group/iu.test(JSON.stringify(r.content)),
				);
				let name = "";
				let args: Record<string, unknown> = {};
				if (!results.length && (memory || task)) {
					name = memory ? "enhanced_memory_search" : "enhanced_task_get";
					args = memory ? { query: "normalizeKey", limit: 3 } : { taskId: "current" };
				} else if (results.length === 1 && unavailable) {
					name = "read";
					args = { path: memory ? "reference.md" : "task-plan.json" };
				} else if (memory || task) {
					const n = results.length - 1 - Number(unavailable);
					if (n === 0) {
						name = "read";
						args = { path: memory ? "key.js" : "formatter.js" };
					}
					if (n === 1) {
						name = "edit";
						args = {
							path: memory ? "key.js" : "formatter.js",
							edits: [
								{
									oldText: memory ? "value.trim()" : "const formatName",
									newText: memory ? "value.trim().toLowerCase()" : "export const formatName",
								},
							],
						};
					}
				} else {
					if (results.length === 0) {
						name = "read";
						args = { path: "diagnostics.txt" };
					}
					if (results.length === 1) {
						name = "read";
						args = { path: "validate.js" };
					}
					if (results.length === 2) {
						name = "edit";
						args = {
							path: "validate.js",
							edits: [{ oldText: "items.slice(0, 10).every", newText: "items.every" }],
						};
					}
				}
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				const delta = name
					? {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `call-${calls}`,
									type: "function",
									function: { name, arguments: JSON.stringify(args) },
								},
							],
						}
					: { role: "assistant", content: "fixed" };
				res.end(
					`data: ${JSON.stringify({ id: `stub-${calls}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
				);
			})().catch(() => res.writeHead(500).end());
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen");
		try {
			const legacyReport = join(root, "packages/pi-enhanced/docs/p5-real-model-results.json");
			const legacyBefore = existsSync(legacyReport) ? readFileSync(legacyReport, "utf8") : null;
			const dryRun = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					join(root, "packages/pi-enhanced/benchmarks/real-agent/run-real-agent.ts"),
					"--comparison-profile",
					"batch-l-v1",
					"--controlled-cell",
					"m_inline",
				],
				{ cwd: root, encoding: "utf8", windowsHide: true },
			);
			expect(dryRun.status, dryRun.stderr).toBe(0);
			expect(existsSync(legacyReport) ? readFileSync(legacyReport, "utf8") : null).toBe(legacyBefore);
			const env = {
				...process.env,
				PI_ENHANCED_REAL_MODEL_EVAL: "1",
				PI_ENHANCED_LOCAL_STUB_EVAL: "1",
				MOCK_PROVIDER_KEY: "mock-upstream-key",
			};
			const result = await new Promise<{ code: number | null; stderr: string }>((done) => {
				const child = spawn(
					process.execPath,
					[
						"--experimental-strip-types",
						runner,
						"--execute",
						"--batch-id",
						"batch_l_offline",
						"--comparison-profile",
						"batch-l-v1",
						"--output-dir",
						dir,
						"--local-stub-url",
						`http://127.0.0.1:${address.port}`,
					],
					{ cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
				);
				let stderr = "";
				child.stderr.on("data", (b: Buffer) => {
					stderr += b.toString();
				});
				child.stdout.on("data", () => {});
				child.once("close", (code) => done({ code, stderr }));
			});
			expect(result.code, result.stderr).toBe(0);
			const report = JSON.parse(readFileSync(join(dir, "batch_l_offline/batch.json"), "utf8"));
			if (process.env.PI_ENHANCED_BATCH_L_STUB_EVIDENCE)
				writeFileSync(
					process.env.PI_ENHANCED_BATCH_L_STUB_EVIDENCE,
					JSON.stringify({ ...report, providerCalls: calls, initialRequests: initial }, null, 2),
				);
			expect(report.stoppedReason).toBeNull();
			expect(report.cells).toHaveLength(6);
			expect(initial).toHaveLength(6);
			for (const cell of report.cells)
				expect(cell).toMatchObject({
					resultStatus: "passed",
					result: { fairness: { referencesUnchanged: true }, verification: { passed: true } },
				});
			for (let i = 0; i < 6; i += 2) {
				expect(initial[i]!.user).toBe(initial[i + 1]!.user);
				expect(initial[i]!.tools).toBe(initial[i + 1]!.tools);
			}
			const byGroup = Object.fromEntries(
				report.cells.map((c: { result: { comparisonGroup: string } }) => [c.result.comparisonGroup, c.result]),
			);
			expect(byGroup.memory_off.observations.memory.matchedSeedReturned).toBe(false);
			expect(byGroup.memory_on.observations.memory.matchedSeedReturned).toBe(true);
			expect(byGroup.task_off.observations.task.planReturned).toBe(false);
			expect(byGroup.task_on.observations.task.planReturned).toBe(true);
			expect(byGroup.task_on.observations.task.after.task.status).toBe("draft");
			expect(
				byGroup.context_on.contextAudit.diagnostics.some(
					(d: { truncatedToolResults: number }) => d.truncatedToolResults > 0,
				),
			).toBe(true);
			const denied = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					runner,
					"--execute",
					"--batch-id",
					"batch_l_denied",
					"--comparison-profile",
					"batch-l-v1",
				],
				{ cwd: root, env, encoding: "utf8", windowsHide: true },
			);
			expect(denied.status).not.toBe(0);
			expect(denied.stderr).toContain("BATCH_L_REAL_AUTHORIZATION_REQUIRED");
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);
});
