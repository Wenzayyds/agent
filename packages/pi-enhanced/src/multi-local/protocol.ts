import { createHash } from "node:crypto";
import type { PytestReceipt } from "../sandbox/task-evidence.ts";
import type { TaskBudgetSettings } from "../shared/task-budget.ts";
import type { RoleModelSelection } from "./model-config.ts";

export const CODE_TOOLS = ["read", "edit"] as const;
export const TEST_TOOLS = ["read"] as const;
export type AgentRole = "code" | "test";

export interface AgentIdentity {
	role: AgentRole;
	sessionId: string;
	sessionFile: string;
}

export interface MultiLocalRequest {
	goal: string;
	target: string;
	editFiles: string[];
	diagnose?: boolean;
	maxDiagnosisRequests?: number;
}

export interface DelegatedTask {
	schemaVersion: 1;
	parentTaskId: string;
	subtaskId: string;
	operationId: string;
	attemptId: string;
	agent: AgentIdentity;
	workspaceRevision: string;
	scope: { projectId: string; workspaceId: string };
	allowedTools: readonly string[];
	budgetAllocation: "parent";
	deadline: number;
}

export interface TestReport {
	operationId: string;
	subtaskId: string;
	sessionId: string;
	workspaceRevision: string;
	approvedTarget: string;
	executedTarget: string;
	receipt: PytestReceipt;
	output: string;
	outputTruncated: boolean;
	failureKind: "assertion" | "test-failure" | "none";
	remoteA2ATaskId?: string;
	remoteDiagnosis?: Diagnosis;
}

export interface Diagnosis {
	cause: "implementation" | "test-environment" | "unknown";
	recommendation: "inspect-implementation" | "review-contract" | "check-fixture";
	file: string | null;
}

export function parseDiagnosis(text: string, files: readonly string[]): Diagnosis {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3)
		throw new Error("MA1_DIAGNOSIS_INVALID");
	const d = value as Partial<Diagnosis>;
	if (
		(d.cause !== "implementation" && d.cause !== "test-environment" && d.cause !== "unknown") ||
		(d.recommendation !== "inspect-implementation" &&
			d.recommendation !== "review-contract" &&
			d.recommendation !== "check-fixture") ||
		(d.file !== null && (typeof d.file !== "string" || !files.includes(d.file)))
	)
		throw new Error("MA1_DIAGNOSIS_INVALID");
	return { cause: d.cause, recommendation: d.recommendation, file: d.file };
}

export type Phase = "edit" | "testing" | "diagnose" | "finalize" | "completed" | "paused";

export interface DelegationState {
	schemaVersion: 1;
	phase: Phase;
	deadline: number;
	budget: TaskBudgetSettings;
	roleModels?: RoleModelSelection;
	retrieval: { memory: boolean; knowledge: boolean };
	scope: DelegatedTask["scope"];
	target: string;
	testHash: string;
	policyHash: string;
	editFiles: string[];
	diagnose: boolean;
	maxDiagnosisRequests: number;
	sessions: Record<AgentRole, AgentIdentity>;
	revision: string;
	originalFiles: [string, string][];
	protectedWrites: string[];
	iteration: number;
	operation?: DelegatedTask;
	remoteTest?: { origin: string; principalId: string };
	remoteTestTaskId?: string;
	report?: TestReport;
	diagnosis?: Diagnosis;
	requests: Record<AgentRole, number>;
	reason?: string;
	resumePhase?: Exclude<Phase, "paused" | "completed">;
}

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
