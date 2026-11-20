import { Marked, type Tokens } from "marked";
import { type DocumentBlock, KnowledgeDocumentError } from "./contracts.ts";

const markdown = new Marked({ gfm: true });
const MAX_LINES = 30_000;
const MAX_HEADING_CHARACTERS = 1_000;

export function normalizeDocumentText(input: string): string {
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(input)) throw new KnowledgeDocumentError("invalid-document");
	const text = input.replace(/\r\n?/gu, "\n");
	let lines = 1;
	for (const _ of text.matchAll(/\n/gu)) {
		if (++lines > MAX_LINES) throw new KnowledgeDocumentError("limit-exceeded", "Too many lines");
	}
	return text;
}

export function parseMarkdownText(input: string, sourceLines: boolean): { blocks: DocumentBlock[]; title?: string } {
	const text = normalizeDocumentText(input);
	const blocks: DocumentBlock[] = [];
	const headings: { level: number; text: string }[] = [];
	let firstHeading: DocumentBlock | undefined;
	let sectionIndex = 0;
	let line = 1;
	let offset = 0;
	for (const token of markdown.lexer(text)) {
		const raw = token.raw;
		const content = raw.trimEnd();
		const lineStart = line;
		line += countNewlines(raw);
		const location = sourceLines ? { lineStart, lineEnd: lineStart + countNewlines(content) } : {};
		// Marked can adjust container token text. Only top-level raw spans can support source citations.
		if (sourceLines && !text.startsWith(raw, offset)) {
			throw new KnowledgeDocumentError("parser-failed", "Unable to map Markdown blocks to source lines");
		}
		offset += raw.length;
		if (token.type === "space" || !content) continue;
		if (token.type === "heading") {
			const heading = token as Tokens.Heading;
			const title = heading.tokens
				.map((item) => ("text" in item && typeof item.text === "string" ? item.text : item.raw))
				.join("")
				.trim();
			if (title.length > MAX_HEADING_CHARACTERS)
				throw new KnowledgeDocumentError("limit-exceeded", "Heading is too long");
			while (headings.length && headings.at(-1)!.level >= heading.depth) headings.pop();
			headings.push({ level: heading.depth, text: title });
			sectionIndex += 1;
			firstHeading ??= { kind: "literal", text: content, headingPath: [title], ...location };
			continue;
		}
		blocks.push({
			sectionIndex,
			kind:
				token.type === "code" || token.type === "table" || token.type === "list"
					? token.type
					: token.type === "paragraph" || token.type === "text"
						? "prose"
						: "literal",
			text: content,
			headingPath: headings.map((heading) => heading.text),
			...location,
		});
	}
	if (sourceLines && offset !== text.length) {
		throw new KnowledgeDocumentError("parser-failed", "Markdown source mapping is incomplete");
	}
	if (!blocks.length && firstHeading) blocks.push(firstHeading);
	return { blocks, title: firstHeading?.headingPath[0] };
}

export function parsePlainText(
	input: string,
	location: { pageNumber: number } | { sourceLines: true },
): DocumentBlock[] {
	const lines = normalizeDocumentText(input).split("\n");
	const blocks: DocumentBlock[] = [];
	let start = 0;
	for (let index = 0; index <= lines.length; index += 1) {
		if (lines[index]?.trim()) continue;
		if (index > start) {
			blocks.push({
				kind: "prose",
				text: lines.slice(start, index).join("\n").trimEnd(),
				headingPath: [],
				...("pageNumber" in location ? location : { lineStart: start + 1, lineEnd: index }),
			});
		}
		start = index + 1;
	}
	return blocks;
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
	return count;
}
