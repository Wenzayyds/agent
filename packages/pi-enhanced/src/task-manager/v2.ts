import { createHash, randomUUID } from "node:crypto";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskSnapshot, TaskStepInput } from "./contracts.ts";
import { TaskError } from "./errors.ts";
import { dependenciesComplete, normalizePlan } from "./plan.ts";
import { observeWorkspace } from "./recovery.ts";
import type { TaskRuntime } from "./runtime.ts";
import type { TaskService } from "./service.ts";

export const TASK_V2_TOOL = "enhanced_task_plan_update";
const MAX_REPLANS = 2;
const STALL_THRESHOLD = 3;
const MAX_UPDATES = 32;
const MAX_STEPS = 12;
const MAX_INPUT_BYTES = 8192;
const id = Type.String({ minLength: 1, maxLength: 100 });
const text = Type.String({ minLength: 1, maxLength: 480 });
const stepSchema = Type.Object(
	{
		id,
		title: text,
		expectedOutcome: text,
		dependsOn: Type.Optional(Type.Array(id, { maxItems: MAX_STEPS })),
	},
	{ additionalProperties: false },
);
const stepsSchema = Type.Array(stepSchema, { minItems: 1, maxItems: MAX_STEPS });
const schema = Type.Union([
	Type.Object({ action: Type.Literal("create"), goal: text, steps: stepsSchema }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("advance"),
			taskId: id,
			revision: Type.Integer({ minimum: 1 }),
			stepId: id,
			status: Type.Union([Type.Literal("running"), Type.Literal("blocked"), Type.Literal("completed")]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("replan"), taskId: id, revision: Type.Integer({ minimum: 1 }), steps: stepsSchema },
		{ additionalProperties: false },
	),
]);
type Input = Static<typeof schema>;
type Owner = { session: string; reply: string; branch: readonly string[] };
const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");

function prepareSteps(steps: Static<typeof stepsSchema>, existing: readonly string[] = []): TaskStepInput[] {
	if (steps.length < 1 || steps.length + existing.length > MAX_STEPS) throw new Error("TASK_V2_STEP_LIMIT");
	const ids = new Map(steps.map((step) => [step.id, randomUUID()]));
	if (ids.size !== steps.length || steps.some((s) => !/^[a-zA-Z0-9_-]{1,48}$/u.test(s.id) || existing.includes(s.id)))
		throw new Error("TASK_V2_STEP_IDS_INVALID");
	return steps.map((step) => ({
		stepId: ids.get(step.id),
		title: step.title,
		expectedOutcome: step.expectedOutcome,
		dependsOn: (step.dependsOn ?? []).map((dep) => ids.get(dep) ?? dep),
	}));
}

export function progressLedger(service: TaskService, snapshot: TaskSnapshot) {
	const taskId = snapshot.task.taskId;
	const events = service.provider.modelPlanEvents(taskId);
	const replans = events.filter((event) => event.type === "v2_replan");
	const attempts = service.provider.getAttempts(taskId);
	const after = Number(replans.at(-1)?.data.attemptCount ?? 0);
	const recent = attempts.slice(after);
	const latest = recent.at(-1);
	const tail = recent.slice(-STALL_THRESHOLD);
	const knownStall =
		latest &&
		tail.length === STALL_THRESHOLD &&
		tail.every(
			(attempt) =>
				(attempt.state === "failed" ||
					(attempt.state === "succeeded" &&
						attempt.riskClass === "read_only" &&
						typeof attempt.resultDigest === "string" &&
						/^[a-f0-9]{64}$/u.test(attempt.resultDigest) &&
						attempt.resultDigest === latest.resultDigest)) &&
				attempt.toolName === latest.toolName &&
				attempt.inputDigest === latest.inputDigest,
		);
	const unknown = attempts.some((a) => a.state === "needs_reconciliation" || a.state === "started");
	const active = snapshot.steps.find((s) => s.status === "running" || s.status === "verifying");
	const ready = snapshot.steps.find((s) => s.status === "pending" && dependenciesComplete(s, snapshot.steps));
	const dependencyBlocked = !active && !ready && snapshot.steps.some((s) => s.status === "pending");
	const checkpoint = snapshot.lastCheckpoint;
	const invalidCheckpoint = checkpoint && service.provider.checkpointIntegrity(checkpoint) === "invalid";
	const reason = unknown
		? "unknown_attempt"
		: invalidCheckpoint
			? "invalid_checkpoint"
			: knownStall
				? "repeated_operation"
				: dependencyBlocked
					? "dependencies_unavailable"
					: null;
	const state =
		unknown || invalidCheckpoint || (reason && replans.length >= MAX_REPLANS)
			? "blocked"
			: reason
				? "replan_requested"
				: "observing";
	let workspaceChanged: boolean | "unknown" = "unknown";
	let trackedChanges: number | "unknown" = "unknown";
	if (checkpoint?.workspaceObservation.gitStatusDigest || latest?.riskClass === "mutating") {
		const now = observeWorkspace(service.provider.scope.rootPath);
		if (now.gitStatusDigest && now.gitHead && !now.observationLimited) {
			trackedChanges = now.gitStatusEntries;
			const previous = checkpoint?.workspaceObservation;
			if (
				previous &&
				!previous.observationLimited &&
				(now.gitStatusDigest !== previous.gitStatusDigest ||
					now.gitHead !== previous.gitHead ||
					now.trackedFiles.some((file) =>
						previous.trackedFiles.some(
							(old) =>
								old.relativePath === file.relativePath &&
								old.sha256 &&
								file.sha256 &&
								old.sha256 !== file.sha256,
						),
					))
			)
				workspaceChanged = true;
		}
	}
	return {
		version: 2,
		state,
		reason,
		currentStepId: active?.stepId ?? ready?.stepId ?? null,
		latestTool: latest
			? {
					toolCallId: latest.toolCallId,
					state: latest.state,
					toolName: latest.toolName,
					confidence: "tool_observed",
					at: latest.endedAt ?? null,
				}
			: null,
		recentError:
			recent
				.slice(-8)
				.reverse()
				.find((a) => a.state === "failed")?.toolCallId ?? null,
		workspaceChanged,
		trackedChanges,
		stallCount: knownStall ? tail.length : 0,
		planUpdates: events.length,
		replans: replans.length,
		attemptCount: attempts.length,
		revision: snapshot.task.revision,
		planRevision: snapshot.task.planRevision,
		additionalModelRequests: 0,
		additionalModelTokens: null,
	};
}

