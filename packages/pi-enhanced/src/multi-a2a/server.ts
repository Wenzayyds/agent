import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	AgentCard,
	type CancelTaskRequest,
	type GetTaskRequest,
	type SendMessageRequest,
	type Task,
	TaskState,
} from "@a2a-js/sdk";
import {
	RequestMalformedError,
	TaskNotCancelableError,
	TaskNotFoundError,
	UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import {
	type A2ARequestHandler,
	JsonRpcTransportHandler,
	ServerCallContext,
	validateVersion,
} from "@a2a-js/sdk/server";
import { removeRunContainers } from "../../benchmarks/real-agent/runner-cleanup.ts";
import { createProjectScope } from "../memory/project-scope.ts";
import { type DelegationState, digest } from "../multi-local/protocol.ts";
import { createTestExecution, pytestPassed, samePytestSnapshot } from "../multi-local/test-execution.ts";
import { assertSandboxWorkspaceIdentity, type SandboxConfig } from "../sandbox/config.ts";
import { isPytestConfig, type PytestConfig } from "../sandbox/pytest.ts";
import { createTaskPytestEvidence } from "../sandbox/task-evidence.ts";
import { createTaskStorageScope, TaskProvider } from "../task-manager/provider.ts";
import {
	a2aPath,
	cardPath,
	intentFromRequest,
	maxBody,
	parseIntent,
	type RemoteTestArtifact,
	type RemoteTestIntent,
	testIntent,
	uuid,
	validateConnection,
} from "./contract.ts";
import { A2ATaskStore, storedArtifact } from "./store.ts";

export interface TestServerOptions {
	port: number;
	principalId: string;
	token: string;
	agentDir: string;
	sandbox: SandboxConfig;
	pytest: PytestConfig;
}

const states = {
	submitted: TaskState.TASK_STATE_SUBMITTED,
	working: TaskState.TASK_STATE_WORKING,
	completed: TaskState.TASK_STATE_COMPLETED,
	failed: TaskState.TASK_STATE_FAILED,
	canceled: TaskState.TASK_STATE_CANCELED,
	rejected: TaskState.TASK_STATE_REJECTED,
} as const;
type Row = NonNullable<ReturnType<A2ATaskStore["get"]>>;
const methods = new Set(["SendMessage", "GetTask", "CancelTask"]);
const notSupported = async (): Promise<never> => {
	throw new UnsupportedOperationError();
};
function noStream(): AsyncGenerator<never, void, undefined> {
	throw new UnsupportedOperationError();
}

export async function startA2ATestServer(
	input: TestServerOptions,
): Promise<{ origin: string; close(): Promise<void> }> {
	const options = { ...input, sandbox: { ...input.sandbox }, pytest: structuredClone(input.pytest) };
	const { port, principalId, token, sandbox, pytest, agentDir } = options;
	if (
		!Number.isInteger(port) ||
		port < 0 ||
		port > 65535 ||
		!sandbox.enabled ||
		!sandbox.trusted ||
		!isPytestConfig(pytest) ||
		pytest.candidateImport
	)
		throw new Error("MA2_SERVER_CONFIG_INVALID");
	validateConnection({ origin: `http://127.0.0.1:${port || 1}`, principalId, token });
	assertSandboxWorkspaceIdentity(sandbox);
	const project = createProjectScope({ cwd: sandbox.workspace, agentDir });
	const provider = new TaskProvider(createTaskStorageScope(project, agentDir));
	let store: A2ATaskStore;
	try {
		store = new A2ATaskStore(provider.scope.databasePath);
	} catch (error) {
		provider.close();
		throw error;
	}
	const active = new Map<string, { abort: AbortController; done: Promise<void> }>();
	const evidence = createTaskPytestEvidence(sandbox, pytest, () => true);
	const expectedAuth = authDigest(`Bearer ${token}`);
	let origin = "";
	let stopping = false;

	function authorized(intent: RemoteTestIntent, collecting = false): DelegationState | undefined {
		if (intent.projectId !== project.projectId || Date.now() >= intent.deadline) return;
		const parent = provider.get(intent.parentTaskId);
		const step = parent?.steps.find((candidate) => candidate.stepId === intent.subtaskId);
		if (
			(parent?.task.status !== "running" && !(collecting && parent?.task.status === "paused")) ||
			step?.status !== "running" ||
			step.validation?.kind !== "pytest" ||
			step.validation.target !== intent.target ||
			step.validation.expectedSha256 !== intent.snapshot.testHash
		)
			return;
		const state = provider.delegationEvents(intent.parentTaskId).at(-1)?.data as DelegationState | undefined;
		const op = state?.operation;
		if (
			!state ||
			(state.phase !== "testing" && !(collecting && state.phase === "paused" && state.resumePhase === "testing")) ||
			!op ||
			op.agent.role !== "test" ||
			state.remoteTest?.principalId !== principalId ||
			state.remoteTest.origin !== origin ||
			state.target !== intent.target ||
			digest(
				testIntent(
					op,
					{
						patchHash: state.revision,
						workspaceId: state.scope.workspaceId,
						testHash: state.testHash,
						policyHash: state.policyHash,
					},
					state.target,
				),
			) !== digest(intent)
		)
			return;
		if (
			!provider
				.getAttempts(intent.parentTaskId)
				.some(
					(attempt) =>
						attempt.attemptId === intent.attemptId &&
						attempt.stepId === intent.subtaskId &&
						attempt.toolCallId === intent.operationId &&
						attempt.toolName === "run_tests" &&
						attempt.sessionId === op.agent.sessionId &&
						attempt.state === "started",
				)
		)
			return;
		if (!samePytestSnapshot(evidence.source.current(intent.target), intent.snapshot)) return;
		return state;
	}

	function launch(row: Row): void {
		if (stopping || row.status !== "submitted" || active.has(row.id)) return;
		const abort = new AbortController();
		const done = new Promise<void>((resolve) => setImmediate(resolve))
			.then(async () => {
				if (stopping) return;
				const intent = parseIntent(JSON.parse(row.intent_json));
				if (!intent || digest(intent) !== row.intent_hash) throw new Error("MA2_INTENT_CORRUPT");
				let accepted: DelegationState | undefined;
				if (
					!store.claim(principalId, row.id, () => {
						accepted = authorized(intent);
						if (accepted) return "allow";
						return authorized(intent, true)?.phase === "paused" ? "defer" : "deny";
					})
				)
					return;
				let failure = "MA2_EXECUTION_UNCERTAIN";
				try {
					const startedAt = Date.now();
					const signal = AbortSignal.any([
						abort.signal,
						AbortSignal.timeout(Math.max(0, intent.deadline - startedAt)),
					]);
					const runner = createTestExecution(
						{ ...sandbox, containerOwner: row.id, runId: `ma2-${row.id}` },
						pytest,
					);
					await runner.run(
						intent,
						accepted!.sessions.test.sessionId,
						intent.target,
						intent.snapshot,
						signal,
						(result) => {
							if (signal.aborted || !authorized(intent, true)) return;
							const { output: _auditOnly, ...report } = result;
							const diagnosis =
								report.failureKind === "none"
									? null
									: {
											cause:
												report.failureKind === "assertion"
													? ("implementation" as const)
													: ("test-environment" as const),
											recommendation:
												report.failureKind === "assertion"
													? ("inspect-implementation" as const)
													: ("check-fixture" as const),
											file: null,
										};
							const artifact: RemoteTestArtifact = {
								schemaVersion: 1,
								remoteA2ATaskId: row.id,
								intent,
								startedAt,
								endedAt: Date.now(),
								failureSummary: pytestPassed(report.receipt)
									? ""
									: report.failureKind === "assertion"
										? "Approved pytest assertions failed."
										: "Approved pytest did not pass.",
								report,
								diagnosis,
								audit: { owner: row.id, source: "docker-pytest", image: pytest.image },
							};
							store.finish(principalId, row.id, "working", "completed", undefined, artifact);
						},
					);
				} catch {
					failure = "MA2_EXECUTION_FAILED";
				}
				if (!removeRunContainers(row.id)) failure = "MA2_DOCKER_CLEANUP_FAILED";
				store.finish(principalId, row.id, "working", "failed", failure);
			})
			.catch(() => {
				store.finish(principalId, row.id, "working", "failed", "MA2_EXECUTION_FAILED");
				store.finish(principalId, row.id, "submitted", "failed", "MA2_INTENT_CORRUPT");
			})
			.finally(() => {
				active.delete(row.id);
			});
		active.set(row.id, { abort, done });
	}

	function render(row: Row): Task {
		const artifact = storedArtifact(row);
		return {
			id: row.id,
			contextId: row.context_id,
			history: [],
			status: { state: states[row.status], timestamp: new Date(row.updated_at).toISOString(), message: undefined },
			metadata: row.reason ? { code: row.reason } : undefined,
			artifacts: artifact
				? [
						{
							artifactId: row.id,
							name: "pytest-result",
							description: "Verified isolated pytest result",
							metadata: undefined,
							extensions: [],
							parts: [
								{
									content: { $case: "data", value: artifact },
									filename: "",
									mediaType: "application/json",
									metadata: undefined,
								},
							],
						},
					]
				: [],
		};
	}

	function scopedTask(id: string, tenant: string, ctx: ServerCallContext): Row {
		const row =
			ctx.user?.isAuthenticated && ctx.user.userName === principalId && !tenant && uuid.test(id)
				? store.get(principalId, id)
				: undefined;
		if (!row) throw new TaskNotFoundError();
		return row;
	}

	const handler: A2ARequestHandler = {
		async getAgentCard() {
			return makeCard(origin);
		},
		async sendMessage(params: SendMessageRequest, ctx: ServerCallContext) {
			const intent = intentFromRequest(params);
			if (!ctx.user?.isAuthenticated || ctx.user.userName !== principalId || !intent)
				throw new RequestMalformedError("MA2_INTENT_INVALID");
			let row: Row;
			try {
				row = store.submit(principalId, intent, () => !stopping && !!authorized(intent));
			} catch (error) {
				if (error instanceof Error && error.message === "MA2_OPERATION_CONFLICT")
					throw new RequestMalformedError(error.message);
				if (error instanceof Error && error.message === "MA2_INTENT_DENIED") throw new TaskNotFoundError();
				throw error;
			}
			launch(row);
			if (!params.configuration?.returnImmediately) await active.get(row.id)?.done;
			return render(scopedTask(row.id, "", ctx));
		},
		async getTask(params: GetTaskRequest, ctx: ServerCallContext) {
			const row = scopedTask(params.id, params.tenant, ctx);
			launch(row);
			return render(row);
		},
		async cancelTask(params: CancelTaskRequest, ctx: ServerCallContext) {
			const row = scopedTask(params.id, params.tenant, ctx);
			if (row.status === "canceled") return render(row);
			if (
				(row.status !== "working" && row.status !== "submitted") ||
				!store.finish(principalId, row.id, row.status, "canceled", "MA2_CANCELLED")
			)
				throw new TaskNotCancelableError();
			active.get(row.id)?.abort.abort();
			return render(scopedTask(row.id, "", ctx));
		},
		getAuthenticatedExtendedAgentCard: notSupported,
		sendMessageStream: noStream,
		resubscribe: noStream,
		createTaskPushNotificationConfig: notSupported,
		getTaskPushNotificationConfig: notSupported,
		listTaskPushNotificationConfigs: notSupported,
		deleteTaskPushNotificationConfig: notSupported,
		listTasks: notSupported,
	};
	const transport = new JsonRpcTransportHandler(handler);
	const server = createServer((request, response) => {
		void (async () => {
			if (!stopping && request.method === "GET" && request.url === cardPath)
				return send(response, 200, AgentCard.toJSON(await handler.getAgentCard()));
			if (stopping || request.method !== "POST" || request.url !== a2aPath) return send(response, 404, {});
			if (!timingSafeEqual(expectedAuth, authDigest(request.headers.authorization ?? ""))) {
				response.setHeader("www-authenticate", 'Bearer realm="pi-enhanced-test"');
				return send(response, 401, {});
			}
			const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
			if (contentType !== "application/json" && contentType !== "application/a2a+json")
				return send(response, 415, {});
			const ver = typeof request.headers["a2a-version"] === "string" ? request.headers["a2a-version"] : "0.3";
			const account = new ServerCallContext({
				user: { isAuthenticated: true, userName: principalId },
				requestedVersion: ver,
			});
			const body = await readBody(request);
			let bodyId: string | number | null = null;
			try {
				const envelope: unknown = JSON.parse(body);
				if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
					const { id, method } = envelope as { id?: unknown; method?: unknown };
					if (typeof id === "string" || typeof id === "number") bodyId = id;
					if (bodyId === null || (typeof bodyId === "string" && bodyId.length > 120))
						return send(response, 400, {});
					if (typeof method === "string" && !methods.has(method))
						return send(response, 200, {
							jsonrpc: "2.0",
							id: bodyId,
							error: { code: -32601, message: "Method not found" },
						});
				}
			} catch {
				/* The SDK returns the standard parse error. */
			}
			try {
				validateVersion(ver, await handler.getAgentCard(), "JSONRPC");
			} catch (error) {
				return send(response, 200, {
					jsonrpc: "2.0",
					id: bodyId,
					error: JsonRpcTransportHandler.mapToJSONRPCError(error),
				});
			}
			const reply = await transport.handle(body, account);
			if (Symbol.asyncIterator in reply) return send(response, 400, {});
			return send(response, 200, reply);
		})().catch((error: unknown) => {
			if (!response.headersSent)
				send(response, error instanceof Error && error.message === "MA2_BODY_LIMIT" ? 413 : 500, {});
		});
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 5_000;
	server.maxConnections = 16;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", resolve);
		});
		const addr = server.address();
		if (!addr || typeof addr === "string") throw new Error("MA2_LISTEN_FAILED");
		origin = `http://127.0.0.1:${addr.port}`;
		for (const row of store.working(principalId)) {
			if (row.owner_pid && alive(row.owner_pid)) continue;
			if (!removeRunContainers(row.id)) throw new Error("MA2_DOCKER_CLEANUP_FAILED");
			store.finish(principalId, row.id, "working", "failed", "MA2_EXECUTION_UNCERTAIN");
		}
	} catch (error) {
		server.close();
		store.close();
		provider.close();
		throw error;
	}
	let closing: Promise<void> | undefined;
	return {
		origin,
		close() {
			closing ??= (async () => {
				stopping = true;
				for (const job of active.values()) job.abort.abort();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await Promise.allSettled([...active.values()].map((job) => job.done));
				store.close();
				provider.close();
			})();
			return closing;
		},
	};
}

function makeCard(origin: string): AgentCard {
	return AgentCard.fromJSON({
		name: "Pi Enhanced Test Agent",
		description: "Executes authorized pytest tasks with Docker isolation",
		version: "1.0.0",
		supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0", url: origin + a2aPath }],
		capabilities: { streaming: false, pushNotifications: false },
		defaultInputModes: ["application/json"],
		defaultOutputModes: ["application/json"],
		securitySchemes: { localBearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
		securityRequirements: [{ schemes: { localBearer: { list: [] } } }],
		skills: [
			{
				id: "approved-pytest",
				name: "Approved pytest",
				description: "Tests the assigned workspace revision",
				tags: ["pytest", "docker"],
				inputModes: ["application/json"],
				outputModes: ["application/json"],
			},
		],
	});
}

async function readBody(request: IncomingMessage): Promise<string> {
	const parts: Buffer[] = [];
	let total = 0;
	for await (const data of request) {
		const chunk = Buffer.from(data);
		total += chunk.length;
		if (total > maxBody) throw new Error("MA2_BODY_LIMIT");
		parts.push(chunk);
	}
	return Buffer.concat(parts).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

const authDigest = (value: string) => createHash("sha256").update(value).digest();
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
