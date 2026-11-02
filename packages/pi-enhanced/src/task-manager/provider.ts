import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectScope } from "../memory/contracts.ts";
import type { TaskAttempt, TaskCheckpoint, TaskEvidence, TaskRecord, TaskSnapshot, TaskStep } from "./contracts.ts";
import { TaskError } from "./errors.ts";

const SCHEMA_VERSION = 2;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;

export interface TaskStorageScope {
	projectId: string;
	rootPath: string;
	dataDir: string;
	manifestPath: string;
	databasePath: string;
}

export function createTaskStorageScope(project: ProjectScope, agentDir: string): TaskStorageScope {
	const dataDir = join(agentDir, "pi-enhanced", "tasks", "projects", project.projectId);
	return {
		projectId: project.projectId,
		rootPath: project.rootPath,
		dataDir,
		manifestPath: join(dataDir, "project.json"),
		databasePath: join(dataDir, "tasks.sqlite3"),
	};
}

export class TaskProvider {
	readonly scope: TaskStorageScope;
	private readonly database: DatabaseSync;
	private readonly maximumTasks: number;
	private readonly maximumEvents: number;
	private closed = false;

	constructor(scope: TaskStorageScope, limits: { maximumTasks?: number; maximumEvents?: number } = {}) {
		this.scope = scope;
		this.maximumTasks = limits.maximumTasks ?? 200;
		this.maximumEvents = limits.maximumEvents ?? 10_000;
		ensureStorage(scope);
		this.database = new DatabaseSync(scope.databasePath, { enableForeignKeyConstraints: true, timeout: 1_500 });
		try {
			this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
			runTaskMigrations(this.database);
			configureSize(this.database);
		} catch (error) {
			this.database.close();
			throw storageError("Task storage initialization failed", error);
		}
	}

	create(task: TaskRecord, steps: readonly TaskStep[], sessionId: string, branchLeafId: string | null): TaskSnapshot {
		return this.transaction(() => {
			const count = this.database
				.prepare("SELECT count(*) AS count FROM tasks WHERE project_id=?")
				.get(this.scope.projectId) as { count: number };
			if (count.count >= this.maximumTasks)
				throw new TaskError("TASK_STORAGE_ERROR", "Task database reached its hard task limit");
			this.database
				.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(
					task.taskId,
					task.projectId,
					task.goal,
					task.status,
					task.revision,
					task.planRevision,
					task.acceptancePolicy,
					task.createdAt,
					task.updatedAt,
				);
			for (const step of steps) this.insertStep(step);
			this.bindSession(task.taskId, sessionId, branchLeafId, "created", task.createdAt);
			this.appendEvent(
				task.taskId,
				"task_created",
				`session:${sessionId}`,
				{ revision: task.revision, stepIds: steps.map(({ stepId }) => stepId) },
				task.createdAt,
			);
			this.writeSnapshot(task.taskId, task.createdAt);
			return { task, steps: [...steps], evidence: [], lastCheckpoint: null };
		});
	}

	list(limit = 50): TaskRecord[] {
		this.assertOpen();
		return (
			this.database
				.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC LIMIT ?")
				.all(this.scope.projectId, limit) as unknown as TaskRow[]
		).map(taskFromRow);
	}

	get(taskId: string): TaskSnapshot | null {
		this.assertOpen();
		const row = this.database
			.prepare("SELECT * FROM tasks WHERE task_id=? AND project_id=?")
			.get(taskId, this.scope.projectId) as TaskRow | undefined;
		if (!row) return null;
		const steps = (
			this.database
				.prepare("SELECT * FROM task_steps WHERE task_id=? ORDER BY ordinal")
				.all(taskId) as unknown as StepRow[]
		).map(stepFromRow);
		const evidence = (
			this.database
				.prepare("SELECT * FROM task_evidence WHERE task_id=? ORDER BY observed_at, evidence_id")
				.all(taskId) as unknown as EvidenceRow[]
		).map(evidenceFromRow);
		const checkpoint = this.database
			.prepare("SELECT * FROM task_checkpoints WHERE task_id=? ORDER BY created_at DESC LIMIT 1")
			.get(taskId) as CheckpointRow | undefined;
		return {
			task: taskFromRow(row),
			steps,
			evidence,
			lastCheckpoint: checkpoint ? checkpointFromRow(checkpoint) : null,
		};
	}

