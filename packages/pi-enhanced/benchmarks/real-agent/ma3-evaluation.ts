import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestUiContext, getMessageText } from "../../../coding-agent/test/suite/harness.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { openMemoryService } from "../../src/memory/service.ts";
import type { A2AConnection } from "../../src/multi-a2a/contract.ts";
import { type MultiLocalOptions, runMultiLocal } from "../../src/multi-local/coordinator.ts";
import type { DelegationState } from "../../src/multi-local/protocol.ts";
import { createPytestExecutor } from "../../src/sandbox/pytest.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { TASK_BUDGET_DEFAULTS, TASK_TOKEN_TIERS } from "../../src/shared/task-budget.ts";
import type { TaskSnapshot } from "../../src/task-manager/contracts.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import {
	close, dockerImageAvailable, sandboxConfigForTesting, startStubProvider, textSse, toolCallsSse,
} from "../../tests/fixtures/runner-support.ts";
import type { Task, gradeIndependent, invokeEvaluationTask, openEvaluationSession } from "./agent-evaluation.ts";
import { type BudgetGatewayStatus, startBudgetGateway } from "./budget-gateway.ts";
import { independentTasks } from "./independent-evaluation-tasks.ts";
import { flashEndpoint, flashVersion, guardMa3Upstream, Ma3Spending } from "./ma3-live-transport.ts";
import { ma3Fixtures, type Ma3Mode, ma3Modes, ma3Order } from "./ma3-tasks.ts";

type Support = {
	gradeIndependent: typeof gradeIndependent;
	invokeEvaluationTask: typeof invokeEvaluationTask;
	openEvaluationSession: typeof openEvaluationSession;
	publicTarget: string;
	image: string;
};
type Fixture = (typeof ma3Fixtures)[number];
type Call = { name: string; args: Record<string, unknown> };
type Stage = "locate" | "edit" | "public" | "pytest-result" | "repair" | "finish" | "done";
type TestStatus = { status?: string; exitCode?: number | null; passed?: number | null; failed?: number | null };
type Input = Parameters<typeof openEvaluationSession>[0];
const model = "deepseek-flash";
const pricing = { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 };
const limits = {
	tier: "standard" as const, maxRequests: TASK_BUDGET_DEFAULTS.maxRequests, maxTotalTokens: TASK_TOKEN_TIERS.standard,
	maxTotalCostUsd: TASK_BUDGET_DEFAULTS.maxTotalCostUsd, maxOutputTokensPerRequest: TASK_BUDGET_DEFAULTS.maxOutputTokensPerRequest,
	minOutputTokensPerRequest: 128, maxConcurrency: 1, requestTimeoutMs: 20_000, maxRequestBytes: 96_000,
};
const forbidden = ["FORBIDDEN_LOCAL_818", "REVOKED_DELIVERY_289", "test_hidden.py", "MA3_PRIVATE_FIXTURE_9851"];
const expectedE15Digest = "d8b13112115bbb19cfd4efbc6ad495397f3af4f575bd020bf88467230f2dcab5";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const clean = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const scratch = () => mkdtempSync(join(realpathSync.native(tmpdir()), "m3-"));
const call = (name: string, args: Call["args"]): Call => ({ name, args });
const productionDir = resolve(".");

function publicInputs(task: Task, target: string) {
	return { ...task.files, [target]: `from app import evaluate\n\ndef test_public():\n    assert ${task.publicCheck}\n` };
}

function scenario(support: Support, candidateSha256: string) {
	const e15Digest = sha(JSON.stringify(independentTasks));
	assert.equal(e15Digest, expectedE15Digest, "E15 tasks differ from the frozen E19 source");
	const outputLimit = limits.maxRequests * limits.maxOutputTokensPerRequest;
	const maxPerCellUsd = ((limits.maxTotalTokens - outputLimit) * pricing.inputUsdPerMillion +
		outputLimit * pricing.outputUsdPerMillion) / 1_000_000;
	return {
		schemaVersion: 1, candidateSha256, e15Digest,
		model, pricing, limits, deadlineMs: TASK_BUDGET_DEFAULTS.timeoutMs, concurrency: 1,
		diagnostics: { S0: "single-agent-self-diagnosis", S1: "model-read-only-test-session", S2: "model-read-only-test-session",
			authority: "actual pytest receipt", s2ArtifactSummary: "deterministic metadata in addition to identical model policy" },
		realModel: { endpoint: "https://api.deepseek.com", thinking: "disabled", temperature: 0,
			serverTools: false, execution: "requires separate authorization and unified gateway transport conformance",
			maxPerCellUsd, maxMatrixUsd: maxPerCellUsd * ma3Order.length,
			authorizationUsd: Math.ceil(maxPerCellUsd * ma3Order.length * 100) / 100 },
		grade: { image: support.image, publicTarget: support.publicTarget, independent: ["contract", "regression"], hiddenInAgentWorkspace: false },
		selection: ma3Fixtures.map(({ task, origin }) => ({
			id: task.id, origin, category: task.category, request: task.request,
			taskSha256: sha(JSON.stringify(task)), hiddenSha256: sha(task.hidden),
			files: Object.fromEntries(Object.entries(publicInputs(task, support.publicTarget)).map(([name, content]) => [name, sha(content)])),
			modules: { memory: !!task.memory, rag: !!task.doc, context: true, taskManager: true },
		})),
		fixturesSha256: sha(JSON.stringify(ma3Fixtures)),
		order: ma3Order,
	};
}

function applyEdits(files: Task["files"], edits: Task["edits"]) {
	const updated = { ...files };
	for (const { path, oldText, newText } of edits) {
		assert(updated[path]?.includes(oldText), path);
		updated[path] = updated[path]!.replace(oldText, newText);
	}
	return updated;
}

type WireMessage = { role: string; content?: string | { type: string; text?: string }[] };

function plainText(message: WireMessage | undefined): string {
	const content = message?.content;
	return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
}

function structuredPrompt(text: string) {
	const start = text.indexOf("{");
	if (start < 0) return;
	try {
		const data: unknown = JSON.parse(text.slice(start));
		if (data && typeof data === "object" && "goal" in data && typeof data.goal === "string")
			return { data: data as { goal: string; evidence?: Record<string, unknown>; failedTest?: Record<string, unknown> }, start };
	} catch { /* User text can be prose. */ }
}

