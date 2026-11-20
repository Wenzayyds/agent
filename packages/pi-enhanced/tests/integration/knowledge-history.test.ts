import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { AuthStorage } from "../../../coding-agent/src/core/auth-storage.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../../coding-agent/test/model-runtime-test-utils.ts";
import { createTestUiContext } from "../../../coding-agent/test/suite/harness.ts";
import { createKnowledgeExtension } from "../../src/knowledge/extension.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import { KNOWLEDGE_READ, KNOWLEDGE_SEARCH, knowledgeResultReferences } from "../../src/knowledge/tools.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { textSse, toolCallSse } from "../fixtures/runner-support.ts";

const REVOKED = "qa_revoked_history_cf11399";
const RETAINED = "qa_retained_history_ace3821";
const ECHO = `The model copied the rollout marker ${REVOKED}.`;
const SEARCH = { query: "rollout policy", corpusId: "ops" };
const CHILD_ENV = "PI_KNOWLEDGE_RESUME_FIXTURE";
const EVIDENCE_ENV = "PI_KNOWLEDGE_WIRE_EVIDENCE";

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
	writeFileSync(join(directory, `${caseId}.json`), JSON.stringify({
		caseId, pid: process.pid, revokedBytes: markerBytes(requests), retainedBytes: markerBytes(requests, RETAINED),
		...observation,
		requests: requests.map((request) => ({
			bytes: request.length, sha256: createHash("sha256").update(request).digest("hex"), body: request.toString("utf8"),
		})),
	}, null, 2));
}

class LoopbackModel {
	readonly requests: Buffer[] = [];
	readonly replies: Array<string | (() => string | Promise<string>)> = [];
	private readonly server = createServer(async (request, response) => {
		const parts: Buffer[] = [];
		for await (const part of request) parts.push(Buffer.from(part));
		this.requests.push(Buffer.concat(parts));
		const reply = this.replies.shift();
		if (request.method !== "POST" || request.url !== "/v1/chat/completions" || !reply) {
			response.writeHead(400).end(`Unexpected fixture request ${request.method} ${request.url} reply=${Boolean(reply)}`);
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
		response.end(typeof reply === "string" ? reply : await reply());
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
) {
	const agentDir = join(root, "a");
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 12 } });
	settingsManager.setProjectTrusted(true);
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, noExtensions: true,
		extensionFactories: [createKnowledgeExtension({ agentDir }), ...(extra ? [extra] : [])],
	});
	await resourceLoader.reload();
	const auth = AuthStorage.inMemory();
	await auth.modify("openai", async () => ({ type: "api_key", key: "fixture-only" }));
	const registry = await createInMemoryModelRegistry(auth);
	const model = {
		...getModel("openai", "gpt-4o"), api: "openai-completions" as const,
		baseUrl, id: "local-history-fixture", provider: "qa-knowledge",
	};
	registry.registerProvider(model.provider, { baseUrl, api: model.api, apiKey: "fixture-only", models: [model] });
	const modelRuntime = getModelRuntime(registry);
	const { session } = await createAgentSession({
		cwd: root, agentDir, settingsManager, sessionManager, resourceLoader, modelRuntime, model,
		tools: [KNOWLEDGE_SEARCH, KNOWLEDGE_READ],
	});
	await session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ confirm: async () => true }) });
	return session;
}

async function withFixture(
	body: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
	extra?: (pi: ExtensionAPI) => void,
) {
	const fixture = await createFixture(extra);
	try {
		await body(fixture);
	} finally {
		await fixture.closeSession();
		await fixture.provider.close();
		rmSync(fixture.root, { force: true, recursive: true });
	}
}

