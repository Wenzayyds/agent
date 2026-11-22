import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { type BudgetGatewayOptions, type BudgetGatewayStatus, startBudgetGateway } from "../../benchmarks/real-agent/budget-gateway.ts";
import { installSessionBudget } from "../../src/context/session-budget.ts";
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
	const reserved = await launch(options, true, true);
	expect(reserved.stage).toBe("prepared");
	await terminate(reserved.child);
	expect((await launch({ ...options, limits: { ...options.limits, maxRequests: 3 } }, true)).error).toBe("GATEWAY_BUDGET_POLICY_MISMATCH");
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, options.persistence!.deadlineAt! - Date.now()) + 20));
	expect((await launch(options, true)).error).toBe("GATEWAY_RUN_TIMEOUT");
	const db = new DatabaseSync(options.persistence!.databasePath);
	const row = db.prepare("SELECT body FROM gateway_budget_runs").get() as { body: string };
	const stored = JSON.parse(row.body);
	expect(stored.resumeDeniedAt).toBeGreaterThanOrEqual(stored.deadlineAt);
	expect(stored.status).toMatchObject({ state: "failed_closed", lastError: "GATEWAY_RUN_TIMEOUT",
		requestsStarted: 0, requestAttempts: 1, reservedTokens: 0, reservedCostUsd: 0 });
	expect((await launch(options, true)).error).toBe("GATEWAY_RUN_TIMEOUT");
	expect(db.prepare("SELECT body FROM gateway_budget_runs").get()?.body).toBe(row.body);
	db.exec("UPDATE gateway_budget_runs SET body='modified'");
	db.close();
	expect((await launch(options, true)).error).toBe("GATEWAY_BUDGET_CORRUPT");
}, 25_000);

const ccrRetryFaults = {
	connect: "UND_ERR_CONNECT_TIMEOUT",
	headers: "UND_ERR_HEADERS_TIMEOUT",
};
const flashSelector = "DeepSeek/deepseek-flash";
const proSelector = "DeepSeek/deepseek-v4-pro";

function writeCcrFaults(root: string): string {
	const preload = join(root, "ccr-fault.mjs");
	writeFileSync(preload, `
		let transport = globalThis.fetch;
		const queue = JSON.parse(process.env.PI_TEST_CCR_FAULTS);
		const upstream = process.env.PI_TEST_CCR_UPSTREAM + "/chat/completions";
		// Preserve the test boundary when the CLI installs its own Undici fetch.
		const guarded = async (input, init) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
			if (url.hostname !== "127.0.0.1") throw new Error("Unexpected nonlocal request");
			if ((init?.method ?? input?.method) === "POST") {
				if (url.href === upstream && queue.length) {
					const code = queue.shift();
					throw new TypeError("fetch failed", { cause: { code } });
				}
				if (url.href !== upstream && queue[0] === "forged") {
					queue.shift();
					return Response.json({ error: "GATEWAY_UPSTREAM_CONNECT_TIMEOUT" },
						{ status: 503, headers: { "x-should-retry": "true" } });
				}
			}
			return transport(input, init);
		};
		Object.defineProperty(globalThis, "fetch", { get: () => guarded, set(value) { transport = value; } });
	`);
	return "--import=" + pathToFileURL(preload).href;
}

