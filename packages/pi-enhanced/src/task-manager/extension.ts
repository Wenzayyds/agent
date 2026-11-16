import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { contextReferences } from "../context/offload.ts";
import { requestMemoryCandidateWrite } from "../memory/candidate-writer.ts";
import type { ProjectScope } from "../memory/contracts.ts";
import { createProjectScope } from "../memory/project-scope.ts";
import { loadTaskManagerConfig } from "./config.ts";
import type { CheckpointObservation, TaskSnapshot, TaskStepInput } from "./contracts.ts";
import { TaskError } from "./errors.ts";
import { registerScopedTaskReaderBroker } from "./reader.ts";
import { createCheckpoint, recoveryPreflight } from "./recovery.ts";
import { branchLeaf, TaskRuntime } from "./runtime.ts";
import { ownsModelPlan, progressLedger, registerTaskV2, TASK_V2_TOOL } from "./v2.ts";

export interface TaskManagerExtensionOptions {
	agentDir?: string;
	initialBinding?: { taskId: string; stepId: string };
}
export function createTaskManagerExtension(options: TaskManagerExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerTaskManagerExtension(pi, options);
}

function registerTaskManagerExtension(pi: ExtensionAPI, options: TaskManagerExtensionOptions): void {
	let runtime: TaskRuntime | undefined;
	let generation = 0;
	let interactionsRegistered = false;
	let unsubscribeReader: (() => void) | undefined;
	let registerV2: () => void;
	const start = async (ctx: ExtensionContext): Promise<void> => {
		generation += 1;
		const currentGeneration = generation;
		const previous = runtime;
		runtime = undefined;
		unsubscribeReader?.();
		unsubscribeReader = undefined;
		previous?.close();
		const agentDir = options.agentDir ?? getAgentDir();
		const loaded = loadTaskManagerConfig({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		let scope: ProjectScope | undefined;
		if (loaded.config.enabled && ctx.isProjectTrusted() && loaded.errors.length === 0) {
			try {
				scope = createProjectScope({ cwd: ctx.cwd, agentDir });
			} catch {}
		}
		const next =
			loaded.errors.length > 0
				? new TaskRuntime("error", loaded.config, undefined, loaded.errors.join("; "))
				: TaskRuntime.start({
						config: loaded.config,
						trusted: ctx.isProjectTrusted(),
						...(scope ? { scope } : {}),
						agentDir,
					});
		if (currentGeneration !== generation) {
			next.close();
			return;
		}
		runtime = next;
		if (options.initialBinding && next.state === "ready" && next.service) {
			const { taskId, stepId } = options.initialBinding;
			const snapshot = next.service.get(taskId);
			if (snapshot?.task.status === "running" && snapshot.steps.some((step) => step.stepId === stepId && step.status === "pending"))
				next.service.bind(taskId, stepId, ctx.sessionManager.getSessionId(), branchLeaf(ctx));
		}
		if (next.state === "ready" && next.scope && next.reader) {
			if (!interactionsRegistered) {
				registerInteractions(pi, () => runtime);
				interactionsRegistered = true;
			}
			registerTools(pi, () => runtime, true);
			unsubscribeReader = registerScopedTaskReaderBroker(pi.events, {
				reader: next.reader,
				scope: next.scope,
				sessionId: ctx.sessionManager.getSessionId(),
			});
		} else if (interactionsRegistered) registerTools(pi, () => runtime, false);
		registerV2();
	};

	pi.on("session_start", async (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => {
		generation += 1;
		const current = runtime;
		runtime = undefined;
		unsubscribeReader?.();
		unsubscribeReader = undefined;
		if (interactionsRegistered) registerTools(pi, () => runtime, false);
		registerV2();
		current?.close();
	});
	pi.on("session_tree", () => runtime?.service?.unbind());
	pi.on("tool_execution_start", (event, ctx) => {
		const current = runtime;
		if (current?.config.mode === "v2" && [TASK_V2_TOOL, "enhanced_task_get"].includes(event.toolName)) return;
		if (current) {
			try {
				current.onToolStart(event, ctx);
			} catch {
				// Evidence collection is observational and must never block the underlying tool.
			}
		}
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const current = runtime;
		if (current?.config.mode === "v2" && [TASK_V2_TOOL, "enhanced_task_get"].includes(event.toolName)) return;
		if (current) {
			try {
				current.onToolEnd(event, ctx);
			} catch {
				// Recovery will reconcile a start without a committed end.
			}
		}
	});
	registerV2 = registerTaskV2(pi, () => runtime);
	pi.on("agent_settled", (event, ctx) => {
		const current = runtime;
		const service = current?.service;
		const binding = service?.activeBinding;
		if (!current || !service || !binding || binding.sessionId !== ctx.sessionManager.getSessionId()) return;
		const lastAssistant = ctx.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		const modelError =
			lastAssistant?.type === "message" &&
			lastAssistant.message.role === "assistant" &&
			lastAssistant.message.stopReason === "error";
		if (!event.aborted && !modelError) return;
		try {
			const task = service.get(binding.taskId)?.task;
			if (task?.status !== "running") return;
			const paused = service.transitionTask(
				task.taskId,
				task.revision,
				"paused",
				event.aborted ? "session:aborted" : "session:model-error",
			);
			createCheckpoint(
				service.provider,
				paused,
				binding.sessionId,
				branchLeaf(ctx),
				current.config.controlledFiles,
				observeCheckpoint(ctx, task.taskId),
			);
		} catch {
			ctx.ui.notify("任务中断后的检查点未完整保存，请检查任务状态。", "warning");
		}
	});
	pi.registerCommand("enhanced-task-manager-status", {
		description: "Show Task Manager runtime and safety state",
		handler: async (_args, ctx) => {
			if (!runtime) await start(ctx);
			ctx.ui.notify(formatStatus(runtime), runtime?.state === "error" ? "warning" : "info");
		},
	});
}

function observeCheckpoint(ctx: ExtensionContext, taskId: string): CheckpointObservation {
	const sessionUsage = { responses: 0, tokens: 0, reportedCostUsd: 0 };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (
			!Number.isSafeInteger(usage?.totalTokens) ||
			usage.totalTokens < 0 ||
			!Number.isFinite(usage.cost?.total) ||
			usage.cost.total < 0
		)
			continue;
		sessionUsage.responses += 1;
		sessionUsage.tokens += usage.totalTokens;
		sessionUsage.reportedCostUsd += usage.cost.total;
	}
	return { contextReferences: contextReferences(ctx, taskId), sessionUsage };
}

type RuntimeGetter = () => TaskRuntime | undefined;
const COMMANDS = [
	"enhanced-task-create",
	"enhanced-task-list",
	"enhanced-task-inspect",
	"enhanced-task-plan",
	"enhanced-task-approve",
	"enhanced-task-pause",
	"enhanced-task-resume",
	"enhanced-task-step",
	"enhanced-task-checkpoint",
	"enhanced-task-recover",
	"enhanced-task-evidence",
	"enhanced-task-complete",
	"enhanced-task-cancel",
	"enhanced-task-memory-propose",
	"enhanced-task-recovery-list",
	"enhanced-task-rebind",
	"enhanced-task-capacity",
] as const;

function registerInteractions(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
	for (const name of COMMANDS)
		if (pi.getCommands().some((command) => command.name === name)) throw new Error(`Task command conflict: ${name}`);
	pi.registerCommand("enhanced-task-create", {
		description: "Create a project-scoped draft task",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const input = await taskInput(args, ctx);
				if (!input) return;
				const service = ready(getRuntime());
				notify(ctx, service.create(input.goal, input.steps, ctx.sessionManager.getSessionId(), branchLeaf(ctx)));
			}),
	});
	pi.registerCommand("enhanced-task-list", {
		description: "List project tasks",
		handler: async (_args, ctx) =>
			command(ctx, async () => ctx.ui.notify(JSON.stringify(ready(getRuntime()).list(), null, 2), "info")),
	});
	pi.registerCommand("enhanced-task-inspect", {
		description: "Inspect task plan, evidence, and checkpoint",
		handler: async (args, ctx) =>
			command(ctx, async () => notify(ctx, requireTask(ready(getRuntime()).get(single(args))))),
	});
	pi.registerCommand("enhanced-task-plan", {
		description: "Replace a draft plan using planRevision CAS and JSON input",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const value = parseJson<{ taskId: string; expectedPlanRevision: number; steps: TaskStepInput[] }>(args);
				notify(ctx, ready(getRuntime()).replacePlan(value.taskId, value.expectedPlanRevision, value.steps));
			}),
	});
	pi.registerCommand("enhanced-task-approve", {
		description: "Approve a draft task",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const [taskId, revision] = pair(args);
				if (!ctx.hasUI || !(await ctx.ui.confirm("批准任务计划", `taskId=${taskId}\nrevision=${revision}`))) return;
				notify(ctx, ready(getRuntime()).transitionTask(taskId, revision, "queued"));
			}),
	});
	pi.registerCommand("enhanced-task-pause", {
		description: "Pause a queued or running task after user confirmation",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const [taskId, revision] = pair(args);
				if (!ctx.hasUI || !(await ctx.ui.confirm("暂停任务", `taskId=${taskId}`))) return;
				const service = ready(getRuntime());
				const paused = service.transitionTask(taskId, revision, "paused");
				createCheckpoint(
					service.provider,
					paused,
					ctx.sessionManager.getSessionId(),
					branchLeaf(ctx),
					getRuntime()?.config.controlledFiles,
					observeCheckpoint(ctx, taskId),
				);
				notify(ctx, requireTask(service.get(taskId)));
			}),
	});
	pi.registerCommand("enhanced-task-resume", {
		description: "Resume a paused or blocked plan; this never replays a tool",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const service = ready(getRuntime());
				const [taskId, revision] = pair(args);
				const snapshot = requireTask(service.get(taskId));
				const preflight = recoveryPreflight(
					service.provider,
					taskId,
					ctx.sessionManager.getSessionId(),
					branchLeaf(ctx),
					getRuntime()?.config.controlledFiles,
				);
				if (
					snapshot.task.status === "needs_reconciliation" ||
					preflight.unknownStepIds.length > 0 ||
					!preflight.consistencyValid
				)
					throw new TaskError(
						"TASK_INVALID_TRANSITION",
						"Resolve checkpoint integrity and unknown attempts before resuming",
					);
				if (!ctx.hasUI || !(await ctx.ui.confirm("恢复任务计划", "只恢复计划状态，不重放任何工具。"))) return;
				notify(ctx, service.transitionTask(taskId, revision, "queued"));
			}),
	});
	pi.registerCommand("enhanced-task-step", {
		description: "Bind or transition one task step under state-machine rules",
		handler: async (args, ctx) => command(ctx, async () => handleStep(args, ctx, ready(getRuntime()))),
	});
	pi.registerCommand("enhanced-task-checkpoint", {
		description: "Persist a consistent task checkpoint",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const service = ready(getRuntime());
				const snapshot = requireTask(service.get(single(args)));
				ctx.ui.notify(
					JSON.stringify(
						createCheckpoint(
							service.provider,
							snapshot,
							ctx.sessionManager.getSessionId(),
							branchLeaf(ctx),
							getRuntime()?.config.controlledFiles,
							observeCheckpoint(ctx, snapshot.task.taskId),
						),
						null,
						2,
					),
					"info",
				);
			}),
	});
	pi.registerCommand("enhanced-task-recover", {
		description: "Dry-run recovery preflight without replaying tools",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const service = ready(getRuntime());
				ctx.ui.notify(
					JSON.stringify(
						recoveryPreflight(
							service.provider,
							single(args),
							ctx.sessionManager.getSessionId(),
							branchLeaf(ctx),
							getRuntime()?.config.controlledFiles,
						),
						null,
						2,
					),
					"warning",
				);
			}),
	});
	pi.registerCommand("enhanced-task-recovery-list", {
		description: "List non-terminal tasks and their recovery state without replaying tools",
		handler: async (_args, ctx) =>
			command(ctx, async () => {
				const service = ready(getRuntime());
				const active = service
					.list()
					.filter((task) => !["completed", "failed", "cancelled", "budget_exhausted"].includes(task.status));
				notify(
					ctx,
					active.map((task) => ({
						taskId: task.taskId,
						status: task.status,
						revision: task.revision,
						checkpointId: service.get(task.taskId)?.lastCheckpoint?.checkpointId ?? null,
						reconciliationCount: service.provider
							.getAttempts(task.taskId)
							.filter((attempt) => attempt.state === "needs_reconciliation" || attempt.state === "started")
							.length,
					})),
				);
			}),
	});
	pi.registerCommand("enhanced-task-rebind", {
		description: "Rebind a recoverable task step after preflight and explicit confirmation",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const [taskId, stepId, ...extra] = args.trim().split(/\s+/u);
				if (!taskId || !stepId || extra.length)
					throw new TaskError("TASK_VALIDATION_ERROR", "Usage: /enhanced-task-rebind <taskId> <stepId>");
				const service = ready(getRuntime());
				const snapshot = requireTask(service.get(taskId));
				if (
					["completed", "failed", "cancelled", "budget_exhausted"].includes(snapshot.task.status) ||
					!snapshot.steps.some((step) => step.stepId === stepId)
				)
					throw new TaskError("TASK_INVALID_TRANSITION", "Task or step cannot be rebound");
				const preflight = recoveryPreflight(
					service.provider,
					taskId,
					ctx.sessionManager.getSessionId(),
					branchLeaf(ctx),
					getRuntime()?.config.controlledFiles,
				);
				if (!preflight.projectMatches || !preflight.consistencyValid || preflight.unknownStepIds.length > 0)
					throw new TaskError(
						"TASK_INVALID_TRANSITION",
						"Resolve project, consistency, and unknown attempt issues before rebinding",
					);
				if (
					!ctx.hasUI ||
					!(await ctx.ui.confirm("重新绑定任务步骤", `${taskId}/${stepId}\n只恢复观察绑定，不会重放工具。`))
				)
					return;
				notify(ctx, service.bind(taskId, stepId, ctx.sessionManager.getSessionId(), branchLeaf(ctx)));
			}),
	});
	pi.registerCommand("enhanced-task-capacity", {
		description: "Show bounded Task SQLite capacity diagnostics",
		handler: async (_args, ctx) => command(ctx, async () => notify(ctx, ready(getRuntime()).provider.diagnostics())),
	});
	pi.registerCommand("enhanced-task-evidence", {
		description: "Inspect evidence or add explicit user-attested evidence",
		handler: async (args, ctx) => command(ctx, async () => handleEvidence(args, ctx, ready(getRuntime()))),
	});
	pi.registerCommand("enhanced-task-complete", {
		description: "Complete a fully evidenced task after user confirmation",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const service = ready(getRuntime());
				const [taskId, revision] = pair(args);
				if (!ctx.hasUI || !(await ctx.ui.confirm("完成任务", "确认所有验收证据均已人工检查。"))) return;
				let snapshot = service.transitionTask(taskId, revision, "verifying");
				snapshot = service.transitionTask(taskId, snapshot.task.revision, "completed");
				notify(ctx, snapshot);
			}),
	});
	pi.registerCommand("enhanced-task-cancel", {
		description: "Cancel task records without deleting project files",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const service = ready(getRuntime());
				const [taskId, revision] = pair(args);
				if (!ctx.hasUI || !(await ctx.ui.confirm("取消任务管理", "只取消任务记录，不删除项目文件。"))) return;
				notify(ctx, service.transitionTask(taskId, revision, "cancelled"));
			}),
	});
	pi.registerCommand("enhanced-task-memory-propose", {
		description: "Preview or explicitly save a candidate experience; never writes verified Memory",
		handler: async (args, ctx) =>
			command(ctx, async () => {
				const [taskId, action, ...extra] = args.trim().split(/\s+/u);
				if (!taskId || extra.length > 0 || (action && action !== "save"))
					throw new TaskError("TASK_VALIDATION_ERROR", "Usage: /enhanced-task-memory-propose <taskId> [save]");
				const snapshot = requireTask(ready(getRuntime()).get(taskId));
				if (snapshot.task.status !== "completed")
					throw new TaskError("TASK_INVALID_TRANSITION", "Only completed tasks can propose experience Memory");
				const proposal = memoryProposal(snapshot);
				ctx.ui.notify(proposal, "info");
				if (action !== "save") return;
				if (!ctx.hasUI || !(await ctx.ui.confirm("保存任务经验候选", "只保存为 candidate，仍需后续审核确认。")))
					return;
				const result = await requestMemoryCandidateWrite(pi.events, ctx, {
					taskId: snapshot.task.taskId,
					content: proposal,
				});
				ctx.ui.notify(
					`已保存 Memory candidate：id=${result.id} revision=${result.revision} status=${result.status}`,
					"info",
				);
			}),
	});
}

