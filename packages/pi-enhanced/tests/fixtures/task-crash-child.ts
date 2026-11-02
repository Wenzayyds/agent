import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { createCheckpoint } from "../../src/task-manager/recovery.ts";
import { TaskService } from "../../src/task-manager/service.ts";

const [projectRoot, agentDir] = process.argv.slice(2);
if (!projectRoot || !agentDir || !process.send) throw new Error("project root, agent dir, and IPC are required");

const scope = createProjectScope({ cwd: projectRoot, agentDir });
const service = new TaskService(new TaskProvider(createTaskStorageScope(scope, agentDir)), 20);
let snapshot = service.create(
	"recover a killed child process",
	[
		{ stepId: "checked", title: "inspect", expectedOutcome: "inspection recorded" },
		{ stepId: "mutate", title: "modify fixture", expectedOutcome: "fixture changed", dependsOn: ["checked"], riskClass: "mutating" },
	],
	"crash-session",
	"crash-leaf",
);
snapshot = service.transitionTask(snapshot.task.taskId, snapshot.task.revision, "queued");
snapshot = service.transitionTask(snapshot.task.taskId, snapshot.task.revision, "running");
let first = snapshot.steps.find(({ stepId }) => stepId === "checked")!;
snapshot = service.transitionStep(snapshot.task.taskId, first.stepId, first.revision, "running");
first = snapshot.steps.find(({ stepId }) => stepId === "checked")!;
snapshot = service.transitionStep(snapshot.task.taskId, first.stepId, first.revision, "verifying");
service.addEvidence({
	taskId: snapshot.task.taskId,
	stepId: first.stepId,
	kind: "manual_review",
	sourceRef: "user:fixture",
	outcome: "succeeded",
	confidenceClass: "manual_attested",
	digestSource: "fixture inspected",
});
first = service.get(snapshot.task.taskId)!.steps.find(({ stepId }) => stepId === "checked")!;
snapshot = service.transitionStep(snapshot.task.taskId, first.stepId, first.revision, "completed");
createCheckpoint(service.provider, snapshot, "crash-session", "crash-leaf");
service.bind(snapshot.task.taskId, "mutate", "crash-session", "crash-leaf");
let second = service.get(snapshot.task.taskId)!.steps.find(({ stepId }) => stepId === "mutate")!;
snapshot = service.transitionStep(snapshot.task.taskId, second.stepId, second.revision, "running");
writeFileSync(join(projectRoot, "fixture.txt"), "changed-once\n");
service.provider.startAttempt({
	attemptId: "crashed-attempt",
	taskId: snapshot.task.taskId,
	stepId: "mutate",
	sessionId: "crash-session",
	toolCallId: "crashed-tool-call",
	toolName: "edit",
	state: "started",
	riskClass: "mutating",
	idempotencyKey: "crashed-idempotency-key",
	inputDigest: "c".repeat(64),
	startedAt: Date.now(),
});
process.send({ type: "ready", taskId: snapshot.task.taskId });
setInterval(() => undefined, 1_000);
