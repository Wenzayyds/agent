import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { type BudgetGatewayOptions, type BudgetGatewayStatus, startBudgetGateway } from "../../benchmarks/real-agent/budget-gateway.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { TaskProvider, createTaskStorageScope } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import { createCheckpoint } from "../../src/task-manager/recovery.ts";
import { close, startStubProvider, textSse } from "../fixtures/runner-support.ts";

const dirs: string[] = [];
const children = new Set<ChildProcess>();

function fixture(upstreamBaseUrl: string, deadlineAt = Date.now() + 30_000): BudgetGatewayOptions {
	const root = mkdtempSync(join(tmpdir(), "pi-budget-recovery-"));
	dirs.push(root);
	const scope = createTaskStorageScope(createProjectScope({ cwd: root, agentDir: root }), root);
	const service = new TaskService(new TaskProvider(scope), 10);
	const created = service.create("budget recovery", [{ title: "inspect", expectedOutcome: "document result" }], "fixture-session", null);
	createCheckpoint(service.provider, created, "fixture-session", null);
	service.close();
	return {
		runId: "cross_process", upstreamBaseUrl, upstreamApiKey: "mock-upstream-key", clientToken: "fixture-client",
		adminToken: "fixture-admin", allowedModel: "fixture",
		limits: { maxRequests: 2, maxTotalTokens: 6_000, maxTotalCostUsd: 0.03, maxConcurrency: 1,
			maxRequestBytes: 8_192, requestTimeoutMs: 10_000, maxOutputTokensPerRequest: 512, minOutputTokensPerRequest: 32 },
		pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
		persistence: { databasePath: scope.databasePath, id: created.task.taskId, mode: "create", deadlineAt },
	};
}

async function launch(options: BudgetGatewayOptions, resume = false, prepared = false) {
	const child = fork(fileURLToPath(new URL("../fixtures/budget-recovery-child.ts", import.meta.url)), [
		JSON.stringify({ ...options, persistence: { ...options.persistence, mode: resume ? "resume" : "create" } }),
		...(prepared ? ["prepared"] : []),
	], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	children.add(child);
	child.once("exit", () => children.delete(child));
	const [message] = await once(child, "message");
	return { child, ...(message as { url?: string; deadlineAt?: number; error?: string; status?: BudgetGatewayStatus; stage?: string }) };
}

async function terminate(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const done = once(child, "exit");
	child.kill("SIGKILL");
	await done;
}

function request(url: string) {
	return fetch(url + "/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: "Bearer fixture-client", "Content-Type": "application/json" },
		body: JSON.stringify({ model: "fixture", stream: true, messages: [{ role: "user", content: "check" }] }),
	});
}

