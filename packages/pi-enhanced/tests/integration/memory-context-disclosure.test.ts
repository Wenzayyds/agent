import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../../../coding-agent/src/core/auth-storage.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../../coding-agent/test/model-runtime-test-utils.ts";
import { createTestUiContext } from "../../../coding-agent/test/suite/harness.ts";
import { startBudgetGateway } from "../../benchmarks/real-agent/budget-gateway.ts";
import { applyEvaluationContextBudget } from "../../benchmarks/real-agent/evaluation-context-budget.ts";
import type { AgentBudgetWorkflow } from "../../src/context/budget-workflow.ts";
import { createContextExtension } from "../../src/context/extension.ts";
import { CONTEXT_RESTORE } from "../../src/context/offload.ts";
import { SOURCE_AUDIT } from "../../src/context/request-policy.ts";
import { deduplicateRuntimeReads, REPEATED_WORKSPACE_READ } from "../../src/context/tool-output.ts";
import { createKnowledgeExtension } from "../../src/knowledge/extension.ts";
import { independentContextResults } from "../../src/knowledge/request-policy.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import { KNOWLEDGE_READ, KNOWLEDGE_SEARCH } from "../../src/knowledge/tools.ts";
import type { MemoryRecord, MemoryScope } from "../../src/memory/contracts.ts";
import { createMemoryExtension } from "../../src/memory/extension.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { openMemoryService } from "../../src/memory/service.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { createTaskManagerExtension } from "../../src/task-manager/extension.ts";
import { createKnowledgeTestRoot, expectIndexedDocument, setDocumentAccess } from "../fixtures/knowledge.ts";
import { textSse, toolCallSse } from "../fixtures/runner-support.ts";

const REVOKED = "qa_revoked_history_cf11399";
const RETAINED = "qa_retained_history_ace3821";
const ECHO = `The model copied the rollout marker ${REVOKED}.`;
const SEARCH = { query: "rollout policy", corpusId: "ops" };
const CHILD_ENV = "PI_MEMORY_CONTEXT_RESUME_FIXTURE";
const EVIDENCE_ENV = "PI_MEMORY_CONTEXT_WIRE_EVIDENCE";

function markerBytes(requests: Buffer[], marker = REVOKED): number {
	const token = Buffer.from(marker);
	let total = 0;
	for (const request of requests) {
		for (let index = request.indexOf(token); index !== -1; index = request.indexOf(token, index + token.length)) {
			total += token.length;
		}
	}
	return total;
}

function recordWire(caseId: string, requests: Buffer[], observation: Record<string, unknown> = {}) {
	const directory = process.env[EVIDENCE_ENV];
	if (!directory) return;
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `${caseId}.json`),
		JSON.stringify(
			{
				caseId,
				pid: process.pid,
				revokedBytes: markerBytes(requests),
				retainedBytes: markerBytes(requests, RETAINED),
				...observation,
				requests: requests.map((request) => ({
					bytes: request.length,
					sha256: createHash("sha256").update(request).digest("hex"),
					body: request.toString("utf8"),
				})),
			},
			null,
			2,
		),
	);
}

class LoopbackModel {
	readonly requests: Buffer[] = [];
	readonly replies: Array<
		string | (() => { status: number; body: string } | Promise<{ status: number; body: string }>)
	> = [];
	private readonly server = createServer(async (request, response) => {
		const parts: Buffer[] = [];
		for await (const part of request) parts.push(Buffer.from(part));
		this.requests.push(Buffer.concat(parts));
		const reply = this.replies.shift();
		if (
			request.method !== "POST" ||
			!["/chat/completions", "/v1/chat/completions", "/v1/messages"].includes(request.url ?? "") ||
			!reply
		) {
			response
				.writeHead(400)
				.end(`Unexpected fixture request ${request.method} ${request.url} reply=${Boolean(reply)}`);
			return;
		}
		const result = typeof reply === "string" ? { status: 200, body: reply } : await reply();
		response.writeHead(result.status, {
			"content-type": result.status === 200 ? "text/event-stream; charset=utf-8" : "application/json",
			"retry-after-ms": "1",
		});
		response.end(result.body);
	});

	async start(): Promise<string> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", resolve);
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture listener address");
		return `http://127.0.0.1:${address.port}/v1`;
	}

	async close(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

async function openSession(
	root: string,
	baseUrl: string,
	sessionManager: SessionManager,
	extra?: (pi: ExtensionAPI) => void,
	api: "openai-completions" | "pi-messages" = "openai-completions",
	loadDisclosurePolicies = true,
	extraTools: string[] = [],
	requestBudget?: AgentBudgetWorkflow,
	managedBudget = false,
	ccr = false,
) {
	const agentDir = join(root, "a");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false, keepRecentTokens: 12 },
		retry: { enabled: false, provider: { maxRetries: ccr ? 0 : 1 } },
	});
	settingsManager.setProjectTrusted(true);
	const audit: unknown[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			createTaskManagerExtension({ agentDir }),
			...(loadDisclosurePolicies
				? [
						createMemoryExtension({ agentDir }),
						createKnowledgeExtension({ agentDir }),
						createContextExtension({ agentDir, requestBudget, ...(managedBudget ? { budgetProvider: {
							provider: "qa-knowledge", model: "local-history-fixture", baseUrl,
							pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
						} } : {}) }),
					]
				: []),
			(pi) => {
				pi.events.on(SOURCE_AUDIT, (item) => audit.push(item));
			},
			...(extra ? [extra] : []),
		],
	});
	await resourceLoader.reload();
	const auth = AuthStorage.inMemory();
	await auth.modify("openai", async () => ({ type: "api_key", key: "fixture-only" }));
	const registry = await createInMemoryModelRegistry(auth);
	const model = {
		...getModel("openai", "gpt-4o"),
		api,
		baseUrl,
		id: ccr ? "DeepSeek/deepseek-flash" : "local-history-fixture",
		provider: ccr ? "local-ccr" : "qa-knowledge",
	};
	registry.registerProvider(model.provider, { baseUrl, api: model.api, apiKey: "fixture-only", models: [model] });
	const modelRuntime = getModelRuntime(registry);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		settingsManager,
		sessionManager,
		resourceLoader,
		modelRuntime,
		model,
		tools: ["read", "enhanced_memory_search", CONTEXT_RESTORE, KNOWLEDGE_SEARCH, KNOWLEDGE_READ, ...extraTools],
	});
	const notes: string[] = [];
	await session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({ confirm: async () => true, notify: (value) => notes.push(value) }),
	});
	return { session, notes, audit, settingsManager };
}

async function withFixture(
	body: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
	extra?: (pi: ExtensionAPI) => void,
	maximumTextCharacters = 600,
	deduplicateReads = false,
	managedBudget = false,
) {
	const fixture = await createFixture(extra, maximumTextCharacters, deduplicateReads, managedBudget);
	try {
		await fixture.importDocuments();
		await body(fixture);
	} finally {
		await fixture.closeSession();
		await fixture.provider.close();
		rmSync(fixture.root, { force: true, recursive: true });
	}
}

