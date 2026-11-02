import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewMemoryInput, ProjectScope } from "../../src/memory/contracts.ts";
import { MemoryError } from "../../src/memory/errors.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { LocalMemoryProvider } from "../../src/memory/provider.ts";
import { MemoryService } from "../../src/memory/service.ts";
import { ensureProjectStorage } from "../../src/memory/storage.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-memory-service-"));
	tempDirs.push(path);
	return path;
}

function setup(): { scope: ProjectScope; service: MemoryService } {
	const root = tempDir();
	const project = join(root, "project");
	mkdirSync(project);
	const scope = createProjectScope({ cwd: project, agentDir: join(root, "agent") });
	ensureProjectStorage(scope);
	return { scope, service: new MemoryService(scope, new LocalMemoryProvider(scope)) };
}

function context(options: { hasUI: boolean; confirm?: () => Promise<boolean> }): ExtensionCommandContext {
	return {
		hasUI: options.hasUI,
		ui: { confirm: options.confirm ?? (async () => false) },
		sessionManager: { getSessionId: () => "test-session" },
	} as unknown as ExtensionCommandContext;
}

function candidate(content: string, ref = "user:command"): NewMemoryInput {
	return { kind: "fact", content, source: { type: "user", ref } };
}

afterEach(async () => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P2-3 MemoryService", () => {
	it("always saves untrusted input as candidate and defaults search to verified", async () => {
		const { service } = setup();
		const input = {
			...candidate("Memory tools are read only"),
			status: "verified",
			verification: { type: "test_passed", ref: "invented" },
			projectId: "other-project",
		} as unknown as NewMemoryInput;
		const record = await service.saveCandidate(input);
		expect(record.status).toBe("candidate");
		expect(record.projectId).toBe(service.scope.projectId);
		expect(await service.search({ text: "Memory tools" })).toEqual([]);
		expect((await service.search({ text: "Memory tools", statuses: ["candidate"] }))[0]?.id).toBe(record.id);
		await service.close();
	});

	it("requires a successful interactive confirmation and keeps contentRevision stable across status changes", async () => {
		const { service } = setup();
		const record = await service.saveCandidate(candidate("Project memory is explicitly reviewed"));
		const confirm = vi.fn(async () => false);
		await expect(service.confirmByUser(record.id, record.revision, context({ hasUI: false, confirm }))).rejects.toMatchObject<MemoryError>({
			code: "MEMORY_VALIDATION_ERROR",
		});
		expect(confirm).not.toHaveBeenCalled();
		await expect(service.confirmByUser(record.id, record.revision, context({ hasUI: true, confirm }))).rejects.toMatchObject<MemoryError>({
			code: "MEMORY_VALIDATION_ERROR",
		});
		await expect(
			service.confirmByUser(
				record.id,
				record.revision,
				context({
					hasUI: true,
					confirm: async () => {
						throw new Error("UI closed");
					},
				}),
			),
		).rejects.toMatchObject<MemoryError>({ code: "MEMORY_VALIDATION_ERROR" });
		expect((await service.get(record.id))?.verifications).toEqual([]);

		const verified = await service.confirmByUser(record.id, record.revision, context({ hasUI: true, confirm: async () => true }));
		expect(verified).toMatchObject({ status: "verified", revision: 2, contentRevision: 1 });
		expect(verified.verifications[0]).toMatchObject({
			type: "user_confirmed",
			verifiedContentRevision: 1,
		});
		const stale = await service.review(verified.id, "mark_stale", verified.revision);
		const reverified = await service.confirmByUser(stale.id, stale.revision, context({ hasUI: true, confirm: async () => true }));
		expect(reverified).toMatchObject({ status: "verified", revision: 4, contentRevision: 1 });
		expect(reverified.verifications).toHaveLength(2);
		await service.close();
	});

	it("invalidates old evidence after content changes and detects stale writers", async () => {
		const { service } = setup();
		const original = await service.saveCandidate(candidate("Original fact"));
		const verified = await service.confirmByUser(original.id, original.revision, context({ hasUI: true, confirm: async () => true }));
		const edited = await service.updateContent(verified.id, "Updated fact", verified.revision);
		expect(edited).toMatchObject({ status: "candidate", revision: 3, contentRevision: 2 });
		expect(edited.verifications[0]?.verifiedContentRevision).toBe(1);
		await expect(service.review(edited.id, "reject", verified.revision)).rejects.toMatchObject<MemoryError>({
			code: "MEMORY_REVISION_CONFLICT",
		});
		await service.close();
		await expect(service.get(edited.id)).rejects.toMatchObject<MemoryError>({ code: "MEMORY_RUNTIME_CLOSED" });
	});

	it("verifies only an exact observed file excerpt and records the real file hash", async () => {
		const { scope, service } = setup();
		const fileContent = "Memory uses a project-scoped database.\n";
		writeFileSync(join(scope.rootPath, "memory.md"), fileContent);
		const exact = await service.saveCandidate(candidate("Memory uses a project-scoped database."));
		const expectedFileHash = createHash("sha256").update(fileContent).digest("hex");
		const verified = await service.verifyFileFact(
			exact.id,
			{ relativePath: "memory.md", exactExcerpt: "Memory uses a project-scoped database.", expectedFileHash },
			exact.revision,
		);
		expect(verified.verifications[0]).toMatchObject({
			type: "file_observed",
			evidenceRef: "memory.md",
			evidenceVersion: expectedFileHash,
		});

		const summary = await service.saveCandidate(candidate("The architecture is secure"));
		await expect(
			service.verifyFileFact(
				summary.id,
				{ relativePath: "memory.md", exactExcerpt: "Memory uses a project-scoped database." },
				summary.revision,
			),
		).rejects.toMatchObject<MemoryError>({ code: "MEMORY_VALIDATION_ERROR" });
		expect((await service.get(summary.id))?.status).toBe("candidate");
		await service.close();
	});

	it("rejects secrets without echoing them and enforces review transitions", async () => {
		const { service } = setup();
		const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
		let error: unknown;
		try {
			await service.saveCandidate(candidate(`token=${secret}`));
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject<MemoryError>({ code: "MEMORY_VALIDATION_ERROR" });
		expect((error as Error).message).not.toContain(secret);

		const record = await service.saveCandidate(candidate("review me"));
		const rejected = await service.review(record.id, "reject", record.revision);
		expect(rejected.status).toBe("rejected");
		const restored = await service.review(rejected.id, "restore_candidate", rejected.revision);
		expect(restored.status).toBe("candidate");
		await expect(service.review(restored.id, "mark_stale", restored.revision)).rejects.toMatchObject<MemoryError>({
			code: "MEMORY_VALIDATION_ERROR",
		});
		await service.close();
	});
});