	replacePlan(taskId: string, expectedPlanRevision: number, steps: readonly TaskStep[], now: number): TaskSnapshot {
		return this.transaction(() => {
			const current = this.require(taskId);
			if (current.task.planRevision !== expectedPlanRevision || current.task.status !== "draft")
				throw new TaskError("TASK_REVISION_CONFLICT", "Task plan changed or is no longer a draft");
			this.database.prepare("DELETE FROM task_steps WHERE task_id=?").run(taskId);
			for (const step of steps) this.insertStep(step);
			const changed = this.database
				.prepare(
					"UPDATE tasks SET revision=revision+1, plan_revision=plan_revision+1, updated_at=? WHERE task_id=? AND project_id=? AND plan_revision=?",
				)
				.run(now, taskId, this.scope.projectId, expectedPlanRevision);
			if (changed.changes !== 1) throw new TaskError("TASK_REVISION_CONFLICT", "Task plan changed concurrently");
			this.appendEvent(
				taskId,
				"plan_replaced",
				"user",
				{ expectedPlanRevision, stepIds: steps.map(({ stepId }) => stepId) },
				now,
			);
			this.writeSnapshot(taskId, now);
			return this.require(taskId);
		});
	}

	setTaskStatus(
		taskId: string,
		expectedRevision: number,
		status: TaskRecord["status"],
		sourceRef: string,
		now: number,
	): TaskSnapshot {
		return this.transaction(() => {
			const changed = this.database
				.prepare(
					"UPDATE tasks SET status=?, revision=revision+1, updated_at=? WHERE task_id=? AND project_id=? AND revision=?",
				)
				.run(status, now, taskId, this.scope.projectId, expectedRevision);
			if (changed.changes !== 1) this.throwMissingOrConflict(taskId);
			this.appendEvent(taskId, "task_status_changed", sourceRef, { fromRevision: expectedRevision, status }, now);
			this.writeSnapshot(taskId, now);
			return this.require(taskId);
		});
	}

	setStepStatus(
		taskId: string,
		stepId: string,
		expectedRevision: number,
		status: TaskStep["status"],
		sourceRef: string,
		now: number,
	): TaskSnapshot {
		return this.transaction(() => {
			this.require(taskId);
			const changed = this.database
				.prepare("UPDATE task_steps SET status=?, revision=revision+1 WHERE step_id=? AND task_id=? AND revision=?")
				.run(status, stepId, taskId, expectedRevision);
			if (changed.changes !== 1)
				throw new TaskError("TASK_REVISION_CONFLICT", "Task step changed or does not exist");
			this.database
				.prepare("UPDATE tasks SET revision=revision+1, updated_at=? WHERE task_id=? AND project_id=?")
				.run(now, taskId, this.scope.projectId);
			this.appendEvent(
				taskId,
				"step_status_changed",
				sourceRef,
				{ stepId, status, fromRevision: expectedRevision },
				now,
			);
			this.writeSnapshot(taskId, now);
			return this.require(taskId);
		});
	}

	addEvidence(value: TaskEvidence): TaskSnapshot {
		return this.transaction(() => {
			this.require(value.taskId);
			this.database
				.prepare(
					"INSERT OR IGNORE INTO task_evidence (evidence_id, task_id, step_id, kind, source_ref, tool_call_id, outcome, confidence_class, observed_at, digest, attempt_id, input_digest, result_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					value.evidenceId,
					value.taskId,
					value.stepId,
					value.kind,
					value.sourceRef,
					value.toolCallId ?? null,
					value.outcome,
					value.confidenceClass,
					value.observedAt,
					value.digest,
					value.attemptId ?? null,
					value.inputDigest ?? null,
					value.resultDigest ?? null,
				);
			this.database
				.prepare("UPDATE tasks SET revision=revision+1, updated_at=? WHERE task_id=? AND project_id=?")
				.run(value.observedAt, value.taskId, this.scope.projectId);
			this.appendEvent(
				value.taskId,
				"evidence_recorded",
				value.sourceRef,
				{
					evidenceId: value.evidenceId,
					stepId: value.stepId,
					confidenceClass: value.confidenceClass,
					outcome: value.outcome,
				},
				value.observedAt,
			);
			this.writeSnapshot(value.taskId, value.observedAt);
			return this.require(value.taskId);
		});
	}