/** Keep the persisted receipts intact and compare identical diagnostic evidence in both transport arms. */
function comparisonMessages(messages: WireMessage[]) {
	let removed = 0;
	const projected = messages.map((message) => {
		if (message.role !== "user") return message;
		const project = (text: string) => {
			const prompt = structuredPrompt(text);
			const record = prompt?.data.evidence ?? prompt?.data.failedTest;
			if (!prompt || !record || !("receipt" in record)) return text;
			let changed = false;
			for (const key of ["remoteDiagnosis", "remoteA2ATaskId"]) {
				if (!Object.hasOwn(record, key)) continue;
				delete record[key];
				removed++;
				changed = true;
			}
			return changed ? text.slice(0, prompt.start) + JSON.stringify(prompt.data) : text;
		};
		return typeof message.content === "string" ? { ...message, content: project(message.content) } :
			{ ...message, content: message.content?.map((part) => typeof part.text === "string" ? { ...part, text: project(part.text) } : part) };
	});
	return { messages: projected, removed };
}

async function verifyGrading(support: Support) {
	const root = scratch();
	try {
			const rows = [];
			for (const { task, origin, provisional, correction } of ma3Fixtures) {
				const base = join(root, task.id + "-base");
				const correct = join(root, task.id + "-ref");
				mkdirSync(base);
				mkdirSync(correct);
				const reference = applyEdits(task.files, task.edits);
				const baseline = await support.gradeIndependent(task, base, task.files);
				const solution = await support.gradeIndependent(task, correct, reference);
				assert.equal(baseline[0]?.status, "failed", task.id);
				assert(solution.every((row) => row.status === "passed"), task.id);
				let provisionalPublic: string | undefined;
				if (provisional && correction) {
					const draft = applyEdits(task.files, provisional);
					assert.deepEqual(applyEdits(draft, correction), reference, task.id);
					const workspace = join(root, task.id + "-draft");
					mkdirSync(workspace);
					const files = { ...publicInputs(task, support.publicTarget), ...draft };
					for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace, name), text);
					const run = createPytestExecutor(sandboxConfigForTesting({ workspace }), {
						image: support.image, files: Object.keys(files), tests: [support.publicTarget],
					});
					const result = await run([support.publicTarget]);
					assert.equal(result.status, "failed", task.id);
					provisionalPublic = result.status;
				}
				rows.push({ id: task.id, origin, baseline, reference: solution, provisionalPublic });
			}
			return rows;
	} finally { clean(root); }
}

async function prepare(root: string, task: Task, support: Support) {
	const workspace = join(root, "p"), agentDir = join(root, "a"), docs = join(root, "d"), grader = join(root, "g");
	for (const p of [workspace, agentDir, docs, grader]) mkdirSync(p);
	const files = publicInputs(task, support.publicTarget);
	for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace, name), text);
	writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({
		budget: { tier: "standard", ...TASK_BUDGET_DEFAULTS },
		modules: { memory: { enabled: !!task.memory }, knowledge: { enabled: !!task.doc, mode: "lexical" },
			context: { enabled: true, mode: "select", memoryInjection: { enabled: false }, taskInjection: { enabled: true },
				toolOutput: { enabled: true, offload: false, deduplicateReads: true } },
			"task-manager": { enabled: true, mode: "v1", contextSummary: true, modelPlanTool: false },
		},
	}));
	const manager = SessionManager.create(workspace, join(root, "s"));
	const scope = createProjectScope({ cwd: workspace, agentDir });
	if (task.memory) {
		const memory = await openMemoryService(scope);
		try {
			const candidate = await memory.saveCandidate({ kind: "fact", type: "semantic", content: task.memory.body,
				source: { type: "user", ref: "frozen-evaluation-fixture" } });
			const context = { hasUI: true, sessionManager: manager,
				ui: createTestUiContext({ confirm: async () => true }) } as unknown as ExtensionCommandContext;
			assert.equal((await memory.confirmByUser(candidate.id, candidate.revision, context)).status, "verified");
		} finally { await memory.close(); }
	}
	if (task.doc) {
		const knowledgeDir = join(agentDir, "pi-enhanced", "knowledge", "projects", scope.projectId);
		mkdirSync(knowledgeDir, { recursive: true });
		const corpus = new KnowledgeService({ projectId: scope.projectId, filename: join(knowledgeDir, "knowledge.sqlite3"), mode: "lexical" });
		try {
			const file = join(docs, "partner.md");
			writeFileSync(file, task.retired ?? task.doc.body);
			await corpus.add(docs, "partner.md", "contract", "allow-external");
			if (task.retired) {
				writeFileSync(file, task.doc.body);
				await corpus.add(docs, "partner.md", "contract", "allow-external");
			}
			writeFileSync(join(docs, "local.md"), `${task.doc.query} FORBIDDEN_LOCAL_818`);
			await corpus.add(docs, "local.md", "contract", "local-only");
		} finally { await corpus.close(); }
	}
	return { workspace, agentDir, grader, files, manager, storage: createTaskStorageScope(scope, agentDir) };
}

