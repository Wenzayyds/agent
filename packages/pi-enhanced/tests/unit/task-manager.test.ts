import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { TaskError } from "../../src/task-manager/errors.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { createCheckpoint, recoveryPreflight } from "../../src/task-manager/recovery.ts";
import type { TaskManagerConfig } from "../../src/task-manager/config.ts";
import { TaskRuntime } from "../../src/task-manager/runtime.ts";
import { TaskService } from "../../src/task-manager/service.ts";

const roots: string[] = [];
const services: TaskService[] = [];
function fixture(): { service: TaskService; root: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-enhanced-task-")); roots.push(root); const project = join(root, "project"); const agentDir = join(root, "agent"); mkdirSync(project);
	const scope = createProjectScope({ cwd: project, agentDir }); const service = new TaskService(new TaskProvider(createTaskStorageScope(scope, agentDir)), 20); services.push(service); return { service, root: project, agentDir };
}
afterEach(() => { for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("P4 Task plan, state, evidence, and recovery", () => {
	it("persists a DAG, rejects cycles, and enforces plan CAS", () => {
		const { service } = fixture();
		expect(() => service.create("cycle", [{ stepId: "a", title: "A", expectedOutcome: "A done", dependsOn: ["b"] }, { stepId: "b", title: "B", expectedOutcome: "B done", dependsOn: ["a"] }], "s", null)).toThrowError(TaskError);
		const task = service.create("fix login", [{ stepId: "a", title: "locate", expectedOutcome: "function reference" }, { stepId: "b", title: "test", expectedOutcome: "exit code zero", dependsOn: ["a"] }], "s", "leaf");
		const replaced = service.replacePlan(task.task.taskId, 1, [{ stepId: "a", title: "locate logs", expectedOutcome: "line reference" }]);
		expect(replaced.task.planRevision).toBe(2);
		expect(() => service.replacePlan(task.task.taskId, 1, [{ title: "stale", expectedOutcome: "no" }])).toThrowError(expect.objectContaining({ code: "TASK_REVISION_CONFLICT" }));
	});

	it("does not accept model claims or settlement as completion evidence", () => {
		const { service } = fixture(); const created = service.create("verified work", [{ stepId: "a", title: "run tests", expectedOutcome: "real exit code" }], "s", null);
		let task = service.transitionTask(created.task.taskId, created.task.revision, "queued"); task = service.transitionTask(task.task.taskId, task.task.revision, "running");
		let step = task.steps[0]!; task = service.transitionStep(task.task.taskId, step.stepId, step.revision, "running"); step = task.steps[0]!; task = service.transitionStep(task.task.taskId, step.stepId, step.revision, "verifying");
		service.addEvidence({ taskId: task.task.taskId, stepId: step.stepId, kind: "claim", sourceRef: "model", outcome: "succeeded", confidenceClass: "model_claim", digestSource: "tests passed" });
		step = service.get(task.task.taskId)!.steps[0]!;
		expect(() => service.transitionStep(task.task.taskId, step.stepId, step.revision, "completed")).toThrowError(expect.objectContaining({ code: "TASK_INVALID_TRANSITION" }));
		service.addEvidence({ taskId: task.task.taskId, stepId: step.stepId, kind: "test_run", sourceRef: "runner", outcome: "succeeded", confidenceClass: "verified_by_runner", digestSource: "exit=0" });
		step = service.get(task.task.taskId)!.steps[0]!;
		expect(() => service.transitionStep(task.task.taskId, step.stepId, step.revision, "completed")).toThrowError(expect.objectContaining({ code: "TASK_INVALID_TRANSITION" }));
		service.addEvidence({ taskId: task.task.taskId, stepId: step.stepId, kind: "manual_review", sourceRef: "user", outcome: "succeeded", confidenceClass: "manual_attested", digestSource: "reviewed output" });
		step = service.get(task.task.taskId)!.steps[0]!; task = service.transitionStep(task.task.taskId, step.stepId, step.revision, "completed"); task = service.transitionTask(task.task.taskId, task.task.revision, "verifying");
		expect(service.transitionTask(task.task.taskId, task.task.revision, "completed").task.status).toBe("completed");
	});

	it("marks an interrupted mutating attempt for reconciliation and never allows automatic replay", () => {
		const { service, agentDir } = fixture(); const created = service.create("edit safely", [{ stepId: "a", title: "edit", expectedOutcome: "reviewed diff", riskClass: "mutating" }], "session-a", "leaf-a");
		service.provider.startAttempt({ attemptId: "attempt-a", taskId: created.task.taskId, stepId: "a", sessionId: "session-a", toolCallId: "call-a", toolName: "edit", state: "started", riskClass: "mutating", idempotencyKey: "key", inputDigest: "a".repeat(64), startedAt: Date.now() });
		const scope = service.provider.scope; service.close(); services.splice(services.indexOf(service), 1);
		const reopened = new TaskProvider(scope); services.push(new TaskService(reopened, 20));
		expect(reopened.markOpenAttemptsForReconciliation(Date.now())).toBe(1);
		const preflight = recoveryPreflight(reopened, created.task.taskId, "session-b", "leaf-b");
		expect(preflight.unknownStepIds).toEqual(["a"]); expect(preflight.automaticReplayAllowed).toBe(false); expect(preflight.requiresReconciliation).toBe(true); expect(reopened.verifyConsistency(created.task.taskId)).toBe(true);
		expect(agentDir).toContain("agent");
	});

	it("creates a checkpoint and distinguishes completed, failed, pending, and unknown steps", () => {
		const { service } = fixture(); const created = service.create("recover", [{ stepId: "done", title: "done", expectedOutcome: "evidence" }, { stepId: "pending", title: "pending", expectedOutcome: "later" }], "s", "leaf");
		createCheckpoint(service.provider, created, "s", "leaf"); const preflight = recoveryPreflight(service.provider, created.task.taskId, "s", "leaf");
		expect(preflight.pendingStepIds).toEqual(["done", "pending"]); expect(preflight.checkpointRevisionMatches).toBe(true); expect(preflight.automaticReplayAllowed).toBe(false);
	});

	it("isolates equal directory names by canonical project identity and rejects a newer schema", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-task-scope-")); roots.push(root); const agentDir = join(root, "agent"); const firstRoot = join(root, "one", "same"); const secondRoot = join(root, "two", "same"); mkdirSync(firstRoot, { recursive: true }); mkdirSync(secondRoot, { recursive: true });
		const firstScope = createTaskStorageScope(createProjectScope({ cwd: firstRoot, agentDir }), agentDir); const secondScope = createTaskStorageScope(createProjectScope({ cwd: secondRoot, agentDir }), agentDir); expect(firstScope.projectId).not.toBe(secondScope.projectId); expect(firstScope.databasePath).not.toBe(secondScope.databasePath);
		const first = new TaskService(new TaskProvider(firstScope), 10); const second = new TaskService(new TaskProvider(secondScope), 10); services.push(first, second); const created = first.create("isolated", [{ title: "one", expectedOutcome: "one" }], "s", null); expect(second.get(created.task.taskId)).toBeNull();
		first.close(); services.splice(services.indexOf(first), 1); const database = new DatabaseSync(firstScope.databasePath); database.prepare("INSERT INTO schema_migrations VALUES (99, ?)").run(Date.now()); database.close(); expect(() => new TaskProvider(firstScope)).toThrowError(/newer than supported/u);
	});

	it("fails closed on a busy or corrupt Task database without changing other module storage", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-task-storage-failure-")); roots.push(root);
		const project = join(root, "project"); const agentDir = join(root, "agent"); mkdirSync(project);
		const storage = createTaskStorageScope(createProjectScope({ cwd: project, agentDir }), agentDir);
		const initial = new TaskProvider(storage); initial.close();
		const lock = new DatabaseSync(storage.databasePath); lock.exec("BEGIN IMMEDIATE");
		try { expect(() => new TaskProvider(storage)).toThrowError(expect.objectContaining({ code: "TASK_STORAGE_ERROR" })); }
		finally { lock.exec("ROLLBACK"); lock.close(); }
		writeFileSync(storage.databasePath, "not-a-sqlite-database");
		expect(() => new TaskProvider(storage)).toThrowError(expect.objectContaining({ code: "TASK_STORAGE_ERROR" }));
	});

	it("upgrades an existing schema v1 database to v2 without losing tasks", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-task-v1-upgrade-")); roots.push(root);
		const project = join(root, "project"); const agentDir = join(root, "agent"); mkdirSync(project);
		const storage = createTaskStorageScope(createProjectScope({ cwd: project, agentDir }), agentDir);
		const initial = new TaskService(new TaskProvider(storage), 10);
		const created = initial.create("keep across migration", [{ stepId: "s", title: "inspect", expectedOutcome: "preserved" }], "s", null);
		createCheckpoint(initial.provider, created, "s", null);
		initial.close();
		const v1 = new DatabaseSync(storage.databasePath);
		v1.exec(`
			ALTER TABLE task_steps DROP COLUMN validation_json;
			ALTER TABLE task_evidence DROP COLUMN attempt_id;
			ALTER TABLE task_evidence DROP COLUMN input_digest;
			ALTER TABLE task_evidence DROP COLUMN result_digest;
			ALTER TABLE task_attempts DROP COLUMN input_digest;
			ALTER TABLE task_checkpoints DROP COLUMN workspace_json;
			ALTER TABLE task_checkpoints DROP COLUMN plan_revision;
			DELETE FROM schema_migrations WHERE version=2;
		`);
		v1.close();
		const upgraded = new TaskService(new TaskProvider(storage), 10); services.push(upgraded);
		expect(upgraded.get(created.task.taskId)).toMatchObject({
			task: { goal: "keep across migration" },
			lastCheckpoint: { planRevision: 1, workspaceObservation: { realRoot: "" } },
		});
		const database = new DatabaseSync(storage.databasePath);
		expect((database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(2);
		database.close();
	});

	it("tracks parallel, nested, blocked, out-of-order, duplicate, and missing-end tool events by real ids", () => {
		const { service } = fixture(); const created = service.create("observe tools", [{ stepId: "a", title: "observe", expectedOutcome: "bounded evidence" }], "session", null); service.bind(created.task.taskId, "a", "session", null);
		const config: TaskManagerConfig = { enabled: true, modelPlanTool: false, contextSummary: false, maximumTasks: 20, maximumSteps: 20, maximumEvents: 1000 };
		const runtime = new TaskRuntime("ready", config, undefined, undefined, service); const ctx = { sessionManager: { getSessionId: () => "session" } } as ExtensionContext;
		runtime.onToolEnd({ type: "tool_execution_end", toolCallId: "out-of-order", toolName: "read", result: {}, isError: false }, ctx);
		runtime.onToolStart({ type: "tool_execution_start", toolCallId: "parallel-a", toolName: "read", args: { path: "secret-not-stored" } }, ctx);
		runtime.onToolStart({ type: "tool_execution_start", toolCallId: "parallel-b", toolName: "unknown_mcp", args: { token: "secret-not-stored" } }, ctx);
		runtime.onToolStart({ type: "tool_execution_start", toolCallId: "parallel-a/1", parentToolCallId: "parallel-a", toolName: "grep", args: {} }, ctx);
		runtime.onToolEnd({ type: "tool_execution_end", toolCallId: "parallel-b", toolName: "unknown_mcp", result: { error: "blocked" }, isError: true }, ctx);
		runtime.onToolEnd({ type: "tool_execution_end", toolCallId: "parallel-a/1", parentToolCallId: "parallel-a", toolName: "grep", result: {}, isError: false }, ctx);
		runtime.onToolEnd({ type: "tool_execution_end", toolCallId: "parallel-a", toolName: "read", result: {}, isError: false }, ctx);
		runtime.onToolEnd({ type: "tool_execution_end", toolCallId: "parallel-a", toolName: "read", result: {}, isError: false }, ctx);
		runtime.onToolStart({ type: "tool_execution_start", toolCallId: "missing-end", toolName: "edit", args: { path: "x" } }, ctx);
		const attempts = service.provider.getAttempts(created.task.taskId); expect(attempts).toHaveLength(4); expect(attempts.find(({ toolCallId }) => toolCallId === "parallel-a/1")?.parentToolCallId).toBe("parallel-a"); expect(attempts.find(({ toolCallId }) => toolCallId === "parallel-b")?.state).toBe("failed");
		expect(service.get(created.task.taskId)?.evidence).toHaveLength(3); expect(JSON.stringify(service.get(created.task.taskId))).not.toContain("secret-not-stored"); expect(service.provider.markOpenAttemptsForReconciliation(Date.now())).toBe(1);
	});
});
