export const TASK_STATUSES = [
	"draft",
	"queued",
	"running",
	"paused",
	"blocked",
	"verifying",
	"completed",
	"failed",
	"cancelled",
	"budget_exhausted",
	"needs_reconciliation",
] as const;
export const STEP_STATUSES = [
	"pending",
	"running",
	"blocked",
	"verifying",
	"completed",
	"failed",
	"skipped",
	"needs_reconciliation",
] as const;
export const RISK_CLASSES = [
	"read_only",
	"idempotent_verified",
	"mutating",
	"external_side_effect",
	"unknown",
] as const;
export const EVIDENCE_CLASSES = [
	"observed",
	"validated",
	"manual_attested",
	"unknown",
	"failed",
	"model_claim",
	"verified_by_runner",
	"user_attested",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type RiskClass = (typeof RISK_CLASSES)[number];
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export type StepValidation =
	| { kind: "pytest"; target: string; expectedSha256: string }
	| {
			kind: "command_exit";
			toolName: "bash" | "powershell";
			inputDigest: string;
			expectedExitCode: number;
	  }
	| { kind: "file_sha256"; relativePath: string; expectedSha256: string };

export interface TaskStepInput {
	stepId?: string;
	title: string;
	expectedOutcome: string;
	dependsOn?: readonly string[];
	riskClass?: RiskClass;
	validation?: StepValidation;
}

export interface TaskRecord {
	taskId: string;
	projectId: string;
	goal: string;
	status: TaskStatus;
	revision: number;
	planRevision: number;
	acceptancePolicy: "user_confirmed";
	createdAt: number;
	updatedAt: number;
}

export interface TaskStep {
	stepId: string;
	taskId: string;
	ordinal: number;
	title: string;
	expectedOutcome: string;
	dependsOn: readonly string[];
	status: StepStatus;
	revision: number;
	riskClass: RiskClass;
	validation?: StepValidation;
}

export interface TaskEvidence {
	pytest?: import("../sandbox/task-evidence.ts").PytestReceipt;
	evidenceId: string;
	taskId: string;
	stepId: string;
	kind: string;
	sourceRef: string;
	toolCallId?: string;
	attemptId?: string;
	outcome: "succeeded" | "failed" | "unknown";
	confidenceClass: EvidenceClass;
	observedAt: number;
	digest: string;
	inputDigest?: string;
	resultDigest?: string;
}

export interface TaskAttempt {
	attemptId: string;
	taskId: string;
	stepId: string;
	sessionId: string;
	toolCallId: string;
	parentToolCallId?: string;
	toolName: string;
	state:
		| "started"
		| "succeeded"
		| "failed"
		| "needs_reconciliation"
		| "reconciled_no_retry"
		| "reconciled_external_success";
	riskClass: RiskClass;
	idempotencyKey: string;
	inputDigest: string;
	startedAt: number;
	endedAt?: number;
	resultDigest?: string;
}

export interface WorkspaceObservation {
	realRoot: string;
	gitHead?: string;
	gitStatusDigest?: string;
	gitStatusEntries: number;
	trackedFiles: readonly { relativePath: string; exists: boolean; size: number; mtimeMs: number; sha256?: string }[];
	observationLimited: boolean;
}

export interface CheckpointObservation {
	contextReferences: readonly string[];
	sessionUsage: { responses: number; tokens: number; reportedCostUsd: number };
	budgetTermination?: {
		runId: string;
		code: string;
		requestsStarted: number;
		confirmedInputTokens: number;
		confirmedOutputTokens: number;
		estimatedConfirmedCostUsd: number;
		unconfirmedTokens: number;
		unconfirmedCostUsd: number;
		auditComplete: boolean;
		verifierPassed: boolean;
	};
}

export interface TaskCheckpoint {
	checkpointId: string;
	taskId: string;
	taskRevision: number;
	planRevision: number;
	sessionId: string;
	branchLeafId: string | null;
	workspaceFingerprint: string;
	workspaceObservation: WorkspaceObservation;
	pendingStepIds: readonly string[];
	lastCommittedEventSeq: number;
	observation?: CheckpointObservation;
	createdAt: number;
}

export interface TaskSnapshot {
	task: TaskRecord;
	steps: readonly TaskStep[];
	evidence: readonly TaskEvidence[];
	lastCheckpoint: TaskCheckpoint | null;
}

export interface TaskRuntimeBinding {
	taskId: string;
	stepId: string;
	sessionId: string;
	branchLeafId: string | null;
}

export interface RecoveryPreflight {
	taskId: string;
	projectMatches: boolean;
	sessionChanged: boolean;
	branchChanged: boolean;
	workspaceChanged: boolean;
	checkpointRevisionMatches: boolean;
	checkpointIntegrity: "verified" | "legacy" | "invalid" | "missing";
	readOnlyRetryStepIds: readonly string[];
	verifyBeforeWriteStepIds: readonly string[];
	completedStepIds: readonly string[];
	failedStepIds: readonly string[];
	unknownStepIds: readonly string[];
	pendingStepIds: readonly string[];
	requiresReconciliation: boolean;
	consistencyValid: boolean;
	bindingMatches: boolean;
	driftReasons: readonly string[];
	safeContinueStepIds: readonly string[];
	automaticReplayAllowed: false;
	recommendations: readonly string[];
}

export interface ScopedTaskSummary {
	taskId: string;
	projectId: string;
	sessionId: string;
	branchLeafId: string | null;
	goal: string;
	status: TaskStatus;
	revision: number;
	planRevision: number;
	checkpointId?: string;
	checkpointRevision?: number;
	checkpointContextReferences?: readonly string[];
	reconciliationCount: number;
	observedAt: number;
	steps: readonly Pick<TaskStep, "stepId" | "title" | "status" | "expectedOutcome" | "dependsOn">[];
}

export interface ScopedTaskReader {
	get(taskId: string): Promise<ScopedTaskSummary | null>;
	getActive(): Promise<ScopedTaskSummary | null>;
	/** Current host binding and authoritative task state for the synchronous transport check. */
	getActiveNow?(): ScopedTaskSummary | null;
}