function createStub(fixture: Fixture, mode: Ma3Mode, target: string) {
	const { task } = fixture;
	const traces: Record<string, unknown>[] = [];
	const violations: string[] = [];
	let stage: Stage = "locate";
	let failedReceipt = false;
	let diagnosed = false;
	let evidenceDelivered = { memory: false, rag: false };
	let modelFinal = false;
	const report = (data: string): TestStatus | undefined => {
		const first = data.split("\n").find((line) => line.startsWith("{") && line.includes('"status"'));
		try { return first ? JSON.parse(first) as TestStatus : undefined; } catch { return; }
	};
	const answer = (choice: Call[] | string, n: number) => typeof choice === "string"
		? textSse(choice, 70 + n * 19, 9) : toolCallsSse(choice, 70 + n * 19, 9, true);
	const editCalls = (edits: Task["edits"]): Call[] =>
		Object.entries(Object.groupBy(edits, (edit) => edit.path)).map(([path, edits]) =>
			call("edit", { path, edits: edits!.map(({ oldText, newText }) => ({ oldText, newText })) }));
	const start = () => startStubProvider((body, response) => {
		const payload = JSON.stringify(body);
		const raw = (body.messages ?? []) as WireMessage[];
		const projection = comparisonMessages(raw);
		const messages = projection.messages;
		const n = traces.length + 1;
		const tools = ((body.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name);
		const isDiagnostic = messages.some((message) => message.role === "system" && plainText(message).includes("MA-1 Test Agent"));
		const lastTool = plainText(messages.findLast((message) => message.role === "tool"));
		const latestUser = plainText(messages.findLast((message) => message.role === "user"));
		const hits = Object.fromEntries(forbidden.map((marker) => [marker, tokenBytes(payload, marker)]));
		if (Object.values(hits).some(Boolean)) violations.push("restricted-marker");
		if (isDiagnostic && tools.some((tool) => tool !== "read")) violations.push("test-tool-scope");
		evidenceDelivered = { memory: evidenceDelivered.memory || (!!task.memory && payload.includes(task.memory.marker)),
			rag: evidenceDelivered.rag || (!!task.doc && payload.includes(task.doc.marker)) };
		const trace = { n, stage, role: isDiagnostic ? "test" : mode === "S0" ? "single" : "code",
			bytes: Buffer.byteLength(payload), payloadHash: sha(payload), model: body.model, maxTokens: body.max_tokens, tools, hits,
			transportMetadataRemoved: projection.removed, comparedMessagesHash: sha(JSON.stringify(messages)),
			sources: { ...evidenceDelivered }, lastTest: report(lastTool)?.status };
		const fail = (why: string) => { violations.push(why); return "Controlled preflight stopped: " + why; };
		let choice: Call[] | string;
		let diagnosticEvidence: unknown;
		if (violations.length) choice = "Controlled preflight stopped on isolation check.";
		else if (isDiagnostic) {
			const evidence = structuredPrompt(latestUser)?.data.evidence as { receipt?: TestStatus; failureKind?: string } | undefined;
			diagnosticEvidence = evidence ? { status: evidence.receipt?.status, failureKind: evidence.failureKind,
				exitCode: evidence.receipt?.exitCode, passed: evidence.receipt?.passed, failed: evidence.receipt?.failed } :
				{ missing: true, messages: messages.filter((m) => m.role === "user").map((m) => plainText(m)) };
			failedReceipt = evidence?.receipt?.status === "failed" && evidence.failureKind === "assertion";
			if (!fixture.correction || !failedReceipt) choice = fail("unexpected-diagnosis");
			else {
				diagnosed = true;
				stage = "repair";
				choice = '{"cause":"implementation","recommendation":"inspect-implementation","file":null}';
			}
		} else switch (stage) {
			case "locate":
				stage = "edit";
				choice = [
					...Object.keys(task.files).map((path) => call("read", { path })),
					...(task.memory ? [call("enhanced_memory_search", { query: task.memory.query })] : []),
					...(task.doc ? [call("enhanced_docs_search", { query: task.doc.query, corpusId: "contract" })] : []),
				];
				break;
			case "edit":
				if ((task.memory && !evidenceDelivered.memory) || (task.doc && !evidenceDelivered.rag)) {
					choice = fail("missing-approved-source");
					break;
				}
				choice = editCalls(fixture.provisional ?? task.edits);
				stage = mode === "S0" ? "public" : "finish";
				break;
			case "public":
				stage = "pytest-result";
				choice = [call("run_tests", { targets: [target] })];
				break;
			case "pytest-result":
				if (fixture.correction && !failedReceipt && report(lastTool)?.status === "failed") {
					failedReceipt = true;
					stage = "public";
					choice = editCalls(fixture.correction);
				} else if (report(lastTool)?.status === "passed" && (!fixture.correction || failedReceipt)) {
					modelFinal = true;
					stage = "done";
					choice = "The scoped patch passed the approved public test.";
				} else choice = fail("public-test-evidence-missing");
				break;
			case "repair":
				if (!diagnosed || !latestUser.includes("inspect-implementation")) {
					choice = fail("diagnosis-not-delivered");
					break;
				}
				stage = "finish";
				choice = editCalls(fixture.correction!);
				break;
			case "finish":
				modelFinal = true;
				stage = "done";
				choice = "The approved source edit is complete. Use the assigned pytest evidence for verification.";
				break;
			default:
				choice = fail("unexpected-model-request");
		}
		if (Array.isArray(choice) && choice.some(({ name }) => !tools.includes(name))) choice = fail("required-tool-hidden");
		traces.push({ ...trace, outgoing: Array.isArray(choice) ? choice.map((item) => item.name) : "text",
			responseRole: isDiagnostic ? "diagnosis" : undefined, diagnosticEvidence });
		response.writeHead(200, { "content-type": "text/event-stream" }).end(answer(choice, n));
	});
	return { start, traces, violations, state: () => ({ failedReceipt, diagnosed, modelFinal, evidenceDelivered }) };
}

function tokenBytes(haystack: string, marker: string): number {
	return (haystack.split(marker).length - 1) * Buffer.byteLength(marker);
}

async function launchServer(options: MultiLocalOptions) {
	const principalId = "ma3-local-worker";
	const token = randomUUID() + randomUUID();
	const child = fork(fileURLToPath(new URL("../../tests/fixtures/multi-local-child.ts", import.meta.url)), [
		"a2a-server", JSON.stringify({ port: 0, principalId, token, agentDir: options.agentDir, sandbox: options.sandbox, pytest: options.pytest }),
	], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const exit = once(child, "exit");
	const [message] = await Promise.race([once(child, "message"), exit.then(() => { throw new Error("MA3 A2A unavailable"); })]);
	const { origin, pid } = message as { origin: string; pid: number };
	assert.notEqual(pid, process.pid);
	const connection: A2AConnection = { origin, principalId, token };
	return { connection, pid, async close() {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.send("shutdown");
		await exit;
	} };
}

async function single(task: Task, prepared: Awaited<ReturnType<typeof prepare>>, root: string, upstream: string, support: Support,
	apiKey = "mock-upstream-key") {
	const { manager, files, storage } = prepared;
	const notes: string[] = [];
	const auditions: TestStatus[] = [];
	const projections: Input["projections"] = [];
	const edited = new Set<string>();
	const ids = new Map<string, string>();
	let duplicateWrites = 0;
	let taskState: TaskSnapshot | undefined;
	let terminalStop: string | undefined;
	let finalTextBytes = 0;
	let budget: BudgetGatewayStatus | undefined;
	const toolEvents: Record<string, unknown>[] = [];
	const onEvent: NonNullable<Input["onEvent"]> = (event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			terminalStop = event.message.stopReason;
			finalTextBytes = event.message.content.reduce((bytes, part) => bytes + (part.type === "text" ? Buffer.byteLength(part.text.trim()) : 0), 0);
		}
		if (event.type === "tool_execution_start" && event.toolName === "edit")
			ids.set(event.toolCallId, sha(JSON.stringify(event.args)));
		if (event.type !== "tool_execution_end") return;
		toolEvents.push({ name: event.toolName, callId: event.toolCallId, isError: event.isError });
		if (event.toolName === "run_tests") {
			const data = getMessageText(event.result);
			try { auditions.push(JSON.parse(data)); } catch { /* The grader cannot use unparseable test claims. */ }
		}
		if (event.isError) return;
		if (event.toolName === "edit") {
			const key = ids.get(event.toolCallId);
			if (key && edited.has(key)) duplicateWrites++;
			if (key) edited.add(key);
		}
	};
	const open = (url: string, phase: string, gateway?: Awaited<ReturnType<typeof startBudgetGateway>>) =>
		support.openEvaluationSession({ root, manager, url, phase, task, inputFiles: files, compact: false, notes, audits: [],
			projections, gateway, workflow: true, productionOnly: true, productionBudget: true, flashCompatibility: true, onEvent,
			...(gateway ? { modelTransport } : {}) });
	let host: Awaited<ReturnType<typeof openEvaluationSession>> | undefined;
	let gateway: Awaited<ReturnType<typeof startBudgetGateway>> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const permits = new Map<string, () => void>();
	const modelTransport: NonNullable<Input["modelTransport"]> = ({ beforeSend }) => async (input, init) => {
		const request = new Request(input, init);
		if (request.method !== "POST" || request.url !== `${gateway?.url}/v1/chat/completions`)
			throw new Error("MA3_GATEWAY_ROUTE_DENIED");
		const permit = randomUUID();
		permits.set(permit, () => beforeSend?.());
		try {
			return await fetch(request.url, { method: "POST", body: await request.text(), signal: request.signal, redirect: "error",
				headers: { Authorization: "Bearer agent-evaluation-client", "content-type": "application/json", "x-pi-budget-permit": permit } });
		} finally { permits.delete(permit); }
	};
	const invoke = (cmd: string, args: string) => support.invokeEvaluationTask(host!, notes, cmd, args);
	const shutdown = async () => {
		if (!host) return;
		await host.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		host.dispose();
		host = undefined;
	};
	try {
		host = await open(upstream, "setup");
		const created = await invoke("enhanced-task-create", JSON.stringify({ goal: task.request, steps: [{
			stepId: "work", title: "Implement and verify", expectedOutcome: "Pass approved tests",
			validation: { kind: "pytest", target: support.publicTarget, expectedSha256: sha(files[support.publicTarget]!) },
		}] }));
		const id = created.task.taskId;
		const deadlineAt = Date.now() + TASK_BUDGET_DEFAULTS.timeoutMs;
		await shutdown();
		gateway = await startBudgetGateway({
			runId: id, allowedModel: model, upstreamBaseUrl: upstream, upstreamApiKey: apiKey,
			clientToken: "agent-evaluation-client", adminToken: randomUUID(), pricing, limits, guardedClientRetry: true,
			persistence: { databasePath: storage.databasePath, id, mode: "create", deadlineAt }, runDeadlineAt: deadlineAt,
			dispatchCheck: (permit) => permit ? permits.get(permit) : undefined,
		});
		host = await open(gateway.url, "run", gateway);
		timer = setTimeout(() => { gateway?.stop("GATEWAY_RUN_TIMEOUT"); void host?.abort().catch(() => undefined); },
			Math.max(0, deadlineAt - Date.now()));
		await invoke("enhanced-task-approve", `${id} ${created.task.revision}`);
		await invoke("enhanced-task-step", `${id} work bind`);
		await invoke("enhanced-task-step", `${id} work start 1`);
		await host.prompt(task.request);
		taskState = await invoke("enhanced-task-inspect", id);
		budget = gateway.status();
		if (terminalStop === "stop" && finalTextBytes && auditions.at(-1)?.status === "passed" && !budget.denials.length && Date.now() <= deadlineAt) {
			const verifying = await invoke("enhanced-task-step", `${id} work verify ${taskState.steps[0]!.revision}`);
			const checked = await invoke("enhanced-task-step", `${id} work complete ${verifying.steps[0]!.revision}`);
			taskState = await invoke("enhanced-task-complete", `${id} ${checked.task.revision}`);
		}
		return { status: taskState.task.status, task: taskState, budget, publicTests: auditions, duplicateWrites, toolEvents,
			delegation: [] as ReturnType<TaskProvider["delegationEvents"]>,
			normalFinal: terminalStop === "stop" && finalTextBytes > 0, testModelRequests: 0, reason: undefined };
	} finally {
		clearTimeout(timer);
		try { await shutdown(); } finally { await gateway?.close(); }
	}
}

async function multi(mode: "S1" | "S2", task: Task, prepared: Awaited<ReturnType<typeof prepare>>, upstream: string, support: Support,
	apiKey = "mock-upstream-key") {
	const toolEvents: Record<string, unknown>[] = [];
	const options: MultiLocalOptions = {
		agentDir: prepared.agentDir,
		sandbox: sandboxConfigForTesting({ workspace: prepared.workspace, readonlyModuleTools: !!task.memory,
			readonlyKnowledgeTools: !!task.doc, runId: `ma3-${randomUUID()}` }),
		pytest: { image: support.image, files: Object.keys(prepared.files), tests: [support.publicTarget] },
		provider: { baseUrl: upstream, apiKey, modelId: model, pricing },
		onTool: (role, name, denied) => toolEvents.push({ role, name, denied }),
	};
	const worker = mode === "S2" ? await launchServer(options) : undefined;
	const a2aWire: { body: string; reply: string; status: number; forbiddenBytes: number; elapsedMs: number }[] = [];
	const onFetch: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		const body = req.method === "POST" ? await req.clone().text() : "";
		const started = performance.now();
		const response = await fetch(req);
		const reply = await response.clone().text();
		a2aWire.push({ body, reply, status: response.status, elapsedMs: performance.now() - started,
			forbiddenBytes: forbidden.reduce((sum, marker) => sum + tokenBytes(body + reply, marker), 0) });
		return response;
	};
	try {
		const result = await runMultiLocal({ ...options, ...(worker ? { remoteTest: worker.connection, a2aFetch: onFetch } : {}) },
			{ goal: task.request, target: support.publicTarget, editFiles: Object.keys(task.files), diagnose: true });
		const provider = new TaskProvider(prepared.storage);
		let publicTests: TestStatus[];
		let duplicateWrites: number;
		let delegation: ReturnType<TaskProvider["delegationEvents"]>;
		try {
			delegation = provider.delegationEvents(result.task.task.taskId);
			publicTests = delegation.filter((event) => event.source === "pytest_receipt")
				.map((event) => (event.data as DelegationState).report!.receipt);
			const writes = provider.getAttempts(result.task.task.taskId).filter((a) => a.toolName === "edit" && a.state === "succeeded");
			duplicateWrites = writes.length - new Set(writes.map((a) => a.inputDigest)).size;
		} finally { provider.close(); }
		return { status: result.task.task.status, task: result.task, budget: result.budget, publicTests, duplicateWrites, delegation, toolEvents,
			normalFinal: result.state.phase === "completed", reason: result.state.reason,
			testModelRequests: result.state.requests.test, ...(worker ? { workerPid: worker.pid, a2aWire } : {}) };
	} finally { await worker?.close(); }
}

