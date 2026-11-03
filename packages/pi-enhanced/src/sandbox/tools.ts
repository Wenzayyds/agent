import { resolve } from "node:path";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	formatSize,
	type ToolDefinition,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { DockerSandboxBroker } from "./broker.ts";

type ToolParameters = Record<string, unknown>;

export function registerSandboxTools(pi: ExtensionAPI, broker: DockerSandboxBroker, workspace: string): void {
	const read = createReadToolDefinition(workspace);
	pi.registerTool({
		...read,
		execute: async (id, input, signal) => executeRead(broker, workspace, id, input, signal),
	});

	const write = createWriteToolDefinition(workspace);
	pi.registerTool({
		...write,
		execute: async (id, input, signal, onUpdate, ctx) =>
			createWriteToolDefinition(workspace, {
				operations: {
					mkdir: async (absolutePath) => {
						await broker.request(
							"write",
							"mkdir",
							{ path: broker.toRelative(absolutePath) },
							{ requestId: `${id}:mkdir`, signal },
						);
					},
					writeFile: async (absolutePath, content) => {
						await broker.request(
							"write",
							"write_file",
							{ path: broker.toRelative(absolutePath), content },
							{ requestId: `${id}:write`, signal },
						);
					},
				},
			}).execute(id, input, signal, onUpdate, ctx),
	});

	const edit = createEditToolDefinition(workspace);
	pi.registerTool({
		...edit,
		execute: async (id, input, signal, onUpdate, ctx) =>
			createEditToolDefinition(workspace, {
				operations: {
					access: async (absolutePath) => {
						await broker.request(
							"edit",
							"access",
							{ path: broker.toRelative(absolutePath), write: true },
							{ requestId: `${id}:access`, signal },
						);
					},
					readFile: async (absolutePath) => {
						const result = (await broker.request(
							"edit",
							"read_file",
							{ path: broker.toRelative(absolutePath) },
							{ requestId: `${id}:read`, signal },
						)) as { base64: string };
						return Buffer.from(result.base64, "base64");
					},
					writeFile: async (absolutePath, content) => {
						await broker.request(
							"edit",
							"write_file",
							{ path: broker.toRelative(absolutePath), content },
							{ requestId: `${id}:write`, signal },
						);
					},
				},
			}).execute(id, input, signal, onUpdate, ctx),
	});

	const find = createFindToolDefinition(workspace);
	pi.registerTool({
		...find,
		execute: async (id, input, signal, onUpdate, ctx) =>
			createFindToolDefinition(workspace, {
				operations: {
					exists: async (absolutePath) => {
						const result = (await broker.request(
							"find",
							"exists",
							{ path: broker.toRelative(absolutePath) },
							{ requestId: `${id}:exists`, signal },
						)) as { exists: boolean };
						return result.exists;
					},
					glob: async (pattern, cwd, options) => {
						const result = (await broker.request(
							"find",
							"glob",
							{ path: broker.toRelative(cwd), pattern, limit: options.limit },
							{ requestId: `${id}:glob`, signal },
						)) as { matches: string[] };
						return result.matches;
					},
				},
			}).execute(id, input, signal, onUpdate, ctx),
	});

	const ls = createLsToolDefinition(workspace);
	pi.registerTool({
		...ls,
		execute: async (id, input, signal, onUpdate, ctx) => {
			let operation = 0;
			return createLsToolDefinition(workspace, {
				operations: {
					exists: async (absolutePath) => {
						const result = (await broker.request(
							"ls",
							"exists",
							{ path: broker.toRelative(absolutePath) },
							{ requestId: `${id}:exists:${operation++}`, signal },
						)) as { exists: boolean };
						return result.exists;
					},
					stat: async (absolutePath) => {
						const result = (await broker.request(
							"ls",
							"stat",
							{ path: broker.toRelative(absolutePath) },
							{ requestId: `${id}:stat:${operation++}`, signal },
						)) as { directory: boolean };
						return { isDirectory: () => result.directory };
					},
					readdir: async (absolutePath) => {
						const result = (await broker.request(
							"ls",
							"readdir",
							{ path: broker.toRelative(absolutePath) },
							{ requestId: `${id}:readdir:${operation++}`, signal },
						)) as { entries: string[] };
						return result.entries;
					},
				},
			}).execute(id, input, signal, onUpdate, ctx);
		},
	});

	const grep = createGrepToolDefinition(workspace);
	pi.registerTool({
		...grep,
		execute: async (id, input: ToolParameters, signal) => executeGrep(broker, workspace, id, input, signal),
	} as ToolDefinition);
}