function registerTools(pi: ExtensionAPI, getRuntime: RuntimeGetter, available: boolean): void {
	pi.registerTool({
		name: "enhanced_task_get",
		label: "Task state",
		description: "Read bounded state for one task in the current project",
		exposure: available ? "direct" : "hidden",
		parameters: Type.Object(
			{ taskId: Type.String({ minLength: 1, maxLength: 100 }) },
			{ additionalProperties: false },
		),
		execute: async (_id, input, _signal, _update, ctx) => {
			const runtime = getRuntime();
			const service = ready(runtime);
			const snapshot = requireTask(service.get(input.taskId));
			const progress =
				runtime?.config.mode === "v2" &&
				ownsModelPlan(
					service,
					input.taskId,
					ctx.sessionManager.getSessionId(),
					ctx.sessionManager.getBranch().map((entry) => entry.id),
				)
					? progressLedger(service, snapshot)
					: undefined;
			const text = JSON.stringify(
				{
					task: snapshot.task,
					steps: snapshot.steps,
					...(progress ? { progress } : {}),
					evidence: snapshot.evidence.map(({ evidenceId, stepId, kind, outcome, confidenceClass, sourceRef }) => ({
						evidenceId,
						stepId,
						kind,
						outcome,
						confidenceClass,
						sourceRef,
					})),
				},
				null,
				2,
			).slice(0, 20_000);
			return { content: [{ type: "text", text }], details: { taskId: input.taskId } };
		},
	});
	pi.registerTool({
		name: "enhanced_task_propose_plan",
		label: "Draft task plan",
		description: "Create a review-required draft plan; it cannot approve, execute, verify, or complete",
		exposure:
			available && getRuntime()?.config.modelPlanTool && getRuntime()?.config.mode !== "v2" ? "direct" : "hidden",
		parameters: Type.Object(
			{
				goal: Type.String({ minLength: 1, maxLength: 4_000 }),
				steps: Type.Array(
					Type.Object(
						{
							title: Type.String({ minLength: 1, maxLength: 4_000 }),
							expectedOutcome: Type.String({ minLength: 1, maxLength: 4_000 }),
							dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 100 })),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1, maxItems: 100 },
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, input, _signal, _update, ctx) => {
			const runtime = getRuntime();
			if (!runtime?.config.modelPlanTool || runtime.config.mode === "v2")
				throw new TaskError("TASK_RUNTIME_UNAVAILABLE", "Model plan proposals are disabled");
			const snapshot = ready(runtime).create(
				input.goal,
				input.steps,
				ctx.sessionManager.getSessionId(),
				branchLeaf(ctx),
			);
			return {
				content: [{ type: "text", text: `已创建待审核 draft：${snapshot.task.taskId}。没有批准或执行任何步骤。` }],
				details: { taskId: snapshot.task.taskId, revision: snapshot.task.revision },
			};
		},
	});
}

