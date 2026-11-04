import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";

const root = resolve(import.meta.dirname, "../../../..");
const docker =
	spawnSync("docker", ["image", "inspect", CONTROLLED_IMAGE], { stdio: "ignore", timeout: 10000 }).status === 0;
describe.skipIf(!docker)("Batch N production telemetry", () => {
	it("runs paired six-cell Stub with trusted tool correlation and identical patches when disabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-n-e2e-"));
		let calls = 0;
		let batchCalls = 0;
		let attack = false;
		let requestLimit = false;
		const server = createServer((req, res) => {
			void (async () => {
				const buffers: Buffer[] = [];
				for await (const b of req) buffers.push(Buffer.from(b));
				const body = JSON.parse(Buffer.concat(buffers).toString("utf8")) as {
					messages: Array<{ role: string; content: unknown }>;
				};
				calls++;
				batchCalls++;
				const user = JSON.stringify(body.messages.find((m) => m.role === "user")?.content);
				const memory = user.includes("normalizeKey"),
					task = user.includes("formatter.js");
				const results = body.messages.filter((m) => m.role === "tool");
				const tool = (name: string, args: Record<string, unknown>) => ({ name, args });
				let operations: Array<{ name: string; args: Record<string, unknown> }> = [];
				if (requestLimit) operations = [tool("read", { path: "key.js", offset: 1, limit: 10 })];
				else if (attack) operations = [tool("ls", { path: ".." })];
				else if (memory || task) {
					if (results.length === 0)
						operations = [
							tool(
								memory ? "enhanced_memory_search" : "enhanced_task_get",
								memory ? { query: "normalizeKey", limit: 3 } : { taskId: "current" },
							),
							tool("read", { path: memory ? "reference.md" : "task-plan.json", offset: 1, limit: 100 }),
						];
					else if (results.length === 2)
						operations = [tool("read", { path: memory ? "key.js" : "formatter.js", offset: 1, limit: 100 })];
					else if (results.length === 3)
						operations = [
							tool("edit", {
								path: memory ? "key.js" : "formatter.js",
								edits: [
									{
										oldText: memory ? "value.trim()" : "const formatName",
										newText: memory ? "value.trim().toLowerCase()" : "export const formatName",
									},
								],
							}),
						];
				} else {
					if (results.length === 0)
						operations = [tool("read", { path: "diagnostics.txt", offset: 1, limit: 200 })];
					else if (results.length === 1)
						operations = [
							tool("read", { path: "diagnostics.txt", offset: 201, limit: 100 }),
							tool("read", { path: "validate.js", offset: 1, limit: 10 }),
						];
					else if (results.length === 3)
						operations = [
							tool("edit", {
								path: "validate.js",
								edits: [{ oldText: "items.slice(0, 10).every", newText: "items.every" }],
							}),
						];
					else if (results.length === 4)
						operations = [tool("read", { path: "validate.js", offset: 1, limit: 10 })];
				}
				const delta = operations.length
					? {
							role: "assistant",
							tool_calls: operations.map((o, index) => ({
								index,
								id: `n-call-${calls}-${index}`,
								type: "function",
								function: { name: o.name, arguments: JSON.stringify(o.args) },
							})),
						}
					: { role: "assistant", content: "done" };
				const data = {
					id: `n-response-${calls}`,
					choices: [{ index: 0, delta, finish_reason: operations.length ? "tool_calls" : "stop" }],
				};
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(
					`data: ${JSON.stringify(data)}\n\ndata: ${JSON.stringify({ id: `n-response-${calls}`, choices: [], usage: { prompt_tokens: 100 + batchCalls, completion_tokens: 10 + batchCalls, total_tokens: 110 + 2 * batchCalls } })}\n\ndata: [DONE]\n\n`,
				);
			})().catch(() => res.writeHead(500).end());
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("listen");
		try {
			const reports: unknown[] = [];
			for (const enabled of [true, false, true, true]) {
				batchCalls = 0;
				attack = reports.length === 2;
				requestLimit = reports.length === 3;
				const batchId = requestLimit
					? "batch_n_request_limit"
					: attack
						? "batch_n_negative"
						: enabled
							? "batch_n_trace_on"
							: "batch_n_trace_off";
				const code = await new Promise<number | null>((done) => {
					const child = spawn(
						process.execPath,
						[
							"--experimental-strip-types",
							join(root, "packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts"),
							"--execute",
							"--comparison-profile",
							"batch-n-v1",
							"--batch-id",
							batchId,
							"--output-dir",
							dir,
							"--local-stub-url",
							`http://127.0.0.1:${address.port}`,
							...(enabled ? ["--evaluation-telemetry"] : []),
						],
						{
							cwd: root,
							env: {
								...process.env,
								PI_ENHANCED_REAL_MODEL_EVAL: "1",
								PI_ENHANCED_LOCAL_STUB_EVAL: "1",
								MOCK_PROVIDER_KEY: "stub-only",
							},
							windowsHide: true,
							stdio: ["ignore", "pipe", "pipe"],
						},
					);
					child.stdout.on("data", () => {});
					child.stderr.on("data", () => {});
					child.once("close", done);
				});
				expect(code).toBe(0);
				const report = JSON.parse(readFileSync(join(dir, batchId, "batch.json"), "utf8"));
				reports.push(report);
				if (process.env.PI_ENHANCED_BATCH_N_EVIDENCE)
					writeFileSync(
						join(process.env.PI_ENHANCED_BATCH_N_EVIDENCE, `${batchId}.json`),
						JSON.stringify(report, null, 2),
					);
				if (attack) {
					expect(report.stoppedReason).not.toBeNull();
					expect(batchCalls).toBe(1);
					expect(report.cells[0].result.gateway.requestsStarted).toBe(1);
					expect(report.cells.slice(1).every((c: { resultStatus: string }) => c.resultStatus === "not_run")).toBe(
						true,
					);
					continue;
				}
				if (requestLimit) {
					expect(report.stoppedReason).toBe("gateway_budget_stop");
					expect(batchCalls).toBe(8);
					expect(report.cells[0].result.telemetry.requests.at(-1)).toMatchObject({
						requestSequence: 9,
						upstreamForwarded: false,
						totalTokens: null,
						inputTokens: null,
						outputTokens: null,
						replyContentStatus: "not_generated",
						outcome: "GATEWAY_REQUEST_LIMIT",
					});
					expect(report.cells.slice(1).every((c: { resultStatus: string }) => c.resultStatus === "not_run")).toBe(
						true,
					);
					continue;
				}
				expect(report.stoppedReason).toBeNull();
				expect(report.cells.every((c: { resultStatus: string }) => c.resultStatus === "passed")).toBe(true);
				for (const cell of report.cells) {
					const r = cell.result;
					if (!enabled) {
						expect(r.telemetry).toBeUndefined();
						continue;
					}
					const t = r.telemetry;
					expect(r.evaluationAccepted).toBe(true);
					expect(t.complete).toBe(true);
					expect(
						t.requests.reduce((n: number, q: { totalTokens: number | null }) => n + (q.totalTokens ?? 0), 0),
					).toBe(r.gateway.actualTotalTokens);
					expect(t.tools.every((x: { requestSequence: number | null }) => x.requestSequence !== null)).toBe(true);
					expect(t.brokerLinks.length).toBeGreaterThan(0);
					expect(
						t.brokerLinks.every((x: { parentToolCallId: string | null }) => x.parentToolCallId !== null),
					).toBe(true);
					if (r.comparisonGroup === "memory_on")
						expect(t.modules.memory).toMatchObject({
							matched_seed: true,
							same_rule_file_accessed: true,
							patch_satisfies_rule: true,
						});
					if (r.comparisonGroup === "memory_off")
						expect(t.modules.memory).toMatchObject({ runtimeAvailable: false, matched_seed: false });
					if (r.comparisonGroup === "task_on")
						expect(t.modules.task).toMatchObject({
							planReturned: true,
							duplicatePlanSources: true,
							before: "draft",
							after: "draft",
						});
					if (r.comparisonGroup === "context_on") {
						expect(t.contextViews.some((v: { changed: unknown[] }) => v.changed.length > 0)).toBe(true);
						expect(
							t.tools.some(
								(x: { readClassification: string }) => x.readClassification === "nonoverlapping_pagination",
							),
						).toBe(true);
						expect(
							t.tools.some(
								(x: { readClassification: string }) => x.readClassification === "post_edit_verification_read",
							),
						).toBe(true);
					}
				}
			}
			const on = reports[0] as {
				cells: Array<{ result: { patchSha256: string; gateway: { actualTotalTokens: number } } }>;
			};
			const off = reports[1] as typeof on;
			expect(on.cells.map((c) => c.result.patchSha256)).toEqual(off.cells.map((c) => c.result.patchSha256));
			expect(on.cells.map((c) => c.result.gateway.actualTotalTokens)).toEqual(
				off.cells.map((c) => c.result.gateway.actualTotalTokens),
			);
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180000);
});
