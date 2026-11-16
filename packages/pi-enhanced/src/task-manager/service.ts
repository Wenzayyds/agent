import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type {
	TaskEvidence,
	TaskRecord,
	TaskRuntimeBinding,
	TaskSnapshot,
	TaskStep,
	TaskStepInput,
} from "./contracts.ts";
import { TaskError } from "./errors.ts";
import { dependenciesComplete, normalizePlan, validText } from "./plan.ts";
import type { TaskProvider } from "./provider.ts";

const TASK_TRANSITIONS: Readonly<Record<TaskRecord["status"], readonly TaskRecord["status"][]>> = {
	draft: ["queued", "cancelled"],
	queued: ["running", "paused", "cancelled"],
	running: ["paused", "blocked", "verifying", "failed", "needs_reconciliation"],
	paused: ["queued", "cancelled", "needs_reconciliation"],
	blocked: ["queued", "failed", "cancelled", "needs_reconciliation"],
	verifying: ["completed", "running", "failed", "needs_reconciliation"],
	completed: [],
	failed: [],
	cancelled: [],
	budget_exhausted: [],
	needs_reconciliation: ["paused", "queued", "failed", "cancelled"],
};
const STEP_TRANSITIONS: Readonly<Record<TaskStep["status"], readonly TaskStep["status"][]>> = {
	pending: ["running", "blocked", "skipped"],
	running: ["blocked", "verifying", "failed", "needs_reconciliation"],
	blocked: ["pending", "failed", "skipped", "needs_reconciliation"],
	verifying: ["completed", "running", "failed", "needs_reconciliation"],
	completed: [],
	failed: ["pending"],
	skipped: [],
	needs_reconciliation: ["pending", "failed", "skipped"],
};

export class TaskService {
	readonly provider: TaskProvider;
	readonly maximumSteps: number;
	private closed = false;
	private binding?: TaskRuntimeBinding;
	constructor(provider: TaskProvider, maximumSteps: number) {
		this.provider = provider;
		this.maximumSteps = maximumSteps;
	}

	create(goal: string, steps: readonly TaskStepInput[], sessionId: string, branchLeafId: string | null): TaskSnapshot {
		this.assertOpen();
		const now = Date.now();
		const taskId = randomUUID();
		const task: TaskRecord = {
			taskId,
			projectId: this.provider.scope.projectId,
			goal: validText(goal, "task goal"),
			status: "draft",
			revision: 1,
			planRevision: 1,
			acceptancePolicy: "user_confirmed",
			createdAt: now,
			updatedAt: now,
		};
		return this.provider.create(task, normalizePlan(taskId, steps, this.maximumSteps), sessionId, branchLeafId);
	}
	list(): TaskRecord[] {
		this.assertOpen();
		return this.provider.list();
	}
	get(taskId: string): TaskSnapshot | null {
		this.assertOpen();
		return this.provider.get(taskId);
	}
	replacePlan(taskId: string, expectedPlanRevision: number, steps: readonly TaskStepInput[]): TaskSnapshot {
		return this.provider.replacePlan(
			taskId,
			expectedPlanRevision,
			normalizePlan(taskId, steps, this.maximumSteps),
			Date.now(),
		);
	}

	transitionTask(
		taskId: string,
		expectedRevision: number,
		next: TaskRecord["status"],
		sourceRef = "user",
	): TaskSnapshot {
		const current = this.require(taskId);
		if (current.task.revision !== expectedRevision)
			throw new TaskError("TASK_REVISION_CONFLICT", "Task changed since it was read");
		if (!TASK_TRANSITIONS[current.task.status].includes(next))
			throw new TaskError("TASK_INVALID_TRANSITION", `Cannot move task from ${current.task.status} to ${next}`);
		if (next === "completed") this.assertCompletable(current);
		return this.provider.setTaskStatus(taskId, expectedRevision, next, sourceRef, Date.now());
	}

	transitionStep(
		taskId: string,
		stepId: string,
		expectedRevision: number,
		next: TaskStep["status"],
		sourceRef = "user",
	): TaskSnapshot {
		const snapshot = this.require(taskId);
		const step = snapshot.steps.find((item) => item.stepId === stepId);
		if (!step) throw new TaskError("TASK_NOT_FOUND", "Task step does not exist");
		if (step.revision !== expectedRevision)
			throw new TaskError("TASK_REVISION_CONFLICT", "Task step changed since it was read");
		if (!STEP_TRANSITIONS[step.status].includes(next))
			throw new TaskError("TASK_INVALID_TRANSITION", `Cannot move step from ${step.status} to ${next}`);
		if (
			(next === "running" || next === "verifying" || next === "completed") &&
			!dependenciesComplete(step, snapshot.steps)
		)
			throw new TaskError("TASK_INVALID_TRANSITION", "Step dependencies are not completed");
		if (next === "completed" && !hasTrustedEvidence(snapshot.evidence.filter((item) => item.stepId === stepId)))
			throw new TaskError(
				"TASK_INVALID_TRANSITION",
				"A step needs runner-verified or user-attested evidence before completion",
			);
		return this.provider.setStepStatus(taskId, stepId, expectedRevision, next, sourceRef, Date.now());
	}

