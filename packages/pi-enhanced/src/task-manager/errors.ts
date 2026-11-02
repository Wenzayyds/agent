export type TaskErrorCode =
	| "TASK_VALIDATION_ERROR"
	| "TASK_NOT_FOUND"
	| "TASK_REVISION_CONFLICT"
	| "TASK_INVALID_TRANSITION"
	| "TASK_STORAGE_ERROR"
	| "TASK_RUNTIME_UNAVAILABLE";

export class TaskError extends Error {
	readonly code: TaskErrorCode;
	constructor(code: TaskErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TaskError";
		this.code = code;
	}
}
