import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";

const root = resolve(import.meta.dirname, "../../../..");
const docker = spawnSync("docker", ["image", "inspect", CONTROLLED_IMAGE], { stdio: "ignore", timeout: 10_000 }).status === 0;

describe.skipIf(!docker)("Six-cell production batch", () => {
	it("runs all six through Pi and Docker with module controls, truncation, and no retries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-controlled-batch-"));
		let calls = 0;
		let offReportLength = 0;
		let onReportLength = 0;
		const server = createServer((req, res) => { void (async () => {
			const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ role: string; content: string; tool_call_id?: string }>; tools: Array<{ function: { name: string } }> };
			calls += 1;
			const rawUser = body.messages.find((m) => m.role === "user")?.content ?? "";
			const user = typeof rawUser === "string" ? rawUser : JSON.stringify(rawUser);
			const names = body.tools.map((t) => t.function.name);
			const memory = names.includes("enhanced_memory_search");
			const task = names.includes("enhanced_task_get");
			const results = body.messages.filter((m) => m.role === "tool");
			let name = ""; let args: Record<string, unknown> = {};
			const offset = memory || task ? 1 : 0;
			if (memory && !results.length) { name = "enhanced_memory_search"; args = { query: "normalizeKey", limit: 3 }; }
			else if (task && !results.length) { name = "enhanced_task_get"; args = { taskId: user.match(/[a-f0-9]{8}-[a-f0-9-]{27,}/u)?.[0] }; }
			else if (user.includes("diagnostics.txt")) {
				if (results.length) {
					const rawReport = results[0]?.content;
					const report = typeof rawReport === "string" ? rawReport : JSON.stringify(rawReport);
					if (report.includes("tool output truncated")) onReportLength = report.length; else offReportLength = report.length;
					expect(report).toContain("validate.js");
				}
				if (!results.length) { name = "read"; args = { path: "diagnostics.txt" }; }
				else if (results.length === 1) { name = "read"; args = { path: "validate.js" }; }
				else if (results.length === 2) { name = "edit"; args = { path: "validate.js", edits: [{ oldText: "items.slice(0, 10).every", newText: "items.every" }] }; }
			} else if (user.includes("formatter")) {
				if (results.length === offset) { name = "read"; args = { path: "formatter.js" }; }
				else if (results.length === offset + 1) { name = "edit"; args = { path: "formatter.js", edits: [{ oldText: "const formatName", newText: "export const formatName" }] }; }
			} else {
				if (results.length === offset) { name = "read"; args = { path: "key.js" }; }
				else if (results.length === offset + 1) { name = "edit"; args = { path: "key.js", edits: [{ oldText: "value.trim()", newText: "value.trim().toLowerCase()" }] }; }
			}
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const choice = name ? { delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null } : { delta: { role: "assistant", content: "fixed" }, finish_reason: null };
			res.end(`data: ${JSON.stringify({ id: `stub-${calls}`, choices: [{ index: 0, ...choice }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
		})(); });
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address(); if (!address || typeof address === "string") throw new Error("stub listen failed");
		try {
			const result = await run(dir, `http://127.0.0.1:${address.port}`);
			expect(result.code, result.stderr).toBe(0);
			const report = JSON.parse(readFileSync(join(dir, "offline_six_batch", "batch.json"), "utf8"));
			expect(report.stoppedReason, JSON.stringify(report.cells.map((c: { id: string; result?: { sandboxAudit: { audit: Array<{ status: string }> }; toolFailures: unknown[] } }) => ({ id: c.id, errors: c.result?.sandboxAudit.audit.filter((a) => a.status !== "ok"), failures: c.result?.toolFailures })))).toBeNull();
			expect(report.cells).toHaveLength(6);
			for (const cell of report.cells) expect(cell.result).toMatchObject({ patchStatus: "passed", runStatus: "completed", retriesEnabled: false });
			expect(report.cells[1].result.moduleToolEvents[0].result.details.count).toBe(1);
			expect(report.cells[3].result.contextAudit.diagnostics.some((d: { truncatedToolResults: number }) => d.truncatedToolResults > 0)).toBe(true);
			expect(report.cells[5].result.moduleToolEvents[0].isError).toBe(false);
			for (let i = 0; i < 6; i += 2) expect(report.cells[i].result.referenceHash).toBe(report.cells[i + 1].result.referenceHash);
			expect(offReportLength).toBeGreaterThan(10_000); expect(onReportLength).toBeLessThan(2500);
			if (process.env.PI_ENHANCED_SIX_EVIDENCE_PATH) writeFileSync(process.env.PI_ENHANCED_SIX_EVIDENCE_PATH, JSON.stringify({ ...report, checks: { offReportLength, onReportLength, providerCalls: calls } }, null, 2));
			const before = calls;
			expect((await run(dir, `http://127.0.0.1:${address.port}`)).code).not.toBe(0);
			expect(calls).toBe(before);
		} finally { await new Promise<void>((resolveClose) => server.close(() => resolveClose())); rmSync(dir, { recursive: true, force: true }); }
	}, 180_000);

	it.each(["gateway", "isolation"])("stops the batch immediately on %s failure and retains unused cells", async (failure) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-controlled-stop-"));
		let calls = 0;
		const server = createServer((request, response) => { void (async () => {
			for await (const _chunk of request) { /* drain request */ }
			calls += 1;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			const choice = failure === "isolation" ? { delta: { role: "assistant", tool_calls: [{ index: 0, id: "escape-call", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "../outside.txt" }) } }] }, finish_reason: "tool_calls" } : { delta: { role: "assistant", content: "done" }, finish_reason: "stop" };
			response.end(`data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: failure === "gateway" ? {} : { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
		})(); });
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address(); if (!address || typeof address === "string") throw new Error("stub listen failed");
		try {
			expect((await run(dir, `http://127.0.0.1:${address.port}`)).code).toBe(0);
			const report = JSON.parse(readFileSync(join(dir, "offline_six_batch", "batch.json"), "utf8"));
			expect(report.stoppedReason).not.toBeNull();
			expect(report.cells.slice(1).every((cell: { status: string }) => cell.status === "not_run")).toBe(true);
			expect(calls).toBe(1);
			expect(report.cells[0].result.gateway.requestsStarted).toBe(1);
			if (failure === "gateway") expect(report.cells[0].result.gateway.committedCostUpperBoundUsd).toBeGreaterThan(0);
			const residue = spawnSync("docker", ["ps", "-a", "--filter", "name=pi-enhanced-tools-offline_six_batch_", "--format", "{{.ID}}"], { encoding: "utf8", timeout: 10_000 });
			expect(residue.stdout.trim()).toBe("");
		} finally { await new Promise<void>((done) => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); }
	}, 60_000);
});

function run(output: string, stub: string): Promise<{ code: number | null; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "packages/pi-enhanced/benchmarks/real-agent/run-controlled.ts"), "--execute", "--batch-id", "offline_six_batch", "--output-dir", output, "--local-stub-url", stub], { cwd: root, env: { ...process.env, PI_ENHANCED_REAL_MODEL_EVAL: "1", PI_ENHANCED_LOCAL_STUB_EVAL: "1", MOCK_PROVIDER_KEY: "mock-upstream-key" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = ""; child.stdout.on("data", () => {}); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.on("close", (code) => done({ code, stderr }));
	});
}