async function createFixture(
	extra?: (pi: ExtensionAPI) => void,
	maximumTextCharacters = 600,
	deduplicateReads = false,
	managedBudget = false,
) {
	const root = createKnowledgeTestRoot("pi-kh-");
	const agentDir = join(root, "a");
	mkdirSync(agentDir);
	const revokedPath = join(root, "revoked.md");
	const retainedPath = join(root, "retained.md");
	writeFileSync(revokedPath, `# Historical policy\n\nRollout policy ${REVOKED}.`);
	writeFileSync(retainedPath, `# Current policy\n\nRollout policy ${RETAINED}.`);
	writeFileSync(
		join(agentDir, ENHANCED_CONFIG_FILE),
		JSON.stringify({
			modules: {
				knowledge: { enabled: true },
				memory: { enabled: true },
				"task-manager": { enabled: true, contextSummary: true },
				context: {
					enabled: true,
					mode: "select",
					compaction: { enabled: true },
					toolOutput: { enabled: true, offload: true, maximumTextCharacters, deduplicateReads },
					memoryInjection: { enabled: true },
					taskInjection: { enabled: true },
				},
			},
		}),
	);
	const provider = new LoopbackModel();
	const baseUrl = await provider.start();
	const manager = SessionManager.create(root, join(root, "s"));
	const { session, notes, audit, settingsManager } = await openSession(
		root, managedBudget ? baseUrl.replace(/\/v1$/u, "") : baseUrl, manager, extra,
		"openai-completions", true, [], undefined, managedBudget,
	);
	const { projectId } = createProjectScope({ cwd: root, agentDir });
	const filename = join(agentDir, "pi-enhanced", "knowledge", "projects", projectId, "knowledge.sqlite3");
	let closed = false;
	return {
		root,
		manager,
		session,
		notes,
		audit,
		settingsManager,
		provider,
		baseUrl,
		filename,
		revokedPath,
		projectId,
		async importDocuments() {
			await setDocumentAccess(session, filename, revokedPath, "ops", "allow-external");
			await setDocumentAccess(session, filename, retainedPath, "ops", "allow-external");
		},
		revocation: () => setDocumentAccess(session, filename, revokedPath, "ops", "local-only"),
		async revokeExternally() {
			const writer = new KnowledgeService({ projectId, filename, mode: "lexical" });
			try {
				await writer.add(root, "revoked.md", "ops", "local-only");
			} finally {
				await writer.close();
			}
			expectIndexedDocument(filename, revokedPath, "ops", "local-only");
		},
		async closeSession() {
			if (closed) return;
			closed = true;
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		},
		async lookup(tool = KNOWLEDGE_SEARCH, args: Record<string, unknown> = SEARCH, response = ECHO) {
			const start = provider.requests.length;
			provider.replies.push(toolCallSse(tool, args, start + 6, 1), textSse(response, 8, 1));
			await session.prompt("Look up the rollout policy.");
			const requests = provider.requests.slice(start);
			const outcome = session.messages.findLast((message) => message.role === "assistant");
			expect(requests, JSON.stringify({ outcome, tools: session.extensionRunner.getActiveTools() })).toHaveLength(2);
			expect(provider.replies).toHaveLength(0);
			return requests;
		},
		async next(response = "Continuation completed.", prompt = "Continue with the rollout.") {
			const start = provider.requests.length;
			provider.replies.push(textSse(response, 8, 1));
			await session.prompt(prompt);
			const requests = provider.requests.slice(start);
			expect(requests).toHaveLength(1);
			return requests;
		},
	};
}

const MEMORY = "qa_revoked_memory_71d837e4";
const SAFE_PAGE = "qa_independent_page_97e28";
const MEMORY_TOOL = "enhanced_memory_search";

function pageReference(requests: Buffer[]): string | undefined {
	const wire = JSON.parse(requests.at(-1)!.toString("utf8")) as { messages: Array<{ role: string; content: string }> };
	return wire.messages
		.filter(({ role }) => role === "tool")
		.at(-1)
		?.content.match(/v1:[a-f0-9]{64}/iu)?.[0];
}

