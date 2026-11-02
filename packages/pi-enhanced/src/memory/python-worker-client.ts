import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 16;
const MAX_STDERR_BYTES = 4_096;

export type MemoryWorkerOperation =
	| "health"
	| "sync_snapshot"
	| "upsert_vectors"
	| "remove_vectors"
	| "search_vectors"
	| "shutdown";

export interface MemoryWorkerClientLike {
	request(
		operation: MemoryWorkerOperation,
		payload?: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

export interface PythonWorkerClientOptions {
	startupTimeoutMs: number;
	requestTimeoutMs: number;
	command?: string;
	args?: readonly string[];
	cwd?: string;
	environment?: Readonly<Record<string, string>>;
}

export interface PythonWorkerLaunch {
	command: string;
	args: readonly string[];
	cwd: string;
}

interface PendingRequest {
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class MemoryWorkerError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MemoryWorkerError";
		this.code = code;
	}
}

export class PythonMemoryWorkerClient implements MemoryWorkerClientLike {
	private readonly options: PythonWorkerClientOptions;
	private process?: ChildProcessWithoutNullStreams;
	private startPromise?: Promise<void>;
	private readonly pending = new Map<string, PendingRequest>();
	private outputBuffer = Buffer.alloc(0);
	private stderrBytes = 0;
	private stopped = false;
	private closing = false;

	constructor(options: PythonWorkerClientOptions) {
		this.options = options;
	}

	get processId(): number | undefined {
		return this.process?.pid;
	}

	async request(
		operation: MemoryWorkerOperation,
		payload: Readonly<Record<string, unknown>> = {},
	): Promise<Record<string, unknown>> {
		if (this.stopped || this.closing) throw new MemoryWorkerError("worker-closed", "Memory worker is closed");
		await this.ensureStarted();
		return this.send(operation, payload, this.options.requestTimeoutMs);
	}

	async close(): Promise<void> {
		if (this.stopped || this.closing) return;
		this.closing = true;
		const child = this.process;
		if (child && child.exitCode === null) {
			try {
				await this.send("shutdown", {}, Math.min(this.options.requestTimeoutMs, 500));
			} catch {
				child.kill();
			}
		}
		this.failAll(new MemoryWorkerError("worker-closed", "Memory worker is closed"));
		this.stopped = true;
		this.closing = false;
	}

	private async ensureStarted(): Promise<void> {
		if (this.process && this.process.exitCode === null) return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.start();
		try {
			await this.startPromise;
		} finally {
			this.startPromise = undefined;
		}
	}

