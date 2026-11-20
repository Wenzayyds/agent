import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { createContextExtension } from "../../src/context/extension.ts";
import { CONTEXT_RESTORE } from "../../src/context/offload.ts";
import { hasValidToolPairing } from "../../src/context/tool-output.ts";
import type { ContextMessage } from "../../src/context/contracts.ts";
import { createMemoryExtension } from "../../src/memory/extension.ts";
import { MemoryService, openMemoryService } from "../../src/memory/service.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { createTaskManagerExtension } from "../../src/task-manager/extension.ts";

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-context-"));
	tempDirs.push(path);
	return path;
}

function writeConfig(agentDir: string, modules: Record<string, unknown>): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), `${JSON.stringify({ modules }, null, 2)}\n`);
}

function selectConfig(memoryInjection = false, taskInjection = false): Record<string, unknown> {
	return {
		enabled: true,
		mode: "select",
		budget: { maximumEstimatedTokens: 1_000, reserveEstimatedTokens: 0, recentMessagesToKeep: 1 },
		toolOutput: { enabled: true, maximumTextCharacters: 600 },
		memoryInjection: { enabled: memoryInjection, maximumRecords: 2, maximumTextCharacters: 2_000, readerTimeoutMs: 200 },
		taskInjection: { enabled: taskInjection, maximumTextCharacters: 2_000, readerTimeoutMs: 200 },
		pythonScoring: { enabled: false },
	};
}

function user(content: string, timestamp: number): ContextMessage {
	return { role: "user", content, timestamp };
}

