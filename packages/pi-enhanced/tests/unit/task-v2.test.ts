import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { loadTaskManagerConfig } from "../../src/task-manager/config.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import { progressLedger, updateModelPlan } from "../../src/task-manager/v2.ts";

it("advances a dependent plan only after evidence, rejects replays and preserves reconciliation", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-task-v2-"));
	const scope = createTaskStorageScope(createProjectScope({ cwd: root, agentDir: root }), root);
	let service = new TaskService(new TaskProvider(scope), 20);
	const session = "fixture-session";
	const apply = (reply: string, input: Parameters<typeof updateModelPlan>[2]) =>
		updateModelPlan(service, { session, reply, branch: [] }, input);
	try {
		const plan = apply("reply1", {
			action: "create",
			goal: "Repair two files",
			steps: [
				{ id: "first", title: "Inspect", expectedOutcome: "Known source" },
				{ id: "second", title: "Repair", expectedOutcome: "Working export", dependsOn: ["first"] },
			],
		});
		expect(plan.task.status).toBe("running");
		expect(plan.steps.map((s) => s.status)).toEqual(["running", "pending"]);
		expect(() =>
			apply("reply1", {
				action: "create",
				goal: "Duplicate",
				steps: [{ id: "x", title: "x", expectedOutcome: "x" }],
			}),
		).toThrow();
		const first = plan.steps[0]!;
		const checked = apply("reply2", {
			action: "advance",
			taskId: plan.task.taskId,
			revision: plan.task.revision,
			stepId: first.stepId,
			status: "completed",
		});
		expect(checked.steps[0]?.status).toBe("verifying");
		expect(() =>
			apply("reply3", {
				action: "advance",
				taskId: plan.task.taskId,
				revision: checked.task.revision,
				stepId: checked.steps[1]!.stepId,
				status: "running",
			}),
		).toThrow();
		const evidence = service.addEvidence({
			taskId: plan.task.taskId,
			stepId: first.stepId,
			kind: "test",
			sourceRef: "user",
			outcome: "succeeded",
			confidenceClass: "user_attested",
			digestSource: "verified",
		});
		const complete = apply("reply4", {
			action: "advance",
			taskId: plan.task.taskId,
			revision: evidence.task.revision,
			stepId: first.stepId,
			status: "completed",
		});
		expect(complete.steps[0]?.status).toBe("completed");
		expect(progressLedger(service, complete).currentStepId).toBe(complete.steps[1]?.stepId);
		service.provider.startAttempt({
			attemptId: "attempt1",
			taskId: plan.task.taskId,
			stepId: complete.steps[1]!.stepId,
			sessionId: session,
			toolCallId: "call1",
			toolName: "edit",
			state: "started",
			riskClass: "mutating",
			idempotencyKey: "a".repeat(64),
			inputDigest: "b".repeat(64),
			startedAt: Date.now(),
		});
		service.close();
		service = new TaskService(new TaskProvider(scope), 20);
		service.provider.markOpenAttemptsForReconciliation(Date.now());
		const recovered = service.get(plan.task.taskId)!;
		expect(progressLedger(service, recovered).state).toBe("blocked");
		expect(() =>
			apply("reply5", {
				action: "advance",
				taskId: recovered.task.taskId,
				revision: recovered.task.revision,
				stepId: recovered.steps[1]!.stepId,
				status: "running",
			}),
		).toThrow();
		expect(service.provider.getAttempts(plan.task.taskId)).toHaveLength(1);
	} finally {
		service.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("persists the replan ceiling and denies other sessions or branches", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-task-v2-replan-"));
	const scope = createTaskStorageScope(createProjectScope({ cwd: root, agentDir: root }), root);
	let service = new TaskService(new TaskProvider(scope), 20);
	try {
		const owner = { session: "session1", reply: "reply-create", branch: ["anchor"] };
		const steps = [{ id: "step", title: "Try a different approach", expectedOutcome: "New evidence" }];
		let snapshot = updateModelPlan(service, owner, { action: "create", goal: "Bound recovery", steps });
		const taskId = snapshot.task.taskId;
		expect(() =>
			updateModelPlan(
				service,
				{ ...owner, reply: "stale-revision" },
				{
					action: "advance",
					taskId,
					revision: snapshot.task.revision - 1,
					stepId: snapshot.steps[0]!.stepId,
					status: "blocked",
				},
			),
		).toThrow("TASK_V2_SCOPE_OR_REVISION_INVALID");
		for (let index = 0; index < 3; index++) {
			const id = `changing-result-${index}`;
			service.provider.startAttempt({
				attemptId: id,
				taskId,
				stepId: snapshot.steps[0]!.stepId,
				sessionId: owner.session,
				toolCallId: id,
				toolName: "read",
				state: "started",
				riskClass: "read_only",
				idempotencyKey: id,
				inputDigest: "a".repeat(64),
				startedAt: Date.now(),
			});
			service.provider.endAttempt(taskId, id, "succeeded", String(index).repeat(64), Date.now());
		}
		expect(progressLedger(service, snapshot).state).toBe("observing");
		const request = (round: number) => ({
			action: "replan" as const,
			taskId,
			revision: snapshot.task.revision,
			steps: steps.map((step) => ({ ...step, id: `next${round}` })),
		});
		for (let round = 0; round < 3; round++) {
			const stepId = snapshot.steps.find((step) => step.status === "running")!.stepId;
			for (let index = 0; index < 3; index++) {
				const id = `attempt${round}-${index}`;
				service.provider.startAttempt({
					attemptId: id,
					taskId,
					stepId,
					sessionId: owner.session,
					toolCallId: id,
					toolName: "read",
					state: "started",
					riskClass: "read_only",
					idempotencyKey: id,
					inputDigest: "a".repeat(64),
					startedAt: Date.now(),
				});
				service.provider.endAttempt(taskId, id, "succeeded", "b".repeat(64), Date.now());
			}
			expect(progressLedger(service, snapshot)).toMatchObject({
				state: round === 2 ? "blocked" : "replan_requested",
				reason: "repeated_operation",
				replans: round,
			});
			if (round === 2) break;
			const next = { ...owner, reply: `reply-${round}` };
			expect(() => updateModelPlan(service, { ...next, session: "other" }, request(round))).toThrow();
			expect(() => updateModelPlan(service, { ...next, branch: ["other"] }, request(round))).toThrow();
			snapshot = updateModelPlan(service, next, request(round));
			const active = snapshot.steps.find((step) => step.status === "running")!;
			expect(service.activeBinding?.stepId).toBe(active.stepId);
			expect(active.stepId).not.toBe(stepId);
			expect(snapshot.steps.find((step) => step.stepId === stepId)?.status).toBe("blocked");
		}
		service.close();
		service = new TaskService(new TaskProvider(scope), 20);
		const recovered = service.get(taskId)!;
		expect(progressLedger(service, recovered)).toMatchObject({ state: "blocked", replans: 2 });
		expect(() => updateModelPlan(service, { ...owner, reply: "after-restart" }, request(3))).toThrow(
			"TASK_V2_RECONCILIATION_OR_LIMIT",
		);
		expect(service.provider.getAttempts(taskId)).toHaveLength(12);
	} finally {
		service.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("requires an explicit host config for V2 writes and keeps the legacy toggle", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-task-v2-config-"));
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		mkdirSync(join(root, ".pi"));
		const config = (path: string, task: object) =>
			writeFileSync(join(path, "pi-enhanced.json"), JSON.stringify({ modules: { "task-manager": task } }));
		const load = () => loadTaskManagerConfig({ agentDir, cwd: root, projectTrusted: true });
		config(agentDir, { enabled: true });
		expect(load().config).toMatchObject({ mode: "v1", hostV2Writes: false });
		config(join(root, ".pi"), { mode: "v2", modelPlanTool: true });
		expect(load().config.enabled).toBe(false);
		config(agentDir, { mode: "v2", modelPlanTool: true });
		expect(load().config).toMatchObject({ mode: "v2", hostV2Writes: true });
		expect(load().errors).toEqual([]);
		config(join(root, ".pi"), { mode: "off" });
		expect(load().config).toMatchObject({ mode: "off", enabled: false, hostV2Writes: false });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
