import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProjectScope } from "./contracts.ts";
import { MemoryError } from "./errors.ts";
import type { MemoryService } from "./service.ts";

export const MEMORY_CANDIDATE_WRITE_REQUEST = "pi-enhanced:memory:candidate-write:request";
export const MEMORY_CANDIDATE_WRITE_RESPONSE = "pi-enhanced:memory:candidate-write:response";

interface CandidateWriteRequest {
	requestId: string;
	sessionId: string;
	cwd: string;
	taskId: string;
	content: string;
}

interface CandidateWriteResponse {
	requestId: string;
	sessionId: string;
	result?: { id: string; status: "candidate"; revision: number };
	error?: "MEMORY_RUNTIME_UNAVAILABLE" | "MEMORY_WRITE_REJECTED";
}

export function registerMemoryCandidateWriterBroker(
	events: EventBus,
	binding: { service: MemoryService; scope: ProjectScope; sessionId: string },
): () => void {
	const seen = new Map<string, CandidateWriteResponse["result"]>();
	return events.on(MEMORY_CANDIDATE_WRITE_REQUEST, async (data) => {
		const request = parseRequest(data);
		if (!request) return;
		let scopeMatches = false;
		try {
			scopeMatches = realpathSync.native(request.cwd) === binding.scope.rootPath;
		} catch {}
		if (!scopeMatches || request.sessionId !== binding.sessionId) {
			respond(events, request, { error: "MEMORY_RUNTIME_UNAVAILABLE" });
			return;
		}
		const contentDigest = createHash("sha256").update(request.content).digest("hex");
		const key = `${binding.scope.projectId}\0${request.taskId}\0${contentDigest}`;
		const prior = seen.get(key);
		if (prior) {
			respond(events, request, { result: prior });
			return;
		}
		try {
			const record = await binding.service.saveCandidate({
				kind: "experience",
				content: request.content,
				source: { type: "user", ref: `task:${request.taskId}:experience:${contentDigest}` },
				metadata: { category: "procedure", tags: ["task-experience"] },
			});
			const result = { id: record.id, status: "candidate" as const, revision: record.revision };
			seen.set(key, result);
			respond(events, request, { result });
		} catch {
			respond(events, request, { error: "MEMORY_WRITE_REJECTED" });
		}
	});
}

export function requestMemoryCandidateWrite(
	events: EventBus,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	input: { taskId: string; content: string },
	timeoutMs = 1_000,
): Promise<{ id: string; status: "candidate"; revision: number }> {
	if (!input.taskId || input.taskId.length > 100 || !input.content || input.content.length > 8_000) {
		return Promise.reject(new MemoryError("MEMORY_VALIDATION_ERROR", "Task Memory candidate is invalid"));
	}
	const request: CandidateWriteRequest = {
		requestId: randomUUID(),
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		taskId: input.taskId,
		content: input.content,
	};
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			callback();
		};
		const off = events.on(MEMORY_CANDIDATE_WRITE_RESPONSE, (data) => {
			const response = parseResponse(data);
			if (!response || response.requestId !== request.requestId || response.sessionId !== request.sessionId) return;
			if (response.result) finish(() => resolve(response.result!));
			else finish(() => reject(unavailable()));
		});
		const timer = setTimeout(() => finish(() => reject(unavailable())), timeoutMs);
		events.emit(MEMORY_CANDIDATE_WRITE_REQUEST, request);
	});
}

function respond(
	events: EventBus,
	request: CandidateWriteRequest,
	value: Pick<CandidateWriteResponse, "result" | "error">,
): void {
	events.emit(MEMORY_CANDIDATE_WRITE_RESPONSE, {
		requestId: request.requestId,
		sessionId: request.sessionId,
		...value,
	} satisfies CandidateWriteResponse);
}

function parseRequest(value: unknown): CandidateWriteRequest | null {
	if (!record(value)) return null;
	if (
		typeof value.requestId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.taskId !== "string" ||
		typeof value.content !== "string" ||
		value.taskId.length < 1 ||
		value.taskId.length > 100 ||
		value.content.length < 1 ||
		value.content.length > 8_000
	)
		return null;
	return value as unknown as CandidateWriteRequest;
}

function parseResponse(value: unknown): CandidateWriteResponse | null {
	if (!record(value) || typeof value.requestId !== "string" || typeof value.sessionId !== "string") return null;
	if (record(value.result) && typeof value.result.id === "string" && value.result.status === "candidate") {
		return {
			requestId: value.requestId,
			sessionId: value.sessionId,
			result: value.result as CandidateWriteResponse["result"],
		};
	}
	if (value.error === "MEMORY_RUNTIME_UNAVAILABLE" || value.error === "MEMORY_WRITE_REJECTED") {
		return { requestId: value.requestId, sessionId: value.sessionId, error: value.error };
	}
	return null;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function unavailable(): MemoryError {
	return new MemoryError("MEMORY_RUNTIME_UNAVAILABLE", "Memory candidate writer is unavailable for this session");
}