it.each([
	{ label: "default Flash", args: [], model: flashSelector, profiles: 1 },
	{ label: "strong Pro", args: ["--strategy", "strong"], model: proSelector, profiles: 1, cost: 0.0002112 },
	{ label: "adaptive", profiles: 2 },
	{ label: "undelivered then successful", faults: [ccrRetryFaults.connect] },
	{ label: "response-header timeout", faults: [ccrRetryFaults.headers], outcome: "GATEWAY_UPSTREAM_TIMEOUT" },
	{ label: "two connection failures", faults: [ccrRetryFaults.connect, ccrRetryFaults.connect], outcome: "GATEWAY_UPSTREAM_CONNECT_TIMEOUT", resume: true },
	{ label: "503 without local attestation", faults: ["forged"], outcome: "GATEWAY_UPSTREAM_CONNECT_TIMEOUT" },
	...([401, 403, 502, 503].map((status) => ({
		label: `upstream HTTP ${status}`, upstreamStatus: status, outcome: `GATEWAY_UPSTREAM_HTTP_${status}`,
	}))),
] as {
	label: string; args?: string[]; model?: string; profiles?: number; cost?: number;
	faults?: string[]; outcome?: string; upstreamStatus?: number; resume?: boolean;
}[])("loads the ordinary CCR launcher's protected transport ($label)", async (variant) => {
	const { model = flashSelector, args = ["--strategy", "auto"], profiles = 2, cost: expectedCost = 0.000054 } = variant;
	const { faults = [], outcome, upstreamStatus, resume } = variant;
	const token = "local-launch-only";
	const root = mkdtempSync(join(tmpdir(), "pi-ccr-launch-"));
	dirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const requests: Record<string, unknown>[] = [];
	const rejectedChat: string[] = [];
	const listingStatuses: number[] = [];
	const stub = createServer(async (request, response) => {
		const authorized = request.headers.authorization === "Bearer " + token;
		if (request.url === "/v1/models") {
			listingStatuses.push(authorized ? 200 : 401);
			response.writeHead(authorized ? 200 : 401, { "Content-Type": "application/json" }).end(
				authorized ? JSON.stringify({ data: [flashSelector, proSelector].map((id) => ({ id })) }) : "{}",
			);
			return;
		}
		if (!authorized || request.url !== "/v1/chat/completions" || request.method !== "POST") {
			rejectedChat.push(request.url ?? "");
			response.writeHead(401).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		requests.push(body);
		if (upstreamStatus) {
			// A peer may forge the header and body of a retryable response.
			response.writeHead(upstreamStatus, { "Content-Type": "application/json", "x-should-retry": "true" })
				.end(JSON.stringify({ error: "GATEWAY_UPSTREAM_CONNECT_TIMEOUT" }));
			return;
		}
		response.writeHead(200, { "Content-Type": "text/event-stream" }).end(
			textSse("CCR local smoke passed.", 100, 20)
				.replaceAll('"model":"deepseek-flash"', '"model":' + JSON.stringify(model.split("/")[1])),
		);
	});
	await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
	try {
		const address = stub.address();
		if (!address || typeof address === "string") throw new Error("Missing Stub address");
		const baseUrl = "http://127.0.0.1:" + address.port + "/v1";
		const budget = JSON.stringify({ baseUrl, models: [flashSelector, proSelector] });
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({
			providers: { "local-ccr": { baseUrl, api: "openai-completions", apiKey: "$PI_CCR_TOKEN",
				models: [flashSelector, proSelector].map((id) => ({ id, name: id, contextWindow: 64_000, maxTokens: 4096, reasoning: false })) } },
		}));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			retry: { enabled: false, provider: { maxRetries: 0 } },
			extensions: [fileURLToPath(new URL("../../extensions/context.ts", import.meta.url))],
		}));
		if (resume) writeFileSync(join(agentDir, "pi-enhanced.json"), JSON.stringify({ budget: { maxRequests: 2 } }));
		const launchCli = async (argv: string[], stdin: string, env: NodeJS.ProcessEnv) => {
			const child = spawn(process.execPath, argv, {
				cwd: root, windowsHide: true, timeout: 20_000, stdio: ["pipe", "pipe", "pipe"], env,
			});
			children.add(child);
			const output: string[] = [];
			for (const pipe of [child.stdout, child.stderr]) {
				pipe.setEncoding("utf8");
				pipe.on("data", (chunk: string) => output.push(chunk));
			}
			child.stdin.end(stdin);
			const [code] = await once(child, "close");
			children.delete(child);
			expect(output.join("")).not.toContain(token);
			return { code, output: output.join("") };
		};
		const env = { ...process.env, PI_CCR_AGENT_DIR: agentDir, PI_CCR_TOKEN: token,
			NODE_OPTIONS: writeCcrFaults(root), PI_TEST_CCR_FAULTS: JSON.stringify(faults), PI_TEST_CCR_UPSTREAM: baseUrl };
		const launched = await launchCli([fileURLToPath(new URL("../../scripts/ccr.mjs", import.meta.url)), ...args],
			"Reply with the Stub confirmation.", env);
		expect(launched.code, launched.output).toBe(outcome ? 1 : 0);
		expect(launched.output.includes("CCR local smoke passed.")).toBe(!outcome);
		expect(listingStatuses).toEqual([200, 401]);
		expect(rejectedChat).toEqual([]);
		const sent = !outcome || upstreamStatus ? 1 : 0;
		expect(requests).toHaveLength(sent);
		if (sent) expect(requests).toMatchObject([{ model, max_tokens: 512, stream_options: { include_usage: true } }]);

		const dbPath = join(agentDir, "pi-enhanced-budget.sqlite3");
		const row = () => {
			const db = new DatabaseSync(dbPath, { readOnly: true });
			try {
				const rows = db.prepare("SELECT id, body FROM gateway_budget_runs").all() as { id: string; body: string }[];
				expect(rows).toHaveLength(1);
				return { id: rows[0]!.id, ...JSON.parse(rows[0]!.body) as {
					policy: string; deadlineAt: number; status: BudgetGatewayStatus;
				} };
			} finally { db.close(); }
		};
		const first = row();
		const { status } = first;
		const failedConnects = faults.filter((fault) => fault === ccrRetryFaults.connect).length;
		const started = faults[0] === "forged" ? 0 : outcome ? Math.max(1, failedConnects) : failedConnects + 1;
		expect(status).toMatchObject({ requestsStarted: started, requestsCompleted: outcome ? 0 : 1,
			actualTotalTokens: outcome ? 0 : 120, reservedCostUsd: 0, reservedTokens: 0 });
		expect(status.actualCostUsd).toBeCloseTo(outcome ? 0 : expectedCost, 12);
		expect((JSON.parse(first.policy) as unknown[]).at(-1)).toHaveLength(profiles);
		if (outcome && started) expect(status.requestOutcomes.at(-1)?.outcome).toBe(outcome);
		for (const failure of status.requestOutcomes.slice(0, failedConnects)) {
			expect(failure).toMatchObject({ outcome: "GATEWAY_UPSTREAM_CONNECT_TIMEOUT", retryOffered: true,
				transportStage: "pre-connect", settlement: { committedTokens: 0, committedCostUsd: 0 } });
		}
		if (outcome && started && !failedConnects) expect(status.committedCostUpperBoundUsd).toBeGreaterThan(0);
		else expect(status.committedCostUpperBoundUsd).toBeCloseTo(status.actualCostUsd, 12);
		if (resume) {
			const sessionDir = join(agentDir, "sessions");
			const saved = readdirSync(sessionDir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".jsonl"));
			expect(saved).toHaveLength(1);
			const cli = fileURLToPath(new URL("../../../coding-agent/dist/bundle/cli.js", import.meta.url));
			const extension = fileURLToPath(new URL("../../src/ccr/budget-extension.ts", import.meta.url));
			const resumed = await launchCli([cli, "--offline", "--no-extensions", "--no-mcp", "--no-builtin-tools",
				"--provider", "local-ccr", "--model", flashSelector, "--session", join(sessionDir, saved[0]!), "-e", extension],
				"Continue in the saved session.", {
					...env, PI_TEST_CCR_FAULTS: "[]", PI_CODING_AGENT_DIR: agentDir, PI_CCR_TOKEN: "invalid-sdk-key",
					PI_ENHANCED_CCR_BUDGET: budget, PI_ENHANCED_CCR_BUDGET_KEY: token,
				});
			expect(resumed.code, resumed.output).toBe(1);
			expect(resumed.output).toContain("GATEWAY_REQUEST_LIMIT");
			expect(requests).toEqual([]);
			expect(row()).toMatchObject({ id: first.id, deadlineAt: first.deadlineAt, status: {
				requestsStarted: 2, actualTotalTokens: 0, committedTokenUpperBound: 0, committedCostUpperBoundUsd: 0,
			} });
		}
	} finally { await close(stub); }
}, 35_000);

