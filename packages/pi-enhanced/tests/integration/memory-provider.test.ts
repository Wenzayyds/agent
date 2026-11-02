import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MemorySource, ProjectScope } from "../../src/memory/contracts.ts";
import { MemoryError } from "../../src/memory/errors.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { LocalMemoryProvider, readSearchState } from "../../src/memory/provider.ts";
import { ensureProjectStorage } from "../../src/memory/storage.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-memory-provider-"));
	tempDirs.push(path);
	return path;
}

function scope(): ProjectScope {
	const root = tempDir();
	const project = join(root, "project");
	mkdirSync(project);
	return createProjectScope({ cwd: project, agentDir: join(root, "agent") });
}

function source(ref: string): MemorySource {
	return { type: "file", ref, observedAt: Date.now() };
}

function normalized(content: string): string {
	return content.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function hash(content: string): string {
	return createHash("sha256").update(normalized(content)).digest("hex");
}

async function save(provider: LocalMemoryProvider, content: string, ref: string) {
	return provider.saveCandidate({
		kind: "fact",
		content,
		normalizedContent: normalized(content),
		contentHash: hash(content),
		source: source(ref),
		now: Date.now(),
	});
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P2-2 LocalMemoryProvider", () => {
	it("migrates core tables, initializes FTS, and keeps multiple sources on one stable record", async () => {
		const currentScope = scope();
		ensureProjectStorage(currentScope);
		const provider = new LocalMemoryProvider(currentScope);
		expect(provider.searchStatus).toBe("fts-ready");
		expect(provider.databaseLimitBytes).toBeLessThanOrEqual(256 * 1024 * 1024);

		const first = await save(provider, "SessionManager keeps the active branch", "README.md#sessions");
		const duplicate = await save(provider, "SessionManager keeps the active branch", "src/session-manager.ts:10");
		expect(duplicate.id).toBe(first.id);
		expect(duplicate.revision).toBe(1);
		expect(duplicate.contentRevision).toBe(1);
		expect(duplicate.sources.map(({ ref }) => ref)).toEqual(["README.md#sessions", "src/session-manager.ts:10"]);

		const hits = await provider.search({ text: "SessionManager", statuses: ["candidate"] });
		expect(hits.map(({ id }) => id)).toEqual([first.id]);
		await provider.close();

		const database = new DatabaseSync(currentScope.databasePath, { readOnly: true });
		expect(readSearchState(database)).toBe("fts-ready");
		expect(
			(database.prepare("SELECT group_concat(version) AS versions FROM schema_migrations ORDER BY version").get() as { versions: string }).versions,
		).toBe("1,2");
		database.close();
	});

	it("keeps core CRUD and literal search available when FTS5 is explicitly unavailable", async () => {
		const currentScope = scope();
		ensureProjectStorage(currentScope);
		const provider = new LocalMemoryProvider(currentScope, { ftsMode: "unavailable-for-test" });
		expect(provider.searchStatus).toBe("degraded");
		const record = await save(provider, "当前会话记忆可以检索", "docs/memory.md");
		expect((await provider.search({ text: "会话记", statuses: ["candidate"] })).map(({ id }) => id)).toEqual([record.id]);
		await provider.close();
	});

	it("separates optimistic revision from content revision and removes related rows", async () => {
		const currentScope = scope();
		ensureProjectStorage(currentScope);
		const provider = new LocalMemoryProvider(currentScope);
		const candidate = await save(provider, "verified content", "README.md");
		const verified = await provider.setStatus({
			id: candidate.id,
			status: "verified",
			verification: {
				id: randomUUID(),
				type: "user_confirmed",
				evidenceRef: "interactive-command",
				evidenceVersion: "confirmation-v1",
				verifiedAt: Date.now(),
			},
			expectedRevision: candidate.revision,
			now: Date.now(),
		});
		expect(verified).toMatchObject({ revision: 2, contentRevision: 1, status: "verified" });
		expect(verified.verifications[0]?.verifiedContentRevision).toBe(1);

		const stale = await provider.setStatus({
			id: verified.id,
			status: "stale",
			expectedRevision: verified.revision,
			now: Date.now(),
		});
		expect(stale).toMatchObject({ revision: 3, contentRevision: 1, status: "stale" });

		const edited = await provider.updateContent({
			id: stale.id,
			content: "new content",
			normalizedContent: normalized("new content"),
			contentHash: hash("new content"),
			expectedRevision: stale.revision,
			now: Date.now(),
		});
		expect(edited).toMatchObject({ revision: 4, contentRevision: 2, status: "candidate" });

		await provider.delete(edited.id, edited.revision);
		expect(await provider.get(edited.id)).toBeNull();
		expect(await provider.search({ text: "new content" })).toEqual([]);
		await provider.close();

		const database = new DatabaseSync(currentScope.databasePath, { readOnly: true });
		for (const table of ["memories", "memory_sources", "memory_verifications"] as const) {
			expect((database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
		}
		database.close();
	});

	it("reports stale writers and content-key conflicts without overwriting records", async () => {
		const currentScope = scope();
		ensureProjectStorage(currentScope);
		const provider = new LocalMemoryProvider(currentScope);
		const first = await save(provider, "first", "first.md");
		const second = await save(provider, "second", "second.md");
		await provider.updateContent({
			id: first.id,
			content: "first changed",
			normalizedContent: normalized("first changed"),
			contentHash: hash("first changed"),
			expectedRevision: first.revision,
			now: Date.now(),
		});
		await expect(
			provider.updateContent({
				id: first.id,
				content: "stale write",
				normalizedContent: normalized("stale write"),
				contentHash: hash("stale write"),
				expectedRevision: first.revision,
				now: Date.now(),
			}),
		).rejects.toMatchObject<MemoryError>({ code: "MEMORY_REVISION_CONFLICT" });
		await expect(
			provider.updateContent({
				id: second.id,
				content: "first changed",
				normalizedContent: normalized("first changed"),
				contentHash: hash("first changed"),
				expectedRevision: second.revision,
				now: Date.now(),
			}),
		).rejects.toMatchObject<MemoryError>({ code: "MEMORY_CONTENT_CONFLICT" });
		await provider.close();
	});

	it("rolls back core migration artifacts when a non-FTS schema error occurs", () => {
		const currentScope = scope();
		ensureProjectStorage(currentScope);
		const database = new DatabaseSync(currentScope.databasePath);
		database.exec("CREATE TABLE memories (bad_column TEXT)");
		database.close();

		expect(() => new LocalMemoryProvider(currentScope)).toThrowError(/Failed to initialize memory database/u);
		const inspection = new DatabaseSync(currentScope.databasePath, { readOnly: true });
		const tables = inspection
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((row) => (row as { name: string }).name);
		expect(tables).toEqual(["memories"]);
		inspection.close();
	});

	it("persists across reopen and reports lock contention with a stable error", async () => {
		const currentScope = scope();
		ensureProjectStorage(currentScope);
		const firstProvider = new LocalMemoryProvider(currentScope);
		const record = await save(firstProvider, "persisted memory", "persist.md");
		await firstProvider.close();

		const reopened = new LocalMemoryProvider(currentScope);
		expect((await reopened.get(record.id))?.content).toBe("persisted memory");
		const lock = new DatabaseSync(currentScope.databasePath, { timeout: 0 });
		lock.exec("BEGIN IMMEDIATE");
		await expect(save(reopened, "blocked write", "busy.md")).rejects.toMatchObject<MemoryError>({
			code: "MEMORY_STORAGE_BUSY",
		});
		lock.exec("ROLLBACK");
		lock.close();
		await reopened.close();
	});

	it("reports a corrupt database instead of treating it as empty", () => {
		const currentScope = scope();
		ensureProjectStorage(currentScope);
		writeFileSync(currentScope.databasePath, "not a sqlite database");
		try {
			new LocalMemoryProvider(currentScope);
			throw new Error("expected corrupt database initialization to fail");
		} catch (error) {
			expect(error).toMatchObject<MemoryError>({ code: "MEMORY_STORAGE_ERROR" });
		}
	});
});
