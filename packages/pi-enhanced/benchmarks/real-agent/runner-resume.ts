import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contextReferences } from "../../src/context/offload.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { atomicPrivateJson, readSandboxAuditSnapshot } from "../../src/sandbox/audit.ts";
import type { SandboxAuditRecord } from "../../src/sandbox/broker.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { createCheckpoint, observeWorkspace, recoveryPreflight, workspaceFingerprint } from "../../src/task-manager/recovery.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import type { BudgetGatewayStatus } from "./budget-gateway.ts";
import { memoryTouchMetadata } from "./evaluation-telemetry.ts";
import type { AgentExecution } from "./runner-execution.ts";
import type { PreparedAgent, RunnerContext } from "./runner-preparation.ts";

const statePath = (root: string) => join(root, "pause.json");
export const resumeSessionPath = (root: string) => join(root, "agent-session.jsonl");

function readPrivateFile(path: string): Buffer {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(dirname(path)) !== realpathSync(dirname(realpathSync(path))) ||
		stat.size > 8 * 1024 * 1024) throw new Error("EVAL_V3_RESUME_FILE_INVALID");
	return readFileSync(path);
}

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function identity(context: RunnerContext) {
	return hash(JSON.stringify({
		workspace: realpathSync(context.root), task: context.task.id, prompt: context.task.prompt, plan: context.plan,
		switches: context.switches, condition: context.condition, testFeedback: context.testFeedback,
		upstream: context.localStubUrl,
		...(context.jointRecovery ? { jointRecovery: true } : {}),
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
		taskId, stepId, kind: stepId === "reproduce" ? "verified_session_boundary" : "isolated_validation",
		sourceRef: stepId === "reproduce" ? "runner:verified-session-boundary" : "runner:isolated-validation",
		outcome: "succeeded", confidenceClass: "validated", digestSource: evidence,
	});
	const verifying = service.transitionStep(taskId, stepId, active.steps.find((s) => s.stepId === stepId)!.revision, "verifying", "runner:observed");
	service.transitionStep(taskId, stepId, verifying.steps.find((s) => s.stepId === stepId)!.revision, "completed", "runner:verified");
}

function inspectWorkspace(cwd: string, repositoryCommit: string) {
	const paths = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "-z"], {
		cwd, encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true,
	}).split("\0").filter(Boolean))].sort();
	const observation = observeWorkspace(cwd, paths);
	const invalidPath = paths.some((path) => {
		if (path.split("/").some((part) => part === ".." || !part) || path.includes("\\")) return true;
		const absolute = join(cwd, path);
		if (!existsSync(absolute)) return false; // A tracked deletion remains in the fingerprint.
		const info = lstatSync(absolute);
		return !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
			realpathSync.native(absolute) !== resolve(observation.realRoot, path);
	});
	if (observation.observationLimited || observation.gitHead !== repositoryCommit || !observation.gitStatusDigest || invalidPath)
		throw new Error("EVAL_V3_RESUME_WORKSPACE_UNVERIFIED");
	return paths;
}

function inspectSession(root: string, cwd: string) {
	const path = resumeSessionPath(root);
	const sessionSha256 = hash(readPrivateFile(path));
	const session = SessionManager.open(path);
	if (realpathSync(session.getCwd()) !== realpathSync(cwd)) throw new Error("EVAL_V3_RESUME_SESSION_SCOPE");
	const messages = session.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
	const calls = new Map<string, string>();
	const completed = new Map<string, ToolResultMessage>();
	let assistantCount = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted")
				throw new Error("EVAL_V3_RESUME_SESSION_UNSETTLED");
			assistantCount++;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (calls.has(block.id)) throw new Error("EVAL_V3_RESUME_REPEATED_TOOL_ID");
				calls.set(block.id, block.name);
			}
		} else if (message.role === "toolResult") {
			if (completed.has(message.toolCallId) || calls.get(message.toolCallId) !== message.toolName)
				throw new Error("EVAL_V3_RESUME_UNPAIRED_RESULT");
			completed.set(message.toolCallId, message);
		}
	}
	const last = messages.at(-1);
	if (!assistantCount || calls.size !== completed.size || last?.role !== "assistant")
		throw new Error("EVAL_V3_RESUME_PENDING_OPERATION");
	return { session, sessionSha256, completed, assistantCount, stopReason: last.stopReason };
}