it("revokes Memory and Knowledge across history, native compaction and paged restore", async () => {
	await withFixture(async (f) => {
		const modelEvidence = (test: string, wire: Buffer[], details: Record<string, unknown> = {}) =>
			recordWire(test, wire, { memoryCanaryBytes: markerBytes(wire, MEMORY), ...details });
		const agentDir = join(f.root, "a");
		const source = "memory-proof.txt";
		const text = `Release vault authority ${MEMORY}. ${"Offline verified policy detail. ".repeat(65)}`;
		writeFileSync(join(f.root, source), text, "utf8");
		writeFileSync(
			join(f.root, "control.txt"),
			`${SAFE_PAGE}\n${"Independent control information.\n".repeat(90)}`,
			"utf8",
		);
		const memory = await openMemoryService(createProjectScope({ cwd: f.root, agentDir }));
		try {
			const candidate = await memory.saveCandidate({
				kind: "fact",
				type: "semantic",
				content: text,
				source: { type: "file", ref: source },
			});
			const verified = await memory.verifyFileFact(
				candidate.id,
				{ relativePath: source, exactExcerpt: text },
				candidate.revision,
			);
			const invoke = async (command: string, args: string) => {
				const before = f.notes.length;
				await f.session.prompt(`/${command} ${args}`);
				expect(f.notes.length).toBeGreaterThan(before);
				return JSON.parse(f.notes.at(-1)!);
			};
			const created = await invoke(
				"enhanced-task-create",
				JSON.stringify({
					goal: "Verify revocation and paging",
					steps: [{ stepId: "inspect", title: "Inspect the fixture", expectedOutcome: "See audited pages" }],
				}),
			);
			const task = created.task.taskId;
			await invoke("enhanced-task-approve", `${task} ${created.task.revision}`);
			await invoke("enhanced-task-step", `${task} inspect bind`);
			await invoke("enhanced-task-step", `${task} inspect start 1`);
			const independent = await f.lookup("read", { path: "control.txt" }, "Control read complete.");
			const control = pageReference(independent);
			const historical = await f.lookup(MEMORY_TOOL, { query: "release vault" }, "Memory lookup complete.");
			const oldMemoryReference = pageReference(historical);
			modelEvidence("combo-memory-authorized", historical, { control, oldMemoryReference });
			expect(control).toBeDefined();
			expect(oldMemoryReference).toBeDefined();
			expect(control).not.toBe(oldMemoryReference);
			const original = f.session.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === MEMORY_TOOL,
			);
			const block = original?.role === "toolResult" ? original.content[0] : undefined;
			if (block?.type !== "text" || !block.text.includes(MEMORY)) throw new Error("No authorized raw Memory result");
			const offset = Math.max(0, block.text.indexOf(MEMORY) - 30);
			const authorizedPage = await f.lookup(
				CONTEXT_RESTORE,
				{ reference: oldMemoryReference, offset, limit: 140 },
				"Authorized page read.",
			);
			modelEvidence("combo-memory-authorized-page", authorizedPage, { offset });
			expect(markerBytes(authorizedPage, MEMORY)).toBeGreaterThan(0);
			const granted = await f.lookup(KNOWLEDGE_SEARCH, SEARCH, "Knowledge lookup complete.");
			modelEvidence("combo-knowledge-authorized", granted);
			expect(markerBytes(granted)).toBeGreaterThan(0);
			await memory.review(verified.id, "mark_stale", verified.revision, "QA permission withdrawal");
			await f.revocation();

			const scope = f.session.extensionRunner;
			const ctx = scope.createToolContext("qa-pager", undefined);
			const search = scope.getToolDefinition(MEMORY_TOOL)!;
			const current = await search.execute(
				"after-revocation",
				{ query: "release vault" },
				undefined,
				undefined,
				ctx,
			);
			expect(current.details).toMatchObject({ count: 0 });
			const pager = scope.getToolDefinition(CONTEXT_RESTORE)!;
			const restore = async (reference: string) => {
				try {
					const value = await pager.execute(
						"qa-page",
						{ reference, offset: reference === control ? 0 : offset, limit: 140 },
						undefined,
						undefined,
						ctx,
					);
					return {
						allowed: true,
						persistedCanary: JSON.stringify(value).includes(MEMORY),
						content: value.content,
					};
				} catch (error) {
					return {
						allowed: false,
						persistedCanary: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			};
			const stale = await restore(oldMemoryReference!);
			const safe = await restore(control!);
			expect(JSON.stringify(safe)).toContain(SAFE_PAGE);

			const after = await f.next("Enough transcript to keep the final turn. ".repeat(40));
			const replay = await f.lookup(
				CONTEXT_RESTORE,
				{ reference: oldMemoryReference, offset, limit: 140 },
				"Page check completed.",
			);
			const start = f.provider.requests.length;
			f.provider.replies.push(
				textSse("Compact unrelated task progress.", 8, 1),
				textSse("Compact unrelated task progress.", 8, 1),
			);
			await f.session.compact();
			const summary = f.provider.requests.slice(start);
			f.provider.replies.splice(0);
			const afterCompact = await f.next();
			modelEvidence("combo-after-revocation", after, { currentSearchCount: 0, stale, allowedControl: true });
			modelEvidence("combo-paged-restore", replay);
			modelEvidence("combo-compaction", summary);
			modelEvidence("combo-after-compaction", afterCompact);

			expect(markerBytes([...after, ...replay, ...summary, ...afterCompact])).toBe(0);
			expect({
				stalePageAllowed: stale.allowed,
				historyBytes: markerBytes(after, MEMORY),
				pagedBytes: markerBytes(replay, MEMORY),
				compactionBytes: markerBytes(summary, MEMORY),
				afterCompactionBytes: markerBytes(afterCompact, MEMORY),
			}).toEqual({
				stalePageAllowed: false,
				historyBytes: 0,
				pagedBytes: 0,
				compactionBytes: 0,
				afterCompactionBytes: 0,
			});
		} finally {
			await memory.close();
		}
	});
}, 90_000);

const SENSITIVE = "fixture_memory_secret_d22fcda1";
const CONTROL = "fixture_memory_safe_99b733f0";
const QUERY = "deployment reference";
type Fixture = Awaited<ReturnType<typeof createFixture>>;
type OpenSession = Awaited<ReturnType<typeof openSession>>;

async function invoke(session: Pick<OpenSession, "session" | "notes">, name: string, args: string) {
	const start = session.notes.length;
	await session.session.prompt(`/${name} ${args}`);
	expect(session.notes.length).toBeGreaterThan(start);
	return JSON.parse(session.notes.at(-1)!);
}

async function activeTask(f: Fixture) {
	const created = await invoke(
		f,
		"enhanced-task-create",
		JSON.stringify({
			goal: "Check deployment references",
			steps: [{ stepId: "inspect", title: "Inspect", expectedOutcome: "Observe source" }],
		}),
	);
	const id: string = created.task.taskId;
	await invoke(f, "enhanced-task-approve", `${id} ${created.task.revision}`);
	await invoke(f, "enhanced-task-step", `${id} inspect bind`);
	await invoke(f, "enhanced-task-step", `${id} inspect start 1`);
	return id;
}

async function withMemory(f: Fixture, run: (service: Awaited<ReturnType<typeof openMemoryService>>) => Promise<void>) {
	const service = await openMemoryService(createProjectScope({ cwd: f.root, agentDir: join(f.root, "a") }));
	try {
		await run(service);
	} finally {
		await service.close();
	}
}

async function seed(
	f: Fixture,
	m: Awaited<ReturnType<typeof openMemoryService>>,
	marker = SENSITIVE,
	scope: MemoryScope = { kind: "project" },
) {
	const file = `source-${createHash("sha256").update(marker).digest("hex").slice(0, 12)}.txt`;
	const content = `${QUERY} ${marker}. ${"Policy text for independent review. ".repeat(37)} ${marker}.`;
	writeFileSync(join(f.root, file), content, "utf8");
	const candidate = await m.saveCandidate({
		kind: "fact",
		type: "semantic",
		scope,
		content,
		source: { type: "file", ref: file },
	});
	return m.verifyFileFact(candidate.id, { relativePath: file, exactExcerpt: content }, candidate.revision);
}

function memoryLookup(f: Fixture, query = QUERY, text?: string) {
	return f.lookup(MEMORY_TOOL, { query }, text ?? "Memory result observed.");
}

function lastToolText(requests: Buffer[]): string {
	const wire = JSON.parse(requests.at(-1)!.toString("utf8")) as { messages: Array<{ role: string; content: string }> };
	return wire.messages.findLast(({ role }) => role === "tool")?.content ?? "";
}

async function sourcePage(
	f: Fixture,
	tool = MEMORY_TOOL,
	args: Record<string, unknown> = { query: QUERY },
	marker = SENSITIVE,
) {
	const original = await f.lookup(tool, args, "Source observed.");
	const reference = pageReference(original);
	if (!reference)
		recordWire("missing-page-reference", original, {
			origins: f.manager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "pi-enhanced-context-origin"),
			results: f.session.messages.filter(({ role }) => role === "toolResult").slice(-3),
		});
	expect(reference).toBeDefined();
	const options = { reference: reference!, offset: 0, limit: 1_500 };
	const allowed = await f.lookup(CONTEXT_RESTORE, options, "Page checked.");
	expect(lastToolText(allowed)).toContain(marker);
	return { original, allowed, options };
}

function assertWire(
	id: string,
	f: Pick<Fixture, "audit">,
	before: Buffer[],
	after: Buffer[],
	sources: { id: string; revision?: number; kind?: string }[],
	marker = SENSITIVE,
	observations: Record<string, unknown> = {},
) {
	const beforeBytes = markerBytes(before, marker);
	const afterBytes = markerBytes(after, marker);
	recordWire(`${id}-before`, before, {
		marker,
		markerBytes: beforeBytes,
		expected: "admitted",
		observed: beforeBytes > 0 ? "admitted" : "not received",
		sources,
	});
	recordWire(`${id}-after`, after, {
		marker,
		markerBytes: afterBytes,
		expected: "withheld",
		observed: afterBytes === 0 ? "withheld" : "received",
		sources,
		observations,
		audit: f.audit,
	});
	expect(beforeBytes).toBeGreaterThan(0);
	expect(afterBytes).toBe(0);
}