	startAttempt(value: TaskAttempt): void {
		this.transaction(() => {
			this.require(value.taskId);
			const inserted = this.database
				.prepare(
					"INSERT OR IGNORE INTO task_attempts (attempt_id, task_id, step_id, session_id, tool_call_id, parent_tool_call_id, tool_name, state, risk_class, idempotency_key, started_at, ended_at, result_digest, input_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					value.attemptId,
					value.taskId,
					value.stepId,
					value.sessionId,
					value.toolCallId,
					value.parentToolCallId ?? null,
					value.toolName,
					value.state,
					value.riskClass,
					value.idempotencyKey,
					value.startedAt,
					null,
					null,
					value.inputDigest,
				);
			if (inserted.changes !== 1) return;
			this.appendEvent(
				value.taskId,
				"attempt_started",
				`tool:${value.toolCallId}`,
				{ attemptId: value.attemptId, stepId: value.stepId, toolName: value.toolName, riskClass: value.riskClass },
				value.startedAt,
			);
		});
	}

	endAttempt(
		taskId: string,
		toolCallId: string,
		state: "succeeded" | "failed",
		resultDigest: string,
		now: number,
	): TaskAttempt | null {
		return this.transaction(() => {
			const row = this.database
				.prepare("SELECT * FROM task_attempts WHERE task_id=? AND tool_call_id=?")
				.get(taskId, toolCallId) as AttemptRow | undefined;
			if (!row) return null;
			if (row.state !== "started") return null;
			this.database
				.prepare(
					"UPDATE task_attempts SET state=?, ended_at=?, result_digest=? WHERE attempt_id=? AND state='started'",
				)
				.run(state, now, resultDigest, row.attempt_id);
			this.appendEvent(
				taskId,
				"attempt_ended",
				`tool:${toolCallId}`,
				{ attemptId: row.attempt_id, state, resultDigest },
				now,
			);
			return attemptFromRow({ ...row, state, ended_at: now, result_digest: resultDigest });
		});
	}

	markOpenAttemptsForReconciliation(now: number): number {
		return this.transaction(() => {
			const rows = this.database
				.prepare("SELECT * FROM task_attempts WHERE state='started'")
				.all() as unknown as AttemptRow[];
			for (const row of rows) {
				this.database
					.prepare("UPDATE task_attempts SET state='needs_reconciliation', ended_at=? WHERE attempt_id=?")
					.run(now, row.attempt_id);
				this.database
					.prepare(
						"UPDATE task_steps SET status='needs_reconciliation', revision=revision+1 WHERE step_id=? AND status='running'",
					)
					.run(row.step_id);
				this.database
					.prepare(
						"UPDATE tasks SET status='needs_reconciliation', revision=revision+1, updated_at=? WHERE task_id=? AND status NOT IN ('completed','failed','cancelled')",
					)
					.run(now, row.task_id);
				this.appendEvent(
					row.task_id,
					"attempt_interrupted",
					`tool:${row.tool_call_id}`,
					{ attemptId: row.attempt_id, riskClass: row.risk_class },
					now,
				);
				this.writeSnapshot(row.task_id, now);
			}
			return rows.length;
		});
	}

	reconcileAttempt(
		taskId: string,
		attemptId: string,
		action: "do_not_retry" | "external_success",
		sourceRef: string,
		now: number,
	): TaskAttempt {
		return this.transaction(() => {
			const row = this.database
				.prepare("SELECT * FROM task_attempts WHERE task_id=? AND attempt_id=?")
				.get(taskId, attemptId) as AttemptRow | undefined;
			if (!row) throw new TaskError("TASK_NOT_FOUND", "Task attempt does not exist");
			if (row.state !== "needs_reconciliation")
				throw new TaskError("TASK_INVALID_TRANSITION", "Task attempt is not awaiting reconciliation");
			const attemptState = action === "do_not_retry" ? "reconciled_no_retry" : "reconciled_external_success";
			const stepState = action === "do_not_retry" ? "failed" : "verifying";
			const taskState = action === "do_not_retry" ? "blocked" : "verifying";
			this.database
				.prepare("UPDATE task_attempts SET state=?, ended_at=? WHERE attempt_id=?")
				.run(attemptState, now, attemptId);
			this.database
				.prepare("UPDATE task_steps SET status=?, revision=revision+1 WHERE step_id=? AND task_id=?")
				.run(stepState, row.step_id, taskId);
			this.database
				.prepare(
					"UPDATE tasks SET status=?, revision=revision+1, updated_at=? WHERE task_id=? AND project_id=? AND status='needs_reconciliation'",
				)
				.run(taskState, now, taskId, this.scope.projectId);
			this.appendEvent(taskId, "attempt_reconciled", sourceRef, { attemptId, action, stepId: row.step_id }, now);
			this.writeSnapshot(taskId, now);
			return attemptFromRow({ ...row, state: attemptState, ended_at: now });
		});
	}

