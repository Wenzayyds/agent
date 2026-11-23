import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { injectVerifiedMemory } from "../../src/context/memory-source.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { ScopedMemoryReaderAdapter } from "../../src/memory/reader.ts";
import { type MemoryService, openMemoryService } from "../../src/memory/service.ts";

function conflictAudit(path: string, project: string, id: string) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db
			.prepare(
				"SELECT after_json FROM memory_governance_audit WHERE memory_id=? AND project_id=? AND action='dream_conflict_pending'",
			)
			.all(id, project)
			.flatMap((row) => JSON.parse(String(row.after_json)).evidence);
	} finally {
		db.close();
	}
}
const roots: string[] = [];
const services: MemoryService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-dream-subject-"));
	roots.push(root);
	const scope = createProjectScope({ cwd: root, agentDir: join(root, "agent") });
	const open = async () => {
		const service = await openMemoryService(scope);
		services.push(service);
		return service;
	};
	const service = await open();
	const add = async (
		name: string,
		subjectKey: string | undefined,
		content: string,
		taskId = "release",
		db = service,
	) => {
		writeFileSync(join(root, name), content);
		const source = await db.saveCandidate({
			kind: "experience",
			type: "episodic",
			content,
			scope: { kind: "task", id: taskId },
			source: { type: "file", ref: name },
			metadata: { subjectKey },
		});
		if (source.status === "verified") return source;
		return db.verifyFileFact(source.id, { relativePath: name, exactExcerpt: content }, source.revision);
	};
	return { add, open, service, scope, root };
}
const approve = (confirm = async () => true) =>
	({
		hasUI: true,
		ui: { confirm },
		sessionManager: { getSessionId: () => "owner" },
	}) as unknown as ExtensionCommandContext;