type PaidScope = {
	spending: Ma3Spending;
	record: (event: Record<string, unknown>) => void;
	key?: string;
};

async function runCell(fixture: Fixture, mode: Ma3Mode, support: Support, scope?: PaidScope) {
	const started = performance.now();
	const { task } = fixture;
	const root = scratch();
	const stubScript = createStub(fixture, mode, support.publicTarget);
	const stub = scope?.key ? undefined : await stubScript.start();
	const cell = `${task.id}:${mode}`;
	const evidenceDelivered = { memory: false, rag: false };
	const guard = scope && guardMa3Upstream({ cell, mode, upstream: stub?.url ?? flashEndpoint, key: scope.key ?? "mock-upstream-key",
		spending: scope.spending, record: scope.record,
		project(raw) {
			assert(Array.isArray(raw.messages), "MA3 request messages missing");
			const source = JSON.stringify(raw);
			assert(!forbidden.some((marker) => source.includes(marker)), "MA3 restricted data reached the provider boundary");
			const projected = comparisonMessages(raw.messages as WireMessage[]);
			const test = projected.messages.some((entry) => entry.role === "system" && plainText(entry).includes("MA-1 Test Agent"));
			const tools = ((raw.tools ?? []) as { type: string; function?: { name: string } }[]);
			assert(tools.every((tool) => tool.type === "function" && (!test || tool.function?.name === "read")), "MA3 unexpected role or provider tool");
			const body = { ...raw, messages: projected.messages, thinking: { type: "disabled" }, temperature: 0 } as Record<string, unknown>;
			delete body.reasoning_effort;
			evidenceDelivered.memory ||= !!task.memory && source.includes(task.memory.marker);
			evidenceDelivered.rag ||= !!task.doc && source.includes(task.doc.marker);
			return { body, metadata: { role: test ? "test" : mode === "S0" ? "single" : "code",
				profile: "flash-openai-compatible", bytes: Buffer.byteLength(JSON.stringify(body)),
				transportFieldsRemoved: projected.removed, tools: tools.map((tool) => tool.function?.name) } };
		},
	});
	try {
		const prep = await prepare(root, task, support);
		if (scope) {
			assert(!existsSync(join(prep.workspace, "test_hidden.py")) && !existsSync(prep.storage.databasePath));
			assert(new Set([prep.workspace, prep.agentDir, prep.grader].map((path) => realpathSync.native(path))).size === 3);
			await assert.rejects(fetch(`${guard!.baseUrl}/chat/completions`), /MA3_GATEWAY_CREDENTIAL_REQUIRED/u);
			await assert.rejects(fetch(`${flashEndpoint}/chat/completions`), /MA3_DIRECT_PROVIDER_DENIED/u);
		}
		let result: Awaited<ReturnType<typeof multi>> | undefined;
		let exception: string | undefined;
		const runStart = performance.now();
		try {
			const upstream = guard?.baseUrl ?? stub!.url;
			result = mode === "S0" ? await single(task, prep, root, upstream, support, guard?.apiKey)
				: await multi(mode, task, prep, upstream, support, guard?.apiKey);
		} catch (error) {
			exception = error instanceof Error ? error.message : String(error);
		}
		const agentMs = performance.now() - runStart;
		assert.equal(fileHash(join(prep.workspace, support.publicTarget)), sha(prep.files[support.publicTarget]!));
		const owned = Object.fromEntries(Object.keys(task.files).map((path) => [path, readFileSync(join(prep.workspace, path), "utf8")]));
		const edited = Object.keys(owned).filter((file) => owned[file] !== task.files[file]);
		const independent = await support.gradeIndependent(task, prep.grader, owned);
		const passed = independent.filter((check) => check.status === "passed").length;
		const budget = result?.budget;
		const costUpperUsd = scope?.spending.settle(cell, budget);
		const overrun = !!budget && (budget.actualTotalTokens > limits.maxTotalTokens ||
			budget.actualCostUsd > limits.maxTotalCostUsd || budget.requestsStarted > limits.maxRequests ||
			stubScript.traces.some((row) => !Number.isInteger(row.maxTokens) || Number(row.maxTokens) < 1 ||
				Number(row.maxTokens) > limits.maxOutputTokensPerRequest));
		const policy = [...stubScript.violations, ...(guard?.violations ?? [])];
		if (exception?.startsWith("MA3_")) policy.push(exception);
		const a2aForbiddenBytes = result?.a2aWire?.reduce((count, entry) => count + entry.forbiddenBytes, 0) ?? 0;
		if (a2aForbiddenBytes) policy.push("a2a-restricted-marker");
		const success = passed === 2 && result?.status === "completed" && result.normalFinal && result.duplicateWrites === 0 &&
			result.publicTests.at(-1)?.status === "passed" && !!budget && !overrun && !policy.length && !exception &&
			(!!scope?.key || !fixture.provisional || (result.publicTests[0]?.status === "failed" &&
				(mode === "S0" || (result.testModelRequests === 1 && stubScript.state().diagnosed))));
		const reason = success ? null : overrun ? "budget-overrun" : budget?.denials.length ? "budget-denied" :
			exception ?? policy[0] ?? result?.reason ?? (passed < 2 ? "independent-grading" : "incomplete-workflow");
		const { a2aWire, ...resultSummary } = result ?? {};
		const { requestsStarted, requestsRejected, actualInputTokens, actualOutputTokens, actualTotalTokens, actualCostUsd, denials } =
			budget ?? ({} as BudgetGatewayStatus);
		return {
			summary: { task: task.id, mode, origin: fixture.origin, success, reason, elapsedMs: performance.now() - started,
				agentMs, edited, independent: passed, publicTests: result?.publicTests.map((row) => ({ status: row.status,
					exitCode: row.exitCode, passed: row.passed, failed: row.failed })),
				taskStatus: result?.status, normalFinal: result?.normalFinal, testModelRequests: result?.testModelRequests,
				duplicateWrites: result?.duplicateWrites, overrun, workerPid: result?.workerPid, a2aForbiddenBytes, costUpperUsd,
				budget: { requestsStarted, requestsRejected, actualInputTokens, actualOutputTokens, actualTotalTokens, actualCostUsd,
					denials: denials?.map(({ code }) => code) }, ...stubScript.state(), ...(scope?.key ? { evidenceDelivered } : {}) },
			trace: { task: task.id, mode, independent, budget, requestTrace: stubScript.traces, providerWire: guard?.trace,
				policy, a2aWire, result: resultSummary, exception },
		};
	} finally { guard?.restore(); try { if (stub) await close(stub.server); } finally { clean(root); } }
}