function source(record: MemoryRecord) {
	return { id: record.id, revision: record.contentRevision, kind: "memory" };
}

it("T1 removes historical Memory, assistant copies and automatic injection after validation is revoked", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const row = await seed(f, m);
			const injected = await f.next("Current injection observed.", QUERY);
			expect(markerBytes(injected, SENSITIVE)).toBeGreaterThan(0);
			const before = await memoryLookup(f, QUERY, `Assistant saw ${SENSITIVE}.`);
			await m.review(row.id, "mark_stale", row.revision, "host withdrew validation");
			const after = await f.next("Current injection is gone.", QUERY);
			assertWire("T1", f, [...injected, ...before], after, [source(row)]);
			expect(after[0].toString()).toContain("Memory or Context source is no longer available");
		}),
	);
});

it("T2 removes the previous revision and sends a newly verified replacement", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const row = await seed(f, m);
			const before = await memoryLookup(f);
			const replacement = row.content.replaceAll(SENSITIVE, CONTROL);
			const changed = await m.updateContent(row.id, replacement, row.revision);
			const file = row.sources[0]!.ref;
			writeFileSync(join(f.root, file), replacement);
			const current = await m.verifyFileFact(
				row.id,
				{ relativePath: file, exactExcerpt: replacement },
				changed.revision,
			);
			const after = await memoryLookup(f);
			assertWire("T2", f, before, after, [source(row), source(current)]);
			expect(markerBytes(after, CONTROL)).toBeGreaterThan(0);
		}),
	);
});

it("T3 checks live project trust in the same session and preserves independent conversation", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const row = await seed(f, m);
			const before = await memoryLookup(f);
			f.settingsManager.setProjectTrusted(false);
			const after = await f.next();
			assertWire("T3", f, before, after, [source(row)]);
			expect(after[0].toString()).toContain("Continue with the rollout.");
		}),
	);
});

it("T4 checks Knowledge permission at original page restoration and replay", async () => {
	await withFixture(async (f) => {
		await activeTask(f);
		const search = await f.lookup(KNOWLEDGE_SEARCH, SEARCH, "Locate the document.");
		const tool = JSON.parse(search.at(-1)!.toString())
			.messages.filter(({ role }: { role: string }) => role === "tool")
			.at(-1);
		const line = tool.content.split("\n").find((value: string) => value.startsWith("{"));
		const projected = JSON.parse(line);
		expect(projected.evidenceStatus).toBe("insufficient-evidence");
		const hit = projected.hits.find(({ excerpt }: { excerpt: string }) => excerpt.includes(REVOKED));
		expect(hit).toBeDefined();
		expect(hit.evidence).toBe("candidate");
		const page = await sourcePage(f, KNOWLEDGE_SEARCH, SEARCH, REVOKED);
		const narrow = await f.lookup(
			CONTEXT_RESTORE,
			{ ...page.options, offset: 120, limit: 32 },
			"Inspect a small candidate page.",
		);
		expect(lastToolText(narrow)).toContain(
			"Knowledge search candidates; verify the source before using them as evidence.",
		);
		expect(lastToolText(narrow)).not.toContain('"evidenceStatus":"supported"');
		await f.revokeExternally();
		const after = await f.lookup(CONTEXT_RESTORE, page.options, "Do not reuse revoked pages.");
		const control = await f.lookup(KNOWLEDGE_SEARCH, SEARCH, "Read only eligible documents.");
		assertWire(
			"T4",
			f,
			[...search, ...page.allowed],
			[...after, ...control],
			[
				{ id: hit.documentId, revision: hit.documentVersion, kind: "knowledge" },
				{ id: page.options.reference, kind: "context-page" },
			],
			REVOKED,
		);
		expect(markerBytes(control, RETAINED)).toBeGreaterThan(0);
	});
});

it("drops detached legacy summaries on reopen even when disclosure extensions are absent", async () => {
	await withFixture(async (f) => {
		const legacy = SessionManager.create(f.root, join(f.root, "orphan"));
		legacy.appendCompaction(SENSITIVE, "source-not-in-detached-session", 100);
		legacy.appendMessage({ role: "user", content: "Keep this independent user message.", timestamp: Date.now() });
		const file = legacy.getSessionFile()!;
		const opened = await openSession(
			f.root,
			f.baseUrl,
			SessionManager.open(file),
			undefined,
			"openai-completions",
			false,
		);
		try {
			const origin = f.provider.requests.length;
			f.provider.replies.push(textSse("Independent work continues.", 10, 1));
			await opened.session.prompt("Continue the independent work.");
			const after = f.provider.requests.slice(origin);
			expect(after).toHaveLength(1);
			expect(markerBytes(after, SENSITIVE)).toBe(0);
			expect(after[0].toString()).toContain("Continue the independent work.");
			recordWire("detached-summary-no-policy", after, { markerBytes: markerBytes(after, SENSITIVE) });
		} finally {
			await opened.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			opened.session.dispose();
		}
	});
});

it("rejects stale tool lineage when a later caller reuses its Knowledge-dependent call ID", async () => {
	await withFixture(async (f) => {
		const before = await f.lookup(KNOWLEDGE_SEARCH, SEARCH, "Observed an authorized source.");
		expect(markerBytes(before)).toBeGreaterThan(0);
		const original = f.session.messages.findLast(({ role }) => role === "assistant");
		if (original?.role !== "assistant") throw new Error("Missing positive assistant control");
		expect(original.requestProvenance?.knowledge).toEqual(
			expect.arrayContaining([expect.objectContaining({ revision: 1 })]),
		);
		const toolCallId = "duplicate-knowledge-dependent-read";
		const time = Date.now();
		const issuer = {
			...original,
			stopReason: "toolUse" as const,
			content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: { path: "fixture.txt" } }],
		};
		const old = {
			role: "toolResult" as const,
			toolName: "read",
			toolCallId,
			timestamp: time + 1,
			isError: false,
			content: [{ type: "text" as const, text: REVOKED }],
		};
		f.manager.appendMessage({ ...issuer, timestamp: time });
		f.manager.appendMessage(old);
		f.manager.appendMessage({
			...issuer,
			timestamp: time + 2,
			requestProvenance: { knowledge: [], memoryContext: [] },
		});
		f.manager.appendMessage({ ...old, timestamp: time + 3, content: [{ type: "text", text: "Independent decoy." }] });
		expect(independentContextResults({ sessionManager: f.manager })(old)).toBe(false);
		await f.revokeExternally();
		const file = f.manager.getSessionFile()!;
		const reopened = await openSession(f.root, f.baseUrl, SessionManager.open(file));
		try {
			const offset = f.provider.requests.length;
			f.provider.replies.push(textSse("Continue using only approved sources.", 10, 1));
			await reopened.session.prompt("Keep the independent user request.");
			const after = f.provider.requests.slice(offset);
			expect(after).toHaveLength(1);
			expect(markerBytes(after)).toBe(0);
			expect(after[0].toString()).toContain("Keep the independent user request.");
			recordWire("duplicate-knowledge-call-after-revocation", after);
		} finally {
			await reopened.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			reopened.session.dispose();
		}
	});
});

