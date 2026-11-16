import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext, ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import type { ProjectScope } from "../memory/contracts.ts";
import type { TaskManagerConfig } from "./config.ts";
import type { ScopedTaskReader, ScopedTaskSummary } from "./contracts.ts";
import { TaskError } from "./errors.ts";
import { createTaskStorageScope, TaskProvider } from "./provider.ts";
import { classifyToolRisk } from "./risk.ts";
import { TaskService } from "./service.ts";

export type TaskRuntimeState = "disabled" | "blocked" | "ready" | "error";

export class TaskRuntime {
	readonly state: TaskRuntimeState;
	readonly config: TaskManagerConfig;
	readonly scope?: ProjectScope;
	readonly error?: string;
	readonly service?: TaskService;
	readonly reader?: ScopedTaskReader;
	private closed = false;
	constructor(
		state: TaskRuntimeState,
		config: TaskManagerConfig,
		scope?: ProjectScope,
		error?: string,
		service?: TaskService,
	) {
		this.state = state;
		this.config = config;
		this.scope = scope;
		this.error = error;
		this.service = service;
		if (service)
			this.reader = {
				get: async (taskId) => this.summary(taskId),
				getActive: async () => {
					const taskId = this.service?.activeBinding?.taskId;
					return taskId ? this.summary(taskId) : null;
				},
			};
	}

