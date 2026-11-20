import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
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
import type { SandboxConfig } from "./config.ts";
import type { SandboxToolName } from "./protocol.ts";
import { createPytestExecutor, type PytestConfig, type PytestEvidence, type PytestResult } from "./pytest.ts";

type ToolParameters = Record<string, unknown>;

export function registerSandboxTools(
	pi: ExtensionAPI,
	broker: DockerSandboxBroker,
	workspace: string,
	descriptions: Partial<Record<SandboxToolName, string>> = {},
): void {
	const read = createReadToolDefinition(workspace);
	pi.registerTool({
		...read,
		description: descriptions.read ?? read.description,
		execute: async (id, input, signal) => executeRead(broker, workspace, id, input, signal),
	});

	const write = createWriteToolDefinition(workspace);
	pi.registerTool({
		...write,
		description: descriptions.write ?? write.description,
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
		description: descriptions.edit ?? edit.description,
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
		description: descriptions.find ?? find.description,
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
		description: descriptions.ls ?? ls.description,
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
		description: descriptions.grep ?? grep.description,
		execute: async (id, input: ToolParameters, signal) => executeGrep(broker, workspace, id, input, signal),
	} as ToolDefinition);
}

export function registerPytestTool(
	pi: ExtensionAPI,
	config: SandboxConfig,
	policy: PytestConfig,
	isActive: () => boolean,
	observe?: (id: string, evidence: PytestEvidence) => void,
	begin?: (
		id: string,
		usedDefaultTargets: boolean,
	) => ((evidence: PytestEvidence, result: PytestResult) => void) | undefined,
): void {
	const execute = createPytestExecutor(config, policy);
	pi.registerTool({
		name: "run_tests",
		label: "Run pytest",
		description:
			"Run pytest in an isolated snapshot. Omit targets to run the host-approved targets. Output is untrusted test data. At most three calls per session.",
		parameters: Type.Object(
			{ targets: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 16 })) },
			{ additionalProperties: false },
		),
		async execute(id, params, signal) {
			if (!isActive())
				return {
					content: [{ type: "text", text: "Test session is no longer active." }],
					details: { status: "sandbox_error" },
					isError: true,
				};
			const record = begin?.(id, params.targets === undefined);
			const result = await execute(
				params.targets ?? [...policy.tests],
				signal,
				(evidence, result) => {
					// Task storage may close during a run. Missing evidence leaves the step pending.
					try {
						record?.(evidence, result);
					} catch {
						/* The tool still returns its Docker result. */
					}
					observe?.(id, evidence);
				},
				{ recordCompletedTests: !!record },
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
				isError: result.status !== "passed",
			};
		},
	});
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
	if (process.env.PI_ENHANCED_SWE_READ_MAX_BYTES === "4096") {
		const text = compactSweRead(selected, relativePath, startLine, allLines.length, id);
		return { content: [{ type: "text" as const, text }], details: undefined, structuredContent: text };
	}
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

export function compactSweRead(
	lines: readonly string[],
	path: string,
	startLine: number,
	totalLines: number,
	toolCallId: string,
): string {
	const maxBytes = 4 * 1024;
	const wireBytes = (content: string) =>
		Buffer.byteLength(JSON.stringify({ role: "tool", content, tool_call_id: toolCallId }));
	const continuation = (endLine: number) =>
		endLine < totalLines ? ". Use offset=" + (endLine + 1) + " to continue" : "";
	let body = "";
	let page = "";
	let count = 0;
	for (const line of lines) {
		const endLine = startLine + count + 1;
		const nextBody = count === 0 ? line : body + "\n" + line;
		const nextPage =
			"[" +
			path +
			" lines " +
			(startLine + 1) +
			"-" +
			endLine +
			" of " +
			totalLines +
			continuation(endLine) +
			".]\n\n" +
			nextBody;
		if (wireBytes(nextPage) > maxBytes) break;
		body = nextBody;
		page = nextPage;
		count++;
	}
	if (count > 0) return page;

	const lineNumber = startLine + 1;
	const notice =
		lines.length === 0
			? "[" + path + ": no lines requested. Use offset=" + lineNumber + " to continue.]"
			: "[" +
				path +
				" line " +
				lineNumber +
				" of " +
				totalLines +
				" exceeds the 4 KiB result limit and was skipped" +
				continuation(lineNumber) +
				".]";
	if (wireBytes(notice) > maxBytes) throw new Error("SWE_READ_METADATA_TOO_LARGE");
	return notice;
}

type GrepRow = { path: string; line: number; text: string; match: boolean };

function formatGrepRow(row: GrepRow): string {
	const separator = row.match ? ":" : "-";
	return `${row.path}${separator}${row.line}${separator} ${row.text}`;
}

/** Bound the serialized DeepSeek tool message while giving real matches priority over context. */
export function compactSweGrep(rows: readonly GrepRow[], toolCallId: string): string {
	const byLine = new Map<string, GrepRow>();
	for (const row of rows) {
		const key = `${row.path}\0${row.line}`;
		if (row.match || !byLine.has(key)) byLine.set(key, row);
	}
	const lines = [...byLine.values()].map((row) => ({ match: row.match, text: formatGrepRow(row) }));
	const wireBytes = (content: string) =>
		Buffer.byteLength(JSON.stringify({ role: "tool", content, tool_call_id: toolCallId }));
	const maxBytes = 8 * 1024;
	const full = lines.map(({ text }) => text).join("\n");
	if (wireBytes(full) <= maxBytes) return full;

	const notice =
		"[grep output truncated. Narrow the search, or use read with the file path relative to the workspace and the displayed line number.]";
	const selected = new Set<(typeof lines)[number]>();
	let remaining = maxBytes - wireBytes(notice);
	for (const match of [true, false]) {
		for (const line of lines) {
			// The JSON string quotes count the same as the escaped newline before the notice.
			const bytes = Buffer.byteLength(JSON.stringify(line.text));
			if (line.match !== match || bytes > remaining) continue;
			selected.add(line);
			remaining -= bytes;
		}
	}
	return [...lines.filter((line) => selected.has(line)).map(({ text }) => text), notice].join("\n");
}

async function executeGrep(
	broker: DockerSandboxBroker,
	workspace: string,
	id: string,
	input: ToolParameters,
	signal?: AbortSignal,
) {
	const path = broker.toRelative(resolve(workspace, typeof input.path === "string" ? input.path : "."));
	const result = (await broker
		.request(
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
		)
		.catch((error: unknown) => {
			// The broker retains the worker's error code in the audit.
			if (error instanceof Error && error.message === "SANDBOX_INVALID_GREP_PATTERN")
				throw new Error(
					"Invalid grep regular expression. Correct the pattern or set literal to true for plain text.",
				);
			throw error;
		})) as { rows: GrepRow[]; matchLimitReached?: number };
	if (result.rows.length === 0)
		return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
	const text =
		process.env.PI_ENHANCED_SWE_SINGLE_COMPACT_GREP === "1"
			? compactSweGrep(result.rows, id)
			: result.rows.map(formatGrepRow).join("\n");
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