	createCheckpoint(value: TaskCheckpoint): TaskCheckpoint {
		return this.transaction(() => {
			const current = this.require(value.taskId);
			if (current.task.revision !== value.taskRevision)
				throw new TaskError("TASK_REVISION_CONFLICT", "Checkpoint task revision is stale");
			this.database
				.prepare(
					"INSERT INTO task_checkpoints (checkpoint_id, task_id, task_revision, session_id, branch_leaf_id, workspace_fingerprint, pending_ids_json, last_event_seq, created_at, workspace_json, plan_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					value.checkpointId,
					value.taskId,
					value.taskRevision,
					value.sessionId,
					value.branchLeafId,
					value.workspaceFingerprint,
					JSON.stringify(value.pendingStepIds),
					value.lastCommittedEventSeq,
					value.createdAt,
					JSON.stringify(value.workspaceObservation),
					value.planRevision,
				);
			this.appendEvent(
				value.taskId,
				"checkpoint_created",
				`session:${value.sessionId}`,
				{ checkpointId: value.checkpointId, taskRevision: value.taskRevision },
				value.createdAt,
			);
			return value;
		});
	}

	bindSession(taskId: string, sessionId: string, branchLeafId: string | null, reason: string, now: number): void {
		this.database
			.prepare("INSERT OR IGNORE INTO task_session_bindings VALUES (?, ?, ?, ?, ?)")
			.run(taskId, sessionId, branchLeafId ?? "", now, reason.slice(0, 100));
	}

	getLastEventSeq(taskId: string): number {
		return (
			this.database.prepare("SELECT COALESCE(max(seq),0) AS seq FROM task_events WHERE task_id=?").get(taskId) as {
				seq: number;
			}
		).seq;
	}

	getAttempts(taskId: string): TaskAttempt[] {
		return (
			this.database
				.prepare("SELECT * FROM task_attempts WHERE task_id=? ORDER BY started_at, attempt_id")
				.all(taskId) as unknown as AttemptRow[]
		).map(attemptFromRow);
	}

	hasSessionBinding(taskId: string, sessionId: string, branchLeafId: string | null): boolean {
		this.assertOpen();
		return Boolean(
			this.database
				.prepare("SELECT 1 FROM task_session_bindings WHERE task_id=? AND session_id=? AND branch_leaf_id=?")
				.get(taskId, sessionId, branchLeafId ?? ""),
		);
	}