function agentConfigDigest(prepared: PreparedAgent) {
	return hash(JSON.stringify(["settings.json", "pi-enhanced.json"].map((name) =>
		hash(readPrivateFile(join(prepared.agentDir, name))))));
}

function budgetEvidence(status: BudgetGatewayStatus, deadline: number | undefined) {
	if (deadline === undefined || status.activeRequests !== 0 || status.reservedTokens !== 0 ||
		status.reservedCostUsd !== 0 || status.state !== "ready")
		throw new Error("EVAL_V3_PAUSE_BUDGET_UNSETTLED");
	return { deadline, requests: status.requestsCompleted, started: status.requestsStarted,
		inputTokens: status.actualInputTokens, outputTokens: status.actualOutputTokens, usd: status.actualCostUsd,
		committedTokens: status.committedTokenUpperBound, committedUsd: status.committedCostUpperBoundUsd };
}

interface PauseState {
	version: 2;
	identity: string;
	prepared: PreparedAgent;
	workspace: string;
	sessionId: string;
	branchLeafId: string | null;
	sessionSha256: string;
	auditSha256: string;
	checkpointId: string;
	configSha256: string;
	budget: ReturnType<typeof budgetEvidence>;
}

export function saveSuspendedRun(context: RunnerContext, prepared: PreparedAgent, execution: AgentExecution) {
	const audit = readSandboxAuditSnapshot(auditPath(context));
	execution.telemetry?.finish(execution.gatewayStatus, audit);
	if (audit.complete !== true || !prepared.seededTaskId) throw new Error("EVAL_V3_PAUSE_UNSAFE");
	const { session, sessionSha256, completed, assistantCount, stopReason } = inspectSession(context.root, prepared.cwd);
	const budget = budgetEvidence(execution.gatewayStatus, execution.deadlineAt);
	if (assistantCount !== budget.started || budget.started !== budget.requests)
		throw new Error("EVAL_V3_PAUSE_SESSION_BUDGET_MISMATCH");
	const sessionId = session.getSessionId();
	const branchLeafId = session.getLeafId();
	const paths = inspectWorkspace(prepared.cwd, prepared.repositoryCommit);
	const records = audit.audit as SandboxAuditRecord[];
	const writeCalls = [...completed].filter(([, result]) => result.toolName === "write" || result.toolName === "edit");
	const written = records.filter(({ operation }) => operation === "write_file");
	if (writeCalls.some(([id, result]) => result.isError || !written.some(({ requestId, status }) =>
		requestId === hash(id + ":write") && status === "ok")) || written.length !== writeCalls.length)
		throw new Error("EVAL_V3_PAUSE_WRITE_UNVERIFIED");
	const taskId = prepared.seededTaskId;
	const references = contextReferences({ cwd: prepared.cwd, sessionManager: session, isProjectTrusted: () => true }, taskId);
	if (context.jointRecovery) {
		const results = [...completed.values()];
		const tests = results.filter(({ toolName }) => toolName === "run_tests");
		const test = tests[0]?.details as { status?: string; exitCode?: number } | undefined;
		const memoryVerified = results.some((result) => result.toolName === "enhanced_memory_search" &&
			memoryTouchMetadata(result, result.isError, prepared.memorySeed?.id ?? null).matchedSeed === true);
		if (stopReason !== "stop" || writeCalls.length || !references.length || tests.length !== 1 ||
			test?.status !== "verification_failed" || test.exitCode !== 1 || !memoryVerified ||
			execution.verification?.status !== "verification_failed" || execution.verification.cleanup !== "removed" ||
			budget.started >= context.plan.maxCallsPerTask ||
			execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
				cwd: prepared.cwd, encoding: "utf8", timeout: 2_000, windowsHide: true,
			}).trim())
			throw new Error("EVAL_V3_JOINT_PAUSE_EVIDENCE_REQUIRED");
	}
	const service = openTask(prepared);
	try {
		const attempts = service.provider.getAttempts(taskId);
		if (attempts.some((attempt) => ["started", "needs_reconciliation"].includes(attempt.state)) ||
			writeCalls.some(([id]) => !attempts.some((attempt) => attempt.sessionId === sessionId &&
				attempt.toolCallId === id && attempt.state === "succeeded")))
			throw new Error("EVAL_V3_PAUSE_OPERATION_UNVERIFIED");
		completeStep(service, taskId, "reproduce", JSON.stringify({ sessionSha256, assistantCount, tools: completed.size }));
		const task = service.get(taskId)!.task;
		const paused = service.transitionTask(taskId, task.revision, "paused", "runner:verified-pause");
		service.provider.bindSession(taskId, sessionId, branchLeafId, "runner:verified-pause", Date.now());
		const checkpoint = createCheckpoint(service.provider, paused, sessionId, branchLeafId, paths, {
			contextReferences: references,
			sessionUsage: { responses: assistantCount, tokens: execution.gatewayStatus.actualTotalTokens,
				reportedCostUsd: execution.gatewayStatus.actualCostUsd },
		});
		const state: PauseState = {
			version: 2, identity: identity(context), prepared, workspace: checkpoint.workspaceFingerprint,
			sessionId, branchLeafId, sessionSha256, auditSha256: hash(readPrivateFile(auditPath(context))),
			checkpointId: checkpoint.checkpointId, configSha256: agentConfigDigest(prepared), budget,
		};
		const body = JSON.stringify(state);
		atomicPrivateJson(statePath(context.root), { body, sha256: hash(body) });
		return { checkpointId: checkpoint.checkpointId, references, sessionId, branchLeafId, completedWrites: written.length,
			phaseVerification: execution.verification, auditComplete: true, pid: process.pid };
	} finally { service.close(); }
}

