import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { digest } from "../multi-local/protocol.ts";
import type { RemoteTestArtifact, RemoteTestIntent } from "./contract.ts";

type Status = "submitted" | "working" | "completed" | "failed" | "canceled" | "rejected";
interface Row {
	id: string;
	context_id: string;
	principal_id: string;
	intent_json: string;
	intent_hash: string;
	status: Status;
	owner_pid: number | null;
	updated_at: number;
	artifact_json: string | null;
	artifact_hash: string | null;
	reason: string | null;
}

export function storedArtifact(row: Row): RemoteTestArtifact | undefined {
	if (row.status !== "completed" || row.artifact_json === null || digest(row.artifact_json) !== row.artifact_hash)
		return;
	return JSON.parse(row.artifact_json) as RemoteTestArtifact;
}

/** Transport records in the existing project Task Manager SQLite, alongside the parent and its budget. */
export class A2ATaskStore {
	private readonly db: DatabaseSync;

	constructor(path: string, readOnly = false) {
		const file = lstatSync(path);
		if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("MA2_TASK_STORAGE_INVALID");
		this.db = new DatabaseSync(path, { readOnly, timeout: 2500, enableForeignKeyConstraints: true });
		try {
			if (!readOnly)
				this.db.exec(`
				PRAGMA synchronous=FULL;
				CREATE TABLE IF NOT EXISTS a2a_test_tasks (
					id TEXT PRIMARY KEY, context_id TEXT NOT NULL, principal_id TEXT NOT NULL,
					parent_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
					operation_id TEXT NOT NULL, intent_json TEXT NOT NULL, intent_hash TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('submitted','working','completed','failed','canceled','rejected')),
					owner_pid INTEGER, updated_at INTEGER NOT NULL,
					artifact_json TEXT, artifact_hash TEXT, reason TEXT,
					UNIQUE(principal_id, operation_id)
				);
			`);
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	get(principal: string, id: string): Row | undefined {
		return this.db.prepare("SELECT * FROM a2a_test_tasks WHERE principal_id=? AND id=?").get(principal, id) as
			| Row
			| undefined;
	}

	working(principal: string): Row[] {
		return this.db
			.prepare("SELECT * FROM a2a_test_tasks WHERE principal_id=? AND status='working'")
			.all(principal) as unknown as Row[];
	}

	submit(principal: string, intent: RemoteTestIntent, check: () => boolean): Row {
		return this.transaction(() => {
			const existing = this.db
				.prepare("SELECT * FROM a2a_test_tasks WHERE principal_id=? AND operation_id=?")
				.get(principal, intent.operationId) as Row | undefined;
			const intentHash = digest(intent);
			if (existing) {
				if (intentHash !== existing.intent_hash) throw new Error("MA2_OPERATION_CONFLICT");
				return existing;
			}
			if (!check()) throw new Error("MA2_INTENT_DENIED");
			const id = randomUUID();
			this.db
				.prepare(`INSERT INTO a2a_test_tasks
				(id, context_id, principal_id, parent_task_id, operation_id, intent_json, intent_hash, status, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`)
				.run(
					id,
					randomUUID(),
					principal,
					intent.parentTaskId,
					intent.operationId,
					JSON.stringify(intent),
					intentHash,
					Date.now(),
				);
			return this.get(principal, id)!;
		});
	}

	claim(principal: string, id: string, check: () => "allow" | "deny" | "defer"): boolean {
		return this.transaction(() => {
			const row = this.get(principal, id);
			if (row?.status !== "submitted") return false;
			const decision = check();
			if (decision === "defer") return false;
			if (decision === "deny") {
				this.finish(principal, id, "submitted", "rejected", "MA2_INTENT_EXPIRED_OR_CHANGED");
				return false;
			}
			return (
				this.db
					.prepare(`UPDATE a2a_test_tasks SET status='working', owner_pid=?, updated_at=?
				WHERE principal_id=? AND id=? AND status='submitted'`)
					.run(process.pid, Date.now(), principal, id).changes === 1
			);
		});
	}

	finish(
		principal: string,
		id: string,
		from: Status,
		to: Status,
		reason?: string,
		artifact?: RemoteTestArtifact,
	): boolean {
		const body = artifact ? JSON.stringify(artifact) : null;
		if (body && Buffer.byteLength(body) > 8192) throw new Error("MA2_ARTIFACT_TOO_LARGE");
		return (
			this.db
				.prepare(`UPDATE a2a_test_tasks SET status=?, updated_at=?, artifact_json=?, artifact_hash=?, reason=?
			WHERE principal_id=? AND id=? AND status=?`)
				.run(to, Date.now(), body, body === null ? null : digest(body), reason ?? null, principal, id, from)
				.changes === 1
		);
	}

	close(): void {
		this.db.close();
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = operation();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