	verifyConsistency(taskId: string): boolean {
		this.assertOpen();
		const current = this.get(taskId);
		if (!current) return false;
		const events = this.database
			.prepare("SELECT seq, payload_json, payload_hash FROM task_events WHERE task_id=? ORDER BY seq")
			.all(taskId) as unknown as Array<{ seq: number; payload_json: string; payload_hash: string }>;
		if (
			events.some(
				(event, index) =>
					event.seq !== index + 1 ||
					createHash("sha256").update(event.payload_json).digest("hex") !== event.payload_hash,
			)
		)
			return false;
		const stored = this.database
			.prepare(
				"SELECT snapshot_json, snapshot_hash, event_seq FROM task_snapshots WHERE task_id=? ORDER BY revision DESC LIMIT 1",
			)
			.get(taskId) as { snapshot_json: string; snapshot_hash: string; event_seq: number } | undefined;
		if (
			!stored ||
			stored.event_seq > events.length ||
			createHash("sha256").update(stored.snapshot_json).digest("hex") !== stored.snapshot_hash
		)
			return false;
		return stored.snapshot_json === this.snapshotJson(current);
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.database.close();
		}
	}

	private require(taskId: string): TaskSnapshot {
		const value = this.get(taskId);
		if (!value) throw new TaskError("TASK_NOT_FOUND", "Task does not exist in the current project");
		return value;
	}
	private insertStep(step: TaskStep): void {
		this.database
			.prepare(
				"INSERT INTO task_steps (step_id, task_id, ordinal, title, expected_outcome, depends_on_json, status, revision, risk_class, validation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				step.stepId,
				step.taskId,
				step.ordinal,
				step.title,
				step.expectedOutcome,
				JSON.stringify(step.dependsOn),
				step.status,
				step.revision,
				step.riskClass,
				step.validation ? JSON.stringify(step.validation) : null,
			);
	}
	private appendEvent(taskId: string, type: string, sourceRef: string, payload: unknown, now: number): void {
		const json = JSON.stringify(payload).slice(0, 8_000);
		const seq = this.getLastEventSeq(taskId) + 1;
		if (seq > this.maximumEvents) throw new TaskError("TASK_STORAGE_ERROR", "Task event limit reached");
		this.database
			.prepare(
				"INSERT INTO task_events (task_id, seq, type, source_ref, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(taskId, seq, type, sourceRef.slice(0, 300), json, createHash("sha256").update(json).digest("hex"), now);
	}

	private writeSnapshot(taskId: string, now: number): void {
		const current = this.require(taskId);
		const json = this.snapshotJson(current);
		this.database
			.prepare(
				"INSERT OR REPLACE INTO task_snapshots (task_id, revision, snapshot_json, snapshot_hash, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				taskId,
				current.task.revision,
				json,
				createHash("sha256").update(json).digest("hex"),
				this.getLastEventSeq(taskId),
				now,
			);
	}

	private snapshotJson(snapshot: TaskSnapshot): string {
		return JSON.stringify({ task: snapshot.task, steps: snapshot.steps, evidence: snapshot.evidence });
	}
	private transaction<T>(operation: () => T): T {
		this.assertOpen();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.database.isTransaction) this.database.exec("ROLLBACK");
			throw error;
		}
	}
	private throwMissingOrConflict(taskId: string): never {
		const exists = this.database
			.prepare("SELECT 1 FROM tasks WHERE task_id=? AND project_id=?")
			.get(taskId, this.scope.projectId);
		if (!exists) throw new TaskError("TASK_NOT_FOUND", "Task does not exist in the current project");
		throw new TaskError("TASK_REVISION_CONFLICT", "Task changed since it was read");
	}
	private assertOpen(): void {
		if (this.closed) throw new TaskError("TASK_RUNTIME_UNAVAILABLE", "Task storage is closed");
	}
}