function inspectPause(context: RunnerContext) {
	if (!existsSync(statePath(context.root))) throw new Error("EVAL_V3_NO_VERIFIED_PAUSE_RECONCILIATION_REQUIRED");
	const { body, sha256 } = JSON.parse(readPrivateFile(statePath(context.root)).toString("utf8"));
	if (typeof body !== "string" || hash(body) !== sha256) throw new Error("EVAL_V3_PAUSE_CORRUPT");
	const state = JSON.parse(body) as PauseState;
	const expectedCwd = join(context.root, context.task.id);
	const expectedAgentDir = join(context.root, context.task.id + "-agent");
	if (state.version !== 2 || state.identity !== identity(context) ||
		state.prepared.cwd !== expectedCwd || state.prepared.agentDir !== expectedAgentDir ||
		!state.prepared.seededTaskId || lstatSync(expectedCwd).isSymbolicLink() || lstatSync(expectedAgentDir).isSymbolicLink() ||
		state.configSha256 !== agentConfigDigest(state.prepared) ||
		state.sessionSha256 !== hash(readPrivateFile(resumeSessionPath(context.root))) ||
		state.auditSha256 !== hash(readPrivateFile(auditPath(context))) ||
		readSandboxAuditSnapshot(auditPath(context)).complete !== true)
		throw new Error("EVAL_V3_RESUME_IDENTITY_MISMATCH");
	const { session, completed } = inspectSession(context.root, expectedCwd);
	const paths = inspectWorkspace(expectedCwd, state.prepared.repositoryCommit);
	if (state.sessionId !== session.getSessionId() || state.branchLeafId !== session.getLeafId() ||
		state.workspace !== workspaceFingerprint(expectedCwd, paths))
		throw new Error("EVAL_V3_RESUME_IDENTITY_MISMATCH");
	return { state, session, completed, paths };
}

export function loadSuspendedRun(context: RunnerContext): PreparedAgent {
	const { state, session, completed } = inspectPause(context);
	const references = contextReferences({ cwd: state.prepared.cwd, sessionManager: session, isProjectTrusted: () => true },
		state.prepared.seededTaskId!);
	return {
		...state.prepared,
		recovery: {
			priorTestCalls: [...completed.values()].filter(({ toolName }) => toolName === "run_tests").length,
			page: references[0] ? { reference: references[0], offset: 1_000, limit: 256 } : undefined,
			sessionId: state.sessionId,
		},
	};
}