export function ownsModelPlan(
	service: TaskService,
	taskId: string,
	session: string,
	branch: readonly string[],
): boolean {
	const creation = service.provider.modelPlanEvents(taskId).find((event) => event.type === "v2_create");
	return (
		creation?.data.session === session &&
		(creation.data.anchor === null ||
			(typeof creation.data.anchor === "string" && branch.includes(creation.data.anchor)))
	);
}

export function updateModelPlan(service: TaskService, owner: Owner, input: Input): TaskSnapshot {
	if (!owner.session || !owner.reply || Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES)
		throw new Error("TASK_V2_SCOPE_OR_INPUT_INVALID");
	const source = `model:${digest([owner.session, owner.reply])}`;
	const anchor = owner.branch.at(-1) ?? null;
	const data: Record<string, unknown> = { session: owner.session, anchor, confidence: "model_proposed" };
	const type = input.action === "create" ? "v2_create" : input.action === "replan" ? "v2_replan" : "v2_advance";
	const result = service.provider.mutateModelPlan(source, type, data, () => {
		if (input.action === "create") {
			const draft = service.create(input.goal, prepareSteps(input.steps), owner.session, anchor);
			const queued = service.transitionTask(draft.task.taskId, draft.task.revision, "queued", source);
			const running = service.transitionTask(queued.task.taskId, queued.task.revision, "running", source);
			const first = running.steps.find((s) => s.dependsOn.length === 0)!;
			return service.transitionStep(running.task.taskId, first.stepId, first.revision, "running", source);
		}
		const current = service.get(input.taskId);
		if (
			!current ||
			!ownsModelPlan(service, input.taskId, owner.session, owner.branch) ||
			current.task.revision !== input.revision
		)
			throw new Error("TASK_V2_SCOPE_OR_REVISION_INVALID");
		const progress = progressLedger(service, current);
		if (current.task.status !== "running" || progress.planUpdates >= MAX_UPDATES || progress.state === "blocked")
			throw new Error("TASK_V2_RECONCILIATION_OR_LIMIT");
		if (input.action === "replan") {
			if (progress.state !== "replan_requested") throw new Error("TASK_V2_REPLAN_NOT_REQUESTED");
			const previous = current.steps.map((s) => ({ ...s }));
			const appended = prepareSteps(
				input.steps,
				previous.map((s) => s.stepId),
			);
			const combined = normalizePlan(
				input.taskId,
				[...previous, ...appended],
				Math.min(MAX_STEPS, service.maximumSteps),
			);
			data.attemptCount = progress.attemptCount;
			data.reason = progress.reason;
			const revised = service.provider.appendModelSteps(
				input.taskId,
				input.revision,
				combined.slice(previous.length),
			);
			// A newly proposed independent recovery step becomes the active observation target.
			const next = revised.steps.slice(previous.length).find((s) => dependenciesComplete(s, revised.steps));
			if (!next) throw new Error("TASK_V2_REPLAN_NO_READY_STEP");
			const running = revised.steps.find((s) => s.status === "running");
			if (revised.steps.some((s) => s.status === "verifying")) throw new Error("TASK_V2_WAITING_FOR_EVIDENCE");
			if (running) service.transitionStep(input.taskId, running.stepId, running.revision, "blocked", source);
			return service.transitionStep(input.taskId, next.stepId, next.revision, "running", source);
		}
		const step = current.steps.find((s) => s.stepId === input.stepId);
		if (!step) throw new Error("TASK_V2_STEP_INVALID");
		data.stepId = step.stepId;
		data.proposedStatus = input.status;
		if (
			input.status === "running" &&
			current.steps.some((s) => s.stepId !== step.stepId && (s.status === "running" || s.status === "verifying"))
		)
			throw new Error("TASK_V2_ACTIVE_STEP_EXISTS");
		if (input.status === "completed" && step.status === "running") {
			service.addEvidence({
				taskId: input.taskId,
				stepId: step.stepId,
				kind: "model_plan_proposal",
				sourceRef: source,
				outcome: "unknown",
				confidenceClass: "model_claim",
				digestSource: digest([step.stepId, input.status]),
			});
			return service.transitionStep(input.taskId, step.stepId, step.revision, "verifying", source);
		}
		if (input.status === "running" && step.status === "blocked") {
			const reset = service.transitionStep(input.taskId, step.stepId, step.revision, "pending", source);
			const pending = reset.steps.find((value) => value.stepId === step.stepId)!;
			return service.transitionStep(input.taskId, step.stepId, pending.revision, "running", source);
		}
		return service.transitionStep(input.taskId, step.stepId, step.revision, input.status, source);
	});
	const active = result.steps.find((step) => step.status === "running" || step.status === "verifying");
	if (active) service.bind(result.task.taskId, active.stepId, owner.session, anchor);
	else service.unbind();
	return result;
}

