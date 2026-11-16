import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { redactMemoryOutput } from "../memory/output-safety.ts";
import type { ContextMessage } from "./contracts.ts";
import { collectToolCallIds, isDiagnostic } from "./tool-output.ts";

export const CONTEXT_ORIGIN = "pi-enhanced-context-origin";
export const CONTEXT_RESTORE = "enhanced_context_restore";
export const MAX_RESTORE_CHARACTERS = 4_000;

type Result = Extract<ContextMessage, { role: "toolResult" }>;
type TextBlock = Result["content"][number];

function textOnly(content: readonly TextBlock[]): string | undefined {
	if (!content.length || content.some((block) => block.type !== "text")) return undefined;
	return content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

export function contextOrigin(
	content: readonly TextBlock[],
	limit: number,
	taskId: string,
	toolCallId: string,
	toolName: string,
) {
	const text = textOnly(content);
	if (text === undefined || text.length <= limit) return undefined;
	return { taskId, toolCallId, toolName, digest: digest(text) };
}

function digest(text: string): string {
	return createHash("sha256").update(text, "utf16le").digest("hex");
}

type ContextScope = Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager">;
function storedResults(ctx: ContextScope, taskId: string) {
	if (!ctx.isProjectTrusted() || !ctx.sessionManager.getSessionFile()) return [];
	const root = realpathSync.native(ctx.cwd);
	if (root !== realpathSync.native(ctx.sessionManager.getCwd())) return [];
	const origins = new Map<string, { taskId: string; toolCallId: string; toolName: string; digest: string }>();
	const results: { reference: string; message: Result; text: string }[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === CONTEXT_ORIGIN) {
			const origin = entry.data as ReturnType<typeof contextOrigin>;
			if (origin && typeof origin.toolCallId === "string") origins.set(origin.toolCallId, origin);
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		const origin = origins.get(message.toolCallId);
		origins.delete(message.toolCallId);
		if (origin?.taskId !== taskId || origin.toolName !== message.toolName || isDiagnostic(message)) continue;
		const text = textOnly(message.content);
		if (text === undefined || digest(text) !== origin.digest) continue;
		const reference = `v1:${digest(JSON.stringify([root, ctx.sessionManager.getSessionId(), taskId, entry.id, origin.digest]))}`;
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
) {
	const offloaded = new Set<string>();
	const calls = collectToolCallIds(messages);
	const results = new Map<string, number>();
	for (const message of messages) {
		if (message.role === "toolResult") results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
	}
	const stored = new Map(storedResults(ctx, taskId).map((item) => [item.message.toolCallId, item]));
	const view = messages.map((message): ContextMessage => {
		if (
			message.role !== "toolResult" ||
			!calls.has(message.toolCallId) ||
			results.get(message.toolCallId) !== 1 ||
			isDiagnostic(message)
		)
			return message;
		const original = stored.get(message.toolCallId);
		if (
			!original ||
			original.text.length <= limit ||
			message.toolName !== original.message.toolName ||
			textOnly(message.content) !== original.text
		)
			return message;
		const text = redactMemoryOutput(original.text, ctx.cwd);
		const note = hostRestores
			? `\n[Stored in this task's session with reference ${original.reference}.]\n`
			: `\n[Stored in this task's session. Use ${CONTEXT_RESTORE} with reference ${original.reference}.]\n`;
		const preview = Math.max(0, Math.floor((limit - note.length) / 2));
		offloaded.add(message.toolCallId);
		return {
			...message,
			content: [{ type: "text", text: text.slice(0, preview) + note + text.slice(text.length - preview) }],
		};
	});
	return { messages: view, offloaded };
}

export function restoreContextPage(
	ctx: ExtensionContext,
	taskId: string,
	reference: string,
	offset = 0,
	limit = MAX_RESTORE_CHARACTERS,
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
	const stored = storedResults(ctx, taskId).find((entry) => entry.reference === reference);
	if (!stored) throw new Error("Context reference is unavailable in this task and session");
	const text = redactMemoryOutput(stored.text, ctx.cwd);
	if (offset >= text.length) throw new Error("Context offset is outside the stored result");
	const end = Math.min(offset + limit, text.length);
	return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null, totalCharacters: text.length };
}
