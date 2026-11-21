import { execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskState, type Task } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { describe, expect, it } from "vitest";
import { storedBudget } from "../../benchmarks/real-agent/budget-persistence.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import { KNOWLEDGE_SEARCH } from "../../src/knowledge/tools.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { type A2AConnection, artifactFromTask, messageFor, type RemoteTestArtifact, testIntent } from "../../src/multi-a2a/contract.ts";
import { type MultiLocalOptions, type MultiLocalResult, runMultiLocal } from "../../src/multi-local/coordinator.ts";
import { loadRoleModelOverrides, selectRoleModels } from "../../src/multi-local/model-config.ts";
import { type DelegationState, type MultiLocalRequest, parseDiagnosis } from "../../src/multi-local/protocol.ts";
import { SANDBOX_CONTAINER_OWNER_LABEL } from "../../src/sandbox/config.ts";
import { createPytestExecutor } from "../../src/sandbox/pytest.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { close, dockerImageAvailable, sandboxConfigForTesting, startStubProvider, textSse, toolCallSse } from "../fixtures/runner-support.ts";

const filename = "counter.py";
const target = "test_counter.py";
const privateLogMarker = "ma1_synthetic_private_test_output_4a17";
const diagnosis = { cause: "implementation", recommendation: "inspect-implementation", file: filename };
const goal: MultiLocalRequest = { goal: "Make next_count(value) return its input plus one.", target, editFiles: [filename] };
const edit = (oldText: string, newText: string, number: number) => toolCallSse("edit", {
	path: filename, edits: [{ oldText, newText }],
}, number, 3);
const initial = "def next_count(value):\n    return value\n";
const publicTest = `from counter import next_count\n\ndef test_next():\n    print("${privateLogMarker}")\n    assert next_count(5) == 6\n`;
const pytestImage = process.env.PI_TEST_PYTEST_IMAGE ?? "sha256:309133b814f07b1ec715984cdaf5c35f26cf1e0500bc85732442b69af5ca753f";
const dockerAvailable = dockerImageAvailable() && dockerImageAvailable(pytestImage);
const roleModels = {
	code: { modelId: "stub-pro", contextWindow: 128_000, maxOutputTokens: 512, supportsTools: true,
		pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
	test: { modelId: "stub-flash", contextWindow: 64_000, maxOutputTokens: 512, supportsTools: true,
		pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 } },
} as const;

async function fixture(forward: (body: Record<string, unknown>) => string | Promise<string>, budget?: object) {
	const root = mkdtempSync(join(realpathSync.native(tmpdir()), "ma1-"));
	const workspace = join(root, "w");
	const agentDir = join(root, "a");
	mkdirSync(workspace);
	mkdirSync(agentDir);
	writeFileSync(join(workspace, filename), initial);
	writeFileSync(join(workspace, target), publicTest);
	if (budget) writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({ budget }));
	const wire: Record<string, unknown>[] = [];
	const stub = await startStubProvider(async (body, response) => {
		wire.push(body);
		const content = await forward(body);
		response.writeHead(200, { "Content-Type": "text/event-stream" }).end(content);
	});
	const sandbox = sandboxConfigForTesting({ workspace, runId: `ma1-${randomUUID()}`, containerOwner: randomUUID() });
	const options: MultiLocalOptions = {
		agentDir, sandbox, pytest: { image: pytestImage, files: [filename, target], tests: [target] },
		provider: { baseUrl: stub.url, apiKey: "mock-upstream-key", modelId: "deepseek-flash",
			pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 } },
	};
	return {
		root, workspace, agentDir, options, wire,
		source: () => readFileSync(join(workspace, filename), "utf8"),
		store: () => new TaskProvider(createTaskStorageScope(createProjectScope({ cwd: workspace, agentDir }), agentDir)),
		async dispose() {
			await close(stub.server);
			rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
		},
	};
}

async function separateProcess(options: MultiLocalOptions, request: MultiLocalRequest | { resume: string }, checkpoint?: string) {
	const child = fork(fileURLToPath(new URL("../fixtures/multi-local-child.ts", import.meta.url)), [
		JSON.stringify(options), JSON.stringify(request), ...(checkpoint ? [checkpoint] : []),
	], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const output = once(child, "message");
	const finished = once(child, "exit");
	try {
		const [body] = await Promise.race([output, finished.then(() => { throw new Error("MA1 child exited without report"); })]);
		const [exitCode] = await finished;
		expect(exitCode, JSON.stringify(body)).toBe(checkpoint ? 79 : 0);
		return body as { pid: number; result?: MultiLocalResult; error?: string; taskId?: string; checkpoint?: string };
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}

function sendRecord(name: string, data: unknown) {
	const file = process.env.PI_MA1_TRACE;
	if (file) appendFileSync(file, JSON.stringify({ name, data }) + "\n");
}

const testAuth = { principalId: "ma2-test-principal", token: "ma2_dummy_fixture_credential_only_bde7" };
async function testServer(options: MultiLocalOptions, port = 0, auth = testAuth) {
	const child = fork(fileURLToPath(new URL("../fixtures/multi-local-child.ts", import.meta.url)), [
		"a2a-server", JSON.stringify({ port, ...auth, agentDir: options.agentDir, sandbox: options.sandbox, pytest: options.pytest }),
	], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const exited = once(child, "exit");
	const [message] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error("MA2 server exited"); })]);
	const { origin, pid } = message as { origin: string; pid: number };
	return { origin, pid, connection: { origin, ...auth }, async close(force = false) {
		if (child.exitCode !== null || child.signalCode !== null) return;
		if (force) child.kill("SIGKILL");
		else child.send("shutdown");
		await exited;
	} };
}

