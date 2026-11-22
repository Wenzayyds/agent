import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerMemoryCandidateWriterBroker,
	requestMemoryCandidateWrite,
} from "../../src/memory/candidate-writer.ts";
import { registerMemoryInteractions } from "../../src/memory/interaction.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { openMemoryService, type MemoryService } from "../../src/memory/service.ts";

import { registerScopedTaskReaderBroker } from "../../src/task-manager/reader.ts";

const roots: string[] = [];
const services: MemoryService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Task to Memory candidate bridge", () => {
	it("accepts only the bound session and project, is idempotent, and never creates verified Memory", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-task-memory-"));
		roots.push(root);
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(project);
		const scope = createProjectScope({ cwd: project, agentDir });
		const service = await openMemoryService(scope);
		services.push(service);
		const events = createEventBus();
		const off = registerMemoryCandidateWriterBroker(events, { service, scope, sessionId: "session-1", isCompletedTask: async (id) => id === "task-1" });
		const context = { cwd: project, sessionManager: { getSessionId: () => "session-1" } } as never;
		await expect(requestMemoryCandidateWrite(events, context, { taskId: "task-1-other", content: "forged task" }))
			.rejects.toMatchObject({ code: "MEMORY_VALIDATION_ERROR" });
		const first = await requestMemoryCandidateWrite(events, context, { taskId: "task-1", content: "A reviewed task experience" });
		const second = await requestMemoryCandidateWrite(events, context, { taskId: "task-1", content: "A reviewed task experience" });
		expect(second).toEqual(first);
		const record = await service.get(first.id);
		expect(record?.status).toBe("candidate");
		expect(record?.sources).toEqual([expect.objectContaining({ type: "user", ref: expect.stringMatching(/^task:task-1:experience:[a-f0-9]{64}$/u) })]);
		expect(await service.search({ text: "reviewed task", statuses: ["verified"] })).toEqual([]);
		await expect(
			requestMemoryCandidateWrite(events, { cwd: project, sessionManager: { getSessionId: () => "other" } } as never, { taskId: "task-1", content: "wrong session" }, 50),
		).rejects.toMatchObject({ code: "MEMORY_RUNTIME_UNAVAILABLE" });
		off();
		await service.close(); services.splice(services.indexOf(service), 1);
		const reopened = await openMemoryService(scope); services.push(reopened);
		const restartedBus = createEventBus();
		const stopRestarted = registerMemoryCandidateWriterBroker(restartedBus, { service: reopened, scope, sessionId: "session-1", isCompletedTask: async (id) => id === "task-1" });
		const afterRestart = await requestMemoryCandidateWrite(restartedBus, context, { taskId: "task-1", content: "A reviewed task experience" });
		expect(afterRestart.id).toBe(first.id);
		const edited = await reopened.updateContent(first.id, "Revised task experience", afterRestart.revision);
		const replay = await requestMemoryCandidateWrite(restartedBus, context, { taskId: "task-1", content: "A reviewed task experience" });
		expect(replay).toMatchObject({ id: first.id, revision: edited.revision });
		expect(await reopened.list()).toHaveLength(1);
		await reopened.delete(first.id, edited.revision);
		await expect(requestMemoryCandidateWrite(restartedBus, context, { taskId: "task-1", content: "A reviewed task experience" }))
			.rejects.toMatchObject({ code: "MEMORY_VALIDATION_ERROR" });
		expect(await reopened.list()).toEqual([]);
		stopRestarted();
	});
});