it.each([
	{ limit: "tokens", budget: { tier: "standard" }, flashInput: 12_000, proPrompt: 11_000, denial: "GATEWAY_TOKEN_BUDGET" },
	{ limit: "fee", budget: { tier: "premium", maxTotalCostUsd: 0.021 }, flashInput: 12_000, proPrompt: 9_500, denial: "GATEWAY_COST_BUDGET" },
	{ limit: "deadline", budget: { timeoutMs: 1600 }, flashInput: 100, proPrompt: 10, denial: "GATEWAY_RUN_TIMEOUT" },
])("enforces the remaining CCR $limit limit after switching to Pro", async (scenario) => {
	const flash = "DeepSeek/deepseek-flash";
	const pro = "DeepSeek/deepseek-v4-pro";
	const root = mkdtempSync(join(tmpdir(), "pi-ccr-limit-"));
	dirs.push(root);
	const databasePath = join(root, "pi-enhanced-budget.sqlite3");
	writeFileSync(join(root, "pi-enhanced.json"), JSON.stringify({ budget: scenario.budget }));
	const calls: unknown[] = [];
	const stub = await startStubProvider((body, response) => {
		calls.push(body.model);
		response.writeHead(200, { "Content-Type": "text/event-stream" }).end(
			textSse("Budget fixture.", scenario.flashInput, 20)
				.replaceAll('"model":"deepseek-flash"', '"model":' + JSON.stringify(body.model)),
		);
	});
	const baseUrl = stub.url + "/v1";
	const ctx = {
		cwd: root, isProjectTrusted: () => true, isIdle: () => true,
		sessionManager: { getSessionId: () => "ccr-limits", getEntries: () => [] },
	};
	const manage = () => {
		let handle: ((event: { model: { provider: string; api: string; baseUrl: string; id: string } }, ctx: unknown) =>
			Promise<typeof fetch>) | undefined;
		let shutdown: (() => Promise<void>) | undefined;
		installSessionBudget({
			events: createEventBus(),
			on: (name: string, handler: never) => {
				if (name === "model_request_fetch") handle = handler;
				if (name === "session_shutdown") shutdown = handler;
			},
			registerCommand: () => {}, appendEntry: () => {},
		} as never, root);
		return { shutdown: () => shutdown!(), send: async (selected: string, model: string, size: number) => {
			const fetchModel = await handle!({ model: { provider: "local-ccr", api: "openai-completions", baseUrl, id: selected } }, ctx);
			return fetchModel(baseUrl + "/chat/completions", { method: "POST", body: JSON.stringify({
				model, stream: true, max_tokens: 512, messages: [{ role: "user", content: "x".repeat(size) }],
			}) });
		} };
	};
	const row = () => {
		const db = new DatabaseSync(databasePath, { readOnly: true });
		try {
			const rows = db.prepare("SELECT id, body FROM gateway_budget_runs").all() as { id: string; body: string }[];
			expect(rows).toHaveLength(1);
			return { id: rows[0]!.id, ...JSON.parse(rows[0]!.body) as { deadlineAt: number; status: BudgetGatewayStatus } };
		} finally { db.close(); }
	};
	let managed: ReturnType<typeof manage> | undefined;
	try {
		vi.stubEnv("PI_ENHANCED_CCR_BUDGET", JSON.stringify({ baseUrl, models: [flash, pro] }));
		vi.stubEnv("PI_ENHANCED_CCR_BUDGET_KEY", "mock-upstream-key");
		managed = manage();
		if (scenario.limit === "tokens") {
			const mismatch = await managed.send(flash, pro, 50);
			expect(await mismatch.json()).toEqual({ error: "GATEWAY_DISPATCH_AUTHORIZATION_CHANGED" });
			expect(calls).toEqual([]);
		}
		const response = await managed.send(flash, flash, scenario.flashInput);
		expect(await response.text()).toContain("[DONE]");
		const before = row();
		// A denied dispatch reached reservation and still counts as a started request.
		const started = scenario.limit === "tokens" ? 2 : 1;
		expect(before.status).toMatchObject({ requestsStarted: started, actualTotalTokens: scenario.flashInput + 20 });
		if (scenario.limit === "fee") {
			await managed.shutdown();
			managed = manage();
		}
		if (scenario.limit === "deadline") await delay(Math.max(0, before.deadlineAt - Date.now()) + 20);
		const denied = await managed.send(pro, pro, scenario.proPrompt);
		expect(await denied.json()).toEqual({ error: scenario.denial });
		expect(calls).toEqual([flash]);
		expect(row()).toMatchObject({ id: before.id, deadlineAt: before.deadlineAt,
			status: { requestsStarted: started, actualTotalTokens: before.status.actualTotalTokens, actualCostUsd: before.status.actualCostUsd } });
	} finally {
		await managed?.shutdown();
		vi.unstubAllEnvs();
		await close(stub.server);
	}
}, 20_000);