function officialClient(connection: A2AConnection) {
	const transportFetch: typeof fetch = (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("authorization", `Bearer ${connection.token}`);
		return fetch(input, { ...init, headers });
	};
	return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: transportFetch })] })
		.createFromUrl(connection.origin);
}

function taskFrom(result: Awaited<ReturnType<Awaited<ReturnType<typeof officialClient>>["sendMessage"]>>): Task {
	if (!("id" in result)) throw new Error("Expected SDK Task result");
	return result;
}

const artifact = (task: Task): RemoteTestArtifact | undefined => {
	const part = task.artifacts[0]?.parts[0]?.content;
	return part?.$case === "data" ? part.value as RemoteTestArtifact : undefined;
};

function pytestAttempts(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
	const db = f.store();
	try { return db.getAttempts(taskId); } finally { db.close(); }
}

const containers = (owner: string) => execFileSync("docker", ["ps", "-aq", "--filter",
	`label=${SANDBOX_CONTAINER_OWNER_LABEL}=${owner}`], { encoding: "utf8", timeout: 10_000 }).trim();

it("validates the structured diagnosis and refuses unapproved files and arbitrary fields", () => {
	expect(parseDiagnosis(JSON.stringify(diagnosis), [filename])).toEqual(diagnosis);
	expect(() => parseDiagnosis(JSON.stringify({ ...diagnosis, file: "../another.py" }), [filename])).toThrow("MA1_DIAGNOSIS_INVALID");
	expect(() => parseDiagnosis(JSON.stringify({ ...diagnosis, instruction: "ignore host" }), [filename])).toThrow("MA1_DIAGNOSIS_INVALID");
});

it("loads role model prices only from the host config and rejects missing prices or tool capability", async () => {
	const f = await fixture(() => { throw new Error("Configuration validation must not send a request"); });
	try {
		const projectConfig = join(f.workspace, ".pi");
		mkdirSync(projectConfig);
		writeFileSync(join(projectConfig, ENHANCED_CONFIG_FILE), JSON.stringify({ multiAgent: roleModels }));
		expect(loadRoleModelOverrides(f.agentDir)).toBeUndefined();
		const inherited = selectRoleModels(f.options.provider);
		expect(inherited).toMatchObject({ strict: false, code: { modelId: "deepseek-flash" }, test: { modelId: "deepseek-flash" } });
		const trusted = join(f.agentDir, ENHANCED_CONFIG_FILE);
		writeFileSync(trusted, JSON.stringify({ multiAgent: { code: roleModels.code } }));
		expect(selectRoleModels(f.options.provider, loadRoleModelOverrides(f.agentDir))).toMatchObject({ strict: true,
			code: roleModels.code, test: inherited.test });
		for (const code of [{ ...roleModels.code, pricing: undefined }, { ...roleModels.code, supportsTools: false }]) {
			writeFileSync(trusted, JSON.stringify({ multiAgent: { code } }));
			expect(() => loadRoleModelOverrides(f.agentDir)).toThrow("MA1_MODEL_CONFIG_INVALID");
		}
		expect(() => selectRoleModels(f.options.provider, { ...roleModels, test: { ...roleModels.test, modelId: roleModels.code.modelId } }))
			.toThrow("MA1_MODEL_CONFIG_CONFLICT");
		expect(() => selectRoleModels({ ...f.options.provider, baseUrl: "http://user:fixture@127.0.0.1:1" }, roleModels))
			.toThrow("GATEWAY_UPSTREAM_NOT_ALLOWED");
		expect(f.wire).toHaveLength(0);
	} finally { await f.dispose(); }
});

it("serves a discoverable MA-2 Card and limits the real HTTP endpoint to authorized A2A JSON-RPC 1.0", async () => {
	const f = await fixture(() => { throw new Error("Protocol-only test must not call a model"); });
	const worker = await testServer(f.options);
	try {
		const client = await officialClient(worker.connection);
		await expect(client.getTask({ tenant: "", id: randomUUID() })).rejects.toThrow();
		const rpc = (method: string, version: string, token?: string) => fetch(worker.origin + "/a2a", {
			method: "POST", headers: { "content-type": "application/json", "a2a-version": version,
				...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { id: randomUUID() } }),
		});
		expect((await rpc("GetTask", "1.0", "not-the-run-token")).status).toBe(401);
		expect((await fetch(worker.origin + "/message:send", { method: "POST" })).status).toBe(404);
		const streaming = await (await rpc("SendStreamingMessage", "1.0", worker.connection.token)).json();
		const wrongVersion = await (await rpc("GetTask", "0.3", worker.connection.token)).json();
		expect(streaming).toMatchObject({ error: { code: -32601 } });
		expect(wrongVersion).toMatchObject({ error: { code: expect.any(Number) } });
		expect(f.wire).toHaveLength(0);
		sendRecord("ma2-protocol", { pid: worker.pid, streaming, wrongVersion, modelRequests: 0 });
	} finally { await worker.close(); await f.dispose(); }
}, 30_000);

