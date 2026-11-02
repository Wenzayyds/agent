import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProjectScope } from "../memory/contracts.ts";
import type { ScopedTaskReader } from "./contracts.ts";
import { TaskError } from "./errors.ts";

export const TASK_READER_REQUEST_CHANNEL = "pi-enhanced:task:reader:request";
export const TASK_READER_RESPONSE_CHANNEL = "pi-enhanced:task:reader:response";

export function registerScopedTaskReaderBroker(
	events: EventBus,
	binding: { reader: ScopedTaskReader; scope: ProjectScope; sessionId: string },
): () => void {
	return events.on(TASK_READER_REQUEST_CHANNEL, (data) => {
		if (
			!record(data) ||
			typeof data.requestId !== "string" ||
			typeof data.sessionId !== "string" ||
			typeof data.cwd !== "string"
		)
			return;
		let pathMatches = false;
		try {
			pathMatches = realpathSync.native(data.cwd) === binding.scope.rootPath;
		} catch {}
		const matches = pathMatches && data.sessionId === binding.sessionId;
		events.emit(TASK_READER_RESPONSE_CHANNEL, {
			requestId: data.requestId,
			sessionId: data.sessionId,
			...(matches ? { reader: binding.reader } : { error: "unavailable" }),
		});
	});
}

export function requestScopedTaskReader(
	events: EventBus,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	timeoutMs = 250,
): Promise<ScopedTaskReader> {
	const request = { requestId: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			off();
			fn();
		};
		const off = events.on(TASK_READER_RESPONSE_CHANNEL, (data) => {
			if (!record(data) || data.requestId !== request.requestId || data.sessionId !== request.sessionId) return;
			const reader = data.reader;
			if (isReader(reader)) finish(() => resolve(reader));
			else finish(() => reject(unavailable()));
		});
		const timer = setTimeout(() => finish(() => reject(unavailable())), timeoutMs);
		events.emit(TASK_READER_REQUEST_CHANNEL, request);
	});
}
function isReader(value: unknown): value is ScopedTaskReader {
	return record(value) && typeof value.get === "function" && typeof value.getActive === "function";
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
function unavailable(): TaskError {
	return new TaskError("TASK_RUNTIME_UNAVAILABLE", "Task reader is unavailable for this session");
}
