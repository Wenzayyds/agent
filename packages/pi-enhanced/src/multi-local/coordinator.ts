import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	type BudgetGatewayPricing,
	type BudgetGatewayStatus,
	type RunningBudgetGateway,
	startBudgetGateway,
} from "../../benchmarks/real-agent/budget-gateway.ts";
import { storedBudget } from "../../benchmarks/real-agent/budget-persistence.ts";
import { removeRunContainers } from "../../benchmarks/real-agent/runner-cleanup.ts";
import { createProjectScope } from "../memory/project-scope.ts";
import { type A2AConnection, testIntent, validateConnection } from "../multi-a2a/contract.ts";
import { assertSandboxWorkspaceIdentity, type SandboxConfig } from "../sandbox/config.ts";
import { isPytestConfig, type PytestConfig, pytestFileVersions } from "../sandbox/pytest.ts";
import { createTaskPytestEvidence } from "../sandbox/task-evidence.ts";
import { loadTaskBudget } from "../shared/config.ts";
import { TASK_TOKEN_TIERS } from "../shared/task-budget.ts";
import type { ScopedTaskSummary, TaskAttempt, TaskSnapshot } from "../task-manager/contracts.ts";
import { createTaskStorageScope, TaskProvider } from "../task-manager/provider.ts";
import { TaskService } from "../task-manager/service.ts";
import {
	type RoleModelOverrides,
	type RoleModelSelection,
	restoreRoleModels,
	selectRoleModels,
} from "./model-config.ts";
import {
	type AgentRole,
	type DelegatedTask,
	type DelegationState,
	digest,
	type MultiLocalRequest,
	parseDiagnosis,
	type TestReport,
} from "./protocol.ts";
import { allowedRoleTools, closeRole, createRoleIdentity, openRole } from "./roles.ts";
import { createTestExecution, pytestPassed, samePytestSnapshot } from "./test-execution.ts";

const source = "ma1-coordinator";
const repair = "repair";
const verify = "verify";
const maximumTestRuns = 3;
const terminalPhases = new Set(["completed", "paused"]);

export interface MultiLocalOptions {
	agentDir: string;
	sandbox: SandboxConfig;
	pytest: PytestConfig;
	provider: { baseUrl: string; apiKey: string; modelId: string; pricing: BudgetGatewayPricing };
	roleModels?: RoleModelOverrides;
	signal?: AbortSignal;
	onCheckpoint?: (checkpoint: string, taskId: string) => void;
	onTool?: (role: AgentRole, name: string, denied: boolean) => void;
	remoteTest?: A2AConnection;
	a2aFetch?: typeof fetch;
}

export interface MultiLocalResult {
	task: TaskSnapshot;
	state: Omit<DelegationState, "report"> & { report?: Omit<TestReport, "output"> };
	budget: BudgetGatewayStatus | undefined;
	modifiedFiles: string[];
}

export async function runMultiLocal(
	input: MultiLocalOptions,
	request: MultiLocalRequest | { resume: string },
): Promise<MultiLocalResult> {
	const options = {
		...input,
		provider: { ...input.provider, pricing: { ...input.provider.pricing } },
		sandbox: { ...input.sandbox },
		pytest: structuredClone(input.pytest),
		remoteTest: input.remoteTest ? { ...input.remoteTest } : undefined,
	};
	const run = new Coordinator(options);
	try {
		if ("resume" in request) run.restore(request.resume);
		else run.initialize(request);
		return await run.execute();
	} finally {
		await run.close();
	}
}

class Coordinator {
	private readonly provider: TaskProvider;
	private readonly service: TaskService;
	private pytest?: ReturnType<typeof createTestExecution>;
	private readonly evidence: ReturnType<typeof createTaskPytestEvidence>;
	private readonly permits = new Map<string, (modelId: string) => void>();
	private readonly hostToken = randomUUID();
	private gateway?: RunningBudgetGateway;
	private deadline?: AbortSignal;
	private taskId!: string;
	private state!: DelegationState;
	private roleModels!: RoleModelSelection;
	private seq = 0;
	private readonly excludedReads = new Set<string>();
	private readonly options: MultiLocalOptions;

