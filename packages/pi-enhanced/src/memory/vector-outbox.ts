import type { DatabaseSync } from "node:sqlite";

export interface VectorJob {
	memoryId: string;
	revision: number;
	token: string;
	attempts: number;
}

// Its lifetime is owned by LocalMemoryProvider, which owns the SQLite connection.
export class VectorOutbox {
	private readonly database: DatabaseSync;
	private readonly projectId: string;

	constructor(database: DatabaseSync, projectId: string) {
		this.database = database;
		this.projectId = projectId;
	}

	due(limit: number, now = Date.now()): VectorJob[] {
		return this.database
			.prepare(`SELECT memory_id AS memoryId, revision, token, attempts
			FROM memory_vector_jobs WHERE project_id=? AND due_at<=? ORDER BY due_at, memory_id LIMIT ?`)
			.all(this.projectId, now, limit) as unknown as VectorJob[];
	}

	enqueue(memoryId: string, revision: number, now = Date.now()): void {
		// Reconciliation may have read this revision before a concurrent writer advanced it.
		this.database
			.prepare(`INSERT INTO memory_vector_jobs
			(project_id, memory_id, revision, token, due_at)
			SELECT project_id, id, revision, lower(hex(randomblob(16))), ? FROM memories
			WHERE project_id=? AND id=? AND revision=?
			ON CONFLICT(project_id, memory_id) DO UPDATE SET due_at=excluded.due_at, token=excluded.token
			WHERE memory_vector_jobs.revision=excluded.revision AND memory_vector_jobs.attempts=0
				AND memory_vector_jobs.due_at>excluded.due_at`)
			.run(now, this.projectId, memoryId, revision);
	}

	complete(job: VectorJob, expiresAt?: number): boolean {
		const result =
			expiresAt === undefined
				? this.database
						.prepare("DELETE FROM memory_vector_jobs WHERE project_id=? AND memory_id=? AND token=?")
						.run(this.projectId, job.memoryId, job.token)
				: this.database
						.prepare(`UPDATE memory_vector_jobs SET due_at=?, attempts=0, error_code=NULL,
				token=lower(hex(randomblob(16))) WHERE project_id=? AND memory_id=? AND token=?`)
						.run(expiresAt, this.projectId, job.memoryId, job.token);
		return result.changes === 1 || result.changes === 1n;
	}

	retry(job: VectorJob, errorCode: string, now = Date.now()): void {
		const delay = Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts, 6));
		this.database
			.prepare(`UPDATE memory_vector_jobs SET attempts=attempts+1, due_at=?, error_code=?,
			token=lower(hex(randomblob(16))) WHERE project_id=? AND memory_id=? AND token=?`)
			.run(now + delay, errorCode, this.projectId, job.memoryId, job.token);
	}

	stats(now = Date.now()): { pending: number; failed: number } {
		return this.database
			.prepare(`SELECT count(*) AS pending,
			count(CASE WHEN attempts>0 THEN 1 END) AS failed FROM memory_vector_jobs
			WHERE project_id=? AND (attempts>0 OR due_at<=?)`)
			.get(this.projectId, now) as { pending: number; failed: number };
	}
}

export function createVectorOutbox(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE memory_vector_jobs (
			project_id TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			token TEXT NOT NULL,
			due_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			error_code TEXT,
			PRIMARY KEY (project_id, memory_id)
		);
		CREATE INDEX memory_vector_jobs_due ON memory_vector_jobs(project_id, due_at, memory_id);
		CREATE TRIGGER memory_vector_change AFTER UPDATE OF revision ON memories
		WHEN NEW.revision <> OLD.revision AND (OLD.status='verified' OR NEW.status='verified'
			OR EXISTS (SELECT 1 FROM memory_vector_jobs WHERE project_id=NEW.project_id AND memory_id=NEW.id))
		BEGIN
			INSERT INTO memory_vector_jobs(project_id, memory_id, revision, token, due_at)
			VALUES (NEW.project_id, NEW.id, NEW.revision, lower(hex(randomblob(16))), NEW.updated_at)
			ON CONFLICT(project_id, memory_id) DO UPDATE SET revision=excluded.revision, token=excluded.token,
				due_at=excluded.due_at, attempts=0, error_code=NULL;
		END;
		CREATE TRIGGER memory_vector_delete AFTER DELETE ON memories
		WHEN OLD.status='verified' OR EXISTS (SELECT 1 FROM memory_vector_jobs WHERE project_id=OLD.project_id AND memory_id=OLD.id)
		BEGIN
			INSERT INTO memory_vector_jobs(project_id, memory_id, revision, token, due_at)
			VALUES (OLD.project_id, OLD.id, OLD.revision+1, lower(hex(randomblob(16))), 0)
			ON CONFLICT(project_id, memory_id) DO UPDATE SET revision=excluded.revision, token=excluded.token,
				due_at=excluded.due_at, attempts=0, error_code=NULL;
		END;
		INSERT INTO memory_vector_jobs(project_id, memory_id, revision, token, due_at)
			SELECT project_id, id, revision, lower(hex(randomblob(16))), 0 FROM memories WHERE status='verified';
	`);
}