describe.skipIf(!dockerAvailable)("MA-2 official A2A and Docker", () => {
	it("repairs from an A2A diagnostic and recovers a dropped SendMessage response without repeating pytest", async () => {
		const replies = [edit("return value", "return value + 2", 100), textSse("First patch", 101, 3),
			edit("return value + 2", "return value + 1", 102), textSse("Repaired", 103, 3)];
		const f = await fixture(() => replies.shift() ?? textSse("Unexpected request", 99, 3));
		let worker = await testServer(f.options);
		const originalPid = worker.pid;
		const wire: unknown[] = [];
		let dropped = false;
		try {
			const card = await (await fetch(worker.origin + "/.well-known/agent-card.json")).json();
			const sdk = await officialClient(worker.connection);
			expect(card).toMatchObject({ supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
				securitySchemes: { localBearer: { httpAuthSecurityScheme: { scheme: "bearer" } } } });
			expect(JSON.stringify(card)).not.toContain(testAuth.token);
			const a2aFetch: typeof fetch = async (input, init) => {
				const req = new Request(input, init);
				const outgoing = req.method === "POST" ? await req.clone().json() as { method?: string } : null;
				const reply = await fetch(req);
				const received = await reply.clone().json();
				wire.push({ outgoing, received, dropped: outgoing?.method === "SendMessage" && !dropped });
				if (outgoing?.method === "SendMessage" && !dropped) {
					dropped = true;
					throw new TypeError("injected transport loss after admission");
				}
				return reply;
			};
			const result = await runMultiLocal({ ...f.options, remoteTest: worker.connection, a2aFetch }, goal);
			sendRecord("ma2-a2a-closure", { result, wire, card, pid: worker.pid, coordinatorPid: process.pid, model: f.wire });
			expect(result.state.reason).toBeUndefined();
			expect(result.task.task.status).toBe("completed");
			expect(result.state.requests).toEqual({ code: 4, test: 0 });
			expect(result.budget?.requestsStarted).toBe(4);
			expect(f.source()).toContain("return value + 1");
			expect(JSON.stringify(f.wire[2])).toContain("inspect-implementation");
			expect(JSON.stringify(wire)).not.toContain(privateLogMarker);
			const db = f.store();
			let reports: NonNullable<DelegationState["report"]>[];
			try {
				reports = db.delegationEvents(result.task.task.taskId).filter(e => e.source === "pytest_receipt")
					.map(e => (e.data as DelegationState).report!);
			} finally { db.close(); }
			expect(reports.map(r => r.receipt.status)).toEqual(["failed", "passed"]);
			const firstRemote = await sdk.getTask({ tenant: "", id: reports[0]!.remoteA2ATaskId! });
			const firstArtifact = artifact(firstRemote)!;
			const forged = structuredClone(firstRemote);
			artifact(forged)!.report.receipt.status = "passed";
			expect(() => artifactFromTask(forged, firstArtifact)).toThrow("MA2_ARTIFACT_MISMATCH");
			expect(firstRemote.id).not.toBe(firstArtifact.intent.operationId);
			expect(firstArtifact.diagnosis).toMatchObject({ cause: "implementation", recommendation: "inspect-implementation" });
			const duplicate = taskFrom(await sdk.sendMessage(messageFor(firstArtifact.intent)));
			expect(duplicate.id).toBe(firstRemote.id);
			expect(artifact(duplicate)?.startedAt).toBe(firstArtifact.startedAt);
			await expect(sdk.sendMessage(messageFor({ ...firstArtifact.intent, target: "different.py" }))).rejects.toThrow();
			await expect(sdk.cancelTask({ tenant: "", id: firstRemote.id, metadata: undefined })).rejects.toThrow();
			expect(pytestAttempts(f, result.task.task.taskId).map(a => [a.toolName, a.state])).toEqual([
				["edit", "succeeded"], ["run_tests", "failed"], ["edit", "succeeded"], ["run_tests", "succeeded"],
			]);
			const port = Number(new URL(worker.origin).port);
			await worker.close(true);
			worker = await testServer(f.options, port);
			const restartedSdk = await officialClient(worker.connection);
			const restartedTask = await restartedSdk.getTask({ tenant: "", id: firstRemote.id });
			expect(artifact(restartedTask)).toEqual(firstArtifact);
			expect(worker.pid).not.toBe(originalPid);
			for (const report of reports) expect(containers(report.remoteA2ATaskId!)).toBe("");
			sendRecord("ma2-server-restart", { originalPid, restarted: worker.pid, artifact: firstArtifact, second: reports[1] });
		} finally { await worker.close(); await f.dispose(); }
	}, 100_000);

	it("resumes a mapped test after the Coordinator process exits without replaying an edit", async () => {
		const replies = [edit("return value", "return value + 1", 100), textSse("Correct", 101, 3)];
		const f = await fixture(() => replies.shift() ?? textSse("Unexpected request", 99, 3), { tier: "premium" });
		const worker = await testServer(f.options);
		try {
			const options = { ...f.options, remoteTest: worker.connection };
			const before = await separateProcess(options, goal, "a2a_task_mapped");
			const db = f.store();
			let saved: DelegationState;
			try { saved = db.delegationEvents(before.taskId!).at(-1)!.data as DelegationState; } finally { db.close(); }
			const after = await separateProcess(options, { resume: before.taskId! });
			expect(after.result?.state.reason, after.error).toBeUndefined();
			expect(after.result?.task.task.status).toBe("completed");
			expect(after.pid).not.toBe(before.pid);
			expect(worker.pid).not.toBe(after.pid);
			expect(after.result?.state.report?.remoteA2ATaskId).toBe(saved.remoteTestTaskId);
			expect(after.result?.state.deadline).toBe(saved.deadline);
			expect(after.result?.budget?.limits).toMatchObject({ tier: "premium", maxTotalTokens: 30_000 });
			expect(after.result?.budget?.actualTotalTokens).toBe(207);
			expect(pytestAttempts(f, before.taskId!).filter(a => a.toolName === "edit")).toHaveLength(1);
			expect(f.wire).toHaveLength(2);
			sendRecord("ma2-coordinator-restart", { before, after, workerPid: worker.pid, remoteId: saved.remoteTestTaskId });
		} finally { await worker.close(); await f.dispose(); }
	}, 70_000);

	it.each(["cancel", "crash"] as const)("isolates foreign requests and preserves the confirmed test state after %s", async (scenario) => {
		const replies = [edit("return value", "return value + 1", 100), textSse("Correct", 101, 3)];
		const f = await fixture(() => replies.shift() ?? textSse("Unexpected request", 99, 3));
		writeFileSync(join(f.workspace, target), publicTest.replace("    print", "    import time\n    time.sleep(12)\n    print"));
		let worker = await testServer(f.options);
		try {
			const first = await separateProcess({ ...f.options, remoteTest: worker.connection }, goal, "a2a_intent_saved");
			const db = f.store();
			let state: DelegationState;
			try {
				state = db.delegationEvents(first.taskId!).at(-1)!.data as DelegationState;
			} finally { db.close(); }
			const intent = testIntent(state.operation!, { workspaceId: state.scope.workspaceId,
				testHash: state.testHash, policyHash: state.policyHash, patchHash: state.revision }, target);
			const sdk = await officialClient(worker.connection);
			if (scenario === "cancel") {
				const denied = await fetch(worker.origin + "/a2a", { method: "POST",
					headers: { "content-type": "application/json", "a2a-version": "1.0" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: randomUUID() } }),
				});
				expect(denied.status).toBe(401);
				await expect(sdk.sendMessage(messageFor({ ...intent, target: "../hidden.py" }))).rejects.toThrow();
				await expect(sdk.sendMessage(messageFor({ ...intent, projectId: "0".repeat(64) }))).rejects.toThrow();
				await expect(sdk.sendMessage(messageFor({ ...intent, parentTaskId: randomUUID() }))).rejects.toThrow();
			}
			const submitted = taskFrom(await sdk.sendMessage(messageFor(intent)));
			expect(submitted.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
			await expect.poll(async () => (await sdk.getTask({ tenant: "", id: submitted.id })).status?.state,
				{ timeout: 12_000 }).toBe(TaskState.TASK_STATE_WORKING);
			expect(containers(submitted.id)).not.toBe("");
			let expected: TaskState;
			const previousPid = worker.pid;
			if (scenario === "cancel") {
				const foreign = await testServer(f.options, 0, { principalId: "other-project-worker", token: "ma2_other_fixture_credential_only_ad12" });
				try {
					const foreignSdk = await officialClient(foreign.connection);
					await expect(foreignSdk.getTask({ tenant: "", id: submitted.id })).rejects.toThrow();
					await expect(foreignSdk.cancelTask({ tenant: "", id: submitted.id, metadata: undefined })).rejects.toThrow();
				} finally { await foreign.close(); }
				const canceled = await sdk.cancelTask({ tenant: "", id: submitted.id, metadata: undefined });
				expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
				expect((await sdk.cancelTask({ tenant: "", id: submitted.id, metadata: undefined })).status?.state)
					.toBe(TaskState.TASK_STATE_CANCELED);
				expected = TaskState.TASK_STATE_CANCELED;
			} else {
				const port = Number(new URL(worker.origin).port);
				await worker.close(true);
				worker = await testServer(f.options, port);
				expect(worker.pid).not.toBe(previousPid);
				expected = TaskState.TASK_STATE_FAILED;
			}
			const finalSdk = await officialClient(worker.connection);
			const final = await finalSdk.getTask({ tenant: "", id: submitted.id });
			expect(final.status?.state).toBe(expected);
			expect(final.artifacts).toHaveLength(0);
			expect(taskFrom(await finalSdk.sendMessage(messageFor(intent))).id).toBe(submitted.id);
			await expect.poll(() => containers(submitted.id), { timeout: 10_000 }).toBe("");
			const resumed = await runMultiLocal({ ...f.options, remoteTest: worker.connection }, { resume: first.taskId! });
			expect(resumed.task.task.status).not.toBe("completed");
			expect(resumed.state.reason).toBe(scenario === "crash" ? "MA2_REMOTE_EXECUTION_UNCERTAIN" : "MA2_CANCELLED");
			expect(pytestAttempts(f, first.taskId!).filter(a => a.toolName === "edit")).toHaveLength(1);
			expect(f.wire).toHaveLength(2);
			sendRecord(`ma2-${scenario}-isolation`, { beforePid: previousPid, serverPid: worker.pid, submitted, final, resumed,
				ownedContainers: 0 });
		} finally { await worker.close(); await f.dispose(); }
	}, 80_000);

	it("does not give A2A another model budget and bounds a disconnected transport before resume", async () => {
		const replies = [edit("return value", "return value + 2", 100), textSse("First patch", 101, 3)];
		const f = await fixture(() => replies.shift() ?? textSse("Unexpected request", 99, 3), { maxRequests: 2 });
		const worker = await testServer(f.options);
		const transportAttempts: string[] = [];
		try {
			const a2aFetch: typeof fetch = async (input, init) => {
				const req = new Request(input, init);
				if (req.method === "POST") {
					const payload = await req.clone().json() as { method: string };
					transportAttempts.push(payload.method);
					const result = await fetch(req);
					await result.body?.cancel();
					throw new TypeError("injected response loss");
				}
				return fetch(req);
			};
			const first = await runMultiLocal({ ...f.options, remoteTest: worker.connection, a2aFetch }, { ...goal, diagnose: true });
			expect(first.state).toMatchObject({ phase: "paused", resumePhase: "testing", reason: "MA2_TRANSPORT_UNAVAILABLE" });
			expect(transportAttempts).toEqual(["SendMessage", "SendMessage", "SendMessage"]);
			const resumed = await separateProcess({ ...f.options, remoteTest: worker.connection }, { resume: first.task.task.taskId });
			expect(resumed.result?.state.reason, resumed.error).toBe("GATEWAY_REQUEST_LIMIT");
			expect(resumed.result?.state.report?.remoteA2ATaskId).toBeDefined();
			expect(resumed.result?.state.requests).toEqual({ code: 2, test: 0 });
			expect(resumed.result?.budget?.actualTotalTokens).toBe(207);
			expect(f.wire).toHaveLength(2);
			expect(pytestAttempts(f, first.task.task.taskId).filter(a => a.toolName === "run_tests")).toHaveLength(1);
			sendRecord("ma2-bounded-retry-budget", { first, resumed, transportAttempts, modelRequests: f.wire.length });
		} finally { await worker.close(); await f.dispose(); }
	}, 70_000);
});

