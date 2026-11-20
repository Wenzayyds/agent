import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryError } from "../../src/memory/errors.ts";
import { startMemoryRuntime } from "../../src/memory/runtime.ts";
import { openMemoryService } from "../../src/memory/service.ts";
import { SessionRecallAdapter } from "../../src/memory/session-recall.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-recall-lifecycle-"));
	tempDirs.push(path);
	return path;
}

function workspace() {
	const root = tempDir();
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(project);
	mkdirSync(sessionDir);
	return { project, agentDir, sessionDir };
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P2-5 Session Recall lifecycle and persistence", () => {
	it.each([
		{ enabled: false, projectTrusted: true, expected: "disabled" },
		{ enabled: true, projectTrusted: false, expected: "blocked" },
	] as const)("does not instantiate Recall or touch Session content in $expected state", async (input) => {
		const { project, agentDir } = workspace();
		const manager = SessionManager.inMemory(project, { id: "inert-session" });
		manager.appendMessage({ role: "user", content: "must stay unread", timestamp: 1 });
		const createSessionRecall = vi.fn(() => {
			throw new Error("must not instantiate");
		});
		const runtime = await startMemoryRuntime({
			...input,
			cwd: project,
			agentDir,
			sessionManager: manager,
			createSessionRecall,
			openBackend: openMemoryService,
		});
		expect(runtime.state).toBe(input.expected);
		expect(createSessionRecall).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "pi-enhanced"))).toBe(false);
	});

	it("uses public SessionManager reads without changing a persisted JSONL file", async () => {
		const { project, agentDir, sessionDir } = workspace();
		const manager = SessionManager.create(project, sessionDir, { id: "persisted-recall" });
		const sourceId = manager.appendMessage({ role: "user", content: "persistent recall evidence", timestamp: 1 });
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted Session file");
		const beforeContent = readFileSync(sessionFile);
		const before = statSync(sessionFile);
		const runtime = await startMemoryRuntime({
			enabled: true,
			projectTrusted: true,
			cwd: project,
			agentDir,
			sessionManager: manager,
			openBackend: openMemoryService,
		});
		const result = runtime.sessionRecall?.search({ text: "persistent recall" });
		expect(result?.hits[0]).toMatchObject({
			projectId: runtime.scope?.projectId,
			sessionId: "persisted-recall",
			entryId: sourceId,
		});
		const afterContent = readFileSync(sessionFile);
		const after = statSync(sessionFile);
		expect(createHash("sha256").update(afterContent).digest("hex")).toBe(
			createHash("sha256").update(beforeContent).digest("hex"),
		);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		await runtime.close();
	});

	it("invalidates the old adapter and binds a replacement runtime to the new Session", async () => {
		const { project, agentDir } = workspace();
		const firstManager = SessionManager.inMemory(project, { id: "before-reload" });
		firstManager.appendMessage({ role: "user", content: "old runtime evidence", timestamp: 1 });
		const first = await startMemoryRuntime({
			enabled: true,
			projectTrusted: true,
			cwd: project,
			agentDir,
			sessionManager: firstManager,
			openBackend: openMemoryService,
		});
		const oldAdapter = first.sessionRecall;
		expect(oldAdapter).toBeInstanceOf(SessionRecallAdapter);
		expect(oldAdapter?.search({ text: "old runtime" }).hits).toHaveLength(1);
		await first.close();
		await first.close();
		expect(() => oldAdapter?.search({ text: "old runtime" })).toThrowError(
			expect.objectContaining<Partial<MemoryError>>({ code: "MEMORY_RUNTIME_CLOSED" }),
		);

		const secondManager = SessionManager.inMemory(project, { id: "after-reload" });
		secondManager.appendMessage({ role: "user", content: "new runtime evidence", timestamp: 2 });
		const second = await startMemoryRuntime({
			enabled: true,
			projectTrusted: true,
			cwd: project,
			agentDir,
			sessionManager: secondManager,
			openBackend: openMemoryService,
		});
		expect(second.sessionRecall?.search({ text: "new runtime" }).sessionId).toBe("after-reload");
		expect(second.sessionRecall?.search({ text: "old runtime" }).hits).toEqual([]);
		await second.close();
	});
});
