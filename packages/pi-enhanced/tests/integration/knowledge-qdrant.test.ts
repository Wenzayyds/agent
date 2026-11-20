import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startVectorLab } from "../../fixtures/knowledge/vector-lab.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import { openDocumentIndex } from "../../src/knowledge/vector.ts";

it.runIf(process.env.PI_ENHANCED_KNOWLEDGE_QDRANT === "1")("indexes, filters and repairs real Qdrant with an offline E5 worker", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-knowledge-qdrant-"));
	const lab = await startVectorLab();
	const index = openDocumentIndex(lab.endpoint, lab.embedding.model, lab.collection);
	const vectors = { ...lab, index };
	const open = (projectId: string) => new KnowledgeService({
		projectId, filename: join(root, `${projectId}.sqlite3`), mode: "hybrid", vectors: {
			collection: vectors.collection, embedding: vectors.embedding, index,
		},
	});
	const main = open("main");
	const other = open("other");
	const scope = { audience: "agent" } as const;
	try {
		const file = join(root, "release.md");
		writeFileSync(file, "# 发布规范\n\n生产环境部署之前必须取得人工审批。启动后运行 release_health 命令确认状态。");
		writeFileSync(join(root, "secret.md"), "# 私有发布\n\nSECRET_DEPLOY_KEY 审批规则。");
		const { documentId } = await main.add(root, "release.md", "release", "allow-external");
		await main.add(root, "secret.md", "release");
		await other.add(root, "release.md", "release", "allow-external");
		expect(lab.workerNetwork()).toBe("none");
		const dense = await main.search("Who approves a production rollout?", scope, 5, "semantic");
		expect(dense.mode).toBe("semantic");
		expect(dense.hits.map(({ document }) => document.documentId)).toEqual([documentId]);
		const oldChunk = dense.hits[0].chunk.chunkId;
		expect(await main.search("SECRET_DEPLOY_KEY", scope, 5, "lexical")).toMatchObject({ hits: [] });

		await lab.stopQdrant();
		expect(await main.search("release_health", scope)).toMatchObject({ mode: "lexical", fallback: "qdrant-unavailable" });
		writeFileSync(file, "# 发布规范\n\n生产部署采用 release_status_v2 查询结果。");
		await expect(main.add(root, "release.md", "release", "allow-external")).rejects.toMatchObject({ code: "qdrant-unavailable" });
		expect(main.list("release").find((item) => item.id === documentId)).toMatchObject({ activeVersion: 1, pendingVersion: 2 });
		await lab.restartQdrant();
		await expect(main.sync(documentId)).resolves.toEqual([{ documentId, outcome: "retried" }]);
		const fresh = await main.search("release_status_v2", scope);
		expect(fresh.hits[0].chunk.documentVersion).toBe(2);
		expect(() => main.read(oldChunk, scope)).toThrow("document-not-found");
		await main.sync(documentId, true);
		const dropped = await fetch(`${lab.endpoint}/collections/${lab.collection}`, { method: "DELETE" });
		expect(dropped.ok).toBe(true);
		expect((await main.maintain()).repaired).toBe(2);
		expect((await other.maintain()).repaired).toBe(1);
		expect((await main.search("release_status_v2", scope, 1, "semantic")).hits).toHaveLength(1);
		await main.remove(documentId);
		await main.maintain();
		expect((await main.search("release_status_v2", scope)).hits).toEqual([]);
		expect((await index.scroll()).points.every(({ payload }) => payload.documentId !== documentId)).toBe(true);
		expect((await other.search("release_health", scope, 5, "semantic")).hits).toHaveLength(1);
	} finally {
		try {
			await Promise.all([main.close(), other.close()]);
		} finally {
			await lab.close();
			rmSync(root, { recursive: true, force: true });
		}
	}
}, 90_000);
