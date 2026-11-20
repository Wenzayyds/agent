import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareKnowledgeDocument } from "../../src/knowledge/ingestion.ts";
import { parseDocument } from "../../src/knowledge/parsers.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";

const root = fileURLToPath(new URL("../fixtures/knowledge", import.meta.url));
const prepare = (source: string) => prepareKnowledgeDocument({
	root, source, version: 1, projectId: "fixture-project", corpusId: "fixtures",
});

describe.runIf(process.env.PI_ENHANCED_KNOWLEDGE_DOCLING === "1")("Knowledge with real offline Docling", () => {
	it("finds and reads indexed Markdown, TXT, HTML, DOCX and PDF", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-k9-formats-"));
		try {
			writeFileSync(join(workspace, "guide.md"), "# Guide\n\nMARKDOWN_71");
			writeFileSync(join(workspace, "notes.txt"), "TEXT_72");
			const rows = [
				["guide.md", "MARKDOWN_71"], ["notes.txt", "TEXT_72"], ["api.html", "AUTH_403"],
				["api.docx", "scope_id"], ["mixed.pdf", "POLICY_503"],
			];
			const service = new KnowledgeService({ projectId: "k9", filename: join(workspace, "test.sqlite3"), mode: "lexical" });
			try {
				for (const [file, term] of rows) {
					if (!file.endsWith(".md") && !file.endsWith(".txt")) cpSync(join(root, file), join(workspace, file));
					const { documentId } = await service.add(workspace, file, "formats", "allow-external");
					const scope = { audience: "agent", corpusId: "formats", documentId } as const;
					const { hits } = await service.search(term, scope);
					expect(hits[0]?.source).toBe(file);
					expect(service.read(hits[0].chunk.chunkId, scope).match.chunk.content).toContain(term);
				}
			} finally {
				await service.close();
			}
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
	it("keeps the HTML main content, code, table and titles", async () => {
		const { document, chunks } = await prepare("api.html");
		const body = chunks.map((chunk) => chunk.content).join("\n");
		expect(document.title).toBe("Keys reference");
		expect(chunks.map((chunk) => chunk.headingPath)).toContainEqual(["Keys API", "Parameters"]);
		expect(body).toContain("POST /v1/keys");
		expect(body).toContain("scope_id: workspace\nrotate: false");
		expect(body).toContain("AUTH_403");
		expect(body).not.toMatch(/Ignore navigation|Ignore footer|invalid\.example/);
		expect(chunks.every((chunk) => chunk.lineStart === undefined && chunk.pageNumber === undefined)).toBe(true);
	});

	it("retains DOCX headings and paragraphs with no inferred line or page number", async () => {
		const { document, chunks } = await prepare("api.docx");
		expect(document.title).toBe("API Contract");
		expect(chunks[0]).toMatchObject({ headingPath: ["API Contract"], content: "Call POST /v1/keys with scope_id." });
		expect(chunks[0].lineStart).toBeUndefined();
		expect(chunks[0].pageNumber).toBeUndefined();
	});

	it("returns the PDF text layer with original page numbers and explicit layout loss", async () => {
		const { chunks, warnings } = await prepare("mixed.pdf");
		expect(chunks[0]).toMatchObject({ pageNumber: 2, content: "POLICY_503: retry with backoff" });
		expect(chunks[0].lineStart).toBeUndefined();
		expect(warnings).toEqual(["pdf-layout-not-reconstructed", "page-has-no-text:1"]);
	});

	it("classifies a PDF with no text layer and corrupt binary documents", async () => {
		await expect(prepare("no-text.pdf")).rejects.toMatchObject({ code: "ocr-required" });
		await expect(parseDocument(Buffer.from("not pdf"), "application/pdf")).rejects.toMatchObject({ code: "invalid-document" });
		await expect(parseDocument(Buffer.from("not docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
			.rejects.toMatchObject({ code: "invalid-document" });
	});
});