	constructor(options: MultiLocalOptions) {
		this.options = options;
		if (options.remoteTest) validateConnection(options.remoteTest);
		const { agentDir, sandbox, pytest } = options;
		if (!sandbox.enabled || !sandbox.trusted || !isPytestConfig(pytest) || pytest.candidateImport)
			throw new Error("MA1_SANDBOX_POLICY_DENIED");
		assertSandboxWorkspaceIdentity(sandbox);
		const fromWorkspace = relative(sandbox.workspace, resolve(agentDir));
		if (!fromWorkspace || (!isAbsolute(fromWorkspace) && !fromWorkspace.split(/[\\/]/u).includes("..")))
			throw new Error("MA1_SESSION_STORAGE_INSIDE_WORKSPACE");
		const scope = createProjectScope({ cwd: sandbox.workspace, agentDir });
		this.evidence = createTaskPytestEvidence(sandbox, pytest, () => true);
		this.provider = new TaskProvider(createTaskStorageScope(scope, agentDir));
		this.service = new TaskService(this.provider, 2, () => this.evidence.source);
	}

	initialize(request: MultiLocalRequest): void {
		const { sandbox, agentDir } = this.options;
		const initial = this.evidence.source.current(request.target);
		if (
			!initial ||
			!this.allowedEdits(request.editFiles) ||
			(request.diagnose !== undefined && typeof request.diagnose !== "boolean")
		)
			throw new Error("MA1_REQUEST_DENIED");
		const budget = loadTaskBudget({ agentDir, cwd: sandbox.workspace, projectTrusted: true });
		this.roleModels = selectRoleModels(this.options.provider, this.options.roleModels);
		const maxDiagnosisRequests = request.maxDiagnosisRequests ?? Math.min(3, budget.maxRequests);
		if (
			!Number.isInteger(maxDiagnosisRequests) ||
			maxDiagnosisRequests < 1 ||
			maxDiagnosisRequests > budget.maxRequests
		)
			throw new Error("MA1_REQUEST_DENIED");
		const original = pytestFileVersions(sandbox, this.options.pytest);
		this.provider.transaction(() => {
			const workInProgress = this.provider.list().some((task) => {
				const previous = this.provider.delegationEvents(task.taskId).at(-1)?.data as DelegationState | undefined;
				return (
					previous &&
					(["running", "verifying", "needs_reconciliation"].includes(task.status) || previous.resumePhase)
				);
			});
			if (workInProgress) throw new Error("MA1_WORKSPACE_ALREADY_ASSIGNED");
			const { task } = this.service.create(
				request.goal,
				[
					{ title: "Repair approved files", expectedOutcome: "Verified patch", riskClass: "mutating" },
					{
						title: "Execute approved pytest",
						expectedOutcome: "Current Docker pytest receipt",
						riskClass: "read_only",
						validation: { kind: "pytest", target: request.target, expectedSha256: initial.testHash },
					},
				],
				randomUUID(),
				null,
			);
			this.taskId = task.taskId;
			const directory = this.sessionDirectory();
			this.taskStatus("queued");
			this.taskStatus("running");
			this.stepStatus(repair, "running");
			this.stepStatus(verify, "running");
			this.save(
				{
					schemaVersion: 1,
					phase: "edit",
					deadline: Date.now() + budget.timeoutMs,
					budget,
					roleModels: this.roleModels,
					retrieval: this.retrieval(),
					scope: { projectId: task.projectId, workspaceId: initial.workspaceId },
					target: request.target,
					testHash: initial.testHash,
					policyHash: initial.policyHash,
					editFiles: [...request.editFiles],
					diagnose: request.diagnose ?? !this.options.remoteTest,
					...(this.remoteSettings() ? { remoteTest: this.remoteSettings() } : {}),
					maxDiagnosisRequests,
					sessions: {
						code: createRoleIdentity(sandbox.workspace, directory, "code"),
						test: createRoleIdentity(sandbox.workspace, directory, "test"),
					},
					revision: initial.patchHash,
					originalFiles: request.editFiles.map((path) => [path, original.get(path)!]),
					protectedWrites: [],
					iteration: 1,
					requests: { code: 0, test: 0 },
				},
				"initialized",
			);
		});
		this.checkpoint("initialized");
	}

