import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import type { SandboxAuditRecord, SandboxContainerEvidence } from "./broker.ts";
import type { SandboxConfig } from "./config.ts";

export const AUDIT_MAX_RECORDS = 256;
export const AUDIT_MAX_BYTES = 512 * 1024;
interface PendingOperation {
	runId: string;
	requestId: string;
	toolName: string;
	operation: string;
	containerId: string;
	startedAt: number;
}
interface AuditBody {
	schemaVersion: 2;
	runId: string;
	workspaceSha256: string;
	state: "running" | "completed" | "limit_reached" | "interrupted";
	updatedAt: number;
	evidence: SandboxContainerEvidence | null;
	pending: PendingOperation[];
	audit: SandboxAuditRecord[];
}

/** Flush + atomic replacement: a reader sees a whole old or new snapshot, never a partial JSON. */
export function atomicPrivateJson(path: string, value: unknown): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export class SandboxAuditJournal {
	private body: AuditBody;
	private readonly path: string;
	private failed = false;
	constructor(path: string, config: SandboxConfig) {
		this.path = path;
		if (relative(realpathSync(dirname(path)), realpathSync(config.runRoot)) !== "" || existsSync(path))
			throw new Error("SANDBOX_AUDIT_PATH_INVALID");
		this.body = {
			schemaVersion: 2,
			runId: config.runId,
			workspaceSha256: createHash("sha256").update(config.workspace).digest("hex"),
			state: "running",
			updatedAt: Date.now(),
			evidence: null,
			pending: [],
			audit: [],
		};
		this.persist();
	}
	setEvidence(evidence: SandboxContainerEvidence): void {
		this.body.evidence = evidence;
		this.persist();
	}
	begin(value: PendingOperation): void {
		if (this.failed || this.body.state !== "running") throw new Error("SANDBOX_AUDIT_INCOMPLETE");
		if (this.body.audit.length + this.body.pending.length >= AUDIT_MAX_RECORDS) {
			this.body.state = "limit_reached";
			this.persist();
			throw new Error("SANDBOX_AUDIT_LIMIT");
		}
		this.body.pending.push(value);
		this.persist();
	}
	end(record: SandboxAuditRecord): void {
		if (!this.body.pending.some((p) => p.requestId === record.requestId))
			throw new Error("SANDBOX_AUDIT_SEQUENCE_INVALID");
		this.body.pending = this.body.pending.filter((p) => p.requestId !== record.requestId);
		this.body.audit.push(record);
		this.persist();
	}
	complete(): void {
		if (this.body.state === "completed" && !this.failed) return;
		if (this.failed || this.body.pending.length || this.body.state !== "running")
			throw new Error("SANDBOX_AUDIT_INCOMPLETE");
		this.body.state = "completed";
		this.persist();
	}
	private persist(): void {
		this.body.updatedAt = Date.now();
		const payload = JSON.stringify(this.body);
		if (Buffer.byteLength(payload) > AUDIT_MAX_BYTES) throw new Error("SANDBOX_AUDIT_LIMIT");
		try {
			atomicPrivateJson(this.path, { ...this.body, sha256: createHash("sha256").update(payload).digest("hex") });
		} catch {
			this.failed = true;
			throw new Error("SANDBOX_AUDIT_WRITE_FAILED");
		}
	}
}

/** Only the host Runner calls this after the sole writer is confirmed absent. */
export function interruptSandboxAudit(path: string, expectedRunId: string): void {
	const { body } = readAuditBody(path);
	if (body.runId !== expectedRunId) throw new Error("SANDBOX_AUDIT_RUN_MISMATCH");
	if (body.state !== "running") return;
	body.state = "interrupted";
	body.updatedAt = Date.now();
	const payload = JSON.stringify(body);
	atomicPrivateJson(path, { ...body, sha256: createHash("sha256").update(payload).digest("hex") });
}

/** Reads verified evidence without changing its terminal state. */
function readAuditBody(path: string): { body: AuditBody; sha256: string } {
	if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > AUDIT_MAX_BYTES)
		throw new Error("SANDBOX_AUDIT_INVALID");
	const { sha256, ...body } = JSON.parse(readFileSync(path, "utf8")) as AuditBody & { sha256: string };
	if (
		body.schemaVersion !== 2 ||
		createHash("sha256").update(JSON.stringify(body)).digest("hex") !== sha256 ||
		!Array.isArray(body.audit) ||
		!Array.isArray(body.pending) ||
		body.audit.length + body.pending.length > AUDIT_MAX_RECORDS ||
		!["running", "completed", "limit_reached", "interrupted"].includes(body.state)
	)
		throw new Error("SANDBOX_AUDIT_INTEGRITY_FAILED");
	const ids = [...body.audit, ...body.pending].map((r) => r.requestId);
	if (
		new Set(ids).size !== ids.length ||
		[...body.audit, ...body.pending].some((r) => r.runId !== body.runId) ||
		(body.state === "completed" && body.pending.length)
	)
		throw new Error("SANDBOX_AUDIT_SEQUENCE_INVALID");
	return { body, sha256 };
}

export function readSandboxAuditSnapshot(path: string): Record<string, unknown> {
	const { body, sha256 } = readAuditBody(path);
	return {
		...body,
		sha256,
		integrity: "valid",
		complete: body.state === "completed",
		recoveryState: body.state === "completed" ? "normal_shutdown" : "interrupted_or_unfinished",
		missingOperationResults: body.pending.map((r) => r.requestId),
		unseenEventsPossible: body.state !== "completed",
	};
}
