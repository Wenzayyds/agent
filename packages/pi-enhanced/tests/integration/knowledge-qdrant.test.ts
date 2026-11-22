import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

it.runIf(process.env.PI_ENHANCED_KNOWLEDGE_QDRANT === "1")("reranks only authorized candidates and refilters after concurrent revocation", async () => {
	const root = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-knowledge-rerank-"));
	const lab = await startVectorLab();
	const filename = join(root, "docs.sqlite3");
	const options = {
		projectId: "rerank", filename, mode: "hybrid" as const,
		vectors: { collection: lab.collection, embedding: lab.embedding, index: openDocumentIndex(lab.endpoint, lab.embedding.model, lab.collection) },
	};
	const scope = { audience: "agent", corpusId: "release" } as const;
	const unranked = new KnowledgeService(options);
	let callback: (query: string, passages: readonly string[]) => Promise<readonly number[]> =
		async (_query, passages) => passages.map((text) => Number(text.includes("BETA_APPROVER")));
	const ranked = new KnowledgeService({ ...options, reranker: { rank: (...args) => callback(...args) } });
	try {
		const fixtures = [
			["alpha.md", "release", "ALPHA_APPROVER", "allow-external"],
			["beta.md", "release", "BETA_APPROVER", "allow-external"],
			["hidden.md", "release", "PRIVATE_APPROVER", "local-only"],
			["outside.md", "outside", "OTHER_CORPUS", "allow-external"],
		] as const;
		for (const [file, corpus, marker, policy] of fixtures) {
			writeFileSync(join(root, file), "The deployment approval process is defined by " + marker + ".");
			await unranked.add(root, file, corpus, policy);
		}
		const query = "deployment approval process";
		const base = await unranked.search(query, scope);
		expect(base.hits.map(({ source }) => source).sort()).toEqual(["alpha.md", "beta.md"]);
		const preferred = await ranked.search(query, scope);
		expect(preferred.rerank).toBe("applied");
		expect(preferred.hits[0]?.source).toBe("beta.md");
		callback = async () => { throw new Error("simulated timeout"); };
		expect(await ranked.search(query, scope)).toEqual({ ...base, rerank: "fallback" });
		callback = async () => [Number.NaN];
		expect(await ranked.search(query, scope)).toEqual({ ...base, rerank: "fallback" });
		let ready!: () => void;
		let resume!: () => void;
		const started = new Promise<void>((resolve) => { ready = resolve; });
		const continued = new Promise<void>((resolve) => { resume = resolve; });
		callback = async (_query, passages) => {
			ready();
			await continued;
			expect(passages.join("\n")).not.toMatch(/PRIVATE_APPROVER|OTHER_CORPUS/u);
			return passages.map((text) => Number(text.includes("BETA_APPROVER")));
		};
		const inFlight = ranked.search(query, scope);
		try {
			await started;
			expect((await ranked.search(query, scope)).rerank).toBe("fallback");
			await unranked.add(root, "beta.md", "release", "local-only");
		} finally { resume(); }
		const revised = await inFlight;
		expect(revised.rerank).toBe("applied");
		expect(revised.hits.map(({ source }) => source)).toEqual(["alpha.md"]);
		expect(() => ranked.read(preferred.hits[0]!.chunk.chunkId, scope)).toThrow("document-not-found");
	} finally {
		try { await Promise.all([ranked.close(), unranked.close()]); }
		finally { await lab.close(); rmSync(root, { recursive: true, force: true }); }
	}
}, 90_000);
