import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicPrivateJson, readSandboxAuditSnapshot } from "../../src/sandbox/audit.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import { createCheckpoint, recoveryPreflight, workspaceFingerprint } from "../../src/task-manager/recovery.ts";
import { parseAgentEvents } from "./evaluation-policy.ts";
import type { AgentExecution } from "./runner-execution.ts";
import type { PreparedAgent, RunnerContext } from "./runner-preparation.ts";

const statePath = (root: string) => join(root, "pause.json");
export const resumeSessionPath = (root: string) => join(root, "agent-session.jsonl");

function readPrivateFile(path: string): Buffer {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(dirname(path)) !== realpathSync(dirname(realpathSync(path))) ||
		stat.size > 8 * 1024 * 1024) throw new Error("EVAL_V3_RESUME_FILE_INVALID");
	return readFileSync(path);
}

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function identity(context: RunnerContext) {
	return hash(JSON.stringify({
		task: context.task.id, prompt: context.task.prompt, plan: context.plan,
		switches: context.switches, condition: context.condition, testFeedback: context.testFeedback,
		upstream: context.localStubUrl,
	}));
}

function auditPath(context: RunnerContext) {
	return join(context.root, context.task.id + "-sandbox-audit.json");
}

function openTask(prepared: PreparedAgent): TaskService {
	const { cwd, agentDir } = prepared;
	return new TaskService(new TaskProvider(createTaskStorageScope(createProjectScope({ cwd, agentDir }), agentDir)), 20);
}

function completeStep(service: TaskService, taskId: string, stepId: string, evidence: string): void {
	const step = service.get(taskId)?.steps.find((step) => step.stepId === stepId);
	if (!step || step.status !== "pending") throw new Error("EVAL_V3_RECOVERY_STEP_INVALID");
	const active = service.transitionStep(taskId, stepId, step.revision, "running", "runner:observed");
	service.addEvidence({
		taskId, stepId, kind: "isolated_validation", sourceRef: "runner:isolated-validation",
		outcome: "succeeded", confidenceClass: "validated", digestSource: evidence,
	});
	const verifying = service.transitionStep(taskId, stepId, active.steps.find((s) => s.stepId === stepId)!.revision, "verifying", "runner:observed");
	service.transitionStep(taskId, stepId, verifying.steps.find((s) => s.stepId === stepId)!.revision, "completed", "runner:verified");
}

export function saveSuspendedRun(context: RunnerContext, prepared: PreparedAgent, execution: AgentExecution): void {
	const audit = readSandboxAuditSnapshot(auditPath(context));
	execution.telemetry?.finish(execution.gatewayStatus, audit);
	if (audit.complete !== true || !prepared.seededTaskId) throw new Error("EVAL_V3_PAUSE_UNSAFE");
	const tests = parseAgentEvents(execution.child.stdout ?? "").filter((event) =>
		event.type === "tool_execution_start" && event.toolName === "run_tests");
	const failedTest = parseAgentEvents(execution.child.stdout ?? "").find((event) => {
		const details = (event.result as { details?: { status?: string; exitCode?: number } } | undefined)?.details;
		return event.type === "tool_execution_end" && event.toolName === "run_tests" &&
			details?.status === "verification_failed" && details.exitCode === 1;
	});
	// The supported pause boundary is the initial test observation and a pristine worktree.
	if (tests.length !== 1 || !failedTest || execution.verification?.status !== "verification_failed" ||
		(audit.audit as Array<{ operation: string }>).some(({ operation }) => operation === "write_file"))
		throw new Error("EVAL_V3_PAUSE_REQUIRES_FAILED_TEST_WITHOUT_WRITE");
	const service = openTask(prepared);
	try {
		const taskId = prepared.seededTaskId;
		completeStep(service, taskId, "reproduce", JSON.stringify(failedTest.result));
		const task = service.get(taskId)!.task;
		const paused = service.transitionTask(taskId, task.revision, "paused", "runner:verified-pause");
		createCheckpoint(service.provider, paused, "controlled-pilot-host", null, ["config.js"]);
	} finally { service.close(); }
	const state = {
		version: 1, identity: identity(context), prepared,
		workspace: workspaceFingerprint(prepared.cwd, ["config.js"]),
		sessionSha256: hash(readPrivateFile(resumeSessionPath(context.root))),
		auditSha256: hash(readPrivateFile(auditPath(context))),
	};
	const body = JSON.stringify(state);
	atomicPrivateJson(statePath(context.root), { body, sha256: hash(body) });
}