async function handleStep(
	args: string,
	ctx: ExtensionCommandContext,
	service: ReturnType<typeof ready>,
): Promise<void> {
	const [taskId, stepId, action, revisionText] = args.trim().split(/\s+/u);
	if (!taskId || !stepId || !action)
		throw new TaskError(
			"TASK_VALIDATION_ERROR",
			"Usage: /enhanced-task-step <taskId> <stepId> <bind|start|verify|complete|block|fail|retry> [revision]",
		);
	if (action === "bind") {
		const snapshot = requireTask(service.get(taskId));
		if (snapshot.task.status === "queued") service.transitionTask(taskId, snapshot.task.revision, "running");
		ctx.ui.notify(
			JSON.stringify(service.bind(taskId, stepId, ctx.sessionManager.getSessionId(), branchLeaf(ctx))),
			"info",
		);
		return;
	}
	const revision = Number(revisionText);
	if (!Number.isSafeInteger(revision) || revision < 1)
		throw new TaskError("TASK_VALIDATION_ERROR", "Step revision is required");
	const states = {
		start: "running",
		verify: "verifying",
		complete: "completed",
		block: "blocked",
		fail: "failed",
		retry: "pending",
	} as const;
	const next = states[action as keyof typeof states];
	if (!next) throw new TaskError("TASK_VALIDATION_ERROR", "Unknown step action");
	notify(ctx, service.transitionStep(taskId, stepId, revision, next));
}