it("T5 excludes revoked data and assistant derivatives from native compaction and subsequent dispatch", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const row = await seed(f, m);
			const before = await memoryLookup(f, QUERY, `Remember ${SENSITIVE} in that recap.`);
			await f.next("Independent work remains. ".repeat(50));
			await m.review(row.id, "mark_stale", row.revision, "revoke source before compaction");
			const start = f.provider.requests.length;
			f.provider.replies.push(
				textSse("Summarized without protected sources.", 8, 1),
				textSse("Summarized safely.", 8, 1),
			);
			await f.session.compact();
			const derived = f.provider.requests.slice(start);
			expect(derived.length).toBeGreaterThan(0);
			f.provider.replies.splice(0);
			const after = await f.next();
			assertWire("T5", f, before, [...derived, ...after], [source(row)], SENSITIVE, {
				derivedRequests: derived.length,
			});
		}),
	);
});

it("T6 pauses a real Task, changes its Memory, then resumes without replaying the old revision", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const taskId = await activeTask(f);
			const row = await seed(f, m, SENSITIVE, { kind: "task", id: taskId });
			const before = (await sourcePage(f)).allowed;
			const prior = await invoke(f, "enhanced-task-inspect", taskId);
			const paused = await invoke(f, "enhanced-task-pause", `${taskId} ${prior.task.revision}`);
			expect(paused.task.status).toBe("paused");
			const revision = await m.updateContent(row.id, row.content.replaceAll(SENSITIVE, CONTROL), row.revision);
			const sent = f.provider.requests.length;
			const resumed = await invoke(f, "enhanced-task-resume", `${taskId} ${paused.task.revision}`);
			expect(resumed.task.status).toBe("queued");
			expect(f.provider.requests).toHaveLength(sent);
			const after = await f.next();
			assertWire("T6", f, before, after, [source(row), source(revision)], SENSITIVE, { taskId });
		}),
	);
});

type ChildCase = {
	root: string;
	file: string;
	baseUrl: string;
	taskId: string;
	page: { reference: string; offset: number; limit: number };
};

it.runIf(!!process.env[CHILD_ENV])("fixture child reads a persisted Context page", async () => {
	const child: ChildCase = JSON.parse(process.env[CHILD_ENV]!);
	const opened = await openSession(child.root, child.baseUrl, SessionManager.open(child.file, join(child.root, "s")));
	try {
		await invoke(opened, "enhanced-task-step", `${child.taskId} inspect bind`);
		await opened.session.prompt("Try the requested old Context page.");
		recordWire("T7-child-audit", [], { audit: opened.audit, pid: process.pid });
	} finally {
		await opened.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		opened.session.dispose();
	}
});

it("T7 resolves a saved page in another process using current SQLite instead of the cached result", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const taskId = await activeTask(f);
			const row = await seed(f, m);
			const page = await sourcePage(f);
			await m.review(row.id, "mark_stale", row.revision, "revoke before process restart");
			const child: ChildCase = {
				root: f.root,
				file: f.manager.getSessionFile()!,
				baseUrl: f.baseUrl,
				taskId,
				page: page.options,
			};
			await f.closeSession();
			const start = f.provider.requests.length;
			f.provider.replies.push(toolCallSse(CONTEXT_RESTORE, child.page, 72, 1), textSse("Recovery complete.", 10, 1));
			await promisify(execFile)(
				process.execPath,
				[
					join(import.meta.dirname, "../../../../node_modules/vitest/vitest.mjs"),
					"--run",
					"tests/integration/memory-context-disclosure.test.ts",
					"-t",
					"fixture child reads",
					"--maxWorkers=1",
				],
				{
					cwd: join(import.meta.dirname, "../.."),
					env: { ...process.env, [CHILD_ENV]: JSON.stringify(child) },
					timeout: 30_000,
				},
			);
			const after = f.provider.requests.slice(start);
			expect(after).toHaveLength(2);
			assertWire("T7", f, page.allowed, after, [source(row), { id: page.options.reference }]);
		}),
	);
}, 45_000);

it("T8 removes only the revoked item in a shared Memory result", async () => {
	await withFixture(
		async (f) =>
			withMemory(f, async (m) => {
				const row = await seed(f, m);
				const control = await seed(f, m, CONTROL);
				const before = await memoryLookup(f);
				expect(markerBytes(before, CONTROL)).toBeGreaterThan(0);
				await m.review(row.id, "mark_stale", row.revision, "revoke only one item");
				const after = await f.next();
				assertWire("T8", f, before, after, [source(row), source(control)]);
				expect(markerBytes(after, CONTROL)).toBeGreaterThan(0);
			}),
		undefined,
		4_000,
	);
});

it.each([false, true])("T9 denies an already assembled body when Memory is revoked (native budget %s)", async (managedBudget) => {
	let revoke: (() => Promise<unknown>) | undefined;
	await withFixture(
		async (f) =>
			withMemory(f, async (m) => {
				const row = await seed(f, m);
				const before = await memoryLookup(f);
				revoke = () => m.review(row.id, "mark_stale", row.revision, "commit during assembly");
				const start = f.provider.requests.length;
				await f.session.prompt("Assemble the next request.");
				expect(f.provider.requests.slice(start)).toHaveLength(0);
				expect(f.audit).toContainEqual(expect.objectContaining({ decision: "dispatch-denied" }));
				const after = await f.next();
				assertWire(managedBudget ? "T9-e20" : "T9", f, before, after, [source(row)], SENSITIVE, { assemblyStageRequests: 0 });
			}),
		(pi) =>
			pi.on("before_provider_request", async () => {
				const pending = revoke;
				revoke = undefined;
				await pending?.();
			}),
		600,
		false,
		managedBudget,
	);
});

it("T10 rechecks each retry of the same HTTP body after a provider error", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const row = await seed(f, m);
			const before = await memoryLookup(f);
			const start = f.provider.requests.length;
			f.provider.replies.push(async () => {
				await m.review(row.id, "mark_stale", row.revision, "source changed between transport attempts");
				return { status: 500, body: JSON.stringify({ error: { message: "fixture transient failure" } }) };
			});
			await f.session.prompt("Provider error may trigger a transport retry.");
			const admitted = f.provider.requests.slice(start);
			expect(admitted).toHaveLength(1);
			expect(markerBytes(admitted, SENSITIVE)).toBeGreaterThan(0);
			expect(f.audit).toContainEqual(expect.objectContaining({ decision: "dispatch-denied" }));
			const after = await f.next();
			assertWire("T10", f, [...before, ...admitted], after, [source(row)], SENSITIVE, {
				retriedRequestsReceived: 0,
			});
		}),
	);
});