type PaidMode = "ma3-paid-preflight" | "ma3-paid" | "ma3-resume-preflight" | "ma3-resume-paid" | "ma3-final-preflight" | "ma3-final-paid";
type FrozenDesign = ReturnType<typeof scenario> & { designSha256: string };

function priorMa3Spending(dir: string, design: FrozenDesign) {
	const prior = JSON.parse(readFileSync(join(dir, "paid.json"), "utf8"));
	assert.equal(prior.status, "BLOCKED");
	assert.equal(prior.designSha256, design.designSha256);
	assert.equal(prior.candidateSha256, design.candidateSha256);
	assert.deepEqual(prior.order, design.order);
	const events = readFileSync(join(dir, "trace.jsonl"), "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line))
		.filter((event) => event.runId === prior.runId && event.stage === "ma3-paid" && !event.probe);
	const prefix = design.order.map(({ id, mode }) => `${id}:${mode}`);
	const dispatched = events.filter((event) => event.kind === "provider-dispatch").map((event) => event.cell as string);
	const settled = events.filter((event) => event.kind === "cell-settled");
	const stopped = events.findLast((event) => event.kind === "operator-stop");
	assert.equal(stopped?.allPaidCallsStopped, true);
	assert.deepEqual(stopped, prior.operatorStop);
	assert.deepEqual(dispatched, prefix.slice(0, stopped.attemptedUnits));
	assert.deepEqual(settled.map((event) => event.cell), dispatched.slice(0, -1));
	assert.equal(dispatched.at(-1), stopped.interruptedCell);
	assert.deepEqual(events.filter((event) => event.kind === "provider-http").map((event) => [event.cell, event.status]),
		dispatched.map((cell) => [cell, 401]));
	const held = settled.reduce((sum, event) => sum + event.costUpperUsd, stopped.pendingConservativeHoldUsd as number);
	assert(Math.abs(held - stopped.totalConservativeExposureUsd) < 1e-8);
	return { attempted: dispatched, heldUsd: stopped.totalConservativeExposureUsd as number, runId: prior.runId as string };
}

function finalMa3Spending(dir: string, design: FrozenDesign) {
	const initial = priorMa3Spending(dir, design);
	const history = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
	const previousRaw = readFileSync(join(dir, "paid-resume.json"));
	const previous = JSON.parse(previousRaw.toString("utf8"));
	const audit = history.ledgerAudit;
	assert.equal(sha(previousRaw.toString("utf8")), audit.validSources.continuationJournalSha256);
	assert.equal(fileHash(join(dir, "paid.json")), audit.validSources.originalPaidJournalSha256);
	const trace = readFileSync(join(dir, "trace.jsonl"));
	assert.equal(createHash("sha256").update(trace.subarray(0, audit.validSources.historicalTraceBytes)).digest("hex"),
		audit.validSources.historicalTraceSha256);
	assert.equal(previous.candidateSha256, design.candidateSha256);
	assert.equal(previous.designSha256, design.designSha256);
	assert.equal(previous.status, "PARTIAL");
	assert.equal(previous.stopReason, "global-budget");
	assert.deepEqual(previous.priorSpending, initial);
	assert.deepEqual(previous.order, design.order.slice(initial.attempted.length));
	const events = trace.toString("utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line))
		.filter((event) => event.runId === previous.runId && event.stage === "ma3-resume-paid" && !event.probe);
	const cellIds = (kind: string) => events.filter((event) => event.kind === kind).map((event) => event.cell as string);
	const settled = events.filter((event) => event.kind === "cell-settled");
	const suffix = previous.order.slice(0, 3).map(({ id, mode }: { id: string; mode: string }) => `${id}:${mode}`);
	assert.deepEqual(cellIds("cell-reserved"), suffix);
	assert.deepEqual(cellIds("cell-settled"), suffix);
	assert.deepEqual([...new Set(cellIds("provider-dispatch"))], suffix);
	assert.equal(cellIds("provider-usage").length, 16);
	assert.equal(previous.rows.length, 3);
	assert(previous.rows.every((row: { success: boolean }) => row.success));
	const heldUsd = previous.settledUpperUsd as number;
	assert(Math.abs(heldUsd - (initial.heldUsd + settled.reduce((sum, event) => sum + event.costUpperUsd, 0))) < 1e-8);
	assert.equal(heldUsd, 0.221823901);
	assert.equal(heldUsd, audit.reconciliation.globalCommittedAndHeldUpperUsd);
	assert.equal(audit.reconciliation.gatewayLivePendingUsd, 0);
	assert.equal(audit.reconciliation.authUnreleasedGlobalHoldUsd, 0.03);
	const attempted = [...initial.attempted, ...suffix];
	assert.deepEqual(audit.entries.map((entry: { cell: string; status: string }, index: number) => [entry.cell, entry.status]),
		design.order.map(({ id, mode }, index) => [`${id}:${mode}`, index < 7 ? "upstream_authentication_failed" : index < 10 ? "completed" : "not_started"]));
	assert.equal(design.order.length - attempted.length, 8);
	return { attempted, heldUsd, runId: previous.runId as string };
}

async function runMa3Paid(dir: string, mode: PaidMode, support: Support, design: FrozenDesign) {
	const paid = mode === "ma3-paid" || mode === "ma3-resume-paid" || mode === "ma3-final-paid";
	const final = mode === "ma3-final-preflight" || mode === "ma3-final-paid";
	const resuming = mode === "ma3-resume-preflight" || mode === "ma3-resume-paid";
	const priorSpending = final ? finalMa3Spending(dir, design) : resuming ? priorMa3Spending(dir, design) : undefined;
	const name = final ? "paid-final" : resuming ? "paid-resume" : "paid";
	const preflightPath = join(dir, `${name}-preflight.json`);
	const output = paid ? join(dir, `${name}.json`) : preflightPath;
	const cumulativeCap = final ? 0.50 : 0.25;
	const traceFile = join(dir, "trace.jsonl");
	const runId = randomUUID();
	const proof = ["agent-evaluation.ts", "ma3-evaluation.ts", "ma3-live-transport.ts", "ma3-tasks.ts"].map((name) =>
		fileHash(fileURLToPath(new URL(name, import.meta.url))));
	const record = (event: Record<string, unknown>) => appendFileSync(traceFile, JSON.stringify({ runId, stage: mode,
		at: new Date().toISOString(), ...event }) + "\n", { flush: true });
	let key: string | undefined;
	if (paid) {
		assert.equal(process.env.PI_MA3_APPROVED_DESIGN, design.designSha256);
		assert.equal(process.env.PI_MA3_MAX_USD, cumulativeCap.toFixed(2));
		const prior = JSON.parse(readFileSync(preflightPath, "utf8"));
		assert.equal(prior.status, "PASS");
		assert.equal(prior.designSha256, design.designSha256);
		assert.deepEqual(prior.proof, proof);
		if (priorSpending) assert.deepEqual(prior.priorSpending, priorSpending);
		assert.equal(prior.rows.length, 18);
		key = process.env.DEEPSEEK_API_KEY?.trim();
		if (!key && process.env.PI_EVALUATION_ENV_FILE)
			key = parseEnv(readFileSync(process.env.PI_EVALUATION_ENV_FILE, "utf8")).DEEPSEEK_API_KEY?.trim();
		assert(key, "No configured DeepSeek credential");
	}
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.PI_EVALUATION_ENV_FILE;
	const spending = new Ma3Spending(cumulativeCap, record, paid ? priorSpending : undefined, final && paid ? 0.24 : cumulativeCap);
	const order = paid && priorSpending ? design.order.slice(priorSpending.attempted.length) : design.order;
	const rows: Awaited<ReturnType<typeof runCell>>["summary"][] = [];
	const matrix = { runId, designSha256: design.designSha256, candidateSha256: design.candidateSha256, proof,
		configuration: { model, expectedVersion: flashVersion, ...limits, globalUsd: cumulativeCap, incrementalUsd: final ? 0.24 : undefined, timeoutMs: design.deadlineMs },
		status: "PENDING", stopReason: null as string | null, settledUpperUsd: spending.settledUsd,
		budgetProbe: "pending", priorSpending, rows, order };
	const snapshot = () => {
		matrix.settledUpperUsd = spending.settledUsd;
		writeFileSync(output + ".next", JSON.stringify(matrix, null, 2) + "\n", { flush: true });
		renameSync(output + ".next", output);
	};
	assert(!existsSync(output + ".next"), "MA3 may have an incomplete journal");
	writeFileSync(output, JSON.stringify(matrix, null, 2) + "\n", { flag: "wx", flush: true });
	try {
		const budgetProbe = new Ma3Spending(0.059, (event) => record({ ...event, probe: true }));
		assert(budgetProbe.reserve("offline-uncertain"));
		budgetProbe.dispatch("offline-uncertain", {});
		assert.equal(budgetProbe.settle("offline-uncertain", undefined), 0.03);
		assert.equal(budgetProbe.reserve("offline-next"), false);
		assert.throws(() => budgetProbe.dispatch("offline-next", {}));
		matrix.budgetProbe = "unknown usage holds full cell and blocks next dispatch at lower cap";
		if (final) {
			assert(priorSpending);
			for (const [cap, count] of [[0.24, 8], [0.50, 9]] as const) {
				const audit = new Ma3Spending(0.50, (event) => record({ ...event, probe: true }), priorSpending, cap);
				assert.throws(() => audit.reserve(priorSpending.attempted[0]!));
				for (let i = 0; i < count; i++) {
					const id = `final-probe-${cap}-${i}`;
					assert(audit.reserve(id));
					audit.dispatch(id, {});
					assert.equal(audit.settle(id, undefined), 0.03);
				}
				assert(!audit.reserve(`final-probe-rejected-${cap}`));
				assert.throws(() => audit.dispatch(`final-probe-rejected-${cap}`, {}));
			}
			matrix.budgetProbe += "; $0.221823901 carried; independent $0.24 increment and $0.50 cumulative refusal tested";
		} else if (priorSpending) {
			const resumeProbe = new Ma3Spending(0.25, (event) => record({ ...event, probe: true }), priorSpending);
			assert.throws(() => resumeProbe.reserve(priorSpending.attempted[0]!));
			assert(resumeProbe.reserve("resume-probe-new"));
			resumeProbe.dispatch("resume-probe-new", {});
			assert.equal(resumeProbe.settle("resume-probe-new", undefined), 0.03);
			assert(!resumeProbe.reserve("resume-probe-beyond-cap"));
			matrix.budgetProbe += "; carried reserve blocks attempted cells and is charged against the same global cap";
		}
		const diagnostics = new Map<string, unknown>();
		for (const { id, mode: arm } of order) {
			const cell = `${id}:${arm}`;
			if (!spending.reserve(cell)) { matrix.stopReason = "global-budget"; break; }
			const fixture = ma3Fixtures.find(({ task }) => task.id === id)!;
			const result = await runCell(fixture, arm, support, { key, spending, record });
			rows.push(result.summary);
			record({ kind: "cell", ...result.trace });
			snapshot();
			console.log(JSON.stringify({ cell, completed: result.summary.success, reason: result.summary.reason,
				costUpperUsd: result.summary.costUpperUsd, settledUpperUsd: spending.settledUsd }));
			const budget = result.trace.budget;
			const wire = result.trace.providerWire ?? [];
			if (budget?.requestOutcomes.some((entry) => entry.httpStatus === 401 || entry.httpStatus === 403)) {
				matrix.stopReason = "provider-authentication";
				break;
			}
			if (final && budget?.denials.some((entry) => entry.code === "GATEWAY_COST_BUDGET")) {
				matrix.stopReason = "unit-cost-budget";
				break;
			}
			if (result.trace.policy.length || result.summary.overrun || result.summary.duplicateWrites ||
				budget?.lastError === "GATEWAY_PROVIDER_USAGE_EXCEEDED_RESERVATION") {
				matrix.stopReason = "safety-or-budget-contract";
				break;
			}
			if (budget) assert.deepEqual(budget.limits, limits, "MA3 arm budgets differ");
			if (!paid) {
				assert(result.summary.success && wire.length > 0 && wire.length === result.trace.requestTrace.length,
					"MA3 preflight expected every request to reach the local Stub through the gateway");
				assert(wire.every((row) => row.model === model && row.expectedVersion === flashVersion && row.temperature === 0 &&
					(row.thinking as { type?: string })?.type === "disabled" && Number(row.maxOutputTokens) <= 512));
				assert.equal(wire.filter((entry) => entry.role === "test").length, result.summary.testModelRequests);
				if (arm === "S2") {
					assert(result.summary.workerPid && result.summary.workerPid !== process.pid && result.trace.a2aWire?.length);
					assert.equal(result.summary.a2aForbiddenBytes, 0);
				}
				if (fixture.provisional && arm !== "S0") {
					const trace = result.trace.requestTrace.filter((row) => row.responseRole === "diagnosis").map((row) => row.diagnosticEvidence);
					assert.equal(trace.length, 1);
					if (diagnostics.has(id)) assert.deepEqual(trace, diagnostics.get(id));
					diagnostics.set(id, trace);
					if (arm === "S2") assert(wire.some((entry) => Number(entry.transportFieldsRemoved) > 0));
				}
			} else if (wire.length && !budget) {
				matrix.stopReason = "missing-gateway-state";
				break;
			}
		}
		matrix.status = rows.length === order.length && !matrix.stopReason ? "PASS" : "PARTIAL";
	} catch (error) {
		matrix.status = "BLOCKED";
		matrix.stopReason = error instanceof Error ? error.message : "MA3 evaluation failed";
		throw error;
	} finally { snapshot(); }
	assert(paid || matrix.status === "PASS", "MA3 local provider preflight incomplete");
}

export async function runMa3(output: string, mode: "ma3-freeze" | "ma3-preflight" | PaidMode, support: Support) {
	assert.equal(output, resolve(".artifacts/ma3/results.json"));
	assert.equal(process.argv.length, 4, "MA-3 supports only the fixed matrix");
	const dir = dirname(output);
	const candidate = JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8")) as {
		candidateSha256: string; files: Record<string, string>; roots: { ma2: string };
	};
	assert.equal(sha(JSON.stringify(candidate.files)), candidate.candidateSha256, "Candidate manifest integrity changed");
	assert.equal(candidate.candidateSha256, "c780d7b5a1f33c3330cb13d89af38b93a37931ee7b94295b14c1d8d79c16018f");
	assert.equal(Object.keys(candidate.files).length, 2_837);
	for (const [file, digest] of Object.entries(candidate.files)) {
		// Existing entry adds only the benchmark dispatch. The immutable baseline remains in candidate.json.
		if (file === "packages/pi-enhanced/benchmarks/real-agent/agent-evaluation.ts") {
			if (mode === "ma3-final-preflight" || mode === "ma3-final-paid") assert.equal(fileHash(join(candidate.roots.ma2, file)), digest, file);
			continue;
		}
		assert.equal(fileHash(join(productionDir, file)), digest, file);
	}
	const frozen = scenario(support, candidate.candidateSha256);
	const design = { ...frozen, designSha256: sha(JSON.stringify(frozen)) };
	const freeze = join(dir, "plan.json");
	if (mode === "ma3-freeze") {
		writeFileSync(freeze, JSON.stringify(design, null, 2) + "\n", { flag: "wx" });
		console.log(JSON.stringify({ designSha256: design.designSha256, tasks: design.selection.map(({ id, origin }) => ({ id, origin })), cells: ma3Order.length }));
		return;
	}
	assert.deepEqual(JSON.parse(readFileSync(freeze, "utf8")), design, "Frozen MA-3 planning drift");
	assert(dockerImageAvailable(support.image), "Pinned offline grading image unavailable");
	if (mode !== "ma3-preflight") return runMa3Paid(dir, mode, support, design);
	const freezeValidation = await verifyGrading(support);
	const runId = randomUUID();
	const rows: Awaited<ReturnType<typeof runCell>>["summary"][] = [];
	const tracePath = join(dir, "trace.jsonl");
	appendFileSync(tracePath, JSON.stringify({ runId, kind: "fixture-validation", freezeValidation }) + "\n");
	const save = () => writeFileSync(output, JSON.stringify({
		runId, status: rows.length !== ma3Order.length ? "PENDING" : rows.every((cell) => cell.success) ? "PASS" : "PARTIAL",
		paidCalls: 0, design, freezeValidation, rows,
		groups: ma3Modes.map((mode) => {
			const group = rows.filter((cell) => cell.mode === mode);
			return { mode, evaluated: group.length, completed: group.filter((cell) => cell.success).length,
				publicPassed: group.filter((cell) => cell.publicTests?.at(-1)?.status === "passed").length,
				independentPassed: group.reduce((sum, cell) => sum + cell.independent, 0),
				modelRequests: group.reduce((sum, cell) => sum + (cell.budget.requestsStarted ?? 0), 0),
				tokens: group.reduce((sum, cell) => sum + (cell.budget.actualTotalTokens ?? 0), 0),
				agentTimeMs: group.reduce((sum, cell) => sum + cell.agentMs, 0),
				budgetDenials: group.reduce((sum, cell) => sum + (cell.budget.denials?.length ?? 0), 0),
				replayedWrites: group.reduce((sum, cell) => sum + (cell.duplicateWrites ?? 0), 0),
			};
		}),
	}, null, 2) + "\n");
	save();
	for (const { id, mode } of ma3Order) {
		const fixture = ma3Fixtures.find(({ task }) => task.id === id)!;
		const result = await runCell(fixture, mode, support);
		rows.push(result.summary);
		appendFileSync(tracePath, JSON.stringify({ runId, kind: "cell", ...result.trace }) + "\n");
		save();
		console.log(JSON.stringify({ id, mode, ok: result.summary.success, reason: result.summary.reason }));
	}
}