async function handleEvidence(
	args: string,
	ctx: ExtensionCommandContext,
	service: ReturnType<typeof ready>,
): Promise<void> {
	const [taskId, stepId, action, ...text] = args.trim().split(/\s+/u);
	if (!taskId || !stepId)
		throw new TaskError("TASK_VALIDATION_ERROR", "Usage: /enhanced-task-evidence <taskId> <stepId> [attest text]");
	if (!action) {
		const snapshot = requireTask(service.get(taskId));
		ctx.ui.notify(
			JSON.stringify(
				snapshot.evidence.filter((item) => item.stepId === stepId),
				null,
				2,
			),
			"info",
		);
		return;
	}
	if (action === "validate") {
		if (text.length > 0) throw new TaskError("TASK_VALIDATION_ERROR", "validate does not accept free text");
		notify(ctx, service.validateFileStep(taskId, stepId));
		return;
	}
	if (action === "reconcile") {
		const [attemptId, decision, ...note] = text;
		if (!attemptId || (decision !== "do_not_retry" && decision !== "external_success") || note.length === 0)
			throw new TaskError(
				"TASK_VALIDATION_ERROR",
				"Usage: /enhanced-task-evidence <taskId> <stepId> reconcile <attemptId> <do_not_retry|external_success> <note>",
			);
		if (
			!ctx.hasUI ||
			!(await ctx.ui.confirm("人工对账中断操作", `${decision}\n${note.join(" ")}\n此操作不会自动重放工具。`))
		)
			return;
		notify(
			ctx,
			service.reconcileAttempt(taskId, attemptId, decision, note.join(" "), ctx.sessionManager.getSessionId()),
		);
		return;
	}
	if (action !== "attest" || text.length === 0)
		throw new TaskError(
			"TASK_VALIDATION_ERROR",
			"Usage: /enhanced-task-evidence <taskId> <stepId> <attest text|validate|reconcile ...>",
		);
	if (!ctx.hasUI || !(await ctx.ui.confirm("添加人工验收证据", text.join(" ")))) return;
	notify(
		ctx,
		service.addEvidence({
			taskId,
			stepId,
			kind: "user_approval",
			sourceRef: `user:${ctx.sessionManager.getSessionId()}`,
			outcome: "succeeded",
			confidenceClass: "manual_attested",
			digestSource: text.join(" "),
		}),
	);
}