function assistantWithCall(id: string): ContextMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "fixture.txt" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function result(id: string, content: string): ContextMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: content }], isError: false, timestamp: 3 };
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P3 Context Extension lifecycle", () => {
	it.each([
		{ mode: "disabled", trusted: true },
		{ mode: "observe", trusted: true },
		{ mode: "select", trusted: false },
	])("keeps the native request unchanged for $mode with trusted=$trusted", async ({ mode, trusted }) => {
		const agentDir = join(tempDir(), "agent");
		if (mode !== "disabled") {
			writeConfig(agentDir, {
				context: mode === "observe" ? { ...selectConfig(true), mode: "observe" } : selectConfig(true),
			});
		}
		const harness = await createHarness({ extensionFactories: [createContextExtension({ agentDir })] });
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(trusted);
		await harness.session.bindExtensions({ mode: "print", uiContext: createTestUiContext() });
		const messages = [user("old ".repeat(2_000), 1), user("latest", 2)];
		await expect(harness.session.extensionRunner.emitContext(messages)).resolves.toEqual(messages);
		expect(existsSync(join(agentDir, "pi-enhanced", "memory"))).toBe(false);
		expect(harness.session.extensionRunner.hasHandlers("context_with_system")).toBe(false);
	});

	it("selects a request view, preserves tool pairing, and never changes the Session JSONL", async () => {
		const agentDir = join(tempDir(), "agent");
		const project = tempDir();
		const sessionDir = join(tempDir(), "sessions");
		mkdirSync(sessionDir);
		const manager = SessionManager.create(project, sessionDir, { id: "context-persistence" });
		writeConfig(agentDir, { context: selectConfig(false) });
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createContextExtension({ agentDir })],
		});
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ mode: "print", uiContext: createTestUiContext() });
		harness.sessionManager.appendMessage(user("old history ".repeat(1_000), 1));
		harness.sessionManager.appendMessage(user("run read", 2));
		harness.sessionManager.appendMessage(assistantWithCall("call-1"));
		harness.sessionManager.appendMessage(result("call-1", `important-start\n${"x".repeat(3_000)}\nimportant-end`));
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent fixture session");
		const before = { hash: createHash("sha256").update(readFileSync(sessionFile)).digest("hex"), stat: readFileSync(sessionFile).length };
		const projection = harness.sessionManager.buildSessionProjection().messages;
		const transformed = await harness.session.extensionRunner.emitContext(projection);
		expect(hasValidToolPairing(transformed)).toBe(true);
		const transformedResult = transformed.find((message) => message.role === "toolResult");
		expect(JSON.stringify(transformedResult)).toContain("original remains in Session");
		expect(JSON.stringify(transformedResult)).toContain("important-start");
		expect(JSON.stringify(transformedResult)).toContain("important-end");
		expect(readFileSync(sessionFile).length).toBe(before.stat);
		expect(createHash("sha256").update(readFileSync(sessionFile)).digest("hex")).toBe(before.hash);

		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		await expect(harness.session.extensionRunner.emitContext(projection)).resolves.toEqual(projection);
	});

	it.each(["before", "after"] as const)("preserves tool structure when another Context handler runs %s", async (order) => {
		const agentDir = join(tempDir(), "agent");
		writeConfig(agentDir, { context: selectConfig(false) });
		const observations: boolean[] = [];
		const observer = (pi: ExtensionAPI) => {
			pi.on("context", (event) => {
				observations.push(hasValidToolPairing(event.messages));
				return { messages: event.messages };
			});
		};
		const context = createContextExtension({ agentDir });
		const harness = await createHarness({ extensionFactories: order === "before" ? [observer, context] : [context, observer] });
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ mode: "print", uiContext: createTestUiContext() });
		const messages = [user("run", 1), assistantWithCall("call"), result("call", "x".repeat(2_000))];
		const transformed = await harness.session.extensionRunner.emitContext(messages);
		expect(observations).toEqual([true]);
		expect(hasValidToolPairing(transformed)).toBe(true);
	});

	it("falls back to TS-only selection when the Memory reader is unavailable", async () => {
		const agentDir = join(tempDir(), "agent");
		writeConfig(agentDir, { context: selectConfig(true) });
		const notifications: string[] = [];
		const harness = await createHarness({ extensionFactories: [createContextExtension({ agentDir })] });
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ mode: "print", uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }) });
		const transformed = await harness.session.extensionRunner.emitContext([user("old ".repeat(2_000), 1), user("latest question", 2)]);
		expect(transformed.at(-1)).toMatchObject({ role: "user", content: "latest question" });
		const inspect = harness.session.extensionRunner.getCommand("enhanced-context-inspect");
		if (!inspect) throw new Error("Missing Context inspect command");
		await inspect.handler("", harness.session.extensionRunner.createCommandContext());
		expect(notifications.at(-1)).toContain("memory-reader-unavailable");
	});

	it("invalidates diagnostics on tree changes and restarts cleanly on resume", async () => {
		const agentDir = join(tempDir(), "agent");
		writeConfig(agentDir, { context: selectConfig(false) });
		const notifications: string[] = [];
		const harness = await createHarness({ extensionFactories: [createContextExtension({ agentDir })] });
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({
			mode: "print",
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		const messages = [user("old ".repeat(2_000), 1), user("latest", 2)];
		expect((await harness.session.extensionRunner.emitContext(messages)).length).toBeLessThan(messages.length);
		await harness.session.extensionRunner.emit({ type: "session_tree", oldLeafId: "old", newLeafId: "new" });
		const inspect = harness.session.extensionRunner.getCommand("enhanced-context-inspect");
		if (!inspect) throw new Error("Missing Context inspect command");
		await inspect.handler("", harness.session.extensionRunner.createCommandContext());
		expect(notifications.at(-1)).toContain("removedMessages=0");
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect((await harness.session.extensionRunner.emitContext(messages)).length).toBeLessThan(messages.length);
	});
});