async function createFixture(extra?: (pi: ExtensionAPI) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-kh-"));
	const agentDir = join(root, "a");
	mkdirSync(agentDir);
	const revokedPath = join(root, "revoked.md");
	const retainedPath = join(root, "retained.md");
	writeFileSync(revokedPath, `# Historical policy\n\nRollout policy ${REVOKED}.`);
	writeFileSync(retainedPath, `# Current policy\n\nRollout policy ${RETAINED}.`);
	writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({ modules: { knowledge: { enabled: true } } }));
	const provider = new LoopbackModel();
	const baseUrl = await provider.start();
	const manager = SessionManager.create(root, join(root, "s"));
	const session = await openSession(root, baseUrl, manager, extra);
	const { projectId } = createProjectScope({ cwd: root, agentDir });
	const filename = join(agentDir, "pi-enhanced", "knowledge", "projects", projectId, "knowledge.sqlite3");
	async function add(path: string, allow: boolean) {
		await session.prompt(`/enhanced-docs add --corpus=ops ${allow ? "--allow-external " : ""}${JSON.stringify([path])}`);
	}
	await add(revokedPath, true);
	await add(retainedPath, true);
	let closed = false;
	return {
		root, manager, session, provider, baseUrl, filename, revokedPath, projectId,
		revocation: () => add(revokedPath, false),
		async revokeExternally() {
			const writer = new KnowledgeService({ projectId, filename, mode: "lexical" });
			try {
				await writer.add(root, "revoked.md", "ops", "local-only");
			} finally {
				await writer.close();
			}
		},
		async closeSession() {
			if (closed) return;
			closed = true;
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		},
		async lookup(tool = KNOWLEDGE_SEARCH, args: Record<string, unknown> = SEARCH, response = ECHO) {
			const start = provider.requests.length;
			provider.replies.push(toolCallSse(tool, args, 6, 1), textSse(response, 8, 1));
			await session.prompt("Look up the rollout policy.");
			const requests = provider.requests.slice(start);
			const outcome = session.messages.findLast((message) => message.role === "assistant");
			expect(requests, JSON.stringify({ outcome, tools: session.extensionRunner.getActiveTools() })).toHaveLength(2);
			expect(provider.replies).toHaveLength(0);
			return requests;
		},
		async next(response = "Continuation completed.") {
			const start = provider.requests.length;
			provider.replies.push(textSse(response, 8, 1));
			await session.prompt("Continue with the rollout.");
			const requests = provider.requests.slice(start);
			expect(requests).toHaveLength(1);
			return requests;
		},
	};
}