	addEvidence(
		input: Omit<TaskEvidence, "evidenceId" | "observedAt" | "digest"> & { digestSource: string },
	): TaskSnapshot {
		this.require(input.taskId);
		return this.provider.addEvidence({
			evidenceId: randomUUID(),
			taskId: input.taskId,
			stepId: input.stepId,
			kind: input.kind.slice(0, 100),
			sourceRef: input.sourceRef.slice(0, 300),
			...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
			...(input.attemptId ? { attemptId: input.attemptId } : {}),
			outcome: input.outcome,
			confidenceClass: input.confidenceClass,
			observedAt: Date.now(),
			digest: createHash("sha256").update(input.digestSource).digest("hex"),
			...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
			...(input.resultDigest ? { resultDigest: input.resultDigest } : {}),
		});
	}

	validateFileStep(taskId: string, stepId: string): TaskSnapshot {
		const snapshot = this.require(taskId);
		const step = snapshot.steps.find((item) => item.stepId === stepId);
		if (!step?.validation || step.validation.kind !== "file_sha256")
			throw new TaskError("TASK_VALIDATION_ERROR", "Step has no file SHA-256 validation rule");
		const root = this.provider.scope.rootPath;
		const candidate = resolve(root, step.validation.relativePath);
		let actual: string;
		try {
			actual = realpathSync.native(candidate);
		} catch (error) {
			throw new TaskError("TASK_VALIDATION_ERROR", "Validation file does not exist", { cause: error });
		}
		const relativePath = relative(root, actual);
		if (!relativePath || relativePath.startsWith("..") || resolve(root, relativePath) !== actual)
			throw new TaskError("TASK_VALIDATION_ERROR", "Validation file escapes the current project");
		const stat = statSync(actual);
		if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
			throw new TaskError("TASK_VALIDATION_ERROR", "Validation file is not a bounded regular file");
		const actualSha256 = createHash("sha256").update(readFileSync(actual)).digest("hex");
		if (actualSha256 !== step.validation.expectedSha256)
			throw new TaskError("TASK_INVALID_TRANSITION", "Validation file hash does not match the expected value");
		return this.addEvidence({
			taskId,
			stepId,
			kind: "file_sha256",
			sourceRef: `file:${step.validation.relativePath}`,
			outcome: "succeeded",
			confidenceClass: "validated",
			digestSource: actualSha256,
			resultDigest: actualSha256,
		});
	}

	reconcileAttempt(
		taskId: string,
		attemptId: string,
		action: "do_not_retry" | "external_success",
		note: string,
		sessionId: string,
	): TaskSnapshot {
		const normalizedNote = validText(note, "reconciliation note");
		const attempt = this.provider.reconcileAttempt(taskId, attemptId, action, `user:${sessionId}`, Date.now());
		if (action === "external_success") {
			return this.addEvidence({
				taskId,
				stepId: attempt.stepId,
				kind: "external_result_attestation",
				sourceRef: `user:${sessionId}`,
				attemptId,
				toolCallId: attempt.toolCallId,
				outcome: "succeeded",
				confidenceClass: "manual_attested",
				digestSource: normalizedNote,
				inputDigest: attempt.inputDigest,
				...(attempt.resultDigest ? { resultDigest: attempt.resultDigest } : {}),
			});
		}
		const snapshot = this.get(taskId);
		if (!snapshot) throw new TaskError("TASK_NOT_FOUND", "Task does not exist after reconciliation");
		return snapshot;
	}

	bind(taskId: string, stepId: string, sessionId: string, branchLeafId: string | null): TaskRuntimeBinding {
		const snapshot = this.require(taskId);
		if (snapshot.task.status === "budget_exhausted")
			throw new TaskError("TASK_INVALID_TRANSITION", "The run exhausted its budget");
		if (snapshot.lastCheckpoint && this.provider.checkpointIntegrity(snapshot.lastCheckpoint) === "invalid")
			throw new TaskError("TASK_INVALID_TRANSITION", "Inspect the invalid checkpoint before binding another step");
		if (!snapshot.steps.some((step) => step.stepId === stepId))
			throw new TaskError("TASK_NOT_FOUND", "Task step does not exist");
		this.provider.bindSession(taskId, sessionId, branchLeafId, "explicit-execution-binding", Date.now());
		this.binding = { taskId, stepId, sessionId, branchLeafId };
		return this.binding;
	}
	unbind(): void {
		this.binding = undefined;
	}
	get activeBinding(): TaskRuntimeBinding | undefined {
		return this.binding ? { ...this.binding } : undefined;
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.binding = undefined;
			this.provider.close();
		}
	}

	private require(taskId: string): TaskSnapshot {
		this.assertOpen();
		const value = this.provider.get(taskId);
		if (!value) throw new TaskError("TASK_NOT_FOUND", "Task does not exist in the current project");
		return value;
	}
	private assertCompletable(snapshot: TaskSnapshot): void {
		if (!snapshot.steps.every((step) => step.status === "completed"))
			throw new TaskError("TASK_INVALID_TRANSITION", "Every task step must be completed");
		for (const step of snapshot.steps)
			if (!hasTrustedEvidence(snapshot.evidence.filter((item) => item.stepId === step.stepId)))
				throw new TaskError("TASK_INVALID_TRANSITION", `Step ${step.stepId} lacks trusted evidence`);
	}
	private assertOpen(): void {
		if (this.closed) throw new TaskError("TASK_RUNTIME_UNAVAILABLE", "Task service is closed");
	}
}

function hasTrustedEvidence(evidence: readonly TaskEvidence[]): boolean {
	return evidence.some(
		(item) =>
			item.outcome === "succeeded" &&
			(item.confidenceClass === "validated" ||
				item.confidenceClass === "manual_attested" ||
				item.confidenceClass === "user_attested"),
	);
}
