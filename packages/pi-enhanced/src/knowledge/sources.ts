import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { type DocumentMimeType, KnowledgeDocumentError } from "./contracts.ts";

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 2_048;
const MAX_SCAN_FILES = 128;
const MAX_SCAN_DEPTH = 6;

const formats = new Map<string, DocumentMimeType>([
	[".md", "text/markdown"],
	[".markdown", "text/markdown"],
	[".txt", "text/plain"],
	[".html", "text/html"],
	[".htm", "text/html"],
	[".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	[".pdf", "application/pdf"],
]);

function pathParts(target: string): string[] {
	if (target.length > 2_048) throw new KnowledgeDocumentError("invalid-path");
	const parts = target.split(/[/\\]/u);
	for (const part of parts) {
		if (!part || part === "." || part === ".." || /[:\x00-\x1f]/u.test(part)) {
			throw new KnowledgeDocumentError("invalid-path");
		}
		if (
			process.platform === "win32" &&
			(/[<>"|?*]/u.test(part) ||
				/[. ]$/u.test(part) ||
				/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu.test(part))
		) {
			throw new KnowledgeDocumentError("invalid-path");
		}
	}
	return parts;
}

async function approvedRoot(root: string): Promise<string> {
	if (!isAbsolute(root) || (process.platform === "win32" && !/^[a-z]:[/\\]/iu.test(root))) {
		throw new KnowledgeDocumentError("invalid-path");
	}
	const absolute = resolve(root);
	const canonical = await realpath(absolute);
	if (relative(canonical, absolute) || !(await lstat(canonical)).isDirectory()) {
		throw new KnowledgeDocumentError("invalid-path", "Choose a real local directory without symbolic links");
	}
	return canonical;
}

async function inspectSource(root: string, parts: readonly string[]): Promise<{ path: string; stat: Stats }> {
	let path = root;
	let stat = await lstat(root);
	for (const part of parts) {
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new KnowledgeDocumentError("invalid-path");
		path = join(path, part);
		stat = await lstat(path);
	}
	if (stat.isSymbolicLink() || relative(path, await realpath(path))) {
		throw new KnowledgeDocumentError("invalid-path", "Symbolic links are outside the approved import scope");
	}
	return { path, stat };
}

function inputError(error: unknown): KnowledgeDocumentError {
	if (error instanceof KnowledgeDocumentError) return error;
	if ((error as NodeJS.ErrnoException).code === "ELOOP") return new KnowledgeDocumentError("invalid-path");
	return new KnowledgeDocumentError("source-unavailable", "Unable to access the selected document source", {
		cause: error,
	});
}

export async function discoverDocumentSources(
	root: string,
	target: string,
	options: { recursive?: boolean } = {},
): Promise<string[]> {
	try {
		const parts = target === "." ? [] : pathParts(target);
		const canonical = await approvedRoot(root);
		const selection = await inspectSource(canonical, parts);
		if (selection.stat.isFile()) {
			if (!formats.has(extname(selection.path).toLowerCase())) {
				throw new KnowledgeDocumentError("unsupported-format");
			}
			return [parts.join("/")];
		}
		if (!selection.stat.isDirectory()) throw new KnowledgeDocumentError("invalid-path");

		let entries = 0;
		const files: string[] = [];
		const visit = async (directory: string[], depth: number): Promise<void> => {
			const before = await inspectSource(canonical, directory);
			for await (const entry of await opendir(before.path)) {
				if (++entries > MAX_SCAN_ENTRIES)
					throw new KnowledgeDocumentError("limit-exceeded", "Too many directory entries");
				if (entry.isSymbolicLink() || /[/\\]/u.test(entry.name)) continue;
				const child = [...directory, entry.name];
				if (entry.isDirectory() && options.recursive === true) {
					if (depth >= MAX_SCAN_DEPTH)
						throw new KnowledgeDocumentError("limit-exceeded", "Import directory is too deep");
					pathParts(child.join("/"));
					await visit(child, depth + 1);
				} else if (entry.isFile() && formats.has(extname(entry.name).toLowerCase())) {
					if (files.length >= MAX_SCAN_FILES)
						throw new KnowledgeDocumentError("limit-exceeded", "Too many documents");
					pathParts(child.join("/"));
					files.push(child.join("/"));
				}
			}
			const after = await inspectSource(canonical, directory);
			if (!sameIdentity(before.stat, after.stat)) throw new KnowledgeDocumentError("source-changed");
		};
		await visit(parts, 0);
		return files.sort();
	} catch (error) {
		throw inputError(error);
	}
}

export async function readDocumentSource(
	root: string,
	target: string,
): Promise<{ sourcePath: string; mimeType: DocumentMimeType; bytes: Buffer }> {
	try {
		const parts = pathParts(target);
		const canonical = await approvedRoot(root);
		const selected = await inspectSource(canonical, parts);
		if (!selected.stat.isFile() || selected.stat.nlink !== 1) {
			throw new KnowledgeDocumentError("invalid-path", "Choose a regular file without additional hard links");
		}
		const mimeType = formats.get(extname(selected.path).toLowerCase());
		if (!mimeType) throw new KnowledgeDocumentError("unsupported-format");
		if (selected.stat.size > MAX_DOCUMENT_BYTES) throw new KnowledgeDocumentError("limit-exceeded");
		const flags =
			constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const handle = await open(selected.path, flags);
		try {
			const before = await handle.stat();
			if (!before.isFile() || before.nlink !== 1 || !sameSnapshot(before, selected.stat)) {
				throw new KnowledgeDocumentError("source-changed");
			}
			const verified = await inspectSource(canonical, parts);
			if (!sameSnapshot(before, verified.stat)) throw new KnowledgeDocumentError("source-changed");

			const bytes = Buffer.alloc(before.size);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
				if (bytesRead === 0) throw new KnowledgeDocumentError("source-changed");
				offset += bytesRead;
			}
			const after = await inspectSource(canonical, parts);
			if (!sameSnapshot(before, await handle.stat()) || !sameSnapshot(before, after.stat)) {
				throw new KnowledgeDocumentError("source-changed");
			}
			return { sourcePath: selected.path, mimeType, bytes };
		} finally {
			await handle.close();
		}
	} catch (error) {
		throw inputError(error);
	}
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
	return (
		sameIdentity(left, right) &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}