it("sends zero revoked bytes while retaining legal history, tool pairs and local audit", async () => {
	await withFixture(async (f) => {
		const initial = await f.lookup();
		expect(markerBytes(initial)).toBeGreaterThan(0);
		expect(markerBytes(initial, RETAINED)).toBeGreaterThan(0);
		const result = f.session.messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("Missing Knowledge result");
		const hits = knowledgeResultReferences({ ...result, toolName: KNOWLEDGE_SEARCH });
		expect(hits).toHaveLength(2);
		const expectedProof = { corpusId: "ops", documentId: expect.stringMatching(/^[a-f0-9]{64}$/), revision: 1, accessPolicy: "allow-external" };
		for (const hit of hits ?? []) expect(hit.disclosure).toMatchObject({ ...expectedProof, chunkId: hit.chunkId });
		expect(JSON.stringify(result)).not.toContain(REVOKED);
		const wire = JSON.parse(initial[1].toString("utf8"));
		const text = wire.messages.find(({ role }: { role: string }) => role === "tool").content as string;
		const matches = JSON.parse(text.slice(text.indexOf("\n") + 1)).hits as { chunkId: string; excerpt: string }[];
		const chunkId = matches.find(({ excerpt }) => excerpt.includes(REVOKED))!.chunkId;
		const read = await f.lookup(KNOWLEDGE_READ, { chunkId });
		expect(markerBytes(read)).toBeGreaterThan(0);

		// Old JSONL files stored the raw tool payload. The policy derives a reference from it
		// and never forwards the stored string, even when no details field can be recovered.
		const legacy = { ...result, details: undefined, content: [{ type: "text" as const, text }] };
		await f.revocation();
		const runner = f.session.extensionRunner;
		const readTool = runner.getToolDefinition(KNOWLEDGE_READ)!;
		const ctx = runner.createToolContext("old-id", undefined);
		await expect(readTool.execute("old-id", { chunkId }, undefined, undefined, ctx)).rejects.toThrow("document-not-found");
		const projected = runner.applyModelRequestPolicy("dispatch", [legacy]);
		expect(JSON.stringify(projected.messages)).not.toContain(REVOKED);
		expect(JSON.stringify(projected.messages)).toContain(RETAINED);

		const after = await f.lookup(KNOWLEDGE_SEARCH, SEARCH, "Confirmed the remaining policy.");
		expect(markerBytes(after)).toBe(0);
		expect(markerBytes(after, RETAINED)).toBeGreaterThan(0);
		for (const request of after) {
			const json = request.toString("utf8");
			const { messages } = JSON.parse(json) as {
				messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
			};
			const calls = new Set(messages.flatMap((message) => message.tool_calls?.map(({ id }) => id) ?? []));
			for (const message of messages) {
				if (message.role === "tool") expect(calls.has(message.tool_call_id!)).toBe(true);
			}
			expect(json).not.toContain("Historical policy");
			expect(json).not.toContain("revoked.md");
		}
		expect(readFileSync(f.manager.getSessionFile()!, "utf8")).toContain(ECHO);
		recordWire("01-before-revocation", initial);
		recordWire("02-same-session", after, { oldChunkDenied: true, rawAuditRetained: true });
	});
});

it("excludes legacy derivatives during and after native Context compaction", async () => {
	await withFixture(async (f) => {
		await f.lookup();
		await f.session.prompt("/enhanced-docs status");
		await f.next("Previous operations acknowledged.");
		await f.next("Second operations acknowledged. ".repeat(60));
		const originalUser = f.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!originalUser) throw new Error("Missing original user message");
		f.manager.appendContextEdit(originalUser.id, { content: ECHO });
		const start = f.provider.requests.length;
		// Simulate an old or extension-provided compaction contaminated before revocation.
		f.provider.replies.push(textSse(ECHO, 8, 1), textSse(ECHO, 8, 1));
		await f.session.compact();
		const summaries = f.provider.requests.slice(start);
		expect(summaries.length).toBeGreaterThan(0);
		expect(markerBytes(summaries)).toBe(0);
		f.provider.replies.splice(0);
		expect(f.manager.getEntries().some((entry) => entry.type === "compaction" && entry.summary.includes(REVOKED))).toBe(true);
		await f.revocation();
		const after = await f.next();
		expect(markerBytes(after)).toBe(0);
		recordWire("03-compaction-input", summaries);
		recordWire("04-after-compaction", after, { originalCompactionContainsMarker: true });
	});
});

it("rechecks the assembled request after payload hooks and before HTTP handoff", async () => {
	const assembled = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let pause = false;
	await withFixture(async (f) => {
		await f.lookup();
		pause = true;
		const sent = f.provider.requests.length;
		f.provider.replies.push(textSse("Rebuilt with the current permissions.", 8, 1));
		const request = f.session.prompt("Continue without a new lookup.");
		try {
			await assembled.promise;
			await f.revokeExternally();
		} finally {
			pause = false;
			release.resolve();
			await request;
		}
		const retried = f.provider.requests.slice(sent);
		expect(retried).toHaveLength(1);
		expect(markerBytes(retried)).toBe(0);
		expect(markerBytes(retried, RETAINED)).toBeGreaterThan(0);
		expect(f.session.getLastAssistantText()).toBe("Rebuilt with the current permissions.");
		const db = new DatabaseSync(f.filename, { readOnly: true });
		try {
			const audit = db.prepare("SELECT outcome FROM audit WHERE operation='model-disclosure' ORDER BY seq").all();
			expect(audit[0]).toMatchObject({ outcome: "dispatch-admitted" });
			expect(audit).toContainEqual(expect.objectContaining({ outcome: "dispatch-denied" }));
			expect(audit.at(-1)).toMatchObject({ outcome: "dispatch-admitted" });
			recordWire("05-revoked-while-assembled", retried, { audit, stalePayloadBlocked: true });
		} finally {
			db.close();
		}
		expect(markerBytes(await f.next())).toBe(0);
	}, (pi) => {
		pi.on("before_provider_request", async ({ payload }) => {
			if (!pause || !JSON.stringify(payload).includes(REVOKED)) return;
			assembled.resolve();
			await release.promise;
		});
	});
});