/** Called once the child has exited. The journal remains available for manual reconciliation. */
export function recordInterruptedRun(prepared: PreparedAgent) {
	const service = openTask(prepared);
	try {
		const taskId = prepared.seededTaskId!;
		const count = service.provider.markOpenAttemptsForReconciliation(Date.now(), taskId);
		if (!count) return undefined;
		return {
			status: service.get(taskId)?.task.status,
			attempts: service.provider.getAttempts(taskId).filter(({ state }) => state === "needs_reconciliation")
				.map(({ toolCallId, toolName, riskClass, state }) => ({ toolCallId, toolName, riskClass, state })),
		};
	} finally { service.close(); }
}

export function finishResumedRun(context: RunnerContext, prepared: PreparedAgent,
	verifierPassed: boolean, normal: boolean, auditComplete: boolean, gateway: BudgetGatewayStatus) {
	const service = openTask(prepared);
	try {
		const taskId = prepared.seededTaskId!;
		const previous = service.get(taskId)!;
		if (previous.task.status !== "running") return previous;
		if (!verifierPassed || !normal || !auditComplete)
			return service.transitionTask(taskId, previous.task.revision, "failed", "runner:resumed-failure");
		const { session, assistantCount } = inspectSession(context.root, prepared.cwd);
		if (session.getSessionId() !== prepared.recovery?.sessionId) throw new Error("EVAL_V3_RESUME_SESSION_SCOPE");
		const sessionId = session.getSessionId();
		const leaf = session.getLeafId();
		const paths = inspectWorkspace(prepared.cwd, prepared.repositoryCommit);
		completeStep(service, taskId, "repair", "Independent read-only Docker verifier passed");
		const verifying = service.transitionTask(taskId, service.get(taskId)!.task.revision, "verifying", "runner:independent-validation");
		const completed = service.transitionTask(taskId, verifying.task.revision, "completed", "runner:verified-finish");
		service.provider.bindSession(taskId, sessionId, leaf, "runner:verified-finish", Date.now());
		createCheckpoint(service.provider, completed, sessionId, leaf, paths, {
			contextReferences: contextReferences({ cwd: prepared.cwd, sessionManager: session, isProjectTrusted: () => true }, taskId),
			sessionUsage: { responses: assistantCount, tokens: gateway.actualTotalTokens, reportedCostUsd: gateway.actualCostUsd },
		});
		return service.get(taskId);
	} finally { service.close(); }
}

/** Call only after obtaining the Gateway's cross-process ownership. */
export function beginResumedRun(context: RunnerContext, gateway: BudgetGatewayStatus, deadline: number | undefined): void {
	const { state, paths } = inspectPause(context);
	const { prepared, sessionId, branchLeafId } = state;
	const budget = budgetEvidence(gateway, deadline);
	if (JSON.stringify(state.budget) !== JSON.stringify(budget)) throw new Error("EVAL_V3_RESUME_BUDGET_MISMATCH");
	const taskId = prepared.seededTaskId!;
	const service = openTask(prepared);
	try {
		const previous = service.get(taskId);
		const check = recoveryPreflight(service.provider, taskId, sessionId, branchLeafId, paths);
		if (previous?.task.status !== "paused" || check.checkpointIntegrity !== "verified" ||
			previous.lastCheckpoint?.checkpointId !== state.checkpointId ||
			!check.bindingMatches || check.sessionChanged || check.branchChanged || !check.checkpointRevisionMatches ||
			!check.consistencyValid || check.workspaceChanged || check.unknownStepIds.length ||
			!check.safeContinueStepIds.includes("repair")) throw new Error("EVAL_V3_TASK_RECOVERY_REJECTED");
		const queued = service.transitionTask(taskId, previous.task.revision, "queued", "runner:verified-recovery");
		service.transitionTask(taskId, queued.task.revision, "running", "runner:resumed");
	} finally { service.close(); }
	renameSync(statePath(context.root), join(context.root, "previous-pause.json"));
	renameSync(auditPath(context), join(context.root, "previous-sandbox-audit.json"));
	const contextPath = join(context.root, context.task.id + "-context-audit.json");
	if (existsSync(contextPath)) renameSync(contextPath, join(context.root, "previous-context-audit.json"));
}
