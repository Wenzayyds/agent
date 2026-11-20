import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sourceRegistry } from "../context/source-registry.ts";
import { currentScopedTaskReader } from "../task-manager/reader.ts";
import { type MemoryRecord, type MemoryVisibility, recordScope } from "./contracts.ts";
import { currentScopedMemoryReader } from "./reader.ts";

export const MEMORY_SEARCH_TOOL = "enhanced_memory_search";
export const MEMORY_CUSTOM_TYPE = "pi-enhanced-context-memory";

export interface MemoryReference {
	kind: "memory";
	memoryId: string;
	projectId: string;
	scopeKind: "project" | "task" | "session";
	scopeId: string | null;
	sessionId: string | null;
	taskBranchId: string | null;
	contentRevision: number;
	contentHash: string;
	evidenceHash: string;
}

type Result = Extract<AgentMessage, { role: "toolResult" }>;

export function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function sourceDigest(text: string): string {
	return createHash("sha256").update(text, "utf16le").digest("hex");
}

export function resultText(content: Result["content"] | string): string | undefined {
	if (typeof content === "string") return content;
	if (!content.length || content.some((block) => block.type !== "text")) return;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function evidenceHash(record: MemoryRecord): string {
	return sourceDigest(
		JSON.stringify([
			record.status,
			record.verifications
				.filter(({ verifiedContentRevision }) => verifiedContentRevision === record.contentRevision)
				.map(({ id, type, evidenceRef, evidenceVersion }) => [id, type, evidenceRef, evidenceVersion])
				.sort(),
			record.sources.map(({ type, ref, commit }) => [type, ref, commit]).sort(),
		]),
	);
}

export function memoryReference(record: MemoryRecord, visibility: MemoryVisibility): MemoryReference {
	const scope = recordScope(record);
	if (!scope) throw new Error("Memory source has no scope");
	const taskBound = scope.kind === "task" || Boolean(record.data?.taskId && scope.kind === "session");
	return {
		kind: "memory",
		memoryId: record.id,
		projectId: record.projectId,
		scopeKind: scope.kind,
		scopeId: scope.kind === "project" ? null : scope.id,
		sessionId: scope.kind === "project" ? null : (visibility.sessionId ?? null),
		taskBranchId: taskBound ? (visibility.taskBranchId ?? null) : null,
		contentRevision: record.contentRevision,
		contentHash: record.contentHash,
		evidenceHash: evidenceHash(record),
	};
}

export function parseMemoryReference(raw: unknown): MemoryReference | undefined {
	const value = object(raw);
	if (!value || value.kind !== "memory") return;
	const {
		memoryId,
		projectId,
		scopeKind,
		scopeId,
		sessionId,
		taskBranchId,
		contentRevision,
		contentHash,
		evidenceHash: evidence,
	} = value;
	if (
		typeof memoryId !== "string" ||
		!memoryId ||
		typeof projectId !== "string" ||
		!projectId ||
		(scopeKind !== "project" && scopeKind !== "session" && scopeKind !== "task") ||
		(scopeKind === "project"
			? scopeId !== null || sessionId !== null
			: typeof scopeId !== "string" || typeof sessionId !== "string") ||
		(taskBranchId !== null && typeof taskBranchId !== "string") ||
		typeof contentRevision !== "number" ||
		!Number.isSafeInteger(contentRevision) ||
		contentRevision < 1 ||
		typeof contentHash !== "string" ||
		!/^[a-f0-9]{64}$/u.test(contentHash) ||
		typeof evidence !== "string" ||
		!/^[a-f0-9]{64}$/u.test(evidence)
	)
		return;
	return {
		kind: "memory",
		memoryId,
		projectId,
		scopeKind,
		scopeId: typeof scopeId === "string" ? scopeId : null,
		sessionId: typeof sessionId === "string" ? sessionId : null,
		taskBranchId,
		contentRevision,
		contentHash,
		evidenceHash: evidence,
	};
}

export function memoryReferences(details: unknown): MemoryReference[] | undefined {
	const raw = object(details)?.memoryReferences;
	if (!Array.isArray(raw) || raw.length > 50) return;
	const references = raw.map(parseMemoryReference);
	return references.every((value) => value !== undefined) ? references : undefined;
}

export function memorySourceDetails(records: readonly MemoryRecord[], visibility: MemoryVisibility, text: string) {
	return {
		modelRequestPolicy: "memoryContext",
		memoryReferences: records.map((record) => memoryReference(record, visibility)),
		sourceDigest: sourceDigest(text),
	};
}

const safeViews = sourceRegistry.memoryViews;

export function preserveMemoryToolView(original: Result, projected: Result): Result {
	if (safeViews.has(original) || validMemoryResultText(original)) safeViews.add(projected);
	return projected;
}

export function validMemoryResultText(message: Result): boolean {
	if (safeViews.has(message)) return true;
	const text = resultText(message.content);
	return text !== undefined && sourceDigest(text) === object(message.details)?.sourceDigest;
}

export function currentAccess(events: EventBus, ctx: ExtensionContext, activeTools: readonly string[]) {
	const sessionId = ctx.sessionManager.getSessionId();
	const trusted = ctx.isProjectTrusted();
	const reader = trusted ? currentScopedMemoryReader(events, ctx) : undefined;
	const task = (() => {
		try {
			if (!trusted) return;
			const value = currentScopedTaskReader(events, ctx)?.getActiveNow?.();
			if (
				value?.sessionId === sessionId &&
				["queued", "running", "paused", "blocked"].includes(value.status) &&
				(value.branchLeafId === null || ctx.sessionManager.getBranch().some(({ id }) => id === value.branchLeafId))
			)
				return value;
		} catch {
			// Missing or unavailable task state cannot authorize a task-scoped source.
		}
	})();
	const conditions = [process.platform, `platform:${process.platform}`, `node:${process.versions.node}`];
	if (reader) conditions.push(`project:${reader.scope.projectId}`);
	for (const name of activeTools
		.filter((name) => /^[a-z_]{1,58}$/u.test(name))
		.sort()
		.slice(0, 28))
		conditions.push(`tool:${name}`);
	const visibility = {
		sessionId,
		conditions,
		...(task && task.projectId === reader?.scope.projectId
			? { taskId: task.taskId, taskBranchId: task.branchLeafId }
			: {}),
	};
	return {
		task,
		read(reference: MemoryReference): MemoryRecord | undefined {
			if (!reader || reader.scope.projectId !== reference.projectId) return;
			try {
				const row = reader.getVisibleNow(reference.memoryId, visibility);
				if (
					!row ||
					!row.verifications.some(({ verifiedContentRevision }) => verifiedContentRevision === row.contentRevision)
				)
					return;
				const current = memoryReference(row, visibility);
				const anchor = reference.taskBranchId;
				if (anchor && !ctx.sessionManager.getBranch().some(({ id }) => id === anchor)) return;
				if (JSON.stringify({ ...current, taskBranchId: anchor }) === JSON.stringify(reference)) return row;
			} catch {
				// Fail closed for an unavailable record or evidence source.
			}
		},
	};
}

export type MemoryAccess = ReturnType<typeof currentAccess>;
