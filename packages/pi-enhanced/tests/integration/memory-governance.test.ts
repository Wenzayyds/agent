import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { classifyMemory, type MemoryKind, type MemoryRecord, type ProjectScope } from "../../src/memory/contracts.ts";
import type { MemoryGovernanceConfig } from "../../src/memory/governance.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { LocalMemoryProvider, rollbackMemoryGovernanceMigration, runCoreMigrations } from "../../src/memory/provider.ts";
import { MemoryService } from "../../src/memory/service.ts";
import { ensureProjectStorage } from "../../src/memory/storage.ts";

const roots: string[] = [];
const services: MemoryService[] = [];
const governance: MemoryGovernanceConfig = {
	maximumScanRecords: 100,
	nearDuplicatePercent: 50,
	archiveAfterDays: 180,
	coreWarningBytes: 49_152,
};

function createStore(name = "project"): { scope: ProjectScope; provider: LocalMemoryProvider; service: MemoryService } {
	const root = mkdtempSync(join(tmpdir(), "pi-enhanced-governance-"));
	roots.push(root);
	const project = join(root, name);
	mkdirSync(project);
	const scope = createProjectScope({ cwd: project, agentDir: join(root, "agent") });
	ensureProjectStorage(scope);
	const provider = new LocalMemoryProvider(scope);
	const service = new MemoryService(scope, provider);
	services.push(service);
	return { scope, provider, service };
}