describe.skipIf(!dockerAvailable)("MA-1 HTTP Stub and Docker", () => {
	it.each(["multi-local", "multi-a2a"] as const)("uses independently priced role models across a %s process restart", async (mode) => {
		const replies = [edit("return value", "return value + 2", 100), textSse("Provisional", 101, 3),
			textSse(JSON.stringify(diagnosis), 102, 3), edit("return value + 2", "return value + 1", 103), textSse("Fixed", 104, 3)];
		const f = await fixture((body) => replies.shift()!.replaceAll('"model":"deepseek-flash"', `"model":${JSON.stringify(body.model)}`));
		const worker = mode === "multi-a2a" ? await testServer(f.options) : undefined;
		const wire: string[] = [];
		try {
			const options = { ...f.options, roleModels, remoteTest: worker?.connection };
			const paused = await separateProcess(options, { ...goal, diagnose: true }, "pytest_receipt");
			expect(paused.pid).not.toBe(process.pid);
			expect(f.wire.map((body) => body.model)).toEqual([roleModels.code.modelId, roleModels.code.modelId]);
			const store = f.store();
			let before;
			let deadline;
			try {
				before = storedBudget({ databasePath: store.scope.databasePath, id: paused.taskId! });
				expect(before).toMatchObject({ requestsStarted: 2, actualTotalTokens: 207 });
				const state = store.delegationEvents(paused.taskId!).at(-1)!.data as DelegationState;
				deadline = state.deadline;
				expect(state.roleModels).toMatchObject(roleModels);
				expect(JSON.stringify(state.roleModels)).not.toContain(options.provider.apiKey);
			} finally { store.close(); }
			const a2aFetch: typeof fetch = async (input, init) => {
				const req = new Request(input, init);
				wire.push(JSON.stringify([...req.headers]), await req.clone().text());
				const reply = await fetch(req);
				wire.push(await reply.clone().text());
				return reply;
			};
			const resumed = await runMultiLocal({ ...options, a2aFetch, roleModels: {
				code: { ...roleModels.code, modelId: "third-model" }, test: { ...roleModels.test, modelId: "other-model" },
			} }, { resume: paused.taskId! });
			expect(resumed.state.reason).toBeUndefined();
			expect(resumed.task.task.status).toBe("completed");
			expect(resumed.state.roleModels).toMatchObject(roleModels);
			expect(resumed.state.requests).toEqual({ code: 4, test: 1 });
			const ordered = [roleModels.code, roleModels.code, roleModels.test, roleModels.code, roleModels.code];
			expect(f.wire.map((body) => body.model)).toEqual(ordered.map((model) => model.modelId));
			expect(resumed.budget).toMatchObject({ requestsStarted: 5, requestsCompleted: 5, actualTotalTokens: 525,
				actualInputTokens: 510, actualOutputTokens: 15, reservedCostUsd: 0, limits: { tier: "standard", maxTotalTokens: 25_000 } });
			expect(resumed.budget?.requestOutcomes.map((result) => [result.modelId, result.pricing])).toEqual(ordered.map((model) => [model.modelId, model.pricing]));
			expect(resumed.budget?.actualCostUsd).toBeCloseTo(0.0009195, 12);
			expect(resumed.budget?.requestOutcomes.slice(0, 2)).toEqual(before?.requestOutcomes);
			expect(resumed.state.deadline).toBe(deadline);
			expect(pytestAttempts(f, paused.taskId!).filter((a) => a.toolName === "edit" && a.state === "succeeded")).toHaveLength(2);
			if (worker) {
				expect(wire.length).toBeGreaterThan(0);
				expect(wire.join("")).not.toContain(options.provider.apiKey);
				expect(wire.join("")).not.toContain(roleModels.test.modelId);
			}
			sendRecord("role-model-restart", { mode, models: f.wire.map((body) => body.model), parentBudget: resumed.budget,
				before, a2aMessages: wire.length, upstreamCredentialBytes: 0 });
		} finally { await worker?.close(); await f.dispose(); }
	}, 70_000);

	it("does not use the configured Test model when LLM diagnosis is disabled", async () => {
		const replies = [edit("return value", "return value + 2", 100), textSse("Provisional", 101, 3),
			edit("return value + 2", "return value + 1", 102), textSse("Fixed", 103, 3)];
		const f = await fixture((body) => replies.shift()!.replaceAll('"model":"deepseek-flash"', `"model":${JSON.stringify(body.model)}`));
		try {
			const result = await runMultiLocal({ ...f.options, roleModels }, { ...goal, diagnose: false });
			expect(result.task.task.status).toBe("completed");
			expect(result.state.requests).toEqual({ code: 4, test: 0 });
			expect(f.wire.map((body) => body.model)).toEqual(Array(4).fill(roleModels.code.modelId));
		} finally { await f.dispose(); }
	}, 45_000);

	it("runs two isolated sessions, returns diagnosis to Code and verifies both public and independent pytest", async () => {
		const replies = [
			toolCallSse("read", { path: filename }, 100, 3),
			edit("return value", "return value + 2", 101),
			textSse("First patch.", 102, 3),
			toolCallSse("read", { path: "../unapproved.py" }, 103, 3),
			edit("return value + 2", "return value + 99", 104),
			textSse(JSON.stringify(diagnosis), 105, 3),
			edit("return value + 2", "return value + 1", 106),
			textSse("Patch repaired.", 107, 3),
		];
		const f = await fixture((_body) => replies.shift() ?? textSse("Unexpected request", 99, 3));
		const toolEvents: unknown[] = [];
		const phases: unknown[] = [];
		try {
			const started = Date.now();
			const result = await runMultiLocal({ ...f.options,
				onTool: (role, name, denied) => toolEvents.push({ role, name, denied }),
				onCheckpoint: (name) => phases.push({ name, source: f.source() }),
			}, goal);
			sendRecord("closure", { result, phases, toolEvents, elapsedMs: Date.now() - started,
				requests: f.wire.map((body) => ({ body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") })) });
			expect(result.state.reason).toBeUndefined();
			expect(result.task.task.status).toBe("completed");
			expect(result.state.sessions.code.sessionId).not.toBe(result.state.sessions.test.sessionId);
			expect(result.modifiedFiles).toEqual([filename]);
			expect(f.source()).toContain("return value + 1");
			expect(result.state.requests).toEqual({ code: 5, test: 3 });
			expect(result.budget).toMatchObject({ requestsStarted: 8, requestsCompleted: 8, actualTotalTokens: 852 });
			expect(f.wire).toHaveLength(8);
			expect(f.wire.every((body) => body.model === f.options.provider.modelId)).toBe(true);
			const testRequests = f.wire.slice(3, 6);
			expect(testRequests.every((body) => {
				const tools = body.tools as { function: { name: string } }[];
				return tools.map((entry) => entry.function.name).join() === "read";
			})).toBe(true);
			expect(JSON.stringify(testRequests[0])).not.toContain("First patch");
			expect(JSON.stringify(f.wire[6])).toContain("inspect-implementation");
			expect(JSON.stringify(f.wire[6])).not.toContain("unapproved.py");
			expect(JSON.stringify(f.wire)).not.toContain(privateLogMarker);
			expect(toolEvents).toContainEqual({ role: "test", name: "read", denied: true });
			const db = f.store();
			try {
				const taskId = result.task.task.taskId;
				const receipts = db.delegationEvents(taskId).filter((e) => e.source === "pytest_receipt")
					.map((e) => (e.data as DelegationState).report!);
				expect(receipts.map((report) => report.receipt.status)).toEqual(["failed", "passed"]);
				expect(receipts[0]?.output).toContain(privateLogMarker);
				expect(receipts[0]?.workspaceRevision).not.toBe(receipts[1]?.workspaceRevision);
				expect(result.state.report?.receipt.patchHash).toBe(receipts[1]?.workspaceRevision);
				expect(db.getAttempts(taskId).filter((attempt) => attempt.toolName === "edit" && attempt.state === "succeeded")).toHaveLength(2);
				sendRecord("receipts", receipts);
			} finally {
				db.close();
			}

			// The independent verifier is a different temporary workspace and is never shown to either role.
			const judge = join(f.root, "judge");
			mkdirSync(judge);
			const independent = "test_contract.py";
			writeFileSync(join(judge, filename), f.source());
			writeFileSync(join(judge, independent), "from counter import next_count\n\ndef test_negative():\n    assert next_count(-5) == -4\n\ndef test_zero():\n    assert next_count(0) == 1\n");
			const verdict = await createPytestExecutor(sandboxConfigForTesting({
				workspace: judge, containerOwner: f.options.sandbox.containerOwner,
			}), { image: f.options.pytest.image, files: [filename, independent], tests: [independent] })([independent]);
			expect(verdict).toMatchObject({ status: "passed", passed: 2, exitCode: 0 });
			expect(containers(result.task.task.taskId)).toBe("");
			expect(containers(f.options.sandbox.containerOwner!)).toBe("");
			sendRecord("independent-verdict", verdict);
		} finally {
			await f.dispose();
		}
	}, 100_000);

	it("recovers independently after initialization, edit, failure receipt, diagnosis and passing receipt", async () => {
		const replies = [edit("return value", "return value + 2", 100), textSse("Provisional", 101, 3),
			textSse(JSON.stringify(diagnosis), 102, 3), edit("return value + 2", "return value + 1", 103),
			textSse("Repaired", 104, 3)];
		const f = await fixture(() => replies.shift() ?? textSse("Unexpected request", 99, 3), { tier: "premium" });
		try {
			const first = await separateProcess(f.options, goal, "initialized");
			const id = first.taskId!;
			const path = [
				await separateProcess(f.options, { resume: id }, "edit_committed"),
				await separateProcess(f.options, { resume: id }, "pytest_receipt"),
				await separateProcess(f.options, { resume: id }, "diagnosis_delivered"),
				await separateProcess(f.options, { resume: id }, "pytest_receipt"),
				await separateProcess(f.options, { resume: id }),
			];
			const result = path.at(-1)?.result;
			sendRecord("resume", { first, path, calls: f.wire.length, source: f.source() });
			expect(new Set([first, ...path].map((step) => step.pid)).size).toBe(6);
			expect(result?.state.reason).toBeUndefined();
			expect(result?.task.task.status).toBe("completed");
			expect(result?.state.requests).toEqual({ code: 4, test: 1 });
			expect(result?.budget).toMatchObject({ requestsStarted: 5, actualTotalTokens: 525, limits: { tier: "premium", maxTotalTokens: 30_000 } });
			expect(f.wire).toHaveLength(5);
			const db = f.store();
			try {
				const attempts = db.getAttempts(id);
				expect(attempts.map((attempt) => [attempt.toolName, attempt.state])).toEqual([
					["edit", "succeeded"], ["run_tests", "failed"], ["edit", "succeeded"], ["run_tests", "succeeded"],
				]);
				expect(db.delegationEvents(id).every((event) => (event.data as DelegationState).deadline === result?.state.deadline)).toBe(true);
			} finally { db.close(); }
			expect(containers(id)).toBe("");
		} finally {
			await f.dispose();
		}
	}, 120_000);

	it("blocks stale test receipts and invalid test targets", async () => {
		const replies = [edit("return value", "return value + 1", 100), textSse("Done", 101, 3)];
		const f = await fixture(() => replies.shift() ?? textSse("Unexpected request", 99, 3));
		try {
			await expect(runMultiLocal(f.options, { ...goal, target: "../hidden.py" })).rejects.toThrow("MA1_REQUEST_DENIED");
			await expect(runMultiLocal(f.options, { ...goal, editFiles: [target] })).rejects.toThrow("MA1_REQUEST_DENIED");
			expect(f.wire).toHaveLength(0);
			const paused = await separateProcess(f.options, goal, "pytest_receipt");
			writeFileSync(join(f.workspace, filename), initial);
			const result = await runMultiLocal(f.options, { resume: paused.taskId! });
			expect(result.state.reason).toBe("MA1_STALE_WORKSPACE");
			expect(result.task.task.status).toBe("paused");
			expect(f.wire).toHaveLength(2);
			sendRecord("stale-receipt", { task: result.task.task, reason: result.state.reason, requests: f.wire.length });
		} finally {
			await f.dispose();
		}
	}, 70_000);

	it.each(["multi-local", "multi-a2a", "multi-local role models", "multi-a2a role models"] as const)("keeps revoked Knowledge and a source-bearing patch out after %s restart", async (variant) => {
		const remote = variant.startsWith("multi-a2a");
		const independentModels = variant.endsWith("role models");
		const restricted = "ma1_revoked_knowledge_999b";
		const retained = "ma1_retained_knowledge_98fa";
		const replies = [
			toolCallSse(KNOWLEDGE_SEARCH, { query: "approved adjustment", corpusId: "counter" }, 100, 3),
			edit("return value", `return value + 2  # ${restricted}`, 101),
			textSse(`First patch based on ${restricted}`, 102, 3),
			toolCallSse("read", { path: filename }, 103, 3),
			textSse(JSON.stringify(diagnosis), 104, 3),
			toolCallSse("read", { path: filename }, 105, 3),
			edit("return value + 2", "return value + 1", 106),
			textSse("Repaired", 107, 3),
		];
		const f = await fixture((body) => {
			const reply = replies.shift() ?? textSse("Unexpected request", 99, 3);
			return independentModels ? reply.replaceAll('"model":"deepseek-flash"', `"model":${JSON.stringify(body.model)}`) : reply;
		});
		if (independentModels) f.options.roleModels = roleModels;
		f.options.sandbox.readonlyKnowledgeTools = true;
		writeFileSync(join(f.agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({ modules: { knowledge: { enabled: true } } }));
		const { projectId } = createProjectScope({ cwd: f.workspace, agentDir: f.agentDir });
		const storage = join(f.agentDir, "pi-enhanced", "knowledge", "projects", projectId);
		mkdirSync(storage, { recursive: true });
		writeFileSync(join(f.workspace, "previous.md"), `# Previous\nApproved adjustment ${restricted}.`);
		writeFileSync(join(f.workspace, "current.md"), `# Current\nApproved adjustment ${retained}.`);
		const knowledge = new KnowledgeService({ projectId, filename: join(storage, "knowledge.sqlite3"), mode: "lexical" });
		let worker: Awaited<ReturnType<typeof testServer>> | undefined;
		try {
			if (remote) {
				worker = await testServer(f.options);
				f.options.remoteTest = worker.connection;
			}
			await knowledge.add(f.workspace, "previous.md", "counter", "allow-external");
			await knowledge.add(f.workspace, "current.md", "counter", "allow-external");
			const first = await separateProcess(f.options, { ...goal, diagnose: true }, "edit_committed");
			expect(f.source()).toContain(restricted);
			const boundary = f.wire.length;
			expect(boundary).toBe(3);
			expect(JSON.stringify(f.wire)).toContain(restricted);
			await knowledge.add(f.workspace, "previous.md", "counter", "local-only");
			const tools: unknown[] = [];
			const rpc: string[] = [];
			const a2aFetch: typeof fetch = async (input, init) => {
				const request = new Request(input, init);
				if (request.method === "POST") rpc.push(await request.clone().text());
				const response = await fetch(request);
				rpc.push(await response.clone().text());
				return response;
			};
			const resumed = await runMultiLocal({ ...f.options, a2aFetch,
				onTool: (role, name, denied) => tools.push({ role, name, denied }) },
				{ resume: first.taskId! });
			const after = f.wire.slice(boundary);
			const wire = JSON.stringify(after);
			const byteCount = (marker: string) => (wire.split(marker).length - 1) * Buffer.byteLength(marker);
			const rpcBytes = (rpc.join("").split(restricted).length - 1) * Buffer.byteLength(restricted);
			sendRecord(`${remote ? "ma2" : "ma1"}-revocation${independentModels ? "-role-models" : ""}`,
				{ revokedBytes: byteCount(restricted), retainedBytes: byteCount(retained), rpcBytes, tools,
					report: resumed.state.report, reason: resumed.state.reason, after, rpc });
			expect(resumed.state.reason).toBeUndefined();
			expect(resumed.task.task.status).toBe("completed");
			expect(after).toHaveLength(5);
			expect(byteCount(restricted)).toBe(0);
			expect(byteCount(retained)).toBeGreaterThan(0);
			if (remote) {
				expect(rpc.length).toBeGreaterThan(0);
				expect(rpcBytes).toBe(0);
				expect(resumed.state.report?.remoteA2ATaskId).toBeDefined();
			}
			if (independentModels) expect(new Set(after.map((body) => body.model))).toEqual(new Set([roleModels.code.modelId, roleModels.test.modelId]));
			expect(tools).toContainEqual({ role: "test", name: "read", denied: true });
			expect(tools).toContainEqual({ role: "code", name: "read", denied: true });
		} finally {
			await worker?.close();
			await knowledge.close();
			await f.dispose();
		}
	}, 80_000);

	it("pauses an edit without a final role checkpoint and does not replay the confirmed write", async () => {
		const f = await fixture(() => edit("return value", "return value + 1", 100));
		try {
			const crashed = await separateProcess(f.options, goal, "write_returned");
			expect(f.source()).toContain("return value + 1");
			const result = await runMultiLocal(f.options, { resume: crashed.taskId! });
			expect(result.task.task.status).toBe("needs_reconciliation");
			expect(result.state.reason).toBe("MA1_INCOMPLETE_DELEGATION");
			expect(f.wire).toHaveLength(1);
			expect(containers(crashed.taskId!)).toBe("");
			const db = f.store();
			try {
				const attempts = db.getAttempts(crashed.taskId!);
				expect(attempts.map((attempt) => [attempt.toolName, attempt.state])).toEqual([["edit", "succeeded"]]);
				sendRecord("unacknowledged-write", { task: result.task.task, attempts, requests: f.wire.length, ownedContainers: 0 });
			} finally {
				db.close();
			}
		} finally {
			await f.dispose();
		}
	}, 60_000);

	it("continues a clean cancellation from the saved phase and preserves the budget", async () => {
		const replies = [edit("return value", "return value + 1", 100), textSse("Done", 101, 3)];
		const f = await fixture(() => replies.shift() ?? textSse("Unexpected request", 99, 3), { tier: "economy" });
		try {
			const control = new AbortController();
			const first = await runMultiLocal({ ...f.options, signal: control.signal,
				onCheckpoint: (name) => { if (name === "edit_committed") control.abort(); },
			}, goal);
			expect(first.state).toMatchObject({ phase: "paused", resumePhase: "testing", reason: "MA1_CANCELLED" });
			const next = await separateProcess(f.options, { resume: first.task.task.taskId });
			expect(next.result?.task.task.status, next.error).toBe("completed");
			expect(next.result?.state.deadline).toBe(first.state.deadline);
			expect(next.result?.budget?.actualTotalTokens).toBe(first.budget?.actualTotalTokens);
			expect(next.result?.budget?.actualCostUsd).toBe(first.budget?.actualCostUsd);
			expect(next.result?.budget?.limits).toMatchObject({ tier: "economy", maxTotalTokens: 20_000 });
			expect(f.wire).toHaveLength(2);
			sendRecord("clean-pause-resume", { first, next, requests: f.wire.length });
		} finally {
			await f.dispose();
		}
	}, 50_000);

	it("counts Test Agent requests against its own allowance and the parent ledger only once", async () => {
		const replies = [edit("return value", "return value + 2", 100), textSse("Provisional", 101, 3),
			toolCallSse("read", { path: filename }, 102, 3)];
		const f = await fixture(() => replies.shift() ?? textSse("Unexpected request", 99, 3));
		try {
			const result = await runMultiLocal(f.options, { ...goal, maxDiagnosisRequests: 1 });
			expect(result.state.reason).toBe("MA1_DIAGNOSIS_REQUEST_LIMIT");
			expect(result.state.requests).toEqual({ code: 2, test: 1 });
			expect(result.budget).toMatchObject({ requestsStarted: 3, requestsCompleted: 3, requestsRejected: 0, actualTotalTokens: 312 });
			expect(f.wire).toHaveLength(3);
			sendRecord("diagnosis-allowance", { result });
		} finally {
			await f.dispose();
		}
	}, 50_000);

	it("rejects a concurrent recovery and stops diagnosis when Code exhausts the parent requests", async () => {
		let reached!: () => void;
		let unlock!: () => void;
		const requestStarted = new Promise<void>((resolve) => { reached = resolve; });
		const wait = new Promise<void>((resolve) => { unlock = resolve; });
		const replies = [edit("return value", "return value + 2", 100), textSse("Done", 101, 3)];
		const f = await fixture(async () => {
			reached();
			await wait;
			return replies.shift() ?? textSse("Unexpected request", 99, 3);
		}, { tier: "premium", maxRequests: 2 });
		try {
			const paused = await separateProcess(f.options, goal, "initialized");
			const request = { resume: paused.taskId! };
			const active = runMultiLocal(f.options, request);
			try {
				await requestStarted;
				const rival = await separateProcess(f.options, request);
				expect(rival.error).toBe("GATEWAY_BUDGET_IN_USE");
				await expect(runMultiLocal(f.options, goal)).rejects.toThrow("MA1_WORKSPACE_ALREADY_ASSIGNED");
			} finally { unlock(); }
			const result = await active;
			expect(result.task.task.status).toBe("paused");
			expect(result.state.reason).toBe("GATEWAY_REQUEST_LIMIT");
			expect(result.state.requests).toEqual({ code: 2, test: 0 });
			expect(f.wire).toHaveLength(2);
			sendRecord("shared-hard-limit", { result, requests: f.wire.length });
		} finally {
			unlock();
			await f.dispose();
		}
	}, 75_000);
});
