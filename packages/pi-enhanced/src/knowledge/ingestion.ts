import { basename, extname } from "node:path";
import { chunkDocument, documentHash } from "./chunking.ts";
import {
	type DocumentAccessPolicy,
	type DocumentChunk,
	type KnowledgeDocument,
	KnowledgeDocumentError,
} from "./contracts.ts";
import { parseDocument } from "./parsers.ts";
import { readDocumentSource } from "./sources.ts";

export interface DocumentPreparation {
	root: string;
	source: string;
	projectId: string;
	corpusId: string;
	version: number;
	accessPolicy?: DocumentAccessPolicy;
}

export interface PreparedDocument {
	document: KnowledgeDocument;
	chunks: DocumentChunk[];
	warnings: readonly string[];
}

export async function prepareKnowledgeDocument(options: DocumentPreparation): Promise<PreparedDocument> {
	return prepareDocumentBytes(options, await readDocumentSource(options.root, options.source));
}

export function documentIdentity(projectId: string, corpusId: string, canonicalPath: string): string {
	const pathIdentity = process.platform === "win32" ? canonicalPath.toLocaleLowerCase("en-US") : canonicalPath;
	return documentHash(JSON.stringify([projectId, corpusId, pathIdentity]));
}

export async function prepareDocumentBytes(
	options: DocumentPreparation,
	input: Awaited<ReturnType<typeof readDocumentSource>>,
): Promise<PreparedDocument> {
	const { projectId, corpusId, version, accessPolicy = "local-only" } = options;
	if (
		!projectId ||
		!corpusId ||
		!Number.isSafeInteger(version) ||
		version < 1 ||
		(accessPolicy !== "local-only" && accessPolicy !== "allow-external")
	)
		throw new TypeError("Invalid document scope, version or access policy");
	const { sourcePath, mimeType, bytes } = input;
	const documentId = documentIdentity(projectId, corpusId, sourcePath);
	const contentHash = documentHash(bytes);
	const parsed = await parseDocument(bytes, mimeType);
	const chunks = chunkDocument(documentId, version, parsed);
	if (!chunks.length) throw new KnowledgeDocumentError("empty-document");
	const now = Date.now();
	const document: KnowledgeDocument = {
		documentId,
		projectId,
		corpusId,
		title: (parsed.title || basename(sourcePath, extname(sourcePath))).slice(0, 1_000),
		sourcePath,
		mimeType,
		contentHash,
		version,
		status: "prepared",
		createdAt: now,
		updatedAt: now,
		accessPolicy,
	};
	return { document, chunks, warnings: parsed.warnings };
}