afterEach(async () => {
	await Promise.all([...children].map(terminate));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("carries settled requests, tokens, cost and the original deadline into a distinct process", async () => {
	let calls = 0;
	const stub = await startStubProvider((_body, response) => {
		calls++;
		response.writeHead(200, { "Content-Type": "text/event-stream" }).end(textSse("done", 100, 20));
	});
	try {
		const options = fixture(stub.url);
		const first = await launch(options);
		expect(await (await request(first.url!)).text()).toContain("[DONE]");
		expect((await launch(options, true)).error).toBe("GATEWAY_BUDGET_IN_USE");
		await terminate(first.child);

		const resumed = await launch(options, true);
		expect(resumed.child.pid).not.toBe(first.child.pid);
		expect(resumed.deadlineAt).toBe(first.deadlineAt);
		expect(resumed.status).toMatchObject({
			requestsStarted: 1, requestsCompleted: 1, actualInputTokens: 100, actualOutputTokens: 20,
			actualTotalTokens: 120, committedTokenUpperBound: 120, actualCostUsd: 0.000054,
		});
		expect(await (await request(resumed.url!)).text()).toContain("[DONE]");
		const rejected = await request(resumed.url!);
		expect(await rejected.json()).toEqual({ error: "GATEWAY_REQUEST_LIMIT" });
		expect(calls).toBe(2);
		await terminate(resumed.child);
		expect((await launch(options, true)).error).toBe("GATEWAY_REQUEST_LIMIT");
	} finally {
		await close(stub.server);
	}
}, 25_000);

it("preserves the admitted usage and deadline across an authorized tier change and process restart", async () => {
	const stub = await startStubProvider((_body, response) => {
		response.writeHead(200, { "Content-Type": "text/event-stream" }).end(textSse("done", 100, 20));
	});
	try {
		const options = fixture(stub.url);
		options.limits = { ...options.limits, tier: "economy", maxTotalTokens: 20_000 };
		const first = await startBudgetGateway(options);
		try {
			expect(await (await request(first.url)).text()).toContain("[DONE]");
			const before = first.status();
			first.changeTier!("premium");
			expect(first.status()).toMatchObject({
				actualTotalTokens: before.actualTotalTokens, actualCostUsd: before.actualCostUsd,
				requestsStarted: before.requestsStarted,
				limits: { tier: "premium", maxTotalTokens: 30_000, maxRequests: 2, maxTotalCostUsd: 0.03 },
			});
			expect(first.deadlineAt).toBe(options.persistence!.deadlineAt);
		} finally { await first.close(); }
		expect((await launch(options, true)).error).toBe("GATEWAY_BUDGET_POLICY_MISMATCH");
		const next = await launch({ ...options, limits: { ...options.limits, tier: "premium", maxTotalTokens: 30_000 } }, true);
		expect(next.deadlineAt).toBe(options.persistence!.deadlineAt);
		expect(next.status).toMatchObject({
			actualTotalTokens: 120, requestsStarted: 1, actualCostUsd: 0.000054, limits: { tier: "premium" },
		});
		expect(await (await request(next.url!)).text()).toContain("[DONE]");
		expect(await (await request(next.url!)).json()).toEqual({ error: "GATEWAY_REQUEST_LIMIT" });
	} finally { await close(stub.server); }
}, 25_000);

it("refunds only a durable reservation that never crossed the dispatch boundary", async () => {
	const options = fixture("http://127.0.0.1:32111");
	const first = await launch(options);
	const exited = once(first.child, "exit");
	first.child.send("close");
	await exited;
	const prepared = await launch(options, true, true);
	expect(prepared.stage).toBe("prepared");
	await terminate(prepared.child);
	const resumed = await launch(options, true);
	expect(resumed.status).toMatchObject({
		requestsStarted: 0, requestsCompleted: 0, requestAttempts: 1, activeRequests: 0,
		reservedTokens: 0, reservedCostUsd: 0, actualTotalTokens: 0,
	});
}, 25_000);

it("holds a dispatched claim on abrupt exit without making up provider usage", async () => {
	let sent!: () => void;
	const arrived = new Promise<void>((resolve) => { sent = resolve; });
	const stub = await startStubProvider((_body, _response) => { sent(); });
	try {
		const options = fixture(stub.url);
		const first = await launch(options);
		const pending = request(first.url!).catch(() => undefined);
		await arrived;
		await terminate(first.child);
		await pending;
		expect((await launch(options, true)).error).toBe("GATEWAY_BUDGET_UNCERTAIN_USAGE");
		const db = new DatabaseSync(options.persistence!.databasePath, { readOnly: true });
		try {
			const row = db.prepare("SELECT body FROM gateway_budget_runs").get() as { body: string };
			expect(JSON.parse(row.body)).toMatchObject({
				pending: [{ phase: "dispatched", requestSequence: 1 }],
				status: { actualTotalTokens: 0, requestsStarted: 1, activeRequests: 1 },
			});
		} finally { db.close(); }
	} finally {
		stub.server.closeAllConnections();
		await close(stub.server);
	}
}, 25_000);

it("refuses a missing, altered, expired or corrupted run on restart", async () => {
	const options = fixture("http://127.0.0.1:32111", Date.now() + 2_500);
	expect((await launch(options, true)).error).toBe("GATEWAY_BUDGET_NOT_FOUND");
	const first = await launch(options);
	expect(first.url).toBeDefined();
	await terminate(first.child);
	expect((await launch({ ...options, limits: { ...options.limits, maxRequests: 3 } }, true)).error).toBe("GATEWAY_BUDGET_POLICY_MISMATCH");
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, options.persistence!.deadlineAt! - Date.now()) + 20));
	expect((await launch(options, true)).error).toBe("GATEWAY_RUN_TIMEOUT");
	const db = new DatabaseSync(options.persistence!.databasePath);
	db.exec("UPDATE gateway_budget_runs SET body='modified'");
	db.close();
	expect((await launch(options, true)).error).toBe("GATEWAY_BUDGET_CORRUPT");
}, 25_000);