it("keeps Auto Dream candidates quarantined and rechecks the exact source after reopen", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-dream-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const scope = createProjectScope({ cwd: root, agentDir });
	const service = await openMemoryService(scope);
	services.push(service);
	const taskId = "completed-task";
	const content = "Release smoke uses the staging manifest.";
	const path = "release.md";
	writeFileSync(join(root, path), content);
	const source = await service.saveCandidate({ kind: "experience", type: "episodic", content,
		scope: { kind: "task", id: taskId }, source: { type: "file", ref: path },
		metadata: { subjectKey: "release-smoke" },
	});
	const verified = await service.verifyFileFact(source.id, { relativePath: path, exactExcerpt: content }, source.revision);
	expect(await service.taskDreamCandidates(taskId)).toMatchObject([{ id: source.id }]);
	expect(await service.taskDreamCandidates("completed-task-foreign")).toEqual([]);
	await expect(service.saveTaskDreamCandidate("completed-task-foreign", 4, source.id, verified.revision)).rejects.toThrow();
	const draft = await service.saveTaskDreamCandidate(taskId, 4, source.id, verified.revision);
	const replay = await service.saveTaskDreamCandidate(taskId, 4, source.id, verified.revision);
	expect(replay.id).toBe(draft.id);
	expect(draft).toMatchObject({ scope: { kind: "task", id: taskId }, status: "candidate", content,
		sources: [{ ref: "task:completed-task:dream:v1:4:" + source.id + ":" + verified.revision }] });
	expect(await service.getVisible(draft.id, { taskId })).toBeNull();
	await expect(service.verifyFileFact(draft.id, { relativePath: path, exactExcerpt: content }, draft.revision))
		.rejects.toThrow("interactive approval");
	const ctx = { hasUI: true, ui: { confirm: async () => true },
		sessionManager: { getSessionId: () => "session-1" } } as never;
	const approved = await service.confirmByUser(draft.id, draft.revision, ctx);
	expect(await service.getVisible(draft.id, { taskId })).toMatchObject({ id: approved.id });
	expect(await service.getVisible(draft.id, { taskId: "completed-task-foreign" })).toBeNull();
	await expect(service.proposeProjectPromotion(draft.id, approved.revision, "project reuse", ctx)).rejects.toThrow();
	await expect(service.updateMetadata(draft.id, approved.revision, { validUntil: null })).rejects.toThrow();
	expect(await service.inspect(draft.id)).toMatchObject({
		relations: [{ relation: "derived_from", targetMemoryId: source.id }],
	});
	await service.close();
	services.splice(services.indexOf(service), 1);
	const reopened = await openMemoryService(scope);
	services.push(reopened);
	expect(await reopened.getVisible(draft.id, { taskId })).not.toBeNull();
	const otherDir = join(root, "different-project");
	mkdirSync(otherDir);
	const other = await openMemoryService(createProjectScope({ cwd: otherDir, agentDir }));
	services.push(other);
	expect(await other.getVisible(draft.id, { taskId })).toBeNull();
	await reopened.delete(source.id, verified.revision);
	expect(await reopened.getVisible(draft.id, { taskId })).toBeNull();
	expect(await reopened.reviewTaskDream(taskId)).toMatchObject([{ id: draft.id, status: "stale" }]);
	await expect(reopened.saveTaskDreamCandidate(taskId, 4, source.id, verified.revision)).rejects.toThrow();
});

it("detects conflicting verified facts on one task subject", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-dream-conflict-"));
	roots.push(root);
	const service = await openMemoryService(createProjectScope({ cwd: root, agentDir: join(root, "agent") }));
	services.push(service);
	const records = [];
	for (const choice of ["alpha", "beta"]) {
		const relativePath = choice + ".md";
		const content = "Deployment selector is " + choice + ".";
		writeFileSync(join(root, relativePath), content);
		const candidate = await service.saveCandidate({ kind: "experience", type: "episodic", content,
			scope: { kind: "task", id: "task" }, metadata: { subjectKey: "deployment-selector" },
			source: { type: "file", ref: relativePath } });
		records.push(await service.verifyFileFact(candidate.id, { relativePath, exactExcerpt: content }, candidate.revision));
	}
	await expect(service.saveTaskDreamCandidate("task", 2, records[0]!.id, records[0]!.revision))
		.rejects.toMatchObject({ code: "MEMORY_CONTENT_CONFLICT" });
	await service.archive(records[1]!.id, records[1]!.revision);
	expect((await service.saveTaskDreamCandidate("task", 2, records[0]!.id, records[0]!.revision)).status).toBe("candidate");
});

