export type MemoryErrorCode =
	| "MEMORY_NOT_FOUND"
	| "MEMORY_REVISION_CONFLICT"
	| "MEMORY_CONTENT_CONFLICT"
	| "MEMORY_REVIEW_REQUIRED"
	| "MEMORY_RUNTIME_CLOSED"
	| "MEMORY_RUNTIME_UNAVAILABLE"
	| "MEMORY_STORAGE_BUSY"
	| "MEMORY_STORAGE_ERROR"
	| "MEMORY_VALIDATION_ERROR";

export class MemoryError extends Error {
	readonly code: MemoryErrorCode;

	constructor(code: MemoryErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MemoryError";
		this.code = code;
	}
}
