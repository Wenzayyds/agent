import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { searchMemoryReferences } from "../../src/memory/reference-search.ts";
import { openMemoryService } from "../../src/memory/service.ts";

describe("Memory reference query fallback", () => {
	it("reproduces long-query FTS misses and retries a code identifier without exposing candidates", async () => {
		const root = mkdtempSync(join(tmpdir(), "memory-query-"));
		const service = await openMemoryService(createProjectScope({ cwd: root, agentDir: join(root, "agent") }));
		try {
			const candidate = await service.saveCandidate({ kind: "experience", content: "normalizeKey must trim and lowercase", source: { type: "test", ref: "offline fixture" } });
			const query = "修复 normalizeKey 保留公开 API，不修改测试。任务计划 ID 为 abcdef。";
			const search = (text: string) => service.search({ text, statuses: ["verified"] });
			expect((await searchMemoryReferences(query, search)).records).toEqual([]);
			await service.provider.setStatus({ id: candidate.id, status: "verified", expectedRevision: candidate.revision, now: Date.now(), verification: { id: "offline-verification", type: "test_passed", evidenceRef: "fixture", evidenceVersion: "v1", verifiedAt: Date.now() } });
			expect(await search(query)).toEqual([]);
			const result = await searchMemoryReferences(query, search);
			expect(result.strategy).toBe("code-identifier");
			expect(result.queries).toEqual([query, "normalizeKey"]);
			expect(result.records.map((record) => record.id)).toEqual([candidate.id]);
			await service.archive(candidate.id, result.records[0]!.revision);
			expect((await searchMemoryReferences(query, search)).records).toEqual([]);
		} finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
	});

	it("retries short phrases only when enabled and leaves caller filters intact", async () => {
		const root = mkdtempSync(join(tmpdir(), "memory-query-"));
		const service = await openMemoryService(createProjectScope({ cwd: root, agentDir: join(root, "agent") }));
		try {
			const candidate = await service.saveCandidate({
				kind: "fact", type: "semantic", content: "Export contract version uses UTC",
				source: { type: "test", ref: "offline fixture" },
			});
			const query = "find verified project Export contract version";
			const search = (text: string) => service.search({ text, statuses: ["verified"], types: ["semantic"] });
			expect((await searchMemoryReferences(query, search, true)).records).toEqual([]);
			await service.provider.setStatus({
				id: candidate.id, status: "verified", expectedRevision: candidate.revision, now: Date.now(),
				verification: { id: "offline-phrase", type: "test_passed", evidenceRef: "fixture", evidenceVersion: "v1", verifiedAt: Date.now() },
			});
			expect((await searchMemoryReferences(query, search)).records).toEqual([]);
			const result = await searchMemoryReferences(query, search, true);
			expect(result.strategy).toBe("phrase");
			expect(result.queries).toEqual([query, "Export contract version"]);
			expect(result.records.map(({ id }) => id)).toEqual([candidate.id]);
			const wrongType = (text: string) => service.search({ text, statuses: ["verified"], types: ["working"] });
			expect((await searchMemoryReferences(query, wrongType, true)).records).toEqual([]);
			await service.archive(candidate.id, result.records[0]!.revision);
			expect((await searchMemoryReferences(query, search, true)).records).toEqual([]);
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
