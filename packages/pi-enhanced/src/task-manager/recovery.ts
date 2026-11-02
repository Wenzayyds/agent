import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RecoveryPreflight, TaskCheckpoint, TaskSnapshot, WorkspaceObservation } from "./contracts.ts";
import { TaskError } from "./errors.ts";
import type { TaskProvider } from "./provider.ts";

export function workspaceFingerprint(rootPath: string): string {
	return createHash("sha256")
		.update(JSON.stringify(observeWorkspace(rootPath)))
		.digest("hex");
}

export function observeWorkspace(rootPath: string): WorkspaceObservation {
	const realRoot = realpathSync.native(rootPath);
	let gitHead: string | undefined;
	let gitStatusDigest: string | undefined;
	let gitStatusEntries = 0;
	try {
		gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: realRoot,
			encoding: "utf8",
			timeout: 1_500,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
			cwd: realRoot,
			encoding: "utf8",
			timeout: 1_500,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		gitStatusEntries = status ? status.split(/\r?\n/u).length : 0;
		gitStatusDigest = createHash("sha256").update(status).digest("hex");
	} catch {}
	const trackedFiles: Array<WorkspaceObservation["trackedFiles"][number]> = [];
	for (const relative of [join(".git", "HEAD"), "package.json", "pyproject.toml"]) {
		const path = join(realRoot, relative);
		if (!existsSync(path)) continue;
		const stat = statSync(path);
		trackedFiles.push({
			relativePath: relative.replaceAll("\\", "/"),
			size: stat.size,
			mtimeMs: Math.trunc(stat.mtimeMs),
			...(stat.isFile() && stat.size <= 64 * 1024
				? { sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }
				: {}),
		});
	}
	return {
		realRoot,
		gitStatusEntries,
		trackedFiles,
		...(gitHead ? { gitHead } : {}),
		...(gitStatusDigest ? { gitStatusDigest } : {}),
	};
}

export function createCheckpoint(
	provider: TaskProvider,
	snapshot: TaskSnapshot,
	sessionId: string,
	branchLeafId: string | null,
): TaskCheckpoint {
	const workspaceObservation = observeWorkspace(provider.scope.rootPath);
	const value: TaskCheckpoint = {
		checkpointId: randomUUID(),
		taskId: snapshot.task.taskId,
		taskRevision: snapshot.task.revision,
		planRevision: snapshot.task.planRevision,
		sessionId,
		branchLeafId,
		workspaceFingerprint: createHash("sha256").update(JSON.stringify(workspaceObservation)).digest("hex"),
		workspaceObservation,
		pendingStepIds: snapshot.steps
			.filter((step) => !["completed", "failed", "skipped"].includes(step.status))
			.map(({ stepId }) => stepId),
		lastCommittedEventSeq: provider.getLastEventSeq(snapshot.task.taskId),
		createdAt: Date.now(),
	};
	return provider.createCheckpoint(value);
}

export function recoveryPreflight(
	provider: TaskProvider,
	taskId: string,
	sessionId: string,
	branchLeafId: string | null,
): RecoveryPreflight {
	const snapshot = provider.get(taskId);
	if (!snapshot) throw new TaskError("TASK_NOT_FOUND", "Task does not exist in the current project");
	const checkpoint = snapshot.lastCheckpoint;
	const attempts = provider.getAttempts(taskId);
	const unknown = new Set(
		attempts
			.filter((attempt) => attempt.state === "needs_reconciliation" || attempt.state === "started")
			.map(({ stepId }) => stepId),
	);
	const currentWorkspace = observeWorkspace(provider.scope.rootPath);
	const currentFingerprint = createHash("sha256").update(JSON.stringify(currentWorkspace)).digest("hex");
	const workspaceChanged = checkpoint ? checkpoint.workspaceFingerprint !== currentFingerprint : true;
	const driftReasons: string[] = [];
	if (!checkpoint) driftReasons.push("checkpoint-missing");
	else {
		if (checkpoint.workspaceObservation.realRoot !== currentWorkspace.realRoot)
			driftReasons.push("project-realpath-changed");
		if (checkpoint.workspaceObservation.gitHead !== currentWorkspace.gitHead) driftReasons.push("git-head-changed");
		if (checkpoint.workspaceObservation.gitStatusDigest !== currentWorkspace.gitStatusDigest)
			driftReasons.push("git-worktree-changed");
		if (checkpoint.planRevision !== snapshot.task.planRevision) driftReasons.push("plan-revision-changed");
		if (checkpoint.taskRevision !== snapshot.task.revision) driftReasons.push("task-revision-changed");
	}
	const bindingMatches = provider.hasSessionBinding(taskId, sessionId, branchLeafId);
	if (!bindingMatches) driftReasons.push("session-binding-missing");
	const consistencyValid = provider.verifyConsistency(taskId);
	if (!consistencyValid) driftReasons.push("event-snapshot-inconsistent");
	const recommendations = ["恢复仅生成计划建议，不会自动重放任何工具。"];
	if (unknown.size > 0) recommendations.push("先人工核对结果不确定的工具调用，再决定失败、完成或重新执行。");
	if (workspaceChanged) recommendations.push("工作区有限指纹已变化，需要重新检查相关文件和 Git 状态。");
	const safeContinueStepIds = snapshot.steps
		.filter(
			(step) =>
				step.status === "pending" &&
				step.dependsOn.every((dependency) =>
					snapshot.steps.some((candidate) => candidate.stepId === dependency && candidate.status === "completed"),
				),
		)
		.map(({ stepId }) => stepId);
	return {
		taskId,
		projectMatches: snapshot.task.projectId === provider.scope.projectId,
		sessionChanged: checkpoint ? checkpoint.sessionId !== sessionId : true,
		branchChanged: checkpoint ? checkpoint.branchLeafId !== branchLeafId : true,
		workspaceChanged,
		checkpointRevisionMatches: checkpoint
			? checkpoint.taskRevision === snapshot.task.revision &&
				checkpoint.planRevision === snapshot.task.planRevision &&
				checkpoint.lastCommittedEventSeq <= provider.getLastEventSeq(taskId)
			: false,
		completedStepIds: snapshot.steps.filter((step) => step.status === "completed").map(({ stepId }) => stepId),
		failedStepIds: snapshot.steps.filter((step) => step.status === "failed").map(({ stepId }) => stepId),
		unknownStepIds: [...unknown],
		pendingStepIds: snapshot.steps
			.filter((step) => ["pending", "running", "blocked", "verifying", "needs_reconciliation"].includes(step.status))
			.map(({ stepId }) => stepId),
		requiresReconciliation: unknown.size > 0 || workspaceChanged || !bindingMatches || !consistencyValid,
		consistencyValid,
		bindingMatches,
		driftReasons,
		safeContinueStepIds,
		automaticReplayAllowed: false,
		recommendations,
	};
}