async function executeRead(
	broker: DockerSandboxBroker,
	workspace: string,
	id: string,
	input: { path: string; offset?: number; limit?: number },
	signal?: AbortSignal,
) {
	const relativePath = broker.toRelative(resolve(workspace, input.path));
	const result = (await broker.request(
		"read",
		"read_file",
		{ path: relativePath },
		{ requestId: `${id}:read`, signal },
	)) as { base64: string };
	const buffer = Buffer.from(result.base64, "base64");
	const mimeType = imageMimeType(input.path);
	if (mimeType) {
		const note = `Read image file [${mimeType}] without host filesystem access`;
		return {
			content: [
				{ type: "text" as const, text: note },
				{ type: "image" as const, data: result.base64, mimeType },
			],
			details: undefined,
			structuredContent: { type: "image", data: result.base64, mimeType, note },
		};
	}
	if (buffer.includes(0)) throw new Error("SANDBOX_BINARY_FILE_UNSUPPORTED");
	const allLines = buffer.toString("utf8").split("\n");
	const startLine = input.offset ? Math.max(0, input.offset - 1) : 0;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${input.offset} is beyond end of file (${allLines.length} lines total)`);
	}
	const selected =
		input.limit === undefined
			? allLines.slice(startLine)
			: allLines.slice(startLine, Math.min(startLine + input.limit, allLines.length));
	const truncation = truncateHead(selected.join("\n"));
	let text = truncation.content;
	if (truncation.truncated) {
		const endLine = startLine + truncation.outputLines;
		text += `\n\n[Showing lines ${startLine + 1}-${endLine} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${endLine + 1} to continue.]`;
	} else if (input.limit !== undefined && startLine + selected.length < allLines.length) {
		const nextOffset = startLine + selected.length + 1;
		text += `\n\n[${allLines.length - startLine - selected.length} more lines in file. Use offset=${nextOffset} to continue.]`;
	}
	return {
		content: [{ type: "text" as const, text }],
		details: truncation.truncated ? { truncation } : undefined,
		structuredContent: text,
	};
}

async function executeGrep(
	broker: DockerSandboxBroker,
	workspace: string,
	id: string,
	input: ToolParameters,
	signal?: AbortSignal,
) {
	const path = broker.toRelative(resolve(workspace, typeof input.path === "string" ? input.path : "."));
	const result = (await broker.request(
		"grep",
		"grep",
		{
			path,
			pattern: input.pattern,
			glob: input.glob,
			ignoreCase: input.ignoreCase,
			literal: input.literal,
			context: input.context,
			limit: input.limit,
		},
		{ requestId: `${id}:grep`, signal },
	)) as { rows: Array<{ path: string; line: number; text: string; match: boolean }>; matchLimitReached?: number };
	if (result.rows.length === 0)
		return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
	const text = result.rows
		.map((row) => `${row.path}${row.match ? ":" : "-"}${row.line}${row.match ? ":" : "-"} ${row.text}`)
		.join("\n");
	return {
		content: [{ type: "text" as const, text }],
		details: result.matchLimitReached ? { matchLimitReached: result.matchLimitReached } : undefined,
	};
}

function imageMimeType(path: string): string | undefined {
	const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
	return extension === "jpg" || extension === "jpeg"
		? "image/jpeg"
		: extension === "png"
			? "image/png"
			: extension === "gif"
				? "image/gif"
				: extension === "webp"
					? "image/webp"
					: extension === "bmp"
						? "image/bmp"
						: undefined;
}
