import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	CoreMemoryDocument,
	CoreMemoryName,
	MemoryRecord,
	ProjectScope,
	ReadonlyMemoryQuery,
	ScopedMemoryReader,
} from "./contracts.ts";
import { MemoryError } from "./errors.ts";
import { redactMemoryOutput } from "./output-safety.ts";
import type { MemoryService } from "./service.ts";

export const MEMORY_READER_REQUEST_CHANNEL = "pi-enhanced:memory:reader:request";
export const MEMORY_READER_RESPONSE_CHANNEL = "pi-enhanced:memory:reader:response";

const DEFAULT_READER_REQUEST_TIMEOUT_MS = 1_000;
const READER_REQUEST_RETRY_MS = 25;

interface MemoryReaderRequest {
	requestId: string;
	sessionId: string;
	cwd: string;
}

interface MemoryReaderResponse {
	requestId: string;
	sessionId: string;
	reader?: ScopedMemoryReader;
	error?: "MEMORY_RUNTIME_UNAVAILABLE";
}

export interface MemoryReaderBrokerBinding {
	reader: ScopedMemoryReader;
	scope: ProjectScope;
	sessionId: string;
}

export class ScopedMemoryReaderAdapter implements ScopedMemoryReader {
	readonly scope: ProjectScope;
	private readonly service: MemoryService;
	private closed = false;

	constructor(service: MemoryService) {
		this.service = service;
		this.scope = service.scope;
	}

	async search(query: ReadonlyMemoryQuery): Promise<readonly MemoryRecord[]> {
		this.assertOpen();
		return this.service.search({
			text: query.text,
			...(query.limit === undefined ? {} : { limit: query.limit }),
			...(query.kinds === undefined ? {} : { kinds: query.kinds }),
			statuses: ["verified"],
		});
	}

	async get(id: string): Promise<MemoryRecord | null> {
		this.assertOpen();
		const record = await this.service.getVerified(id);
		return record?.lifecycle === "active" ? record : null;
	}

	async getCore(name: CoreMemoryName): Promise<CoreMemoryDocument | null> {
		this.assertOpen();
		const document = this.service.getCore(name);
		if (!document) return null;
		const content = redactMemoryOutput(document.content, this.scope.rootPath);
		return {
			...document,
			content,
			contentHash: createHash("sha256").update(content).digest("hex"),
		};
	}

	close(): void {
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) throw new MemoryError("MEMORY_RUNTIME_CLOSED", "Memory runtime is closed");
	}
}

export function registerScopedMemoryReaderBroker(events: EventBus, binding: MemoryReaderBrokerBinding): () => void {
	return events.on(MEMORY_READER_REQUEST_CHANNEL, (data) => {
		const request = parseRequest(data);
		if (!request) return;
		let cwdMatches = false;
		try {
			cwdMatches = realpathSync.native(request.cwd) === binding.scope.rootPath;
		} catch {
			cwdMatches = false;
		}
		const matches = request.sessionId === binding.sessionId && cwdMatches;
		const response: MemoryReaderResponse = {
			requestId: request.requestId,
			sessionId: request.sessionId,
			...(matches ? { reader: binding.reader } : { error: "MEMORY_RUNTIME_UNAVAILABLE" }),
		};
		events.emit(MEMORY_READER_RESPONSE_CHANNEL, response);
	});
}

export function requestScopedMemoryReader(
	events: EventBus,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	timeoutMs = DEFAULT_READER_REQUEST_TIMEOUT_MS,
): Promise<ScopedMemoryReader> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
		return Promise.reject(new MemoryError("MEMORY_VALIDATION_ERROR", "Reader request timeout is invalid"));
	}
	const request: MemoryReaderRequest = {
		requestId: randomUUID(),
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
	};
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(retryTimer);
			unsubscribe();
			callback();
		};
		const unsubscribe = events.on(MEMORY_READER_RESPONSE_CHANNEL, (data) => {
			const response = parseResponse(data);
			if (!response || response.requestId !== request.requestId || response.sessionId !== request.sessionId) return;
			if (response.reader) finish(() => resolve(response.reader as ScopedMemoryReader));
			else finish(() => reject(unavailableError()));
		});
		const timer = setTimeout(() => finish(() => reject(unavailableError())), timeoutMs);
		const retryTimer = setInterval(
			() => events.emit(MEMORY_READER_REQUEST_CHANNEL, request),
			READER_REQUEST_RETRY_MS,
		);
		events.emit(MEMORY_READER_REQUEST_CHANNEL, request);
	});
}

function parseRequest(value: unknown): MemoryReaderRequest | null {
	if (!isRecord(value)) return null;
	if (typeof value.requestId !== "string" || typeof value.sessionId !== "string" || typeof value.cwd !== "string") {
		return null;
	}
	return { requestId: value.requestId, sessionId: value.sessionId, cwd: value.cwd };
}

function parseResponse(value: unknown): MemoryReaderResponse | null {
	if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.sessionId !== "string") return null;
	const reader = isScopedMemoryReader(value.reader) ? value.reader : undefined;
	const error = value.error === "MEMORY_RUNTIME_UNAVAILABLE" ? value.error : undefined;
	if (!reader && !error) return null;
	return {
		requestId: value.requestId,
		sessionId: value.sessionId,
		...(reader ? { reader } : {}),
		...(error ? { error } : {}),
	};
}

function isScopedMemoryReader(value: unknown): value is ScopedMemoryReader {
	return (
		isRecord(value) &&
		typeof value.search === "function" &&
		typeof value.get === "function" &&
		typeof value.getCore === "function"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function unavailableError(): MemoryError {
	return new MemoryError("MEMORY_RUNTIME_UNAVAILABLE", "Memory reader is unavailable for the current session");
}