	restore(taskId: string): void {
		if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(taskId)) throw new Error("MA1_TASK_ID_INVALID");
		this.taskId = taskId;
		const last = this.provider.delegationEvents(taskId).at(-1);
		if (!last) throw new Error("MA1_TASK_NOT_FOUND");
		const state = last.data as DelegationState;
		if (
			!state ||
			state.schemaVersion !== 1 ||
			!["edit", "testing", "diagnose", "finalize", "completed", "paused"].includes(state.phase) ||
			state.scope?.projectId !== this.provider.scope.projectId ||
			digest(state.remoteTest ?? null) !== digest(this.remoteSettings() ?? null) ||
			!this.allowedEdits(state.editFiles) ||
			!state.retrieval ||
			digest(state.retrieval) !== digest(this.retrieval()) ||
			!Array.isArray(state.protectedWrites) ||
			!state.protectedWrites.every((path) => state.editFiles.includes(path)) ||
			!Object.hasOwn(TASK_TOKEN_TIERS, state.budget?.tier) ||
			!Number.isSafeInteger(state.deadline) ||
			!Number.isInteger(state.iteration) ||
			!Number.isInteger(state.maxDiagnosisRequests) ||
			state.maxDiagnosisRequests < 1 ||
			state.maxDiagnosisRequests > state.budget.maxRequests ||
			state.iteration < 1 ||
			state.iteration > maximumTestRuns ||
			state.sessions?.code?.role !== "code" ||
			state.sessions?.test?.role !== "test" ||
			state.sessions.test.sessionId === state.sessions.code.sessionId
		)
			throw new Error("MA1_DELEGATION_STATE_INVALID");
		const parent = this.task();
		if (
			(state.phase === "completed" && parent.task.status !== "completed") ||
			(state.resumePhase &&
				(state.phase !== "paused" ||
					parent.task.status !== "paused" ||
					!["edit", "testing", "diagnose", "finalize"].includes(state.resumePhase))) ||
			(!terminalPhases.has(state.phase) && parent.task.status !== "running")
		)
			throw new Error("MA1_PARENT_STATE_CONFLICT");
		this.state = state;
		this.roleModels =
			state.roleModels === undefined
				? selectRoleModels(this.options.provider)
				: restoreRoleModels(state.roleModels, this.options.provider.baseUrl);
		this.seq = last.seq;
	}

	async execute(): Promise<MultiLocalResult> {
		if (terminalPhases.has(this.state.phase) && !this.state.resumePhase) return this.result();
		const prior = this.storedBudget();
		const settings = this.state.budget;
		const { provider } = this.options;
		const { code, test, strict } = this.roleModels;
		const models = this.state.diagnose && code.modelId !== test.modelId ? [code, test] : [code];
		if (!prior && this.state.operation) throw new Error("MA1_LEDGER_MISSING");
		try {
			this.gateway = await startBudgetGateway({
				runId: this.taskId,
				upstreamBaseUrl: this.roleModels.upstreamBaseUrl,
				upstreamApiKey: provider.apiKey,
				allowedModel: code.modelId,
				pricing: code.pricing,
				...(strict ? { models } : {}),
				clientToken: this.hostToken,
				adminToken: randomUUID(),
				limits: prior?.limits ?? {
					tier: settings.tier,
					maxTotalTokens: TASK_TOKEN_TIERS[settings.tier],
					maxRequests: settings.maxRequests,
					maxOutputTokensPerRequest: settings.maxOutputTokensPerRequest,
					maxTotalCostUsd: settings.maxTotalCostUsd,
					minOutputTokensPerRequest: Math.min(128, settings.maxOutputTokensPerRequest),
					maxConcurrency: 1,
					maxRequestBytes: 96_000,
					requestTimeoutMs: Math.min(20_000, settings.timeoutMs),
				},
				runDeadlineAt: this.state.deadline,
				guardedClientRetry: true,
				dispatchCheck: (permit) => (permit ? this.permits.get(permit) : undefined),
				persistence: {
					databasePath: this.provider.scope.databasePath,
					id: this.taskId,
					...(prior ? { mode: "resume" as const } : { mode: "create" as const, deadlineAt: this.state.deadline }),
				},
			});
		} catch (error) {
			if (!["GATEWAY_RUN_TIMEOUT", "GATEWAY_BUDGET_UNCERTAIN_USAGE"].includes(errorCode(error))) throw error;
			this.pause(errorCode(error), Boolean(this.state.operation));
			return this.result();
		}
		// Another owner may have advanced the state between our initial read and ledger acquisition.
		const latest = this.provider.delegationEvents(this.taskId).at(-1);
		if (latest?.seq !== this.seq) this.restore(this.taskId);
		if (terminalPhases.has(this.state.phase) && !this.state.resumePhase) return this.result();
		const deadline = AbortSignal.timeout(Math.max(0, this.gateway.deadlineAt! - Date.now()));
		this.deadline = this.options.signal ? AbortSignal.any([deadline, this.options.signal]) : deadline;
		try {
			if (prior && !removeRunContainers(this.taskId)) throw new Error("MA1_RECOVERY_CLEANUP_FAILED");
			if (this.state.operation && !this.resumableRemoteTest()) {
				this.pause("MA1_INCOMPLETE_DELEGATION", this.state.phase === "edit");
				return this.result();
			}
			if (this.state.resumePhase) {
				this.provider.transaction(() => {
					this.taskStatus("queued");
					this.taskStatus("running");
					this.save(
						{ ...this.state, phase: this.state.resumePhase!, resumePhase: undefined, reason: undefined },
						"resumed",
					);
				});
			}
			for (const task of this.provider.list()) {
				const last = this.provider.delegationEvents(task.taskId).at(-1)?.data as DelegationState | undefined;
				for (const path of last?.protectedWrites ?? []) this.excludedReads.add(path);
			}
			if (!this.options.remoteTest) this.pytest = createTestExecution(this.sandbox(), this.options.pytest);
			while (!terminalPhases.has(this.state.phase)) {
				this.assertActive();
				if (this.task().task.status !== "running") throw new Error("MA1_PARENT_STATE_CONFLICT");
				const live = this.currentVersion();
				if (live.patchHash !== this.state.revision) throw new Error("MA1_STALE_WORKSPACE");
				switch (this.state.phase) {
					case "edit":
						await this.edit();
						break;
					case "testing":
						await this.test();
						break;
					case "diagnose":
						await this.diagnose();
						break;
					case "finalize":
						this.finalize();
						break;
				}
			}
		} catch (error) {
			const code = errorCode(error);
			if (code === "MA2_TRANSPORT_UNAVAILABLE" && this.resumableRemoteTest() && Date.now() < this.state.deadline) {
				this.provider.transaction(() => {
					this.taskStatus("paused");
					this.save({ ...this.state, phase: "paused", resumePhase: "testing", reason: code }, "a2a_disconnected");
				});
				return this.result();
			}
			this.pause(
				code,
				this.state.phase === "edit" &&
					Boolean(this.state.operation) &&
					this.provider
						.getAttempts(this.taskId)
						.some((attempt) => attempt.state === "started" && attempt.toolName === "edit"),
			);
		}
		return this.result();
	}

	async close(): Promise<void> {
		try {
			await this.gateway?.close();
		} finally {
			this.service.close();
		}
	}

	private async edit(): Promise<void> {
		const report = this.state.report;
		if (report && report.workspaceRevision !== this.state.revision) throw new Error("MA1_STALE_REPORT");
		const operation = this.begin("code", repair);
		const result = await this.prompt(
			"code",
			JSON.stringify({
				goal: this.task().task.goal,
				workspaceRevision: this.state.revision,
				editFiles: this.state.editFiles,
				instruction: "Inspect the allowed source and make the necessary edit. End with a short summary.",
				...(report ? { failedTest: publicReport(report), diagnosis: this.state.diagnosis } : {}),
			}),
			operation,
		);
		const revision = this.currentVersion().patchHash;
		if (revision === operation.workspaceRevision && !result) throw new Error("MA1_CODE_RESPONSE_MISSING");
		if (
			revision === operation.workspaceRevision ||
			!this.provider
				.getAttempts(this.taskId)
				.some(
					(attempt) =>
						attempt.parentToolCallId === operation.operationId &&
						attempt.toolName === "edit" &&
						attempt.state === "succeeded",
				)
		)
			throw new Error("MA1_PATCH_MISSING");
		this.save(
			{ ...this.state, phase: "testing", revision, operation: undefined, report: undefined, diagnosis: undefined },
			"edit_committed",
		);
		this.checkpoint("edit_committed");
	}

	private async test(): Promise<void> {
		const taskId = this.taskId;
		const operation = this.state.operation ?? this.begin("test", verify);
		const target = this.state.target;
		const expected = this.currentVersion();
		const attempt = this.attempt(operation, operation.operationId, "run_tests", target);
		const existing = this.provider.getAttempts(taskId).find((item) => item.attemptId === attempt.attemptId);
		if (!existing) this.provider.startAttempt(attempt);
		else if (!this.options.remoteTest || existing.state !== "started" || existing.inputDigest !== attempt.inputDigest)
			throw new Error("MA2_ATTEMPT_CONFLICT");

		const record = (report: TestReport) => {
			const receipt = report.receipt;
			if (
				receipt.target !== target ||
				!samePytestSnapshot(receipt, expected) ||
				!samePytestSnapshot(this.currentVersion(), expected) ||
				report.subtaskId !== operation.subtaskId ||
				report.sessionId !== operation.agent.sessionId ||
				report.operationId !== operation.operationId
			)
				throw new Error("MA1_RECEIPT_INVALID");
			const passed = pytestPassed(receipt);
			this.provider.transaction(() => {
				this.provider.endAttempt(
					taskId,
					attempt.toolCallId,
					passed ? "succeeded" : "failed",
					digest(receipt),
					Date.now(),
				);
				this.service.addEvidence({
					taskId,
					stepId: attempt.stepId,
					toolCallId: attempt.toolCallId,
					attemptId: attempt.attemptId,
					kind: "sandbox_pytest",
					sourceRef: `tool:${attempt.toolCallId}`,
					pytest: receipt,
					outcome: passed ? "succeeded" : "failed",
					confidenceClass: passed ? "validated" : "observed",
					digestSource: JSON.stringify(receipt),
					resultDigest: receipt.patchHash,
				});
				this.save(
					{
						...this.state,
						phase: passed ? "finalize" : "diagnose",
						report,
						operation: undefined,
						remoteTestTaskId: undefined,
					},
					"pytest_receipt",
				);
			});
			this.checkpoint("pytest_receipt");
		};

		if (!this.options.remoteTest) {
			await this.pytest!.run(operation, operation.agent.sessionId, target, expected, this.deadline, record);
			return;
		}
		if (!existing) this.checkpoint("a2a_intent_saved");
		const { executeRemoteTest } = await import("../multi-a2a/client.ts");
		const result = await executeRemoteTest(
			this.options.remoteTest,
			this.provider.scope.databasePath,
			testIntent(operation, expected, target),
			this.deadline!,
			this.state.remoteTestTaskId,
			(id) => {
				this.save({ ...this.state, remoteTestTaskId: id }, "a2a_task_mapped");
				this.checkpoint("a2a_task_mapped");
			},
			this.options.a2aFetch,
		);
		this.assertActive();
		record({
			...result.report,
			output: "",
			remoteA2ATaskId: result.remoteA2ATaskId,
			...(result.diagnosis ? { remoteDiagnosis: result.diagnosis } : {}),
		});
	}

	private async diagnose(): Promise<void> {
		const report = this.state.report;
		if (!report || report.workspaceRevision !== this.state.revision) throw new Error("MA1_STALE_REPORT");
		if (report.receipt.status !== "failed") throw new Error(`MA1_PYTEST_${report.receipt.status.toUpperCase()}`);
		if (this.state.iteration >= maximumTestRuns) throw new Error("MA1_REPAIR_LIMIT");
		const diagnosis = this.state.diagnose
			? parseDiagnosis(
					await this.prompt(
						"test",
						JSON.stringify({
							goal: this.task().task.goal,
							evidence: publicReport(report),
							files: this.state.editFiles,
							instruction:
								'Return only JSON containing cause ("implementation", "test-environment", "unknown"), recommendation ("inspect-implementation", "review-contract", "check-fixture"), and file (approved path or null).',
						}),
						this.begin("test", verify),
					),
					this.state.editFiles,
				)
			: (report.remoteDiagnosis ?? {
					cause: "unknown" as const,
					recommendation: "inspect-implementation" as const,
					file: null,
				});
		this.save(
			{ ...this.state, phase: "edit", iteration: this.state.iteration + 1, diagnosis, operation: undefined },
			"diagnosis_delivered",
		);
		this.checkpoint("diagnosis_delivered");
	}

	private finalize(): void {
		const report = this.state.report;
		if (!report || report.workspaceRevision !== this.currentVersion().patchHash || !this.modifiedFiles().length)
			throw new Error("MA1_STALE_REPORT");
		this.provider.transaction(() => {
			this.service.addEvidence({
				taskId: this.taskId,
				stepId: this.step(repair).stepId,
				kind: "ma1_verified_patch",
				sourceRef: report.operationId,
				outcome: "succeeded",
				confidenceClass: "validated",
				digestSource: report.workspaceRevision,
			});
			this.stepStatus(repair, "verifying");
			this.stepStatus(verify, "verifying");
			this.stepStatus(verify, "completed");
			this.stepStatus(repair, "completed");
			this.taskStatus("verifying");
			this.taskStatus("completed");
			this.save({ ...this.state, phase: "completed" }, "completed");
		});
	}

	private async prompt(role: AgentRole, prompt: string, operation: DelegatedTask): Promise<string> {
		const gateway = this.gateway!;
		const prior = gateway.status();
		let diagnosisLimitReached = false;
		const session = await openRole({
			identity: operation.agent,
			directory: this.sessionDirectory(),
			agentDir: this.options.agentDir,
			sandbox: this.sandbox(),
			reads: this.options.pytest.files,
			edits: this.state.editFiles,
			task: () => this.taskSummary(role),
			gateway,
			hostToken: this.hostToken,
			modelId: this.roleModels[role].modelId,
			capabilities: this.roleModels.strict ? this.roleModels[role] : undefined,
			permits: this.permits,
			assertBudget: () => {
				this.assertActive();
				const requests = this.requestsAfter(role, prior.requestsStarted);
				if (role === "test" && requests.test >= this.state.maxDiagnosisRequests) {
					diagnosisLimitReached = true;
					throw new Error("MA1_DIAGNOSIS_REQUEST_LIMIT");
				}
			},
			canRead: (path) => !this.excludedReads.has(path),
			startWrite: (id, data) => {
				this.assertActive();
				const attempt = this.attempt(operation, id, "edit", data);
				if (
					this.provider
						.getAttempts(this.taskId)
						.some((previous) => previous.toolCallId === id || previous.idempotencyKey === attempt.idempotencyKey)
				)
					return false;
				const path = (data as { path: string }).path;
				this.provider.transaction(() => {
					this.provider.startAttempt(attempt);
					// A generated patch can persist material that was authorized when the model created it.
					// The Sandbox receipt stays usable. A later model cannot read those bytes without provenance.
					if (
						(this.state.retrieval.memory || this.state.retrieval.knowledge) &&
						!this.state.protectedWrites.includes(path)
					) {
						this.save(
							{ ...this.state, protectedWrites: [...this.state.protectedWrites, path] },
							"write_source_guard",
						);
						this.excludedReads.add(path);
					}
				});
				return true;
			},
			finishWrite: (id, ok) => {
				const attempt = this.provider.endAttempt(
					this.taskId,
					id,
					ok ? "succeeded" : "failed",
					this.currentVersion().patchHash,
					Date.now(),
				);
				if (ok && attempt) this.checkpoint("write_returned");
			},
			onTool: (name, denied) => this.options.onTool?.(role, name, denied),
		});
		const abort = () => {
			void session.abort();
		};
		this.deadline!.addEventListener("abort", abort, { once: true });
		try {
			this.assertActive();
			await session.prompt(prompt, { expandPromptTemplates: false });
			if (diagnosisLimitReached) throw new Error("MA1_DIAGNOSIS_REQUEST_LIMIT");
			const last = session.messages.findLast((message) => message.role === "assistant");
			const after = gateway.status();
			if (after.requestsRejected > prior.requestsRejected) {
				const denial = after.lastError ?? after.denials.at(-1)?.code;
				if (denial) throw new Error(denial);
			}
			if (this.deadline?.aborted) this.assertActive();
			if (!last || last.stopReason !== "stop") throw new Error("MA1_ROLE_RESPONSE_INCOMPLETE");
			return session.getLastAssistantText() ?? "";
		} finally {
			this.deadline!.removeEventListener("abort", abort);
			await closeRole(session);
			if (this.state.operation)
				this.save({ ...this.state, requests: this.requestsAfter(role, prior.requestsStarted) }, "role_accounted");
		}
	}

	private begin(role: AgentRole, stepId: string): DelegatedTask {
		if (this.state.operation) throw new Error("MA1_OPERATION_ALREADY_STARTED");
		const operationId = digest([this.taskId, this.state.iteration, this.state.phase, this.state.revision]);
		const operation: DelegatedTask = {
			schemaVersion: 1,
			parentTaskId: this.taskId,
			subtaskId: this.step(stepId).stepId,
			operationId,
			attemptId: digest([operationId, "attempt"]),
			agent: this.state.sessions[role],
			workspaceRevision: this.state.revision,
			scope: this.state.scope,
			allowedTools: allowedRoleTools(role, this.options.sandbox),
			budgetAllocation: "parent",
			deadline: this.state.deadline,
		};
		this.save({ ...this.state, operation }, `${this.state.phase}_assigned`);
		return operation;
	}

	private attempt(operation: DelegatedTask, id: string, tool: "edit" | "run_tests", input: unknown): TaskAttempt {
		return {
			attemptId: tool === "run_tests" ? operation.attemptId : digest([operation.operationId, id]),
			taskId: this.taskId,
			stepId: operation.subtaskId,
			sessionId: operation.agent.sessionId,
			toolCallId: id,
			parentToolCallId: operation.operationId,
			toolName: tool,
			state: "started",
			riskClass: tool === "edit" ? "mutating" : "read_only",
			idempotencyKey: digest([operation.operationId, input]),
			inputDigest: digest(input),
			startedAt: Date.now(),
		};
	}

	private allowedEdits(paths: string[]): boolean {
		const policy = this.options.pytest;
		return (
			Array.isArray(paths) &&
			paths.length > 0 &&
			paths.length <= 12 &&
			new Set(paths).size === paths.length &&
			paths.every(
				(path) =>
					typeof path === "string" &&
					path.length <= 128 &&
					policy.files.includes(path) &&
					!policy.tests.some((target) => target.split("::")[0] === path),
			)
		);
	}

	private currentVersion() {
		const current = this.evidence.source.current(this.state.target);
		if (
			!current ||
			current.workspaceId !== this.state.scope.workspaceId ||
			current.testHash !== this.state.testHash ||
			current.policyHash !== this.state.policyHash
		)
			throw new Error("MA1_WORKSPACE_POLICY_CHANGED");
		return current;
	}

	private assertActive() {
		if (Date.now() >= this.state.deadline) throw new Error("GATEWAY_RUN_TIMEOUT");
		if (this.options.signal?.aborted) throw new Error("MA1_CANCELLED");
		if (this.deadline?.aborted) throw new Error("GATEWAY_RUN_TIMEOUT");
	}

	private pause(reason: string, reconcile: boolean): void {
		this.provider.transaction(() => {
			if (this.state.operation) this.provider.markOpenAttemptsForReconciliation(Date.now(), this.taskId);
			if (this.task().task.status === "running") this.taskStatus(reconcile ? "needs_reconciliation" : "paused");
			const phase = this.state.phase;
			const resumePhase =
				reason === "MA1_CANCELLED" && !this.state.operation && phase !== "paused" && phase !== "completed"
					? phase
					: undefined;
			this.save({ ...this.state, phase: "paused", reason, resumePhase }, "paused");
		});
	}

	private save(state: DelegationState, event: string) {
		this.seq = this.provider.appendDelegation(this.taskId, this.seq, event, state);
		this.state = state;
	}

	private task() {
		return this.service.get(this.taskId)!;
	}
	private sandbox(): SandboxConfig {
		return { ...this.options.sandbox, containerOwner: this.taskId };
	}
	private remoteSettings(): DelegationState["remoteTest"] {
		const connection = this.options.remoteTest;
		return connection ? { origin: connection.origin, principalId: connection.principalId } : undefined;
	}
	private resumableRemoteTest(): boolean {
		return (
			!!this.state.remoteTest &&
			this.state.operation?.agent.role === "test" &&
			(this.state.phase === "testing" || (this.state.phase === "paused" && this.state.resumePhase === "testing"))
		);
	}
	private retrieval() {
		return {
			memory: this.options.sandbox.readonlyModuleTools === true,
			knowledge: this.options.sandbox.readonlyKnowledgeTools === true,
		};
	}
	private sessionDirectory() {
		return join(this.provider.scope.dataDir, "ma1", this.taskId);
	}
	private storedBudget() {
		return storedBudget({ databasePath: this.provider.scope.databasePath, id: this.taskId });
	}
	private checkpoint(name: string) {
		this.options.onCheckpoint?.(name, this.taskId);
	}

	private taskStatus(status: Parameters<TaskService["transitionTask"]>[2]) {
		this.service.transitionTask(this.taskId, this.task().task.revision, status, source);
	}

	private stepStatus(id: string, status: Parameters<TaskService["transitionStep"]>[3]) {
		const step = this.step(id);
		this.service.transitionStep(this.taskId, step.stepId, step.revision, status, source);
	}

	private step(id: string) {
		return this.task().steps[id === repair ? 0 : 1]!;
	}

	private taskSummary(role: AgentRole): ScopedTaskSummary | null {
		if (role !== "code") return null;
		const { task } = this.task();
		return {
			taskId: task.taskId,
			goal: task.goal,
			projectId: task.projectId,
			status: task.status,
			sessionId: this.state.sessions.code.sessionId,
			branchLeafId: null,
			revision: task.revision,
			planRevision: task.planRevision,
			reconciliationCount: 0,
			observedAt: task.updatedAt,
			steps: [this.step(repair)],
		};
	}

	private requestsAfter(role: AgentRole, before: number) {
		return {
			...this.state.requests,
			[role]: this.state.requests[role] + this.gateway!.status().requestsStarted - before,
		};
	}

	private modifiedFiles(): string[] {
		const live = pytestFileVersions(this.options.sandbox, this.options.pytest);
		return this.state.originalFiles.filter(([path, hash]) => live.get(path) !== hash).map(([path]) => path);
	}

	private result(): MultiLocalResult {
		const { report, ...state } = this.state;
		const safeReport = report ? publicReport(report) : undefined;
		let modifiedFiles: string[] = [];
		try {
			modifiedFiles = this.modifiedFiles();
		} catch {
			/* Missing workspace cannot establish a patch. */
		}
		return {
			task: this.task(),
			state: { ...state, report: safeReport },
			budget: this.gateway?.status() ?? this.storedBudget(),
			modifiedFiles,
		};
	}
}

function publicReport({ output: _localOnly, ...report }: TestReport) {
	return report;
}

function errorCode(error: unknown): string {
	if (error instanceof Error && /^(?:MA[12]|GATEWAY)_[A-Z0-9_]+$/u.test(error.message)) return error.message;
	return "MA1_EXECUTION_FAILED";
}
