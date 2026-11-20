import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareKnowledgeDocument } from "../../src/knowledge/ingestion.ts";
import { discoverDocumentSources, MAX_DOCUMENT_BYTES } from "../../src/knowledge/sources.ts";

let base: string;
let root: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "pi-knowledge-ingest-"));
	root = join(base, "knowledge");
	mkdirSync(root);
});

afterEach(() => rmSync(base, { force: true, recursive: true }));

function prepare(source: string, version = 1, corpusId = "engineering") {
	return prepareKnowledgeDocument({ root, source, projectId: "test-project", corpusId, version });
}

describe("Knowledge host import scope", () => {
	it("selects one file or an explicit directory and only walks nested folders on request", async () => {
		mkdirSync(join(root, "api", "internal"), { recursive: true });
		writeFileSync(join(root, "architecture.txt"), "Use the gateway.");
		writeFileSync(join(root, "api", "public.md"), "# API\n\nGET /v1/keys");
		writeFileSync(join(root, "api", "internal", "admin.md"), "# Admin\n\nGET /v1/admin");
		writeFileSync(join(root, "api", "data.json"), "{}");
		await expect(discoverDocumentSources(root, "architecture.txt")).resolves.toEqual(["architecture.txt"]);
		await expect(discoverDocumentSources(root, "api")).resolves.toEqual(["api/public.md"]);
		await expect(discoverDocumentSources(root, "api", { recursive: true })).resolves.toEqual([
			"api/internal/admin.md", "api/public.md",
		]);
	});

	it.each(["../external.md", "/external.md", "api/../external.md", "file.txt:secret", "api//keys.md"])(
		"rejects an invalid source %s",
		async (source) => {
			await expect(prepare(source)).rejects.toMatchObject({ code: "invalid-path" });
		},
	);

	it("rejects links to content outside the explicit scope", async () => {
		const external = join(base, "external");
		mkdirSync(external);
		writeFileSync(join(external, "secret.md"), "Outside the authorized directory");
		symlinkSync(external, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
		linkSync(join(external, "secret.md"), join(root, "linked.md"));
		await expect(discoverDocumentSources(root, "alias")).rejects.toMatchObject({ code: "invalid-path" });
		await expect(prepare("alias/secret.md")).rejects.toMatchObject({ code: "invalid-path" });
		await expect(prepare("linked.md")).rejects.toMatchObject({ code: "invalid-path" });
		await expect(prepareKnowledgeDocument({
			root: join(root, "alias"), source: "secret.md", projectId: "project", corpusId: "corpus", version: 1,
		})).rejects.toMatchObject({ code: "invalid-path" });
	});

	it("rejects unsupported, missing, corrupt, empty and oversized files", async () => {
		writeFileSync(join(root, "bundle.zip"), "Unsupported");
		writeFileSync(join(root, "bad.md"), Buffer.from([0xff, 0xff]));
		writeFileSync(join(root, "empty.txt"), "  \n\t");
		writeFileSync(join(root, "large.md"), "");
		truncateSync(join(root, "large.md"), MAX_DOCUMENT_BYTES + 1);
		await expect(prepare("bundle.zip")).rejects.toMatchObject({ code: "unsupported-format" });
		await expect(prepare("missing.md")).rejects.toMatchObject({ code: "source-unavailable" });
		await expect(prepare("bad.md")).rejects.toMatchObject({ code: "invalid-document" });
		await expect(prepare("empty.txt")).rejects.toMatchObject({ code: "empty-document" });
		await expect(prepare("large.md")).rejects.toMatchObject({ code: "limit-exceeded" });
	});

	it("bounds recursive traversal", async () => {
		mkdirSync(join(root, "a/b/c/d/e/f/g"), { recursive: true });
		await expect(discoverDocumentSources(root, ".")).resolves.toEqual([]);
		await expect(discoverDocumentSources(root, ".", { recursive: true })).rejects.toMatchObject({ code: "limit-exceeded" });
	});

	it("derives stable scoped document IDs and exact byte hashes for future duplicate checks", async () => {
		const file = join(root, "api.md");
		const raw = Buffer.from("# API\r\n\r\nGET /v1/keys");
		writeFileSync(file, raw);
		const initial = await prepare("api.md");
		expect(initial.document).toMatchObject({
			contentHash: createHash("sha256").update(raw).digest("hex"),
			sourcePath: file,
			accessPolicy: "local-only",
			status: "prepared",
		});
		expect((await prepare("api.md")).chunks).toEqual(initial.chunks);
		expect((await prepare("api.md", 1, "other")).document.documentId).not.toBe(initial.document.documentId);
		writeFileSync(file, "# API\n\nPOST /v1/keys");
		const updated = await prepare("api.md", 2);
		expect(updated.document.documentId).toBe(initial.document.documentId);
		expect(updated.document.contentHash).not.toBe(initial.document.contentHash);
		expect(updated.chunks[0].documentVersion).toBe(2);
		expect(updated.chunks[0].chunkId).not.toBe(initial.chunks[0].chunkId);
	});
});

describe("Knowledge document structure", () => {
	it("preserves nested headings, API parameters, code, error tables, and adjacent source links", async () => {
		const code = ["```yaml", "scope_id: workspace", "# literal comment", "rotate: false", "```"].join("\n");
		const table = ["| code | meaning |", "|---|---|", "| AUTH_403 | Missing scope |"].join("\n");
		writeFileSync(join(root, "api.md"), [
			"# Keys API", "", "## Create a key", "", "POST /v1/keys accepts `scope_id`.", "",
			code, "", "## Errors", "", table, "", "## 排查", "", "检查配置字段 `scope_id`。",
		].join("\r\n"));
		const { chunks, document } = await prepare("api.md");
		expect(document.title).toBe("Keys API");
		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toMatchObject({
			headingPath: ["Keys API", "Create a key"], lineStart: 5, lineEnd: 11, nextChunkId: chunks[1].chunkId,
		});
		expect(chunks[0].content).toContain("POST /v1/keys accepts `scope_id`.");
		expect(chunks[0].content).toContain(code);
		expect(chunks[1]).toMatchObject({
			content: table, headingPath: ["Keys API", "Errors"], previousChunkId: chunks[0].chunkId,
			nextChunkId: chunks[2].chunkId, lineStart: 15, lineEnd: 17,
		});
		expect(chunks[2].headingPath).toEqual(["Keys API", "排查"]);
		expect(chunks[2].nextChunkId).toBeUndefined();
	});

	it("splits a long TXT paragraph, keeping each original line in the result", async () => {
		const lines = Array.from({ length: 300 }, (_, n) => `${n % 2 ? "  " : ""}GET /v1/keys?key=${n} scope_id 认证流程`);
		writeFileSync(join(root, "api.txt"), lines.join("\r\n"));
		const { chunks } = await prepare("api.txt");
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.content).toBe(lines.slice(chunk.lineStart! - 1, chunk.lineEnd).join("\n"));
			expect(chunk.content.length).toBeLessThanOrEqual(3_000);
			expect(chunk.pageNumber).toBeUndefined();
		}
		expect(chunks.map((chunk) => chunk.content).join("\n")).toBe(lines.join("\n"));
	});

	it("keeps repeated headings in separate source sections", async () => {
		writeFileSync(join(root, "api.md"), "# API\n\n## Errors\n\nFirst group\n\n## Errors\n\nSecond group");
		const { chunks } = await prepare("api.md");
		expect(chunks.map((chunk) => ({ headingPath: chunk.headingPath, line: chunk.lineStart }))).toEqual([
			{ headingPath: ["API", "Errors"], line: 5 },
			{ headingPath: ["API", "Errors"], line: 9 },
		]);
	});

	it("reports too many chunks and oversized indivisible code blocks", async () => {
		writeFileSync(join(root, "api.md"), Array.from({ length: 801 }, (_, n) => `# Section ${n}\n\ntext\n\n`).join(""));
		await expect(prepare("api.md")).rejects.toMatchObject({ code: "limit-exceeded", message: "Too many document chunks" });
		writeFileSync(join(root, "api.md"), `\`\`\`yaml\n${"scope_id: workspace\n".repeat(150)}\`\`\``);
		await expect(prepare("api.md")).rejects.toMatchObject({ code: "limit-exceeded", message: expect.stringContaining("code") });
	});
});