	static start(options: {
		config: TaskManagerConfig;
		trusted: boolean;
		scope?: ProjectScope;
		agentDir: string;
	}): TaskRuntime {
		if (!options.config.enabled) return new TaskRuntime("disabled", options.config);
		if (!options.trusted) return new TaskRuntime("blocked", options.config);
		if (!options.scope) return new TaskRuntime("error", options.config, undefined, "Project scope is unavailable");
		try {
			const provider = new TaskProvider(createTaskStorageScope(options.scope, options.agentDir), {
				maximumTasks: options.config.maximumTasks,
				maximumEvents: options.config.maximumEvents,
			});
			provider.markOpenAttemptsForReconciliation(Date.now());
			return new TaskRuntime(
				"ready",
				options.config,
				options.scope,
				undefined,
				new TaskService(provider, options.config.maximumSteps),
			);
		} catch (error) {
			return new TaskRuntime(
				"error",
				options.config,
				options.scope,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	onToolStart(event: ToolExecutionStartEvent, ctx: ExtensionContext): void {
		const binding = this.activeBinding(ctx);
		if (!binding || !this.service) return;
		const riskClass = classifyToolRisk(event.toolName, event.args);
		const now = Date.now();
		const inputDigest = digestToolInput(event.args);
		this.service.provider.startAttempt({
			attemptId: randomUUID(),
			taskId: binding.taskId,
			stepId: binding.stepId,
			sessionId: binding.sessionId,
			toolCallId: event.toolCallId,
			...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
			toolName: event.toolName.slice(0, 100),
			state: "started",
			riskClass,
			idempotencyKey: createHash("sha256")
				.update(`${binding.taskId}\0${binding.stepId}\0${event.toolCallId}`)
				.digest("hex"),
			inputDigest,
			startedAt: now,
		});
	}

	onToolEnd(event: ToolExecutionEndEvent, ctx: ExtensionContext): void {
		const binding = this.activeBinding(ctx);
		if (!binding || !this.service) return;
		const metadata = resultMetadata(event.result);
		const state = event.isError ? "failed" : "succeeded";
		let resultDigest = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
		if (this.config.mode === "v2") {
			const serialized = JSON.stringify(event.result) ?? "";
			// Hash bounded observations without retaining tool output. Oversized results cannot prove repetition.
			resultDigest =
				Buffer.byteLength(serialized) <= 1024 * 1024
					? createHash("sha256").update(serialized).digest("hex")
					: "unknown";
		}
		const attempt = this.service.provider.endAttempt(
			binding.taskId,
			event.toolCallId,
			state,
			resultDigest,
			Date.now(),
		);
		if (!attempt) return;
		const snapshot = this.service.get(binding.taskId);
		const step = snapshot?.steps.find((item) => item.stepId === binding.stepId);
		const validated =
			!event.isError &&
			step?.validation?.kind === "command_exit" &&
			step.validation.toolName === event.toolName &&
			step.validation.inputDigest === attempt.inputDigest &&
			step.validation.expectedExitCode === metadata.exitCode;
		this.service.addEvidence({
			taskId: binding.taskId,
			stepId: binding.stepId,
			kind: validated ? "validated_command" : "tool_result",
			sourceRef: `tool:${event.toolCallId}`,
			toolCallId: event.toolCallId,
			attemptId: attempt.attemptId,
			outcome: event.isError ? "failed" : "succeeded",
			confidenceClass: event.isError ? "failed" : validated ? "validated" : "observed",
			digestSource: JSON.stringify(metadata),
			inputDigest: attempt.inputDigest,
			...(attempt.resultDigest ? { resultDigest: attempt.resultDigest } : {}),
		});
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.service?.close();
		}
	}
	private activeBinding(ctx: ExtensionContext) {
		if (this.closed || this.state !== "ready" || !this.service) return undefined;
		const binding = this.service.activeBinding;
		return binding?.sessionId === ctx.sessionManager.getSessionId() ? binding : undefined;
	}
	private async summary(taskId: string): Promise<ScopedTaskSummary | null> {
		if (this.closed || !this.service) throw new TaskError("TASK_RUNTIME_UNAVAILABLE", "Task reader is closed");
		const binding = this.service.activeBinding;
		if (!binding || binding.taskId !== taskId) return null;
		const value = this.service.get(taskId);
		if (!value) return null;
		return {
			taskId,
			projectId: value.task.projectId,
			sessionId: binding.sessionId,
			branchLeafId: binding.branchLeafId,
			goal: value.task.goal,
			status: value.task.status,
			revision: value.task.revision,
			planRevision: value.task.planRevision,
			...(value.lastCheckpoint
				? {
						checkpointId: value.lastCheckpoint.checkpointId,
						checkpointRevision: value.lastCheckpoint.taskRevision,
						...(binding.sessionId === value.lastCheckpoint.sessionId &&
						value.lastCheckpoint.observation &&
						this.service.provider.checkpointIntegrity(value.lastCheckpoint) === "verified"
							? { checkpointContextReferences: value.lastCheckpoint.observation.contextReferences }
							: {}),
					}
				: {}),
			reconciliationCount: this.service.provider
				.getAttempts(taskId)
				.filter((attempt) => attempt.state === "needs_reconciliation").length,
			observedAt: Date.now(),
			steps: value.steps.map(({ stepId, title, status, expectedOutcome, dependsOn }) => ({
				stepId,
				title,
				status,
				expectedOutcome,
				dependsOn,
			})),
		};
	}
}

export function digestToolInput(input: unknown): string {
	return createHash("sha256").update(stableJson(input)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right, "en-US"))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function resultMetadata(result: unknown): { isObject: boolean; exitCode?: number; testCount?: number } {
	if (!result || typeof result !== "object") return { isObject: false };
	const value = result as Record<string, unknown>;
	const details =
		value.details && typeof value.details === "object" ? (value.details as Record<string, unknown>) : undefined;
	const exitCode =
		typeof details?.exitCode === "number"
			? details.exitCode
			: typeof value.exitCode === "number"
				? value.exitCode
				: undefined;
	const testCount = typeof details?.testCount === "number" ? details.testCount : undefined;
	return {
		isObject: true,
		...(exitCode === undefined ? {} : { exitCode }),
		...(testCount === undefined ? {} : { testCount }),
	};
}

export function branchLeaf(ctx: ExtensionContext): string | null {
	return ctx.sessionManager.getLeafId();
}