export function registerTaskV2(pi: ExtensionAPI, getRuntime: () => TaskRuntime | undefined) {
	let reply: { session: string; leaf: string; toolId: string } | undefined;
	let sentRevision = "";
	const available = () => {
		const runtime = getRuntime();
		return runtime?.state === "ready" &&
			runtime.config.mode === "v2" &&
			runtime.config.hostV2Writes &&
			runtime.config.modelPlanTool
			? runtime
			: undefined;
	};
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		reply = undefined;
		if (!available() || !ctx.isProjectTrusted()) return;
		const calls = event.message.content.filter((block) => block.type === "toolCall" && block.name === TASK_V2_TOOL);
		const leaf = ctx.sessionManager.getLeafId();
		if (calls.length === 1 && calls[0]?.type === "toolCall" && leaf)
			reply = { session: ctx.sessionManager.getSessionId(), leaf, toolId: calls[0].id };
	});
	const reset = () => {
		reply = undefined;
		sentRevision = "";
	};
	pi.on("session_tree", reset);
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("tool_execution_end", (_event, ctx) => {
		const service = available()?.service;
		const binding = service?.activeBinding;
		if (!service || !binding || binding.sessionId !== ctx.sessionManager.getSessionId()) return;
		const snapshot = service.get(binding.taskId);
		if (!snapshot) return;
		const progress = progressLedger(service, snapshot);
		const key = `${binding.taskId}:${progress.replans}:${progress.state}`;
		if (progress.state === "observing" || key === sentRevision) return;
		sentRevision = key;
		pi.sendMessage(
			{
				customType: "enhanced-task-progress",
				content: JSON.stringify({
					taskId: binding.taskId,
					...progress,
				}),
				display: false,
				details: {
					state: progress.state,
					reason: progress.reason,
					revision: progress.revision,
					replans: progress.replans,
					stallCount: progress.stallCount,
				},
			},
			{ deliverAs: "steer", triggerTurn: false },
		);
	});
	let registered = false;
	return () => {
		const runtime = available();
		if (!runtime && !registered) return;
		registered = true;
		pi.registerTool({
			name: TASK_V2_TOOL,
			label: "Maintain task plan",
			exposure: runtime ? "direct" : "hidden",
			description:
				"For complex work, create or advance a scoped task plan. Skip simple tasks. One update per assistant reply. Completion requires independent evidence. Replan only when progress requests it.",
			parameters: Type.Object({ change: schema }, { additionalProperties: false }),
			execute: async (toolId, input, _signal, _update, ctx: ExtensionContext) => {
				const service = available()?.service;
				const session = ctx.sessionManager.getSessionId();
				const branch = ctx.sessionManager.getBranch().map((entry) => entry.id);
				if (
					!service ||
					!ctx.isProjectTrusted() ||
					reply?.session !== session ||
					reply.toolId !== toolId ||
					!branch.includes(reply.leaf)
				)
					throw new TaskError("TASK_RUNTIME_UNAVAILABLE", "Task plan write not authorized");
				const entry = reply.leaf;
				reply = undefined;
				const snapshot = updateModelPlan(service, { session, reply: entry, branch }, input.change);
				const progress = progressLedger(service, snapshot);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								task: snapshot.task,
								steps: snapshot.steps,
								progress,
							}).slice(0, 12_000),
						},
					],
					details: { taskId: snapshot.task.taskId, taskV2: progress },
				};
			},
		});
	};
}
