import { realpathSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentKnowledgePageText, independentContextResults } from "../knowledge/request-policy.ts";
import { isKnowledgeTool, KNOWLEDGE_SEARCH } from "../knowledge/tools.ts";
import {
	MEMORY_SEARCH_TOOL,
	type MemoryAccess,
	memoryReferences,
	object,
	preserveMemoryToolView,
	resultText,
	sourceDigest,
} from "../memory/disclosure.ts";
import { renderMemoryToolResult } from "../memory/interaction.ts";
import { redactMemoryOutput } from "../memory/output-safety.ts";
import type { ContextMessage } from "./contracts.ts";
import { CONTEXT_RESTORE, independentMemoryResults, type PageReference } from "./source-history.ts";
import { collectToolCallIds, previewToolOutput } from "./tool-output.ts";

export const CONTEXT_ORIGIN = "pi-enhanced-context-origin";
export { CONTEXT_RESTORE } from "./source-history.ts";
export const MAX_RESTORE_CHARACTERS = 4_000;

type Result = Extract<ContextMessage, { role: "toolResult" }>;
type TextBlock = Result["content"][number];

export function contextOrigin(
	content: readonly TextBlock[],
	limit: number,
	taskId: string,
	toolCallId: string,
	toolName: string,
	taskBranchId?: string | null,
) {
	const text = resultText([...content]);
	if (text === undefined || text.length <= limit) return undefined;
	return { taskId, toolCallId, toolName, digest: sourceDigest(text), taskBranchId };
}

type ContextScope = Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager">;
function storedResults(ctx: ContextScope, taskId: string, access?: MemoryAccess) {
	if (!ctx.isProjectTrusted() || !ctx.sessionManager.getSessionFile()) return [];
	const root = realpathSync.native(ctx.cwd);
	if (root !== realpathSync.native(ctx.sessionManager.getCwd())) return [];
	const origins = new Map<string, NonNullable<ReturnType<typeof contextOrigin>>>();
	const results: { reference: string; message: Result; text: string }[] = [];
	const independentKnowledge = independentContextResults(ctx);
	const independentMemory = independentMemoryResults(ctx);
	const branch = ctx.sessionManager.getBranch();
	const branchIds = new Set(branch.map(({ id }) => id));
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === CONTEXT_ORIGIN) {
			const origin = entry.data as ReturnType<typeof contextOrigin>;
			if (origin && typeof origin.toolCallId === "string") origins.set(origin.toolCallId, origin);
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		const origin = origins.get(message.toolCallId);
		origins.delete(message.toolCallId);
		if (
			origin?.taskId !== taskId ||
			origin.toolName !== message.toolName ||
			(origin.taskBranchId && !branchIds.has(origin.taskBranchId))
		)
			continue;
		if (access && access.task?.taskId !== taskId) continue;
		let text: string | undefined;
		if (message.toolName === MEMORY_SEARCH_TOOL) {
			const references = memoryReferences(message.details);
			if (access && references?.length) {
				const rows = references.flatMap((reference) => access.read(reference) ?? []);
				if (rows.length === references.length)
					text = renderMemoryToolResult(rows, ctx.cwd, object(message.details)?.retrieval);
			}
		} else if (isKnowledgeTool(message.toolName)) {
			if (access) text = currentKnowledgePageText(ctx as ExtensionContext, message);
		} else if (independentKnowledge(message) && independentMemory(message)) {
			text = resultText(message.content);
		}
		if (text === undefined || sourceDigest(text) !== origin.digest) continue;
		const reference = `v1:${sourceDigest(JSON.stringify([root, ctx.sessionManager.getSessionId(), taskId, entry.id, origin.digest]))}`;
		results.push({ reference, message, text });
	}
	return results;
}

export function contextReferences(ctx: ContextScope, taskId: string): string[] {
	return storedResults(ctx, taskId)
		.slice(-20)
		.map(({ reference }) => reference);
}

export function offloadProjection(
	messages: readonly ContextMessage[],
	ctx: ExtensionContext,
	taskId: string,
	limit: number,
	hostRestores = false,
	access?: MemoryAccess,
) {
	const offloaded = new Set<string>();
	const calls = collectToolCallIds(messages);
	const results = new Map<string, number>();
	for (const message of messages) {
		if (message.role === "toolResult") results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
	}
	const stored = new Map(storedResults(ctx, taskId, access).map((item) => [item.message.toolCallId, item]));
	const view = messages.map((message): ContextMessage => {
		if (message.role !== "toolResult" || !calls.has(message.toolCallId) || results.get(message.toolCallId) !== 1)
			return message;
		const original = stored.get(message.toolCallId);
		if (original && isKnowledgeTool(message.toolName) && original.text.length > limit) {
			return { ...message, details: { ...object(message.details), contextPageHint: original.reference } } as Result;
		}
		if (
			!original ||
			original.text.length <= limit ||
			message.toolName !== original.message.toolName ||
			resultText(message.content) !== original.text
		)
			return message;
		const text = redactMemoryOutput(original.text, ctx.cwd);
		if (text.length <= limit)
			return preserveMemoryToolView(message, { ...message, content: [{ type: "text", text }] });
		const note = hostRestores
			? `\n[Stored in this task's session with reference ${original.reference}.]\n`
			: `\n[Stored in this task's session. Use ${CONTEXT_RESTORE} with reference ${original.reference}.]\n`;
		if (note.length > limit) return message;
		const preview = previewToolOutput(text, limit, note, 0.5);
		offloaded.add(message.toolCallId);
		return preserveMemoryToolView(message, {
			...message,
			content: [{ type: "text", text: preview }],
		});
	});
	return { messages: view, offloaded };
}

export function restoreContextPage(
	ctx: ExtensionContext,
	taskId: string,
	reference: string,
	offset = 0,
	limit = MAX_RESTORE_CHARACTERS,
	access?: MemoryAccess,
	audience: PageReference["audience"] = "tool",
) {
	if (
		!/^v1:[a-f0-9]{64}$/u.test(reference) ||
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > MAX_RESTORE_CHARACTERS
	)
		throw new Error("Invalid context reference or page range");
	const stored = storedResults(ctx, taskId, access).find((entry) => entry.reference === reference);
	if (!stored) throw new Error("Context reference is unavailable in this task and session");
	const text = redactMemoryOutput(stored.text, ctx.cwd);
	if (offset >= text.length) throw new Error("Context offset is outside the stored result");
	const end = Math.min(offset + limit, text.length);
	const page = text.slice(offset, end);
	const proof: PageReference = {
		kind: "context-page",
		audience,
		reference,
		taskId,
		offset,
		limit,
		digest: sourceDigest(page),
	};
	return {
		text: page,
		nextOffset: end < text.length ? end : null,
		totalCharacters: text.length,
		knowledgeCandidates: stored.message.toolName === KNOWLEDGE_SEARCH,
		proof,
	};
}

export function contextPageText(page: ReturnType<typeof restoreContextPage>, header: string): string {
	const advisory = page.knowledgeCandidates
		? "[Knowledge search candidates; verify the source before using them as evidence.]\n"
		: "";
	return `${header}\n${advisory}${page.text}`;
}