it.each(["source-file", "source-edit", "source-archive", "review-expiration"])("Auto Dream invalidates %s", async (reason) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dream-stale-"));
	roots.push(root);
	const service = await openMemoryService(createProjectScope({ cwd: root, agentDir: join(root, "agent") }));
	services.push(service);
	const content = "Rerun the release smoke validation.";
	const relativePath = "provider.md";
	writeFileSync(join(root, relativePath), content);
	const candidate = await service.saveCandidate({ kind: "experience", type: "episodic", content,
		scope: { kind: "task", id: "one" }, source: { type: "file", ref: relativePath } });
	const source = await service.verifyFileFact(candidate.id, { relativePath, exactExcerpt: content }, candidate.revision);
	const draft = await service.saveTaskDreamCandidate("one", 2, source.id, source.revision);
	const approved = await service.confirmByUser(draft.id, draft.revision, {
		hasUI: true, ui: { confirm: async () => true }, sessionManager: { getSessionId: () => "approved" },
	} as never);
	expect(await service.getVisible(approved.id, { taskId: "one" })).not.toBeNull();
	if (reason === "source-file") writeFileSync(join(root, relativePath), "The original source was withdrawn.");
	if (reason === "source-edit") await service.updateContent(source.id, "The source has a newer revision.", source.revision);
	if (reason === "source-archive") await service.archive(source.id, source.revision);
	if (reason === "review-expiration") await service.updateMetadata(approved.id, approved.revision, { validUntil: 1 });
	expect(await service.getVisible(approved.id, { taskId: "one" })).toBeNull();
});

it("previews through the host command without saving and limits saving to completed bound tasks", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-dream-command-"));
	roots.push(root);
	const scope = createProjectScope({ cwd: root, agentDir: join(root, "agent") });
	const service = await openMemoryService(scope);
	services.push(service);
	const content = "Use the staging manifest during release review.";
	const relativePath = "manifest.md";
	const taskId = "task-review";
	writeFileSync(join(root, relativePath), content);
	const candidate = await service.saveCandidate({ kind: "experience", type: "episodic", content,
		scope: { kind: "task", id: taskId }, source: { type: "file", ref: relativePath } });
	await service.verifyFileFact(candidate.id, { relativePath, exactExcerpt: content }, candidate.revision);
	const events = createEventBus();
	let state = "running";
	let boundBranch = "original";
	const off = registerScopedTaskReaderBroker(events, { scope, sessionId: "session", reader: {
		get: async (id) => id === taskId ? {
			taskId, projectId: scope.projectId, sessionId: "session", branchLeafId: boundBranch, revision: 3, status: state,
		} as never : null,
		getActive: async () => null,
	} });
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	registerMemoryInteractions({
		events, on: () => {}, getCommands: () => [], getAllTools: () => [], registerTool: () => {}, registerCommand: commands.set.bind(commands),
	} as never, () => ({ state: "ready", scope, backend: service, close: () => service.close() }));
	const run = commands.get("enhanced-memory-dream")!.handler;
	let confirmed = false;
	const notices: string[] = [];
	const ctx = {
		cwd: root, hasUI: true, isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session", getBranch: () => [{ id: "original" }] },
		ui: { confirm: async () => confirmed, notify: (message: string) => notices.push(message) },
	} as never;
	try {
		await run(taskId + " save", ctx);
		expect(await service.list()).toHaveLength(1);
		state = "completed";
		await run(taskId, ctx);
		expect(notices.join("\n")).toContain(content);
		expect(await service.list()).toHaveLength(1);
		await run(taskId + " save", ctx);
		expect(await service.list()).toHaveLength(1);
		confirmed = true;
		boundBranch = "foreign";
		await run(taskId + " save", ctx);
		expect(await service.list()).toHaveLength(1);
		boundBranch = "original";
		await run(taskId + " save", ctx);
		expect(await service.list({ statuses: ["candidate"] })).toHaveLength(1);
	} finally { off(); }
});
