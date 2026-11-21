import { Role, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import { type DelegatedTask, type Diagnosis, digest, type TestReport } from "../multi-local/protocol.ts";
import type { PytestSnapshot } from "../sandbox/task-evidence.ts";

export const a2aPath = "/a2a";
export const cardPath = "/.well-known/agent-card.json";
export const maxBody = 16_384;
export const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const hash = /^[a-f0-9]{64}$/u;
const targetPattern = /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.py(?:::[A-Za-z_]\w*){0,2}$/u;

export interface RemoteTestIntent {
	schemaVersion: 1;
	parentTaskId: string;
	subtaskId: string;
	operationId: string;
	attemptId: string;
	projectId: string;
	snapshot: PytestSnapshot;
	target: string;
	deadline: number;
}

export interface RemoteTestArtifact {
	schemaVersion: 1;
	remoteA2ATaskId: string;
	intent: RemoteTestIntent;
	startedAt: number;
	endedAt: number;
	failureSummary: string;
	diagnosis: Diagnosis | null;
	audit: { owner: string; source: "docker-pytest"; image: string };
	report: Omit<TestReport, "output">;
}

export interface A2AConnection {
	origin: string;
	principalId: string;
	token: string;
	timeoutMs?: number;
}

export function validateConnection(value: A2AConnection): void {
	if (
		!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(value.origin) ||
		new URL(value.origin).origin !== value.origin ||
		!/^[a-zA-Z0-9_-]{1,80}$/u.test(value.principalId) ||
		!/^[a-zA-Z0-9_.~-]{32,240}$/u.test(value.token) ||
		(value.timeoutMs !== undefined &&
			(!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 15_000))
	)
		throw new Error("MA2_CONNECTION_INVALID");
}

export function testIntent(operation: DelegatedTask, snapshot: PytestSnapshot, target: string): RemoteTestIntent {
	return {
		schemaVersion: 1,
		parentTaskId: operation.parentTaskId,
		subtaskId: operation.subtaskId,
		operationId: operation.operationId,
		attemptId: operation.attemptId,
		projectId: operation.scope.projectId,
		snapshot: {
			workspaceId: snapshot.workspaceId,
			patchHash: snapshot.patchHash,
			testHash: snapshot.testHash,
			policyHash: snapshot.policyHash,
		},
		target,
		deadline: operation.deadline,
	};
}

export function parseIntent(input: unknown): RemoteTestIntent | undefined {
	if (!input || typeof input !== "object") return;
	const v = input as RemoteTestIntent;
	if (
		Object.keys(v).length !== 9 ||
		v.schemaVersion !== 1 ||
		![v.parentTaskId, v.subtaskId].every((value) => typeof value === "string" && uuid.test(value)) ||
		![v.operationId, v.attemptId, v.projectId].every((value) => typeof value === "string" && hash.test(value)) ||
		typeof v.target !== "string" ||
		v.target.length > 240 ||
		!targetPattern.test(v.target) ||
		!Number.isSafeInteger(v.deadline) ||
		v.deadline <= 0 ||
		!v.snapshot ||
		typeof v.snapshot !== "object" ||
		Object.keys(v.snapshot).length !== 4 ||
		![v.snapshot.workspaceId, v.snapshot.patchHash, v.snapshot.testHash, v.snapshot.policyHash].every(
			(value) => typeof value === "string" && hash.test(value),
		)
	)
		return;
	const { schemaVersion, parentTaskId, subtaskId, operationId, attemptId, projectId, target, deadline } = v;
	const { workspaceId, patchHash, testHash, policyHash } = v.snapshot;
	return {
		schemaVersion,
		parentTaskId,
		subtaskId,
		operationId,
		attemptId,
		projectId,
		snapshot: { workspaceId, patchHash, testHash, policyHash },
		target,
		deadline,
	};
}

export function messageFor(intent: RemoteTestIntent): SendMessageRequest {
	return {
		tenant: "",
		metadata: undefined,
		message: {
			messageId: intent.operationId,
			role: Role.ROLE_USER,
			contextId: "",
			taskId: "",
			metadata: undefined,
			parts: [
				{
					content: { $case: "data", value: intent },
					filename: "",
					mediaType: "application/json",
					metadata: undefined,
				},
			],
			extensions: [],
			referenceTaskIds: [],
		},
		configuration: {
			acceptedOutputModes: ["application/json"],
			taskPushNotificationConfig: undefined,
			historyLength: 0,
			returnImmediately: true,
		},
	};
}

export function intentFromRequest(request: SendMessageRequest): RemoteTestIntent | undefined {
	const m = request.message;
	if (
		!m ||
		request.tenant ||
		request.metadata ||
		m.role !== Role.ROLE_USER ||
		m.taskId ||
		m.contextId ||
		m.metadata ||
		m.extensions.length ||
		m.referenceTaskIds.length ||
		m.parts.length !== 1 ||
		request.configuration?.taskPushNotificationConfig
	)
		return;
	const part = m.parts[0];
	if (part?.content?.$case !== "data" || part.filename || part.metadata || part.mediaType !== "application/json")
		return;
	const intent = parseIntent(part.content.value);
	return intent?.operationId === m.messageId ? intent : undefined;
}

export function artifactFromTask(task: Task, trusted: RemoteTestArtifact): RemoteTestArtifact {
	const art = task.artifacts[0];
	const part = art?.parts[0];
	if (
		task.id !== trusted.remoteA2ATaskId ||
		task.artifacts.length !== 1 ||
		art?.artifactId !== task.id ||
		art.parts.length !== 1 ||
		part?.mediaType !== "application/json" ||
		part.content?.$case !== "data" ||
		digest(canonical(part.content.value)) !== digest(canonical(trusted))
	)
		throw new Error("MA2_ARTIFACT_MISMATCH");
	return trusted;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}