it.each([false, true, "test-only", "read-only-verification", "runtime", "runtime-workflow"] as const)(
	"T13 rechecks Memory and Knowledge at Gateway retry, budget projection %s",
	async (withBudget) => {
		const runtime = withBudget === "runtime";
		const runtimeWorkflow = withBudget === "runtime-workflow";
		await withFixture(
			async (f) =>
				withMemory(f, async (m) => {
					if (runtime) {
						writeFileSync(join(f.root, "retry-control.txt"), "Authorized runtime read ".repeat(9));
						await f.lookup("read", { path: "retry-control.txt" }, "Authorized runtime read completed.");
						await f.lookup("read", { path: "retry-control.txt" }, "Authorized runtime read completed.");
					}
					const row = await seed(f, m);
					expect(markerBytes(await memoryLookup(f), SENSITIVE)).toBeGreaterThan(0);
					expect(markerBytes(await f.lookup(), REVOKED)).toBeGreaterThan(0);
					await f.closeSession();
					const upstreamStart = f.provider.requests.length;
					const testOnly = withBudget === "test-only";
					const verifyReadOnly = withBudget === "read-only-verification" || runtimeWorkflow;
					const setupRequests = testOnly ? 1 : 0;
					if (testOnly) f.provider.replies.push(toolCallSse("edit", {}, 12, 1));
					const projections: { mode: string; afterDenial: string | null }[] = [];
					let connectAttempts = 0;
					const gateway = await startBudgetGateway({
						runId: "e9-revocation-retry",
						upstreamBaseUrl: f.baseUrl.replace(/\/v1$/u, ""),
						upstreamApiKey: "fixture-only",
						clientToken: "fixture-only",
						adminToken: "fixture-admin",
						allowedModel: "local-history-fixture",
						limits: {
							maxRequests: 8,
							maxTotalTokens: 20_000,
							maxTotalCostUsd: 0.03,
							maxConcurrency: 1,
							requestTimeoutMs: 2_000,
							maxOutputTokensPerRequest: 512,
							maxRequestBytes: 40_000,
						},
						pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
						guardedClientRetry: true,
						fetch: async (_input, init) => {
							if (++connectAttempts === setupRequests + 1) {
								const body = typeof init?.body === "string" ? init.body : "";
								expect(body).toContain(SENSITIVE);
								expect(body).toContain(REVOKED);
								if (runtime) expect(body).toContain(REPEATED_WORKSPACE_READ);
								if (testOnly || verifyReadOnly) {
									const request = JSON.parse(body);
									expect(
										request.tools.map((entry: { function: { name: string } }) => entry.function.name),
									).toEqual(["run_tests"]);
									expect(request.tool_choice).toEqual({ type: "function", function: { name: "run_tests" } });
								}
								await m.review(row.id, "mark_stale", row.revision, "changed before the guarded retry");
								await f.revokeExternally();
								throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
							}
							return fetch(`${f.baseUrl}/chat/completions`, { ...init, redirect: "error" });
						},
					});
					const restored = await openSession(
						f.root,
						`${gateway.url}/v1`,
						f.manager,
						withBudget && !runtime
							? (pi) => {
									let successfulEditId: string | undefined;
									if (testOnly || verifyReadOnly) {
										pi.registerTool({
											name: "edit",
											label: "Edit fixture",
											description: "Simulate the completion of a scoped edit.",
											parameters: Type.Object({}),
											async execute() {
												return {
													content: [{ type: "text", text: "Fixture edit completed." }],
													details: {},
												};
											},
										});
										pi.registerTool({
											name: "run_tests",
											label: "Test fixture",
											description: "The only tool offered after an edit.",
											parameters: Type.Object({}),
											async execute() {
												throw new Error("The revoked request must never arrive at the provider");
											},
										});
										if (runtimeWorkflow) return;
										pi.on("tool_result", (event) => {
											successfulEditId =
												event.toolName === "edit" && !event.isError ? event.toolCallId : undefined;
										});
									}
									pi.on("before_provider_request", ({ payload }) => {
										if (!payload || typeof payload !== "object") return;
										const body = payload as Record<string, unknown>;
										const latest = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
										if (
											successfulEditId &&
											latest?.tool_call_id === successfulEditId &&
											Array.isArray(body.tools)
										) {
											body.tools = [
												...body.tools,
												{
													type: "function",
													function: { name: "pressure_fixture", description: "x".repeat(18_000) },
												},
											];
										}
										const verify = verifyReadOnly && projections.length === 0;
										const decision = applyEvaluationContextBudget(
											body,
											gateway.preview!,
											successfulEditId,
											verify ? { readOnly: true, verifyReadOnly: true } : undefined,
										);
										projections.push(decision.observation);
										return decision.selected;
									});
								}
							: undefined,
						"openai-completions",
						true,
						testOnly || verifyReadOnly ? ["edit", "run_tests"] : [],
						runtimeWorkflow ? {
							preview: gateway.preview!,
							status: gateway.status,
							readOnly: true,
							verifyReadOnly: () => projections.length === 0,
							onProjection: ({ observation }) => projections.push(observation),
						} : undefined,
					);
					try {
						await restored.session.prompt("Assess the authorized rollout.");
						expect(f.provider.requests).toHaveLength(upstreamStart + setupRequests);
						if (testOnly || verifyReadOnly)
							expect(projections.at(-1)).toMatchObject({ mode: "test-only", afterDenial: null });
						expect(gateway.status().denials).toEqual([]);
						expect(connectAttempts).toBe(setupRequests + 1);
						expect(gateway.status()).toMatchObject({
							requestsStarted: setupRequests + 1,
							committedTokenUpperBound: testOnly ? 13 : 0,
							reservedTokens: 0,
							reservedCostUsd: 0,
							requestOutcomes: expect.arrayContaining([
								expect.objectContaining({
									outcome: "GATEWAY_UPSTREAM_CONNECT_TIMEOUT",
									transportStage: "pre-connect",
									retryOffered: true,
								}),
							]),
						});
						expect(restored.audit).toContainEqual(expect.objectContaining({ decision: "dispatch-denied" }));
						f.provider.replies.push(textSse("Authorized control only.", 12, 1));
						await restored.session.prompt("Continue with current authorization.");
						expect(restored.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
						const delivered = f.provider.requests.slice(upstreamStart + setupRequests);
						expect(delivered).toHaveLength(1);
						expect(markerBytes(delivered, SENSITIVE)).toBe(0);
						expect(markerBytes(delivered, REVOKED)).toBe(0);
						expect(markerBytes(delivered, RETAINED)).toBeGreaterThan(0);
						if (runtime) expect(markerBytes(delivered, REPEATED_WORKSPACE_READ)).toBeGreaterThan(0);
						recordWire(
							runtimeWorkflow
								? "T13-e18-runtime-workflow"
								: runtime
								? "T13-e16-runtime-after"
								: verifyReadOnly
									? "T13-e14-readonly-after"
									: testOnly
										? "T13-test-only-after"
										: withBudget
											? "T13-e12-after"
											: "T13-after",
							delivered,
							{
								marker: SENSITIVE,
								markerBytes: markerBytes(delivered, SENSITIVE),
								retriedRequestsReceived: 0,
								retainedBytes: markerBytes(delivered, RETAINED),
							},
						);
					} finally {
						await restored.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
						restored.session.dispose();
						await gateway.close();
					}
				}),
			undefined,
			600,
			runtime,
		);
	},
);

it("rechecks real Memory and Knowledge sources before the ordinary CCR transport retries", async () => {
	await withFixture(async (f) => withMemory(f, async (memory) => {
		const row = await seed(f, memory);
		const deliveredMemory = await memoryLookup(f);
		const deliveredKnowledge = await f.lookup();
		expect(markerBytes(deliveredMemory, SENSITIVE)).toBeGreaterThan(0);
		expect(markerBytes(deliveredKnowledge, REVOKED)).toBeGreaterThan(0);
		await f.closeSession();
		const initialCount = f.provider.requests.length;
		const flash = "DeepSeek/deepseek-flash";
		const send = globalThis.fetch;
		let connectionAttempts = 0;
		try {
			vi.stubEnv("PI_ENHANCED_CCR_BUDGET", JSON.stringify({ baseUrl: f.baseUrl, models: [flash] }));
			vi.stubEnv("PI_ENHANCED_CCR_BUDGET_KEY", "fixture-only");
			vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				if (input === `${f.baseUrl}/chat/completions` && ++connectionAttempts === 1) {
					const pending = Buffer.from(String(init?.body));
					expect(markerBytes([pending], SENSITIVE)).toBeGreaterThan(0);
					expect(markerBytes([pending], REVOKED)).toBeGreaterThan(0);
					await memory.review(row.id, "mark_stale", row.revision, "Revoked before CCR retry");
					await f.revokeExternally();
					throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
				}
				return send(input, init);
			});
			const restored = await openSession(
				f.root, f.baseUrl, f.manager, undefined, "openai-completions", true, [], undefined, false, true,
			);
			try {
				await restored.session.prompt("Assess the authorized rollout.");
				expect(restored.session.messages.at(-1)).toMatchObject({
					role: "assistant", stopReason: "error", errorMessage: expect.stringContaining("GATEWAY_DISPATCH_AUTHORIZATION_CHANGED"),
				});
				expect(restored.audit).toContainEqual(expect.objectContaining({ decision: "dispatch-denied" }));
				expect(connectionAttempts).toBe(1);
				expect(f.provider.requests).toHaveLength(initialCount);

				f.provider.replies.push(textSse("Authorized control only.", 100, 20));
				await restored.session.prompt("Continue with current authorization.");
				expect(restored.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
				const delivered = f.provider.requests.slice(initialCount);
				expect(delivered).toHaveLength(1);
				expect(markerBytes(delivered, SENSITIVE)).toBe(0);
				expect(markerBytes(delivered, REVOKED)).toBe(0);
				expect(markerBytes(delivered, RETAINED)).toBeGreaterThan(0);
				recordWire("ccr-retry-after", delivered, { memoryRevokedBytes: markerBytes(delivered, SENSITIVE) });
			} finally {
				await restored.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				restored.session.dispose();
			}
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	}));
});

it("T11 rejects task Memory and paging from a sibling branch", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			await f.next();
			const forkPoint = f.manager.getLeafId()!;
			await f.next("Start a branch with task-owned data.");
			const taskId = await activeTask(f);
			const row = await seed(f, m, SENSITIVE, { kind: "task", id: taskId });
			const page = await sourcePage(f);
			f.manager.branch(forkPoint);
			const after = await f.lookup(CONTEXT_RESTORE, page.options, "Sibling cannot read the page.");
			const search = await memoryLookup(f);
			assertWire(
				"T11",
				f,
				page.allowed,
				[...after, ...search],
				[source(row), { id: page.options.reference }],
				SENSITIVE,
				{ taskId, forkPoint },
			);
		}),
	);
});