export function runTaskMigrations(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, plan_revision INTEGER NOT NULL, acceptance_policy TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS task_steps (step_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, title TEXT NOT NULL, expected_outcome TEXT NOT NULL, depends_on_json TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, risk_class TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS task_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL, source_ref TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(task_id, seq));
			CREATE TABLE IF NOT EXISTS task_snapshots (task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, event_seq INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(task_id, revision));
			CREATE TABLE IF NOT EXISTS task_evidence (evidence_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE, step_id TEXT NOT NULL REFERENCES task_steps(step_id) ON DELETE CASCADE, kind TEXT NOT NULL, source_ref TEXT NOT NULL, tool_call_id TEXT, outcome TEXT NOT NULL, confidence_class TEXT NOT NULL, observed_at INTEGER NOT NULL, digest TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS task_attempts (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE, step_id TEXT NOT NULL REFERENCES task_steps(step_id) ON DELETE CASCADE, session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, parent_tool_call_id TEXT, tool_name TEXT NOT NULL, state TEXT NOT NULL, risk_class TEXT NOT NULL, idempotency_key TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, result_digest TEXT, UNIQUE(task_id, tool_call_id));
			CREATE TABLE IF NOT EXISTS task_checkpoints (checkpoint_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE, task_revision INTEGER NOT NULL, session_id TEXT NOT NULL, branch_leaf_id TEXT, workspace_fingerprint TEXT NOT NULL, pending_ids_json TEXT NOT NULL, last_event_seq INTEGER NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS task_session_bindings (task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE, session_id TEXT NOT NULL, branch_leaf_id TEXT NOT NULL DEFAULT '', bound_at INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(task_id, session_id, branch_leaf_id));
			CREATE INDEX IF NOT EXISTS tasks_project_updated ON tasks(project_id, updated_at DESC);
			CREATE INDEX IF NOT EXISTS task_events_task_seq ON task_events(task_id, seq);
			CREATE INDEX IF NOT EXISTS task_attempts_open ON task_attempts(state, task_id);
		`);
		const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as {
			version: number;
		}[];
		if (versions.some(({ version }) => version > SCHEMA_VERSION))
			throw new Error(`Task schema is newer than supported version ${SCHEMA_VERSION}`);
		if (!versions.some(({ version }) => version === 1))
			database.prepare("INSERT INTO schema_migrations VALUES (1, ?)").run(Date.now());
		if (!versions.some(({ version }) => version === 2)) {
			database.exec(`
				ALTER TABLE task_steps ADD COLUMN validation_json TEXT;
				ALTER TABLE task_evidence ADD COLUMN attempt_id TEXT;
				ALTER TABLE task_evidence ADD COLUMN input_digest TEXT;
				ALTER TABLE task_evidence ADD COLUMN result_digest TEXT;
				ALTER TABLE task_attempts ADD COLUMN input_digest TEXT NOT NULL DEFAULT '';
				ALTER TABLE task_checkpoints ADD COLUMN workspace_json TEXT NOT NULL DEFAULT '{}';
				ALTER TABLE task_checkpoints ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 1;
			`);
			database.prepare("INSERT INTO schema_migrations VALUES (2, ?)").run(Date.now());
		}
		database.exec("COMMIT");
	} catch (error) {
		if (database.isTransaction) database.exec("ROLLBACK");
		throw error;
	}
}

function ensureStorage(scope: TaskStorageScope): void {
	mkdirSync(scope.dataDir, { recursive: true });
	const expected = { schemaVersion: 1, projectId: scope.projectId, rootPath: scope.rootPath };
	if (existsSync(scope.manifestPath)) {
		try {
			const current = JSON.parse(readFileSync(scope.manifestPath, "utf8"));
			if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("manifest mismatch");
		} catch (error) {
			throw storageError("Task project manifest is invalid", error);
		}
		return;
	}
	const temporary = join(scope.dataDir, `.${basename(scope.manifestPath)}.${process.pid}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx" });
	renameSync(temporary, scope.manifestPath);
}
function configureSize(database: DatabaseSync): void {
	const pageSize = (database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
	database.exec(`PRAGMA max_page_count=${Math.floor(MAX_DATABASE_BYTES / pageSize)}`);
}
function storageError(message: string, error: unknown): TaskError {
	return error instanceof TaskError
		? error
		: new TaskError("TASK_STORAGE_ERROR", `${message}: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
}

interface TaskRow {
	task_id: string;
	project_id: string;
	goal: string;
	status: TaskRecord["status"];
	revision: number;
	plan_revision: number;
	acceptance_policy: "user_confirmed";
	created_at: number;
	updated_at: number;
}
interface StepRow {
	step_id: string;
	task_id: string;
	ordinal: number;
	title: string;
	expected_outcome: string;
	depends_on_json: string;
	status: TaskStep["status"];
	revision: number;
	risk_class: TaskStep["riskClass"];
	validation_json: string | null;
}
interface EvidenceRow {
	evidence_id: string;
	task_id: string;
	step_id: string;
	kind: string;
	source_ref: string;
	tool_call_id: string | null;
	outcome: TaskEvidence["outcome"];
	confidence_class: TaskEvidence["confidenceClass"];
	observed_at: number;
	digest: string;
	attempt_id: string | null;
	input_digest: string | null;
	result_digest: string | null;
}
interface AttemptRow {
	attempt_id: string;
	task_id: string;
	step_id: string;
	session_id: string;
	tool_call_id: string;
	parent_tool_call_id: string | null;
	tool_name: string;
	state: TaskAttempt["state"];
	risk_class: TaskAttempt["riskClass"];
	idempotency_key: string;
	started_at: number;
	ended_at: number | null;
	result_digest: string | null;
	input_digest: string;
}
interface CheckpointRow {
	checkpoint_id: string;
	task_id: string;
	task_revision: number;
	session_id: string;
	branch_leaf_id: string | null;
	workspace_fingerprint: string;
	pending_ids_json: string;
	last_event_seq: number;
	created_at: number;
	workspace_json: string;
	plan_revision: number;
}
function taskFromRow(row: TaskRow): TaskRecord {
	return {
		taskId: row.task_id,
		projectId: row.project_id,
		goal: row.goal,
		status: row.status,
		revision: row.revision,
		planRevision: row.plan_revision,
		acceptancePolicy: row.acceptance_policy,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
function stepFromRow(row: StepRow): TaskStep {
	return {
		stepId: row.step_id,
		taskId: row.task_id,
		ordinal: row.ordinal,
		title: row.title,
		expectedOutcome: row.expected_outcome,
		dependsOn: parseStrings(row.depends_on_json),
		status: row.status,
		revision: row.revision,
		riskClass: row.risk_class,
		...(row.validation_json ? { validation: parseValidation(row.validation_json) } : {}),
	};
}
function evidenceFromRow(row: EvidenceRow): TaskEvidence {
	return {
		evidenceId: row.evidence_id,
		taskId: row.task_id,
		stepId: row.step_id,
		kind: row.kind,
		sourceRef: row.source_ref,
		...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
		...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
		outcome: row.outcome,
		confidenceClass: row.confidence_class,
		observedAt: row.observed_at,
		digest: row.digest,
		...(row.input_digest ? { inputDigest: row.input_digest } : {}),
		...(row.result_digest ? { resultDigest: row.result_digest } : {}),
	};
}
function attemptFromRow(row: AttemptRow): TaskAttempt {
	return {
		attemptId: row.attempt_id,
		taskId: row.task_id,
		stepId: row.step_id,
		sessionId: row.session_id,
		toolCallId: row.tool_call_id,
		...(row.parent_tool_call_id ? { parentToolCallId: row.parent_tool_call_id } : {}),
		toolName: row.tool_name,
		state: row.state,
		riskClass: row.risk_class,
		idempotencyKey: row.idempotency_key,
		inputDigest: row.input_digest,
		startedAt: row.started_at,
		...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
		...(row.result_digest ? { resultDigest: row.result_digest } : {}),
	};
}
function checkpointFromRow(row: CheckpointRow): TaskCheckpoint {
	return {
		checkpointId: row.checkpoint_id,
		taskId: row.task_id,
		taskRevision: row.task_revision,
		planRevision: row.plan_revision,
		sessionId: row.session_id,
		branchLeafId: row.branch_leaf_id,
		workspaceFingerprint: row.workspace_fingerprint,
		workspaceObservation: parseWorkspaceObservation(row.workspace_json),
		pendingStepIds: parseStrings(row.pending_ids_json),
		lastCommittedEventSeq: row.last_event_seq,
		createdAt: row.created_at,
	};
}

function parseValidation(value: string): TaskStep["validation"] {
	try {
		return JSON.parse(value) as TaskStep["validation"];
	} catch (error) {
		throw new TaskError("TASK_STORAGE_ERROR", "Stored validation JSON is invalid", { cause: error });
	}
}

function parseWorkspaceObservation(value: string): TaskCheckpoint["workspaceObservation"] {
	try {
		const parsed = JSON.parse(value) as Partial<TaskCheckpoint["workspaceObservation"]>;
		return {
			realRoot: typeof parsed.realRoot === "string" ? parsed.realRoot : "",
			gitStatusEntries: Number.isSafeInteger(parsed.gitStatusEntries) ? (parsed.gitStatusEntries as number) : 0,
			trackedFiles: Array.isArray(parsed.trackedFiles) ? parsed.trackedFiles : [],
			...(typeof parsed.gitHead === "string" ? { gitHead: parsed.gitHead } : {}),
			...(typeof parsed.gitStatusDigest === "string" ? { gitStatusDigest: parsed.gitStatusDigest } : {}),
		};
	} catch (error) {
		throw new TaskError("TASK_STORAGE_ERROR", "Stored workspace observation is invalid", { cause: error });
	}
}
function parseStrings(value: string): string[] {
	const result: unknown = JSON.parse(value);
	if (!Array.isArray(result) || !result.every((item) => typeof item === "string"))
		throw new TaskError("TASK_STORAGE_ERROR", "Stored task JSON is invalid");
	return result;
}