it("records an admitted request already received by the provider and blocks subsequent reuse", async () => {
	await withFixture(async (f) => {
		await f.lookup();
		const arrived = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const start = f.provider.requests.length;
		f.provider.replies.push(async () => {
			arrived.resolve();
			await release.promise;
			return textSse(ECHO, 8, 1);
		});
		const pending = f.session.prompt("Continue while the provider is receiving the prompt.");
		try {
			await arrived.promise;
			expect(markerBytes(f.provider.requests.slice(start))).toBeGreaterThan(0);
			await f.revokeExternally();
		} finally {
			release.resolve();
			await pending;
		}
		const arriving = f.provider.requests.slice(start);
		const after = await f.next();
		expect(markerBytes(after)).toBe(0);
		recordWire("06-received-before-revocation", arriving);
		recordWire("07-after-in-flight-revocation", after);
	});
});

it.each(["before", "after"] as const)("sends zero bytes when revocation commits %s cross-process restore", async (revocation) => {
	await withFixture(async (f) => {
		await f.lookup();
		if (revocation === "before") await f.revocation();
		const sessionPath = f.manager.getSessionFile()!;
		const original = readFileSync(sessionPath, "utf8");
		expect(original).toContain(ECHO);
		expect(original).toContain('"requestProvenance"');
		await f.closeSession();
		const start = f.provider.requests.length;
		f.provider.replies.push(textSse("Restored successfully.", 8, 1));
		const workspace = resolve(import.meta.dirname, "../../../..");
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[join(workspace, "node_modules/vitest/vitest.mjs"), "--run",
				"tests/integration/knowledge-history.test.ts", "-t", "fixture child resumes"],
			{ cwd: join(workspace, "packages/pi-enhanced"), env: { ...process.env, [CHILD_ENV]: JSON.stringify({ root: f.root, baseUrl: f.baseUrl, sessionPath, parentPid: process.pid, revocation }) } },
		);
		expect(stdout).toContain("1 passed");
		const requests = f.provider.requests.slice(start);
		expect(requests).toHaveLength(1);
		expect(markerBytes(requests)).toBe(0);
		expect(markerBytes(requests, RETAINED)).toBeGreaterThan(0);
		recordWire(`08-cross-process-${revocation}`, requests, { restoredInSeparateProcess: true, revocation });
	});
}, 45_000);

it.runIf(Boolean(process.env[CHILD_ENV]))("fixture child resumes a saved session", async () => {
	const { root, baseUrl, sessionPath, parentPid, revocation } = JSON.parse(process.env[CHILD_ENV]!) as {
		root: string; baseUrl: string; sessionPath: string; parentPid: number; revocation: "before" | "after";
	};
	expect(process.pid).not.toBe(parentPid);
	const session = await openSession(root, baseUrl, SessionManager.open(sessionPath));
	try {
		if (revocation === "after") {
			await session.prompt(`/enhanced-docs add --corpus=ops ${JSON.stringify([join(root, "revoked.md")])}`);
		}
		await session.prompt("Resume the project from disk.");
		expect(session.getLastAssistantText()).toBe("Restored successfully.");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