it("T12 drops unproven legacy results and preserves a verified control source", async () => {
	await withFixture(
		async (f) =>
			withMemory(f, async (m) => {
				const row = await seed(f, m);
				const control = await seed(f, m, CONTROL);
				const before = await memoryLookup(f);
				await m.review(row.id, "mark_stale", row.revision, "invalidate legacy source");
				const auditTool = f.session.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === MEMORY_TOOL,
				);
				expect(auditTool?.role).toBe("toolResult");
				if (auditTool?.role !== "toolResult") throw new Error("missing saved tool result");
				const issued = f.session.messages.findLast(
					(message) =>
						message.role === "assistant" &&
						message.content.some((part) => part.type === "toolCall" && part.id === auditTool.toolCallId),
				);
				if (issued?.role !== "assistant") throw new Error("missing tool call");
				const toolCallId = "fixture-legacy-call";
				const timestamp = Date.now();
				f.manager.appendMessage({
					...issued,
					timestamp,
					requestProvenance: undefined,
					content: [{ type: "toolCall", id: toolCallId, name: MEMORY_TOOL, arguments: { query: QUERY } }],
				});
				f.manager.appendMessage({
					...auditTool,
					toolCallId,
					timestamp: timestamp + 1,
					details: {},
					content: [{ type: "text", text: `Legacy unverified transcript ${SENSITIVE}` }],
				});
				const after = await memoryLookup(f);
				assertWire("T12", f, before, after, [source(row), source(control)], SENSITIVE, {
					legacyToolCallId: toolCallId,
				});
				expect(markerBytes(after, CONTROL)).toBeGreaterThan(0);
			}),
		undefined,
		4_000,
	);
});

it("suppresses an upgraded session's unlabelled assistant copy of legacy automatic Memory injection", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const row = await seed(f, m);
			const before = await f.next(`The provider originally received ${SENSITIVE}.`, QUERY);
			const previous = f.session.messages.findLast(({ role }) => role === "assistant");
			if (previous?.role !== "assistant") throw new Error("missing positive control");
			// The frozen Context transform never persisted its injected input; only the resulting assistant text survives.
			const directory = join(f.root, "legacy");
			const legacy = SessionManager.create(f.root, directory);
			legacy.appendMessage({ role: "user", content: "Continue the deployment.", timestamp: Date.now() });
			legacy.appendMessage({ ...previous, requestProvenance: undefined });
			const file = legacy.getSessionFile()!;
			await m.review(row.id, "mark_stale", row.revision, "revoke before reopening the legacy log");
			const opened = await openSession(f.root, f.baseUrl, SessionManager.open(file, directory));
			try {
				const begin = f.provider.requests.length;
				f.provider.replies.push(textSse("Continue without legacy data.", 10, 1));
				await opened.session.prompt("Continue the work independently.");
				const after = f.provider.requests.slice(begin);
				expect(after).toHaveLength(1);
				assertWire("legacy-injection", opened, before, after, [source(row)]);
				expect(after[0].toString()).toContain("Continue the work independently.");
			} finally {
				await opened.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				opened.session.dispose();
			}
		}),
	);
});