describe("P3 verified Memory integration", () => {
	it("restores a bounded page after reopening the task and continues through verified memory", async () => {
		const project = tempDir();
		const agentDir = join(tempDir(), "agent");
		const sessionDir = tempDir();
		const config = selectConfig(true, true);
		writeConfig(agentDir, {
			context: { ...config, compaction: { enabled: true }, toolOutput: { enabled: true, offload: true, maximumTextCharacters: 600 } },
			memory: { enabled: true },
			"task-manager": { enabled: true, contextSummary: true },
		});
		const source = "head-evidence" + "x".repeat(987) + "middle-evidence" + "y".repeat(900) + "\nAssertionError: unexpected key casing\n" + "y".repeat(1_100) + "tail-evidence";
		writeFileSync(join(project, "fixture.txt"), source);
		let reads = 0;
		let memory: MemoryService | undefined;
		const notifications: string[] = [];
		const open = async (sessionManager: SessionManager) => {
			const harness = await createHarness({
				sessionManager,
				provider: "context-task-recovery-stub",
				extensionFactories: [
					createTaskManagerExtension({ agentDir }),
					createMemoryExtension({ agentDir, openBackend: async (scope) => (memory = await openMemoryService(scope)) }),
					createContextExtension({ agentDir }),
					(pi) => pi.registerTool({
						name: "read_fixture", label: "Read fixture", description: "Read the fixed test fixture",
						parameters: Type.Object({}),
						async execute() {
							reads += 1;
							return { content: [{ type: "text", text: readFileSync(join(project, "fixture.txt"), "utf8") }], details: {} };
						},
					}),
				],
			});
			harnesses.push(harness);
			(harness.session as unknown as { _cwd: string })._cwd = project;
			(harness.session.extensionRunner as unknown as { cwd: string }).cwd = project;
			harness.settingsManager.setProjectTrusted(true);
			const ui = createTestUiContext({ confirm: async () => true, notify: (message) => notifications.push(message) });
			await harness.session.bindExtensions({ mode: "tui", uiContext: ui });
			const ctx = Object.create(harness.session.extensionRunner.createCommandContext()) as ExtensionCommandContext;
			Object.defineProperties(ctx, { hasUI: { value: true }, ui: { value: ui } });
			const invoke = async (name: string, args: string) => {
				const command = harness.session.extensionRunner.getCommand(name);
				if (!command) throw new Error(`Missing ${name}`);
				await command.handler(args, ctx);
				return notifications.at(-1)!;
			};
			return { harness, invoke, ctx };
		};

		const first = await open(SessionManager.create(project, sessionDir));
		const task = JSON.parse(await first.invoke("enhanced-task-create", JSON.stringify({
			goal: "Inspect file then validate its version",
			steps: [
				{ stepId: "inspect", title: "Inspect", expectedOutcome: "Read the fixture once" },
				{ stepId: "verify", title: "Verify", expectedOutcome: "Validate the observed fixture", dependsOn: ["inspect"],
					validation: { kind: "file_sha256", relativePath: "fixture.txt", expectedSha256: createHash("sha256").update(source).digest("hex") } },
			],
		})));
		const taskId: string = task.task.taskId;
		await first.invoke("enhanced-task-approve", `${taskId} ${task.task.revision}`);
		await first.invoke("enhanced-task-step", `${taskId} inspect bind`);
		await first.invoke("enhanced-task-step", `${taskId} inspect start 1`);
		const candidate = await memory!.saveCandidate({
			kind: "fact", content: "retained marker documents the fixture version", source: { type: "user", ref: "fixture" },
		});
		await memory!.confirmByUser(candidate.id, candidate.revision, first.ctx);
		let reference: string | undefined;
		first.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read_fixture", {})], { stopReason: "toolUse" }),
			(context) => {
				const projected = context.messages.find((message) => message.role === "toolResult");
				const serialized = JSON.stringify(projected);
				reference = /v1:[a-f0-9]{64}/u.exec(serialized)?.[0];
				expect(reference).toBeDefined();
				expect(serialized).not.toContain("middle-evidence");
				expect(serialized).toContain("AssertionError: unexpected key casing");
				return fauxAssistantMessage("Inspection finished");
			},
		]);
		await first.harness.session.prompt("Inspect the file. Preserve the original fixture.");
		expect(first.harness.getPendingResponseCount()).toBe(0);
		expect(reference).toBeDefined();
		const sessionFile = first.harness.sessionManager.getSessionFile()!;
		expect(readFileSync(sessionFile, "utf8")).toContain(JSON.stringify(source).slice(1, -1));
		await first.invoke("enhanced-task-evidence", `${taskId} inspect attest observed file content`);
		await first.invoke("enhanced-task-step", `${taskId} inspect verify 2`);
		await first.invoke("enhanced-task-step", `${taskId} inspect complete 3`);
		const checkpoint = JSON.parse(await first.invoke("enhanced-task-checkpoint", taskId));
		expect(checkpoint.observation.contextReferences).toEqual([reference]);
		expect(checkpoint.observation.sessionUsage.responses).toBe(2);
		const firstKeptEntryId = first.harness.sessionManager.getLeafId()!;
		first.harness.sessionManager.appendCompaction("The fixture was inspected.", firstKeptEntryId, 1_000);
		await first.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harnesses.splice(harnesses.indexOf(first.harness), 1);
		first.harness.cleanup();

		const second = await open(SessionManager.open(sessionFile, sessionDir));
		const preflight = JSON.parse(await second.invoke("enhanced-task-recover", taskId));
		expect(preflight).toMatchObject({
			checkpointIntegrity: "verified", completedStepIds: ["inspect"], safeContinueStepIds: ["verify"], automaticReplayAllowed: false,
		});
		await second.invoke("enhanced-task-rebind", `${taskId} verify`);
		await second.invoke("enhanced-task-step", `${taskId} verify start 1`);
		let sawRestoredPage = false;
		second.harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(candidate.id);
				expect(JSON.stringify(context.messages)).toContain(`contextReference=${reference}`);
				return fauxAssistantMessage([fauxToolCall(CONTEXT_RESTORE, { reference: reference!, offset: 995, limit: 25 })], { stopReason: "toolUse" });
			},
			(context) => {
				const restored = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === CONTEXT_RESTORE);
				expect(JSON.stringify(restored)).toContain("xxxxxmiddle-evidenceyyyyy");
				sawRestoredPage = true;
				return fauxAssistantMessage("Ready for independent validation");
			},
		]);
		await second.harness.session.prompt("retained marker");
		expect(second.harness.session.messages.findLast((message) => message.role === "assistant")).toMatchObject({ stopReason: "stop" });
		expect(sawRestoredPage).toBe(true);
		expect(reads).toBe(1);
		const continued = JSON.parse(await second.invoke("enhanced-task-checkpoint", taskId));
		expect(continued.observation.sessionUsage.responses).toBe(checkpoint.observation.sessionUsage.responses + 2);
		await second.invoke("enhanced-task-evidence", `${taskId} verify validate`);
		await second.invoke("enhanced-task-step", `${taskId} verify verify 2`);
		await second.invoke("enhanced-task-step", `${taskId} verify complete 3`);
		const inspected = JSON.parse(await second.invoke("enhanced-task-inspect", taskId));
		const completed = JSON.parse(await second.invoke("enhanced-task-complete", `${taskId} ${inspected.task.revision}`));
		expect(completed.task.status).toBe("completed");
		expect(completed.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "succeeded", stepId: "verify" })]));

		const other = JSON.parse(await second.invoke("enhanced-task-create", JSON.stringify({
			goal: "Different task", steps: [{ stepId: "other", title: "Other", expectedOutcome: "No cross-task restore" }],
		})));
		await second.invoke("enhanced-task-approve", `${other.task.taskId} ${other.task.revision}`);
		await second.invoke("enhanced-task-step", `${other.task.taskId} other bind`);
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall(CONTEXT_RESTORE, { reference: reference! })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await second.harness.session.prompt("Check task isolation.");
		expect(second.harness.session.messages.findLast((item) => item.role === "toolResult")).toMatchObject({ isError: true });
	});

	it("optionally injects the current bound Task without changing the user message structure", async () => {
		const agentDir = join(tempDir(), "agent");
		writeConfig(agentDir, {
			context: selectConfig(false, true),
			"task-manager": { enabled: true, modelPlanTool: false, contextSummary: true, maximumTasks: 50, maximumSteps: 20, maximumEvents: 1_000 },
		});
		const notifications: string[] = [];
		const harness = await createHarness({ extensionFactories: [createTaskManagerExtension({ agentDir }), createContextExtension({ agentDir })] });
		harnesses.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ notify: (message) => notifications.push(message), confirm: async () => true }) });
		const base = harness.session.extensionRunner.createCommandContext();
		const interactive = Object.create(base) as ExtensionCommandContext;
		Object.defineProperty(interactive, "hasUI", { value: true });
		Object.defineProperty(interactive, "ui", { value: createTestUiContext({ notify: (message) => notifications.push(message), confirm: async () => true }) });
		const invoke = async (name: string, args: string) => {
			const command = harness.session.extensionRunner.getCommand(name);
			if (!command) throw new Error(`missing ${name}`);
			await command.handler(args, interactive);
		};
		await invoke("enhanced-task-create", JSON.stringify({ goal: "keep context task visible", steps: [{ stepId: "s", title: "inspect", expectedOutcome: "facts" }] }));
		const created = JSON.parse(notifications.at(-1)!) as { task: { taskId: string; revision: number } };
		await invoke("enhanced-task-approve", `${created.task.taskId} ${created.task.revision}`);
		await invoke("enhanced-task-step", `${created.task.taskId} s bind`);
		const original = [user("continue task", 10)];
		const transformed = await harness.session.extensionRunner.emitContext(original);
		expect(transformed.map(({ role }) => role)).toEqual(["custom", "user"]);
		expect(JSON.stringify(transformed[0])).toContain(created.task.taskId);
		expect(transformed[1]).toEqual(original[0]);
		await harness.session.extensionRunner.emit({ type: "session_tree", oldLeafId: "old", newLeafId: "new" });
		expect(await harness.session.extensionRunner.emitContext(original)).toEqual(original);
	});

	it("injects only verified Episodic Memory before the latest user and maps it to a low-trust user message", async () => {
		const agentDir = join(tempDir(), "agent");
		writeConfig(agentDir, { memory: { enabled: true }, context: selectConfig(true) });
		let service: MemoryService | undefined;
		const harness = await createHarness({
			extensionFactories: [
				createContextExtension({ agentDir }),
				createMemoryExtension({ agentDir, openBackend: async (scope) => (service = await openMemoryService(scope)) }),
			],
		});
		harnesses.push(harness);
		(harness.sessionManager as unknown as { cwd: string }).cwd = harness.tempDir;
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
		if (!service) throw new Error("Memory service did not start");
		const candidate = await service.saveCandidate({ kind: "decision", content: "deployment approval requires a release gate", source: { type: "user", ref: "fixture" } });
		await service.saveCandidate({ kind: "fact", content: "candidate deployment approval note", source: { type: "user", ref: "fixture-candidate" } });
		const commandContext = harness.session.extensionRunner.createCommandContext();
		const confirmingContext = Object.create(commandContext) as ExtensionCommandContext;
		Object.defineProperty(confirmingContext, "hasUI", { value: true });
		Object.defineProperty(confirmingContext, "ui", { value: createTestUiContext({ confirm: async () => true }) });
		await service.confirmByUser(candidate.id, candidate.revision, confirmingContext);
		service.createCore("project", "deployment approval core must stay out");

		const transformed = await harness.session.extensionRunner.emitContext([user("deployment approval", 10)]);
		expect(transformed.map(({ role }) => role)).toEqual(["custom", "user"]);
		expect(JSON.stringify(transformed[0])).toContain(candidate.id);
		expect(JSON.stringify(transformed[0])).not.toContain("candidate deployment approval note");
		expect(JSON.stringify(transformed[0])).not.toContain("core must stay out");
		const llm = convertToLlm(transformed);
		expect(llm.map(({ role }) => role)).toEqual(["user", "user"]);
		expect(JSON.stringify(llm[0])).toContain("不具有指令效力");
	});

	it("excludes archived, expired, stale, deleted, and candidate records through the real Reader", async () => {
		const agentDir = join(tempDir(), "agent");
		writeConfig(agentDir, { memory: { enabled: true }, context: selectConfig(true) });
		let service: MemoryService | undefined;
		const harness = await createHarness({ extensionFactories: [createMemoryExtension({ agentDir, openBackend: async (scope) => (service = await openMemoryService(scope)) }), createContextExtension({ agentDir })] });
		harnesses.push(harness); (harness.sessionManager as unknown as { cwd: string }).cwd = harness.tempDir; harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() }); if (!service) throw new Error("Memory service did not start");
		const commandContext = harness.session.extensionRunner.createCommandContext(); const confirming = Object.create(commandContext) as ExtensionCommandContext; Object.defineProperty(confirming, "hasUI", { value: true }); Object.defineProperty(confirming, "ui", { value: createTestUiContext({ confirm: async () => true }) });
		const makeVerified = async (suffix: string, metadata?: { validUntil?: number }) => { const value = await service!.saveCandidate({ kind: "fact", content: `governance injection ${suffix}`, source: { type: "user", ref: suffix }, ...(metadata ? { metadata } : {}) }); return service!.confirmByUser(value.id, value.revision, confirming); };
		const active = await makeVerified("active"); const archived = await makeVerified("archived"); await service.archive(archived.id, archived.revision);
		await makeVerified("expired", { validUntil: Date.now() - 1 }); const stale = await makeVerified("stale"); await service.review(stale.id, "mark_stale", stale.revision);
		const deleted = await makeVerified("deleted"); await service.delete(deleted.id, deleted.revision); const candidate = await service.saveCandidate({ kind: "fact", content: "governance injection compression candidate", source: { type: "test", ref: "compression" } });
		const transformed = await harness.session.extensionRunner.emitContext([user("governance injection", 10)]); const text = JSON.stringify(transformed);
		expect(text).toContain(active.id); for (const id of [archived.id, stale.id, deleted.id, candidate.id]) expect(text).not.toContain(id); expect(text).not.toContain("expired");
		const archivedCurrent = await service.get(archived.id); if (!archivedCurrent) throw new Error("archived fixture missing"); await service.restore(archived.id, archivedCurrent.revision);
		expect((await service.search({ text: "governance injection archived" })).map(({ id }) => id)).toContain(archived.id);
		const afterRestore = JSON.stringify(await harness.session.extensionRunner.emitContext([user("archived governance injection", 11)])); expect(afterRestore).toContain(archived.id);
	});
});
