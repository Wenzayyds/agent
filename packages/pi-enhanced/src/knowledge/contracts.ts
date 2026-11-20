export type DocumentMimeType =
	| "text/markdown"
	| "text/plain"
	| "text/html"
	| "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	| "application/pdf";

export type DocumentAccessPolicy = "local-only" | "allow-external";

export interface KnowledgeDocument {
	documentId: string;
	projectId: string;
	corpusId: string;
	title: string;
	sourcePath: string;
	mimeType: DocumentMimeType;
	contentHash: string;
	version: number;
	activeVersion?: number;
	status: "prepared" | "indexed" | "failed" | "deleted";
	createdAt: number;
	updatedAt: number;
	indexedAt?: number;
	accessPolicy: DocumentAccessPolicy;
}

export interface DocumentLocation {
	pageNumber?: number;
	lineStart?: number;
	lineEnd?: number;
}

export interface DocumentChunk extends DocumentLocation {
	chunkId: string;
	documentId: string;
	documentVersion: number;
	content: string;
	contentHash: string;
	headingPath: readonly string[];
	chunkIndex: number;
	previousChunkId?: string;
	nextChunkId?: string;
	parserVersion: string;
	chunkerVersion: string;
}

export interface DocumentBlock extends DocumentLocation {
	sectionIndex?: number;
	kind: "prose" | "code" | "table" | "list" | "literal";
	text: string;
	headingPath: readonly string[];
}

export interface ParsedDocument {
	title?: string;
	parserVersion: string;
	blocks: readonly DocumentBlock[];
	warnings: readonly string[];
}

export type DocumentErrorCode =
	| "index-busy"
	| "document-not-found"
	| "knowledge-disabled"
	| "invalid-parameter"
	| "invalid-path"
	| "source-unavailable"
	| "source-changed"
	| "unsupported-format"
	| "invalid-document"
	| "empty-document"
	| "ocr-required"
	| "limit-exceeded"
	| "parser-unavailable"
	| "parser-failed";

export class KnowledgeDocumentError extends Error {
	readonly code: DocumentErrorCode;

	constructor(code: DocumentErrorCode, message: string = code, options?: ErrorOptions) {
		super(message, options);
		this.name = "KnowledgeDocumentError";
		this.code = code;
	}
}
