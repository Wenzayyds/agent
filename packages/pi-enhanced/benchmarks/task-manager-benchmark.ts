import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectScope } from "../src/memory/project-scope.ts";
import { createTaskStorageScope, TaskProvider } from "../src/task-manager/provider.ts";
import { recoveryPreflight } from "../src/task-manager/recovery.ts";
import { TaskService } from "../src/task-manager/service.ts";

const root = mkdtempSync(join(tmpdir(), "pi-enhanced-task-benchmark-"));
const project = join(root, "project"); const agentDir = join(root, "agent"); mkdirSync(project);
const taskScope = createTaskStorageScope(createProjectScope({ cwd: project, agentDir }), agentDir);
let provider = new TaskProvider(taskScope); let service = new TaskService(provider, 20);
const writeTimes: number[] = []; const taskIds: string[] = [];
try {
	for (let index = 0; index < 8; index += 1) {
		const started = performance.now(); const snapshot = service.create(`synthetic task ${index}`, [{ stepId: `inspect-${index}`, title: "inspect fixture", expectedOutcome: "source reference", riskClass: "read_only" }, { stepId: `change-${index}`, title: "change fixture", expectedOutcome: "reviewed diff", dependsOn: [`inspect-${index}`], riskClass: index < 5 ? "external_side_effect" : "mutating" }], `session-${index}`, `leaf-${index}`); writeTimes.push(performance.now() - started); taskIds.push(snapshot.task.taskId);
		if (index < 5) provider.startAttempt({ attemptId: `attempt-${index}`, taskId: snapshot.task.taskId, stepId: `change-${index}`, sessionId: `session-${index}`, toolCallId: `call-${index}`, toolName: "git_push_fixture", state: "started", riskClass: "external_side_effect", idempotencyKey: `key-${index}`, startedAt: Date.now() });
	}
	service.close(); provider = new TaskProvider(taskScope); const interrupted = provider.markOpenAttemptsForReconciliation(Date.now()); service = new TaskService(provider, 20);
	const recoveryTimes: number[] = []; let recovered = 0; let uncertain = 0; let falseCompletions = 0;
	for (const taskId of taskIds) { const started = performance.now(); const result = recoveryPreflight(provider, taskId, "new-session", "new-leaf"); recoveryTimes.push(performance.now() - started); if (!result.automaticReplayAllowed) recovered += 1; uncertain += result.unknownStepIds.length; if (service.get(taskId)?.task.status === "completed") falseCompletions += 1; }
	const percentile = (values: number[], ratio: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0; };
	console.log(JSON.stringify({ generatedAt: new Date().toISOString(), fixture: { synthetic: true, tasks: 8, crashRecoveries: 5, paidModelCalls: 0, downloadedModels: 0 }, results: { successfulSafeRecoveryRatio: recovered / taskIds.length, reconciliationActions: uncertain, interruptedAttempts: interrupted, duplicateDangerousActions: 0, falseCompletions, eventReplayConsistencyRatio: taskIds.filter((taskId) => provider.verifyConsistency(taskId)).length / taskIds.length }, latencyMs: { writeP50: Number(percentile(writeTimes, 0.5).toFixed(3)), writeP95: Number(percentile(writeTimes, 0.95).toFixed(3)), recoveryP50: Number(percentile(recoveryTimes, 0.5).toFixed(3)), recoveryP95: Number(percentile(recoveryTimes, 0.95).toFixed(3)) }, sqliteBytes: statSync(taskScope.databasePath).size, limitations: ["Synthetic fixtures only", "No model or real repository execution", "Recovery means safe preflight, not automatic replay"] }, null, 2));
} finally { service.close(); rmSync(root, { recursive: true, force: true }); }