	private async start(): Promise<void> {
		const defaults = resolvePythonWorkerLaunch();
		const child = spawn(this.options.command ?? defaults.command, [...(this.options.args ?? defaults.args)], {
			cwd: this.options.cwd ?? defaults.cwd,
			env: this.options.environment ? { ...this.options.environment } : sanitizedEnvironment(),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.process = child;
		this.outputBuffer = Buffer.alloc(0);
		this.stderrBytes = 0;
		child.stdout.on("data", (chunk: Buffer) => this.handleOutput(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + chunk.length);
		});
		child.once("error", (error) => {
			this.failProcess(
				new MemoryWorkerError("worker-start-failed", "Memory worker could not start", { cause: error }),
			);
		});
		child.once("exit", (code, signal) => {
			if (!this.closing) {
				this.failProcess(
					new MemoryWorkerError(
						"worker-exited",
						`Memory worker exited unexpectedly (${code ?? "no-code"}/${signal ?? "no-signal"})`,
					),
				);
			}
		});
		const health = await this.send("health", {}, this.options.startupTimeoutMs);
		if (health.status !== "ready") {
			this.failProcess(new MemoryWorkerError("worker-unhealthy", "Memory worker health check failed"));
			throw new MemoryWorkerError("worker-unhealthy", "Memory worker health check failed");
		}
	}

	private send(
		operation: MemoryWorkerOperation,
		payload: Readonly<Record<string, unknown>>,
		timeoutMs: number,
	): Promise<Record<string, unknown>> {
		const child = this.process;
		if (!child || child.exitCode !== null || !child.stdin.writable) {
			return Promise.reject(new MemoryWorkerError("worker-unavailable", "Memory worker is unavailable"));
		}
		if (this.pending.size >= MAX_PENDING_REQUESTS) {
			return Promise.reject(new MemoryWorkerError("worker-busy", "Memory worker request limit reached"));
		}
		const requestId = randomUUID();
		const frame = `${JSON.stringify({ requestId, op: operation, payload })}\n`;
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
			return Promise.reject(new MemoryWorkerError("request-too-large", "Memory worker request is too large"));
		}
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.failProcess(new MemoryWorkerError("worker-timeout", "Memory worker request timed out"));
			}, timeoutMs);
			this.pending.set(requestId, { resolve, reject, timer });
			child.stdin.write(frame, "utf8", (error) => {
				if (!error) return;
				const pending = this.pending.get(requestId);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(requestId);
				reject(
					new MemoryWorkerError("worker-write-failed", "Memory worker request could not be written", {
						cause: error,
					}),
				);
			});
		});
	}

	private handleOutput(chunk: Buffer): void {
		this.outputBuffer = Buffer.concat([this.outputBuffer, chunk]);
		if (this.outputBuffer.length > MAX_FRAME_BYTES && !this.outputBuffer.includes(10)) {
			this.failProcess(new MemoryWorkerError("response-too-large", "Memory worker response is too large"));
			return;
		}
		let newline = this.outputBuffer.indexOf(10);
		while (newline >= 0) {
			const line = this.outputBuffer.subarray(0, newline);
			this.outputBuffer = this.outputBuffer.subarray(newline + 1);
			if (line.length > MAX_FRAME_BYTES) {
				this.failProcess(new MemoryWorkerError("response-too-large", "Memory worker response is too large"));
				return;
			}
			if (line.length > 0) this.handleFrame(line);
			newline = this.outputBuffer.indexOf(10);
		}
	}

	private handleFrame(line: Buffer): void {
		let value: unknown;
		try {
			value = JSON.parse(line.toString("utf8"));
		} catch {
			this.failProcess(new MemoryWorkerError("invalid-response", "Memory worker returned invalid JSON"));
			return;
		}
		if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.ok !== "boolean") {
			this.failProcess(new MemoryWorkerError("invalid-response", "Memory worker returned an invalid response"));
			return;
		}
		const pending = this.pending.get(value.requestId);
		if (!pending) {
			this.failProcess(
				new MemoryWorkerError("unexpected-response", "Memory worker returned an unexpected response"),
			);
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(value.requestId);
		if (value.ok) {
			if (!isRecord(value.result)) {
				pending.reject(new MemoryWorkerError("invalid-response", "Memory worker result is invalid"));
				return;
			}
			pending.resolve(value.result);
			return;
		}
		const error = isRecord(value.error) ? value.error : undefined;
		pending.reject(
			new MemoryWorkerError(
				typeof error?.code === "string" ? error.code : "worker-error",
				typeof error?.message === "string" ? error.message : "Memory worker operation failed",
			),
		);
	}

	private failProcess(error: Error): void {
		this.failAll(error);
		const child = this.process;
		if (child && child.exitCode === null) child.kill();
		this.process = undefined;
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export function resolvePythonWorkerLaunch(
	configuredPython = process.env.PI_ENHANCED_MEMORY_PYTHON,
): PythonWorkerLaunch {
	const pythonOverride = configuredPython && isAbsolute(configuredPython) ? configuredPython : undefined;
	return {
		command: pythonOverride ?? (process.platform === "win32" ? "py" : "python3"),
		args:
			process.platform === "win32" && !pythonOverride
				? ["-3", "-m", "memory_intelligence.worker"]
				: ["-m", "memory_intelligence.worker"],
		cwd: fileURLToPath(new URL("../../python/memory-intelligence/src/", import.meta.url)),
	};
}

function sanitizedEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {
		PYTHONIOENCODING: "utf-8",
		PYTHONUNBUFFERED: "1",
		TEMP: process.env.TEMP ?? tmpdir(),
		TMP: process.env.TMP ?? tmpdir(),
	};
	for (const name of ["PATH", "SystemRoot", "WINDIR"] as const) {
		const value = process.env[name];
		if (value) environment[name] = value;
	}
	return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