export function loadSuspendedRun(context: RunnerContext): PreparedAgent {
	const { body, sha256 } = JSON.parse(readPrivateFile(statePath(context.root)).toString("utf8"));
	if (typeof body !== "string" || hash(body) !== sha256) throw new Error("EVAL_V3_PAUSE_CORRUPT");
	const state = JSON.parse(body) as {
		version: number; identity: string; prepared: PreparedAgent; workspace: string; sessionSha256: string; auditSha256: string;
	};
	const expectedCwd = join(context.root, context.task.id);
	const expectedAgentDir = join(context.root, context.task.id + "-agent");
	if (state.version !== 1 || state.identity !== identity(context) ||
		state.prepared.cwd !== expectedCwd || state.prepared.agentDir !== expectedAgentDir ||
		!state.prepared.seededTaskId || lstatSync(expectedCwd).isSymbolicLink() || lstatSync(expectedAgentDir).isSymbolicLink() ||
		state.workspace !== workspaceFingerprint(expectedCwd, ["config.js"]) ||
		state.sessionSha256 !== hash(readPrivateFile(resumeSessionPath(context.root))) ||
		state.auditSha256 !== hash(readPrivateFile(auditPath(context))) ||
		readSandboxAuditSnapshot(auditPath(context)).complete !== true)
		throw new Error("EVAL_V3_RESUME_IDENTITY_MISMATCH");
	return state.prepared;
}

export function finishResumedRun(prepared: PreparedAgent, verifierPassed: boolean, normal: boolean, auditComplete: boolean) {
	const service = openTask(prepared);
	try {
		const taskId = prepared.seededTaskId!;
		const previous = service.get(taskId)!;
		if (previous.task.status !== "running") return previous;
		if (!verifierPassed || !normal || !auditComplete)
			return service.transitionTask(taskId, previous.task.revision, "failed", "runner:resumed-failure");
		completeStep(service, taskId, "repair", "Independent read-only Docker verifier passed");
		const verifying = service.transitionTask(taskId, service.get(taskId)!.task.revision, "verifying", "runner:independent-validation");
		return service.transitionTask(taskId, verifying.task.revision, "completed", "runner:verified-finish");
	} finally { service.close(); }
}

/** Call only after obtaining the Gateway's cross-process ownership. */
export function beginResumedRun(context: RunnerContext): void {
	const prepared = loadSuspendedRun(context);
	const taskId = prepared.seededTaskId!;
	const service = openTask(prepared);
	try {
		const previous = service.get(taskId);
		const check = recoveryPreflight(service.provider, taskId, "controlled-pilot-host", null, ["config.js"]);
		if (previous?.task.status !== "paused" || check.checkpointIntegrity !== "verified" ||
			!check.consistencyValid || check.workspaceChanged || check.unknownStepIds.length ||
			!check.safeContinueStepIds.includes("repair")) throw new Error("EVAL_V3_TASK_RECOVERY_REJECTED");
		const queued = service.transitionTask(taskId, previous.task.revision, "queued", "runner:verified-recovery");
		service.transitionTask(taskId, queued.task.revision, "running", "runner:resumed");
	} finally { service.close(); }
	renameSync(statePath(context.root), join(context.root, "previous-pause.json"));
	renameSync(auditPath(context), join(context.root, "previous-sandbox-audit.json"));
}
