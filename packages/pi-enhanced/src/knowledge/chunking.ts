import { createHash } from "node:crypto";
import { type DocumentBlock, type DocumentChunk, KnowledgeDocumentError, type ParsedDocument } from "./contracts.ts";

const CHUNKER_VERSION = "structured-v1";
const TARGET_TOKENS = 400;
const MAX_TOKENS = 600;
const MAX_CHUNK_CHARACTERS = 3_000;
const MAX_CHUNKS = 800;
const tokenEstimate = /[a-zA-Z\d_]{1,4}|[^\s]/gu;

export function documentHash(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export function chunkDocument(documentId: string, documentVersion: number, parsed: ParsedDocument): DocumentChunk[] {
	const chunks: DocumentChunk[] = [];
	let pending: DocumentBlock | undefined;
	const flush = () => {
		if (!pending) return;
		if (chunks.length >= MAX_CHUNKS) throw new KnowledgeDocumentError("limit-exceeded", "Too many document chunks");
		const chunkIndex = chunks.length;
		const contentHash = documentHash(pending.text);
		const chunkId = documentHash(
			JSON.stringify([documentId, documentVersion, parsed.parserVersion, CHUNKER_VERSION, chunkIndex, contentHash]),
		);
		const previous = chunks.at(-1);
		if (previous) previous.nextChunkId = chunkId;
		chunks.push({
			chunkId,
			documentId,
			documentVersion,
			content: pending.text,
			contentHash,
			headingPath: pending.headingPath,
			chunkIndex,
			previousChunkId: previous?.chunkId,
			parserVersion: parsed.parserVersion,
			chunkerVersion: CHUNKER_VERSION,
			pageNumber: pending.pageNumber,
			lineStart: pending.lineStart,
			lineEnd: pending.lineEnd,
		});
		pending = undefined;
	};

	for (const block of parsed.blocks) {
		const headingTokens = estimateTokens(block.headingPath.join("\n"), MAX_TOKENS);
		if (headingTokens >= MAX_TOKENS) throw new KnowledgeDocumentError("limit-exceeded", "Heading path is too long");
		const target = Math.max(1, TARGET_TOKENS - headingTokens);
		const maximum = MAX_TOKENS - headingTokens;
		for (const part of splitBlock(block, target, maximum)) {
			if (pending && sameSection(pending, part) && fits(`${pending.text}\n\n${part.text}`, target)) {
				pending = { ...pending, text: `${pending.text}\n\n${part.text}`, lineEnd: part.lineEnd };
				continue;
			}
			flush();
			pending = part;
		}
	}
	flush();
	return chunks;
}

function sameSection(left: DocumentBlock, right: DocumentBlock): boolean {
	return (
		left.pageNumber === right.pageNumber &&
		left.sectionIndex === right.sectionIndex &&
		left.headingPath.length === right.headingPath.length &&
		left.headingPath.every((heading, index) => heading === right.headingPath[index])
	);
}

function fits(text: string, tokens: number): boolean {
	return text.length <= MAX_CHUNK_CHARACTERS && estimateTokens(text, tokens) <= tokens;
}

function estimateTokens(text: string, limit: number): number {
	let count = 0;
	for (const _ of text.matchAll(tokenEstimate)) {
		if (++count > limit) break;
	}
	return count;
}

function* splitBlock(block: DocumentBlock, target: number, maximum: number): Iterable<DocumentBlock> {
	if (fits(block.text, block.kind === "prose" ? target : maximum)) {
		yield block;
		return;
	}
	if (block.kind !== "prose") {
		throw new KnowledgeDocumentError("limit-exceeded", `Document ${block.kind} block exceeds the chunk limit`);
	}

	let remaining = block.text;
	let sourceLine = block.lineStart;
	while (remaining) {
		let end = remaining.length;
		let previousTokenEnd = 0;
		let lastBoundary = 0;
		let lastLineBoundary = 0;
		let count = 0;
		for (const token of remaining.matchAll(tokenEstimate)) {
			const index = token.index;
			if (index > previousTokenEnd && index <= MAX_CHUNK_CHARACTERS) {
				lastBoundary = index;
				const newline = remaining.slice(previousTokenEnd, index).lastIndexOf("\n");
				if (newline !== -1) lastLineBoundary = previousTokenEnd + newline + 1;
			}
			if (++count > target || index + token[0].length > MAX_CHUNK_CHARACTERS) {
				end = lastLineBoundary || lastBoundary || previousTokenEnd;
				// Long indentation can exceed the character limit before the first token.
				if (!end) end = Math.min(index || token[0].length, MAX_CHUNK_CHARACTERS);
				break;
			}
			previousTokenEnd = index + token[0].length;
		}
		const consumed = remaining.slice(0, end);
		const text = consumed.trimEnd();
		remaining = remaining.slice(end);
		if (text.trim()) {
			yield {
				...block,
				text,
				lineStart: sourceLine,
				lineEnd: sourceLine === undefined ? undefined : sourceLine + countLineBreaks(text),
			};
		}
		if (sourceLine !== undefined) {
			sourceLine += countLineBreaks(consumed);
		}
	}
}

function countLineBreaks(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
	return count;
}