async function verified(
	provider: LocalMemoryProvider,
	content: string,
	options: { kind?: MemoryKind; subjectKey?: string; category?: MemoryRecord["category"] } = {},
): Promise<MemoryRecord> {
	const normalized = content.normalize("NFKC").replace(/\s+/gu, " ").trim();
	const candidate = await provider.saveCandidate({
		kind: options.kind ?? "experience",
		content,
		normalizedContent: normalized,
		contentHash: createHash("sha256").update(normalized).digest("hex"),
		source: { type: "test", ref: "memory-governance.test.ts", observedAt: Date.now() },
		metadata: {
			category: options.category ?? "other",
			...(options.subjectKey ? { subjectKey: options.subjectKey } : {}),
			tags: [],
			importance: 1,
		},
		now: Date.now(),
	});
	return provider.setStatus({
		id: candidate.id,
		status: "verified",
		verification: {
			id: randomUUID(),
			type: "test_passed",
			evidenceRef: "memory-governance.test.ts",
			evidenceVersion: "v1",
			verifiedAt: Date.now(),
		},
		expectedRevision: candidate.revision,
		now: Date.now(),
	});
}

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Memory Governance schema and lifecycle", () => {
	it("upgrades v1 data, supports an explicit v2 rollback, and upgrades again without losing records", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-v1-"));
		roots.push(root);
		const scope = createProjectScope({ cwd: root, agentDir: join(root, "agent") });
		ensureProjectStorage(scope);
		const database = new DatabaseSync(scope.databasePath, { enableForeignKeyConstraints: true });
		runCoreMigrations(database, 2);
		const original = { id: "legacy-id" };
		database.prepare(`INSERT INTO memories (id, project_id, kind, content, normalized_content, status,
			content_hash, created_at, updated_at) VALUES (?, ?, 'experience', 'legacy', 'legacy', 'candidate', 'old-hash', 1, 1)`)
			.run(original.id, scope.projectId);
		database.prepare("INSERT INTO memory_sources (memory_id, source_type, source_ref, observed_at) VALUES (?, 'user', 'task:old-task:experience:1', 1)")
			.run(original.id);
		rollbackMemoryGovernanceMigration(database);
		expect((database.prepare("SELECT group_concat(version) AS versions FROM schema_migrations").get() as { versions: string }).versions).toBe("1");
		expect((database.prepare("SELECT count(*) AS count FROM memories").get() as { count: number }).count).toBe(1);
		runCoreMigrations(database);
		expect((database.prepare("SELECT group_concat(version) AS versions FROM schema_migrations").get() as { versions: string }).versions).toBe("1,2,3");
		database.close();
		const reopenedProvider = new LocalMemoryProvider(scope);
		const reopened = new MemoryService(scope, reopenedProvider);
		services.push(reopened);
		expect(await reopened.get(original.id)).toMatchObject({ category: "other", lifecycle: "active", useCount: 0, type: "episodic", scope: { kind: "task", id: "old-task" }, contentHash: "old-hash" });
	});

	it("keeps task duplicates within their source task and honors an explicit forget", async () => {
		const { service } = createStore();
		const input = { kind: "experience" as const, content: "The fixture is versioned", source: { type: "user" as const, ref: "task:a:experience:first" } };
		const first = await service.saveCandidate(input);
		expect((await service.saveCandidate(input)).id).toBe(first.id);
		const second = await service.saveCandidate({ ...input, source: { ...input.source, ref: "task:b:experience:first" } });
		expect(second.id).not.toBe(first.id);
		expect(classifyMemory(second)).toBe("task");
		await service.delete(first.id, first.revision);
		await expect(service.saveCandidate(input)).rejects.toThrow("explicitly forgotten");
		expect((await service.saveCandidate({ ...input, source: second.sources[0] })).id).toBe(second.id);
		const profile = await service.saveCandidate({
			kind: "fact", content: "Maintains the test fixtures", source: { type: "user", ref: "manual" }, metadata: { subjectKey: "profile:role" },
		});
		const preference = await service.saveCandidate({
			kind: "decision", content: "Show focused output first", source: { type: "user", ref: "manual" }, metadata: { category: "preference" },
		});
		expect(classifyMemory(profile)).toBe("profile");
		expect(classifyMemory(preference)).toBe("preference");
	});

	it("withdraws a disproved file fact and preserves versioned evidence of the correction", async () => {
		const { scope, service } = createStore();
		const file = join(scope.rootPath, "facts.txt");
		const old = "fixture uses version one";
		writeFileSync(file, old);
		const input = { kind: "fact" as const, content: old, source: { type: "file" as const, ref: "facts.txt" } };
		const candidate = await service.saveCandidate(input);
		const record = await service.verifyFileFact(candidate.id, { relativePath: "facts.txt", exactExcerpt: old }, candidate.revision);
		expect(classifyMemory(record)).toBe("long-term");
		expect(await service.reflectFileEvidence(record.id, record.revision)).toEqual(record);
		const updated = "fixture uses version two";
		writeFileSync(file, updated);
		const reflected = await service.reflectFileEvidence(record.id, record.revision);
		expect(reflected.status).toBe("stale");
		expect(reflected.verifications).toEqual(record.verifications);
		expect(await service.search({ text: old })).toEqual([]);
		expect((await service.saveCandidate(input)).status).toBe("stale");
		const other = new DatabaseSync(scope.databasePath);
		try {
			const audit = other.prepare("SELECT after_json FROM memory_governance_audit WHERE action='file_evidence_changed'").get() as { after_json: string };
			expect(JSON.parse(audit.after_json)).toEqual([{
				evidenceRef: "facts.txt", previousSha256: createHash("sha256").update(old).digest("hex"),
				observedSha256: createHash("sha256").update(updated).digest("hex"),
			}]);
		} finally {
			other.close();
		}
	});

	it("fills a bounded search after an invalidated file fact takes the first rank", async () => {
		const { scope, service } = createStore();
		const facts = [];
		for (const suffix of ["first", "second"]) {
			const relativePath = suffix + ".txt";
			const content = "lookup guard " + suffix;
			writeFileSync(join(scope.rootPath, relativePath), content);
			const candidate = await service.saveCandidate({ kind: "fact", content, source: { type: "file", ref: relativePath } });
			facts.push(await service.verifyFileFact(candidate.id, { relativePath, exactExcerpt: content }, candidate.revision));
		}
		const query = { text: "lookup guard", limit: 1 };
		const [first] = await service.search(query);
		expect(first).toBeDefined();
		writeFileSync(join(scope.rootPath, first.verifications[0].evidenceRef), "The old evidence no longer applies.");
		const current = facts.find(({ id }) => id !== first.id);
		expect(await service.getVerified(first.id)).toBeNull();
		expect((await service.search(query)).map(({ id }) => id)).toEqual([current?.id]);
	});

	it("archives reversibly, excludes archived records from default search/snapshots, and tracks usage without revision churn", async () => {
		const { provider, service } = createStore();
		const record = await verified(provider, "archive lifecycle fixture");
		await service.recordUsage(record.id);
		const used = await service.get(record.id);
		expect(used).toMatchObject({ revision: record.revision, useCount: 1 });
		const archived = await service.archive(record.id, record.revision);
		expect(archived).toMatchObject({ lifecycle: "archived", revision: record.revision + 1 });
		expect(await service.search({ text: "archive lifecycle" })).toEqual([]);
		expect((await service.listVerifiedSnapshot()).records).toEqual([]);
		expect((await service.list({ lifecycles: ["archived"] })).map(({ id }) => id)).toEqual([record.id]);
		const restored = await service.restore(record.id, archived.revision);
		expect((await service.search({ text: "archive lifecycle" })).map(({ id }) => id)).toEqual([restored.id]);
	});

	it("keeps expired records inspectable but out of default retrieval", async () => {
		const { provider, service } = createStore();
		const content = "expired environment fact";
		const normalized = content;
		const candidate = await provider.saveCandidate({
			kind: "fact",
			content,
			normalizedContent: normalized,
			contentHash: createHash("sha256").update(normalized).digest("hex"),
			source: { type: "test", ref: "expired", observedAt: Date.now() },
			metadata: { category: "environment", tags: [], importance: 1, validUntil: Date.now() - 1 },
			now: Date.now(),
		});
		await provider.setStatus({
			id: candidate.id, status: "verified", expectedRevision: candidate.revision, now: Date.now(),
			verification: { id: randomUUID(), type: "test_passed", evidenceRef: "fixture", evidenceVersion: "v1", verifiedAt: Date.now() },
		});
		expect(await service.search({ text: "expired environment" })).toEqual([]);
		expect((await service.list({ statuses: ["verified"] })).map(({ id }) => id)).toContain(candidate.id);
		expect((await service.doctor(governance)).expiredActiveIds).toContain(candidate.id);
	});

	it("blocks conflict consolidation and creates a traceable candidate for an approved compression", async () => {
		const { provider, service } = createStore();
		const first = await verified(provider, "Node runtime version is 20 for production", { subjectKey: "runtime.node", category: "environment" });
		const second = await verified(provider, "Node runtime version is 22 for production", { subjectKey: "runtime.node", category: "environment" });
		await verified(provider, "Tests require release gate approval before deployment", { category: "procedure" });
		await verified(provider, "Tests require release gate approval prior to deployment", { category: "procedure" });
		const plan = await service.planMaintenance(governance);
		expect(plan.report.conflictGroups).toContainEqual(expect.arrayContaining([first.id, second.id]));
		const conflict = plan.proposals.find((proposal) => proposal.action === "keep" && proposal.sourceIds.includes(first.id));
		expect(conflict?.justification).toContain("automatic consolidation is blocked");
		expect(plan.proposals.some((proposal) => (proposal.action === "merge" || proposal.action === "compress") && proposal.sourceIds.includes(first.id) && proposal.sourceIds.includes(second.id))).toBe(false);
		const compression = plan.proposals.find((proposal) => proposal.action === "compress");
		if (!compression) throw new Error("Expected a compression proposal");
		const applied = await service.applyMaintenanceProposal(compression.id);
		expect(applied.status).toBe("applied");
		const candidates = await service.search({ text: "release gate approval", statuses: ["candidate"] });
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ status: "candidate", lifecycle: "active" });
		expect(candidates[0]?.verifications).toEqual([]);
		expect((await service.inspect(candidates[0]!.id)).relations.filter((relation) => relation.relation === "derived_from")).toHaveLength(2);
		expect((await service.get(first.id))?.status).toBe("verified");
		expect((await service.get(second.id))?.status).toBe("verified");
	});

	it("uses proposal revisions as CAS and keeps different project scopes isolated", async () => {
		const first = createStore("first");
		const second = createStore("second");
		const source = await verified(first.provider, "old unused procedure for archive");
		const metadata = await first.service.updateMetadata(source.id, source.revision, { importance: 0 });
		const plan = await first.service.planMaintenance({ ...governance, archiveAfterDays: 1 });
		const proposal = plan.proposals.find((item) => item.sourceIds.includes(source.id));
		if (proposal) {
			await first.service.updateMetadata(source.id, metadata.revision, { category: "procedure" });
			await expect(first.service.applyMaintenanceProposal(proposal.id)).rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT" });
		}
		expect(await second.service.get(source.id)).toBeNull();
		expect(await second.service.getMaintenanceProposal(proposal?.id ?? "missing")).toBeNull();
	});

	it("allows batch delete preview but refuses to apply it", async () => {
		const { service } = createStore();
		const candidate = await service.saveCandidate({
			kind: "experience",
			content: "rejected archived cleanup preview",
			source: { type: "test", ref: "delete-preview" },
		});
		const rejected = await service.review(candidate.id, "reject", candidate.revision);
		await service.archive(rejected.id, rejected.revision);
		const plan = await service.planMaintenance(governance);
		const proposal = plan.proposals.find((item) => item.action === "delete");
		if (!proposal) throw new Error("Expected batch delete preview");
		await expect(service.applyMaintenanceProposal(proposal.id)).rejects.toMatchObject({
			code: "MEMORY_VALIDATION_ERROR",
		});
		expect(await service.get(candidate.id)).not.toBeNull();
	});
});