it.each([
	[10, 0],
	[52, 0],
	[122, 1],
	[125, 53],
	[125, 103],
])("checks all %i task records with conflicting evidence at offset %i", async (size, offset) => {
	const { service, add, scope, root } = await fixture();
	let earlier = "";
	for (let n = 0; n < size - 1; n++) {
		const record =
			n === offset
				? await add("old.md", "colour", "Use amber.")
				: await add("step" + n + ".md", "part-" + n, "Part " + n);
		if (n === offset) earlier = record.id;
	}
	const source = await add("new.md", "colour", "Use blue.");
	expect(service.taskDreamConflicts("release", source)).toContain(earlier + "@2");
	await expect(service.saveTaskDreamCandidate("release", 4, source.id, source.revision)).rejects.toMatchObject({
		code: "MEMORY_CONTENT_CONFLICT",
	});
	const [draft] = await service.list({ statuses: ["candidate"] });
	expect(draft).toBeDefined();
	await expect(service.confirmByUser(draft!.id, draft!.revision, approve())).rejects.toMatchObject({
		code: "MEMORY_CONTENT_CONFLICT",
	});
	expect(await service.getVisible(draft!.id, { taskId: "release" })).toBeNull();
	expect(conflictAudit(scope.databasePath, scope.projectId, draft!.id)).toContain(earlier + "@2");
	const control = await add("ready.md", "packing", "Blue cartons are ready.");
	expect((await service.inspect(source.id)).modelReview?.state).toBe("conflict");
	expect((await service.inspect(earlier)).record.status).toBe("verified");
	const reader = new ScopedMemoryReaderAdapter(service, undefined, "owner", async () => ({
		taskId: "release",
		sessionId: "owner",
	}));
	try {
		const result = await injectVerifiedMemory({
			reader,
			projectRoot: root,
			taskId: "release",
			sessionId: "owner",
			config: { enabled: true, maximumRecords: 5, maximumTextCharacters: 3000, readerTimeoutMs: 3000 },
			messages: [{ role: "user", content: "blue", timestamp: 1 }],
		});
		expect(result.injectedMemoryIds).toContain(control.id);
		expect(result.injectedMemoryIds).not.toContain(source.id);
		expect(result.injectedMemoryIds).not.toContain(earlier);
		expect(result.injectedMemoryIds).not.toContain(draft!.id);
	} finally {
		reader.close();
	}
});
it("rechecks inside approval after a second SQLite connection verifies contrary evidence", async () => {
	const { service, add, open } = await fixture();
	const writer = await open();
	const source = await add("original.md", "colour", "Use blue.");
	const draft = await service.saveTaskDreamCandidate("release", 4, source.id, source.revision);
	await expect(
		service.confirmByUser(
			draft.id,
			draft.revision,
			approve(async () => {
				await add("other.md", "colour", "Use amber.", "release", writer);
				return true;
			}),
		),
	).rejects.toMatchObject({ code: "MEMORY_CONTENT_CONFLICT" });
	expect(await writer.getVisible(draft.id, { taskId: "release" })).toBeNull();
});
it("deduplicates agreeing sources and isolates other tasks and projects", async () => {
	const a = await fixture();
	const b = await fixture();
	const foreignTask = await a.add("other.md", "colour", "Use red.", "different");
	const foreignProject = await b.add("red.md", "colour", "Use red.");
	const source = await a.add("blue.md", "colour", "Use blue.");
	const same = await a.add("also-blue.md", "colour", "Use blue.");
	expect(same.id).toBe(source.id);
	const draft = await a.service.saveTaskDreamCandidate("release", 4, same.id, same.revision);
	expect(await a.service.getVisible(foreignTask.id, { taskId: "release" })).toBeNull();
	expect(await a.service.getVisible(foreignProject.id, { taskId: "release" })).toBeNull();
	expect(() => a.service.taskDreamConflicts("release", foreignProject)).toThrow();
	const approved = await a.service.confirmByUser(draft.id, draft.revision, approve());
	expect(await a.service.getVisible(approved.id, { taskId: "release" })).not.toBeNull();
	expect(await b.service.getVisible(approved.id, { taskId: "release" })).toBeNull();
});
it("rechecks task approvals when an authorized project fact changes the evidence", async () => {
	const { service, add, scope } = await fixture();
	const source = await add("blue.md", "colour", "Use blue.");
	const draft = await service.saveTaskDreamCandidate("release", 3, source.id, source.revision);
	await service.confirmByUser(draft.id, draft.revision, approve());
	const project = await service.saveCandidate({
		kind: "fact",
		type: "semantic",
		scope: { kind: "project" },
		content: "Use amber.",
		metadata: { subjectKey: "colour" },
		source: { type: "user", ref: "owner" },
	});
	const confirmed = await service.confirmByUser(project.id, project.revision, approve());
	expect(await service.getVisible(draft.id, { taskId: "release" })).toBeNull();
	expect((await service.inspect(draft.id)).record.status).toBe("stale");
	expect(conflictAudit(scope.databasePath, scope.projectId, draft.id)).toContain(
		confirmed.id + "@" + confirmed.revision,
	);
});
it("keeps ambiguous evidence with no subject pending", async () => {
	const { service, add } = await fixture();
	const source = await add("bare.md", undefined, "Use blue.");
	await add("file.md", "colour", "Use amber.");
	await expect(service.saveTaskDreamCandidate("release", 3, source.id, source.revision)).rejects.toMatchObject({
		code: "MEMORY_CONTENT_CONFLICT",
	});
});
it("fails closed when evidence cannot be checked during approval", async () => {
	const { service, add, root } = await fixture();
	const source = await add("blue.md", "colour", "Use blue.");
	const draft = await service.saveTaskDreamCandidate("release", 3, source.id, source.revision);
	await add("contrary.md", "colour", "Use amber.");
	const path = join(root, "contrary.md");
	rmSync(path);
	mkdirSync(path);
	await expect(service.confirmByUser(draft.id, draft.revision, approve())).rejects.toMatchObject({
		code: "MEMORY_VALIDATION_ERROR",
	});
	expect(await service.getVisible(draft.id, { taskId: "release" })).toBeNull();
});
it("quarantines live and pre-fix approvals with durable evidence on reopen", async () => {
	const { service, add, open, scope } = await fixture();
	const source = await add("first.md", "colour", "Use blue.");
	const draft = await service.saveTaskDreamCandidate("release", 3, source.id, source.revision);
	await service.confirmByUser(draft.id, draft.revision, approve());
	const old = await add("second.md", "colour", "Use amber.");
	expect(await service.getVisible(draft.id, { taskId: "release" })).toBeNull();
	// Recreate the persisted status written by the pre-fix release.
	const db = new DatabaseSync(scope.databasePath);
	try {
		db.prepare("UPDATE memories SET status='verified' WHERE id=?").run(draft.id);
	} finally {
		db.close();
	}
	const restarted = await open();
	expect(await restarted.getVisible(draft.id, { taskId: "release" })).toBeNull();
	expect((await restarted.inspect(draft.id)).record.status).toBe("stale");
	expect(conflictAudit(scope.databasePath, scope.projectId, draft.id)).toContain(old.id + "@" + old.revision);
});