it("sends only projected content through the Pi Messages full-context SSE adapter", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (m) => {
			const row = await seed(f, m);
			const authorizedHistory = await memoryLookup(f);
			const file = f.manager.getSessionFile()!;
			await f.closeSession();
			const opened = await openSession(
				f.root,
				f.baseUrl,
				SessionManager.open(file, join(f.root, "s")),
				undefined,
				"pi-messages",
			);
			const reply = () =>
				[
					{ type: "start" },
					{ type: "text_start", contentIndex: 0 },
					{ type: "text_delta", contentIndex: 0, delta: "Independent reply." },
					{ type: "text_end", contentIndex: 0, content: "Independent reply." },
					{
						type: "done",
						reason: "stop",
						usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
					},
				]
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join("");
			async function send() {
				const start = f.provider.requests.length;
				f.provider.replies.push(reply());
				await opened.session.prompt("Continue with the approved material.");
				expect(opened.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
				return f.provider.requests.slice(start);
			}
			try {
				const before = await send();
				expect(before).toHaveLength(1);
				expect(markerBytes(before, SENSITIVE)).toBeGreaterThan(0);
				expect(before[0]!.toString()).not.toMatch(/"memoryReferences"|"requestProvenance"|"queries"/u);
				await m.review(row.id, "mark_stale", row.revision, "revoke before Pi Messages request");
				const after = await send();
				expect(after).toHaveLength(1);
				assertWire("pi-messages", opened, [...authorizedHistory, ...before], after, [source(row)]);
			} finally {
				await opened.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				opened.session.dispose();
			}
		}),
	);
});

it("E16 deduplicates only workspace reads on the production request path after revocation", async () => {
	await withFixture(
		async (f) =>
			withMemory(f, async (memory) => {
				const row = await seed(f, memory);
				const marker = "E16_AUTHORIZED_WORKSPACE_READ";
				const content = marker + " Read-only fixture content.".repeat(12);
				writeFileSync(join(f.root, "workspace-control.txt"), content);
				await f.lookup("read", { path: "workspace-control.txt" }, "First read completed.");
				const repeated = await f.lookup("read", { path: "workspace-control.txt" }, "Repeated read completed.");
				const repeatedRequest = JSON.parse(repeated.at(-1)!.toString("utf8"));
				expect(
					repeatedRequest.messages.filter((m: { content?: string }) => m.content === REPEATED_WORKSPACE_READ),
				).toHaveLength(1);
				expect(markerBytes([repeated.at(-1)!], marker)).toBe(Buffer.byteLength(marker));
				expect(f.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "read")).toHaveLength(2);
				await memoryLookup(f);
				await f.lookup();
				await memory.review(row.id, "mark_stale", row.revision, "revoked in the runtime deduplication test");
				await f.revokeExternally();
				const after = await f.next();
				expect(markerBytes(after, SENSITIVE)).toBe(0);
				expect(markerBytes(after, REVOKED)).toBe(0);
				expect(markerBytes(after, RETAINED)).toBeGreaterThan(0);
				expect(markerBytes(after, marker)).toBe(Buffer.byteLength(marker));
				recordWire("E16-runtime-dedup-after", after, {
					marker: SENSITIVE,
					markerBytes: 0,
					workspaceMarkerBytes: markerBytes(after, marker),
					retainedBytes: markerBytes(after, RETAINED),
				});
			}),
		undefined,
		600,
		true,
	);
});

it("E16 leaves source, mutation and non-Chat-Completions results intact and rejects ambiguous pairs", () => {
	const resultText = "identical fixture output ".repeat(8);
	const pair = (id: string, name: string) => [
		{ role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
		{ role: "tool", tool_call_id: id, content: resultText },
	];
	const messages = [
		...pair("read-1", "read"),
		...pair("read-2", "read"),
		...pair("doc-1", "enhanced_docs_read"),
		...pair("doc-2", "enhanced_docs_read"),
		...pair("edit-1", "edit"),
		...pair("edit-2", "edit"),
	];
	const payload = { stream: true, messages, tools: [{ type: "function" }] };
	const projected = deduplicateRuntimeReads(payload);
	expect(projected).toEqual({
		...payload,
		messages: messages.map((m, i) => (i === 1 ? { ...m, content: REPEATED_WORKSPACE_READ } : m)),
	});
	expect(payload.messages[1].content).toBe(resultText);
	expect(deduplicateRuntimeReads({ ...payload, stream: false })).toBeUndefined();
	expect(deduplicateRuntimeReads({ ...payload, messages: [...messages, ...pair("read-2", "read")] })).toBeUndefined();
	expect(deduplicateRuntimeReads({ ...payload, messages: messages.slice(0, -1) })).toBeUndefined();
});

it("withholds both sides of a Dream conflict from injection, Memory tools and HTTP history", async () => {
	await withFixture(async (f) =>
		withMemory(f, async (memory) => {
			const taskId = await activeTask(f);
			const query = "shipment temperature";
			const cold = "dream_cold_rule_12b4",
				warm = "dream_warm_rule_e8a1",
				control = "dream_dispatch_control_72a1";
			async function verify(token: string, subjectKey: string) {
				const path = token + ".txt",
					content = query + " " + token;
				writeFileSync(join(f.root, path), content);
				const record = await memory.saveCandidate({
					scope: { kind: "task", id: taskId },
					type: "episodic",
					kind: "experience",
					content,
					metadata: { subjectKey },
					source: { type: "file", ref: path },
				});
				return memory.verifyFileFact(record.id, { relativePath: path, exactExcerpt: content }, record.revision);
			}
			const current = await verify(cold, "temperature");
			const draft = await memory.saveTaskDreamCandidate(taskId, 8, current.id, current.revision);
			const approve = {
				hasUI: true,
				ui: { confirm: async () => true },
				sessionManager: { getSessionId: () => "qa-owner" },
			} as never;
			await memory.confirmByUser(draft.id, draft.revision, approve);
			await verify(control, "manifest");
			const before = await f.next("Ok.", query);
			expect(markerBytes(before, cold)).toBeGreaterThan(0);
			expect(markerBytes(before, draft.id)).toBeGreaterThan(0);
			recordWire("dream-control-before", before, { cold, warm, control, derived: draft.id });
			const other = await verify(warm, "temperature");
			async function capture(id: string) {
				const wire = [...(await f.next("Ok.", query)), ...(await memoryLookup(f, query, "Lookup complete."))];
				recordWire(id, wire, { cold, warm, control, derived: draft.id });
				expect(markerBytes(wire, cold)).toBe(0);
				expect(markerBytes(wire, warm)).toBe(0);
				expect(markerBytes(wire, draft.id)).toBe(0);
				return wire;
			}
			expect(markerBytes(await capture("dream-complete-conflict"), control)).toBeGreaterThan(0);
			const db = new DatabaseSync(memory.scope.databasePath);
			try {
				db.prepare("DELETE FROM memory_metadata WHERE memory_id=?").run(other.id);
			} finally {
				db.close();
			}
			const stale = (await memory.inspect(draft.id)).record;
			await expect(memory.confirmByUser(draft.id, stale.revision, approve)).rejects.toMatchObject({
				code: "MEMORY_REVIEW_REQUIRED",
			});
			expect(markerBytes(await capture("dream-incomplete-conflict"), control)).toBeGreaterThan(0);
		}),
	);
}, 90000);