async function taskInput(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<{ goal: string; steps: TaskStepInput[] } | undefined> {
	if (args.trim()) return parseJson(args);
	if (!ctx.hasUI) throw new TaskError("TASK_VALIDATION_ERROR", "Interactive UI or JSON input is required");
	const goal = await ctx.ui.input("任务目标");
	if (!goal) return undefined;
	const plan = await ctx.ui.editor(
		"步骤 JSON",
		JSON.stringify([{ title: "核对现状", expectedOutcome: "获得可引用的事实", dependsOn: [] }], null, 2),
	);
	if (!plan) return undefined;
	return { goal, steps: JSON.parse(plan) as TaskStepInput[] };
}
function ready(runtime: TaskRuntime | undefined) {
	if (!runtime?.service || runtime.state !== "ready")
		throw new TaskError("TASK_RUNTIME_UNAVAILABLE", "Task Manager is not ready");
	return runtime.service;
}
function requireTask(value: TaskSnapshot | null): TaskSnapshot {
	if (!value) throw new TaskError("TASK_NOT_FOUND", "Task does not exist");
	return value;
}
function notify(ctx: ExtensionCommandContext, value: unknown): void {
	ctx.ui.notify(JSON.stringify(value, null, 2).slice(0, 24_000), "info");
}
async function command(ctx: ExtensionCommandContext, operation: () => Promise<void>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		ctx.ui.notify(
			`${error instanceof TaskError ? error.code : "TASK_ERROR"}: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}
function single(args: string): string {
	const value = args.trim();
	if (!value || /\s/u.test(value)) throw new TaskError("TASK_VALIDATION_ERROR", "Exactly one task id is required");
	return value;
}
function pair(args: string): [string, number] {
	const [id, text, ...extra] = args.trim().split(/\s+/u);
	const revision = Number(text);
	if (!id || extra.length > 0 || !Number.isSafeInteger(revision) || revision < 1)
		throw new TaskError("TASK_VALIDATION_ERROR", "Task id and positive revision are required");
	return [id, revision];
}
function parseJson<T>(text: string): T {
	try {
		const value = JSON.parse(text) as T;
		if (!value || typeof value !== "object") throw new Error("object required");
		return value;
	} catch (error) {
		throw new TaskError(
			"TASK_VALIDATION_ERROR",
			`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
function formatStatus(runtime: TaskRuntime | undefined): string {
	if (!runtime) return "pi-enhanced task-manager: not initialized";
	return [
		`pi-enhanced task-manager: ${runtime.state}`,
		`Model plan tool: ${runtime.config.modelPlanTool ? "enabled" : "disabled"}`,
		`P3 task summary: ${runtime.config.contextSummary ? "configured but not injected" : "disabled"}`,
		"Execution replay: disabled",
		...(runtime.scope ? [`Project: ${runtime.scope.rootPath}`] : []),
		...(runtime.error ? [`Error: ${runtime.error}`] : []),
	].join("\n");
}
function memoryProposal(snapshot: TaskSnapshot): string {
	return [
		"以下内容只是 Memory candidate 建议，未写入 Memory，也未获得 verified 状态。",
		`来源 taskId=${snapshot.task.taskId}`,
		`场景/目标：${snapshot.task.goal}`,
		`实际步骤：${snapshot.steps.map((step) => `${step.title}:${step.status}`).join("；")}`,
		`验证方式：${
			snapshot.evidence
				.filter((item) => item.confidenceClass !== "model_claim")
				.map((item) => `${item.kind}:${item.evidenceId}`)
				.join("；") || "无"
		}`,
		"适用边界与失效条件：需用户补充。",
		"如需保存，请复制到 /enhanced-memory-save，由现有 Memory 审核流程生成 candidate。",
	].join("\n");
}

export default createTaskManagerExtension();