it("holds approval and restored Dream records when verified metadata is missing", async () => {
	const { service, add, open, scope } = await fixture();
	const earlier = await add("older.md", "colour", "Use amber.");
	const source = await add("newer.md", "colour", "Use blue.");
	await expect(service.saveTaskDreamCandidate("release", 4, source.id, source.revision)).rejects.toMatchObject({
		code: "MEMORY_CONTENT_CONFLICT",
	});
	const [draft] = await service.list({ statuses: ["candidate"] });
	const db = new DatabaseSync(scope.databasePath);
	try {
		db.prepare("DELETE FROM memory_metadata WHERE memory_id=?").run(earlier.id);
		expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
		await expect(service.saveTaskDreamCandidate("release", 4, source.id, source.revision)).rejects.toMatchObject({
			code: "MEMORY_REVIEW_REQUIRED",
		});
		await expect(service.confirmByUser(draft!.id, draft!.revision, approve())).rejects.toMatchObject({
			code: "MEMORY_REVIEW_REQUIRED",
		});
		expect((await service.inspect(source.id)).modelReview?.state).toBe("needs_review");
		expect(await service.getVisible(source.id, { taskId: "release" })).toBeNull();
		// Persist the status left by the pre-fix version, then reopen the same database.
		db.prepare("UPDATE memories SET status='verified' WHERE id=?").run(draft!.id);
		const reopened = await open();
		expect((await reopened.inspect(draft!.id)).record.status).toBe("stale");
		expect(await reopened.getVisible(draft!.id, { taskId: "release" })).toBeNull();
		const history = db
			.prepare(
				"SELECT after_json FROM memory_governance_audit WHERE memory_id=? AND action='dream_conflict_pending'",
			)
			.all(draft!.id);
		expect(history.some((row) => JSON.parse(String(row.after_json)).reason === "MEMORY_REVIEW_REQUIRED")).toBe(true);
		expect(db.prepare("SELECT content FROM memories WHERE id=?").get(earlier.id)?.content).toBe("Use amber.");
		const independent = await add("foreign.md", "colour", "Unrelated task proof.", "other");
		expect(await reopened.getVisible(independent.id, { taskId: "other" })).not.toBeNull();
	} finally {
		db.close();
	}
});

it.each(["older", "newer"])("uses legacy same-subject evidence when the %s endpoint loses metadata", async (lost) => {
	const { add, service, open, scope } = await fixture();
	const older = await add("cold.md", "dispatch", "Keep cold.");
	const newer = await add("warm.md", "dispatch", "Keep warm.");
	const independent = await add("ok.md", "packing", "Use two boxes.");
	const [missing, witness] = lost === "older" ? [older, newer] : [newer, older];
	const db = new DatabaseSync(scope.databasePath);
	try {
		// Legacy status events did not include the subject of the verified record.
		db.prepare("UPDATE memory_governance_audit SET after_json=json_remove(after_json,'$.subjectKey') WHERE action='status_changed'").run();
		db.prepare("DELETE FROM memory_metadata WHERE memory_id=?").run(missing.id);
		const reopened = await open();
		const context = { taskId: "release" };
		expect(await reopened.getVisible(independent.id, context)).not.toBeNull();
		expect(await reopened.getVisible(witness.id, context)).toBeNull();
		await expect(service.confirmByUser(missing.id, missing.revision, approve())).rejects.toMatchObject({
			code: "MEMORY_REVIEW_REQUIRED",
		});
		// A later subject change breaks the equality proved by the creation event.
		await service.updateMetadata(witness.id, witness.revision, { subjectKey: "storage" });
		expect(await reopened.getVisible(independent.id, context)).toBeNull();
	} finally {
		db.close();
	}
});

it("restores the surviving source after resolution and keeps the audit of the conflict", async () => {
	const { add, service, scope } = await fixture();
	const a = await add("cold.md", "dispatch", "Keep cold.");
	const b = await add("warm.md", "dispatch", "Keep warm.");
	expect(await service.getVisible(a.id, { taskId: "release" })).toBeNull();
	expect(await service.getVisible(b.id, { taskId: "release" })).toBeNull();
	const same = await add("ok.md", "packing", "Use two boxes.");
	expect(await service.getVisible(same.id, { taskId: "release" })).not.toBeNull();
	await service.archive(b.id, b.revision);
	expect(await service.getVisible(a.id, { taskId: "release" })).not.toBeNull();
	expect((await service.inspect(b.id)).record.content).toBe("Keep warm.");
	const db = new DatabaseSync(scope.databasePath, { readOnly: true });
	try {
		const audit = db
			.prepare(
				"SELECT after_json FROM memory_governance_audit WHERE memory_id=? AND action='subject_review_pending'",
			)
			.all(b.id);
		expect(audit.some((row) => JSON.parse(String(row.after_json)).evidence.includes(a.id + "@" + a.revision))).toBe(
			true,
		);
	} finally {
		db.close();
	}
});
