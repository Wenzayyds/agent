import type { EmbeddingModel } from "../shared/embedding/e5.ts";
import { QdrantIndex } from "../shared/vector/qdrant.ts";
import { documentHash } from "./chunking.ts";
import type { DocumentAccessPolicy, DocumentChunk, KnowledgeDocument } from "./contracts.ts";

export const KNOWLEDGE_COLLECTION = "pi_enhanced_docs_v1";

export interface DocumentVectorPayload {
	schemaVersion: 1;
	chunkId: string;
	documentId: string;
	documentVersion: number;
	projectId: string;
	corpusId: string;
	contentHash: string;
	embeddingModelId: string;
	accessPolicy: DocumentAccessPolicy;
}

export function openDocumentIndex(endpoint: string, model: EmbeddingModel, collectionName = KNOWLEDGE_COLLECTION) {
	return new QdrantIndex<DocumentVectorPayload>({
		endpoint,
		collectionName,
		dimensions: model.dimensions,
		timeoutMs: 3_000,
		payloadIndexes: {
			projectId: "keyword",
			corpusId: "keyword",
			documentId: "keyword",
			embeddingModelId: "keyword",
			accessPolicy: "keyword",
		},
		parsePayload(value) {
			const v = value as Partial<DocumentVectorPayload> | null;
			if (
				v?.schemaVersion !== 1 ||
				typeof v.chunkId !== "string" ||
				typeof v.documentId !== "string" ||
				typeof v.documentVersion !== "number" ||
				!Number.isSafeInteger(v.documentVersion) ||
				typeof v.projectId !== "string" ||
				typeof v.corpusId !== "string" ||
				typeof v.contentHash !== "string" ||
				typeof v.embeddingModelId !== "string" ||
				(v.accessPolicy !== "allow-external" && v.accessPolicy !== "local-only")
			) {
				throw new TypeError("Invalid Knowledge point payload");
			}
			return {
				schemaVersion: 1,
				chunkId: v.chunkId,
				documentId: v.documentId,
				documentVersion: v.documentVersion,
				projectId: v.projectId,
				corpusId: v.corpusId,
				contentHash: v.contentHash,
				embeddingModelId: v.embeddingModelId,
				accessPolicy: v.accessPolicy,
			};
		},
	});
}

export function embeddingModelKey(model: EmbeddingModel): string {
	return JSON.stringify([model.id, model.revision, model.dimensions]);
}

export function documentPointId(chunkId: string, modelKey: string): string {
	const hash = documentHash(JSON.stringify([chunkId, modelKey]));
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function pointMetadata(
	document: KnowledgeDocument,
	chunk: DocumentChunk,
	modelKey: string,
): DocumentVectorPayload {
	return {
		schemaVersion: 1,
		chunkId: chunk.chunkId,
		documentId: document.documentId,
		documentVersion: document.version,
		projectId: document.projectId,
		corpusId: document.corpusId,
		contentHash: chunk.contentHash,
		embeddingModelId: modelKey,
		accessPolicy: document.accessPolicy,
	};
}
