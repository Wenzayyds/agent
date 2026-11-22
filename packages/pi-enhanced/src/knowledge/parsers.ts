import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	type DocumentErrorCode,
	type DocumentMimeType,
	KnowledgeDocumentError,
	type ParsedDocument,
} from "./contracts.ts";
import { parseMarkdownText, parsePlainText } from "./markdown.ts";
import { MAX_DOCUMENT_BYTES } from "./sources.ts";

const PARSER_IMAGE = "pi-enhanced-knowledge-parser:2.92.0";
const DOCLING_VERSION = "docling-2.92.0/core-2.107.1/knowledge-v1";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024 + 256;
const MAX_PDF_PAGES = 300;

export async function parseDocument(bytes: Buffer, mimeType: DocumentMimeType): Promise<ParsedDocument> {
	if (bytes.length > MAX_DOCUMENT_BYTES) throw new KnowledgeDocumentError("limit-exceeded");
	if (mimeType === "text/markdown") {
		return {
			...parseMarkdownText(decodeText(bytes), true),
			parserVersion: "marked-18.0.11/knowledge-v1",
			warnings: [],
		};
	}
	if (mimeType === "text/plain") {
		return {
			blocks: parsePlainText(decodeText(bytes), { sourceLines: true }),
			parserVersion: "utf8-text-v1",
			warnings: [],
		};
	}
	const kind = mimeType === "application/pdf" ? "pdf" : mimeType === "text/html" ? "html" : "docx";
	const result = await runDocling(kind, bytes);
	if (!Array.isArray(result.warnings) || !result.warnings.every((warning) => typeof warning === "string")) {
		throw new KnowledgeDocumentError("parser-failed");
	}
	if (kind !== "pdf") {
		if (typeof result.markdown !== "string" || (result.title !== null && typeof result.title !== "string")) {
			throw new KnowledgeDocumentError("parser-failed");
		}
		const parsed = parseMarkdownText(result.markdown, false);
		return {
			blocks: parsed.blocks,
			title: result.title?.trim() || parsed.title,
			parserVersion: DOCLING_VERSION,
			warnings: result.warnings,
		};
	}
	if (!Array.isArray(result.pages) || result.pages.length > MAX_PDF_PAGES) {
		throw new KnowledgeDocumentError("parser-failed");
	}
	let previousPage = 0;
	const blocks = result.pages.flatMap((page: unknown) => {
		if (
			!isRecord(page) ||
			typeof page.text !== "string" ||
			typeof page.pageNumber !== "number" ||
			!Number.isInteger(page.pageNumber) ||
			page.pageNumber <= previousPage ||
			page.pageNumber > MAX_PDF_PAGES
		) {
			throw new KnowledgeDocumentError("parser-failed");
		}
		previousPage = page.pageNumber;
		return parsePlainText(page.text, { pageNumber: page.pageNumber });
	});
	return { blocks, parserVersion: DOCLING_VERSION, warnings: result.warnings };
}

function decodeText(bytes: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new KnowledgeDocumentError("invalid-document", "Plain text documents must be valid UTF-8");
	}
}

const workerErrors = new Set<DocumentErrorCode>([
	"limit-exceeded",
	"invalid-document",
	"unsupported-format",
	"ocr-required",
	"parser-unavailable",
]);

async function runDocling(kind: "html" | "docx" | "pdf", bytes: Buffer): Promise<Record<string, unknown>> {
	const name = `pi-knowledge-parser-${randomUUID()}`;
	const output = await new Promise<string>((resolve, reject) => {
		const child = execFile(
			"docker",
			[
				"run",
				"--rm",
				"-i",
				"--name",
				name,
				"--pull=never",
				"--network=none",
				"--read-only",
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,nodev,size=32m",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--user=65534:65534",
				"--memory=768m",
				"--memory-swap=768m",
				"--cpus=1",
				"--pids-limit=64",
				"--log-driver=none",
				PARSER_IMAGE,
				kind,
			],
			{ encoding: "utf8", windowsHide: true, timeout: 25_000, maxBuffer: MAX_OUTPUT_BYTES },
			(error, stdout) => {
				if (!error) {
					resolve(stdout);
					return;
				}
				const unavailable = error.code === "ENOENT" || error.code === 125;
				const failure = new KnowledgeDocumentError(
					unavailable ? "parser-unavailable" : "parser-failed",
					unavailable
						? "Docling parser requires Docker and the local Knowledge parser image"
						: "Docling parser failed",
				);
				if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					// Terminating the CLI does not terminate its Docker container.
					execFile("docker", ["rm", "-f", name], { timeout: 5_000, windowsHide: true }, () => reject(failure));
				} else {
					reject(failure);
				}
			},
		);
		child.stdin?.on("error", () => {
			// The process reports an early exit through the execFile callback.
		});
		child.stdin?.end(bytes);
	});
	let frame: unknown;
	try {
		frame = JSON.parse(output);
	} catch {
		throw new KnowledgeDocumentError("parser-failed");
	}
	if (!isRecord(frame)) throw new KnowledgeDocumentError("parser-failed");
	if (typeof frame.error === "string" && workerErrors.has(frame.error as DocumentErrorCode)) {
		throw new KnowledgeDocumentError(frame.error as DocumentErrorCode);
	}
	if (!isRecord(frame.result)) throw new KnowledgeDocumentError("parser-failed");
	return frame.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
