import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RecoveryPreflight, TaskCheckpoint, TaskSnapshot, WorkspaceObservation } from "./contracts.ts";
import { TaskError } from "./errors.ts";
import type { TaskProvider } from "./provider.ts";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export function workspaceFingerprint(rootPath: string, controlledFiles: readonly string[] = []): string {
	return createHash("sha256")
		.update(JSON.stringify(observeWorkspace(rootPath, controlledFiles)))
		.digest("hex");
}

export function observeWorkspace(rootPath: string, controlledFiles: readonly string[] = []): WorkspaceObservation {
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
	const candidates = new Set<string>([join(".git", "HEAD"), "package.json", "pyproject.toml", ...controlledFiles]);
	let gitDiffComplete = false;
	try {
		const changed = execFileSync("git", ["diff", "--name-only", "--relative", "-z", "HEAD", "--"], {
			cwd: realRoot,
			encoding: "utf8",
			timeout: 1_500,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		for (const item of changed.split("\0")) if (item) candidates.add(item);
		gitDiffComplete = true;
	} catch {}
	const trackedFiles: Array<WorkspaceObservation["trackedFiles"][number]> = [];
	let totalBytes = 0;
	let observationLimited = candidates.size > MAX_FILES || (gitHead !== undefined && (!gitDiffComplete || !gitStatusDigest));
	for (const requested of [...candidates].sort().slice(0, MAX_FILES)) {
		const normalized = process.platform === "win32" ? requested.replaceAll("\\", "/") : requested;
		if (!normalized || isAbsolute(normalized) || normalized.split("/").includes("..")) {
			observationLimited = true;
			continue;
		}
		const path = resolve(realRoot, normalized);
		if (!inside(realRoot, path) || !inside(realRoot, nearestExisting(path))) {
			observationLimited = true;
			continue;
		}
		if (!existsSync(path)) {
			trackedFiles.push({ relativePath: normalized, exists: false, size: 0, mtimeMs: 0 });
			continue;
		}
		const stat = statSync(path);
		if (!stat.isFile()) {
			observationLimited = true;
			continue;
		}
		totalBytes += stat.size;
		const hashable = stat.size <= MAX_FILE_BYTES && totalBytes <= MAX_TOTAL_BYTES;
		if (!hashable) observationLimited = true;
		trackedFiles.push({
			relativePath: normalized,
			exists: true,
			size: stat.size,
			mtimeMs: Math.trunc(stat.mtimeMs),
			...(hashable ? { sha256: createHash("sha256").update(readFileSync(path)).digest("hex") } : {}),
		});
	}
	return {
		realRoot,
		gitStatusEntries,
		trackedFiles,
		observationLimited,
		...(gitHead ? { gitHead } : {}),
		...(gitStatusDigest ? { gitStatusDigest } : {}),
	};
}

function inside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function nearestExisting(path: string): string {
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return realpathSync.native(current);
}

export function createCheckpoint(
	provider: TaskProvider,
	snapshot: TaskSnapshot,
	sessionId: string,
	branchLeafId: string | null,
	controlledFiles: readonly string[] = [],
	observation?: TaskCheckpoint["observation"],
): TaskCheckpoint {
	const workspaceObservation = observeWorkspace(provider.scope.rootPath, controlledFiles);
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
		...(observation ? { observation } : {}),
	};
	return provider.createCheckpoint(value);
}

export function recoveryPreflight(
	provider: TaskProvider,
	taskId: string,
	sessionId: string,
	branchLeafId: string | null,
	controlledFiles: readonly string[] = [],
): RecoveryPreflight {
	const snapshot = provider.get(taskId);
	if (!snapshot) throw new TaskError("TASK_NOT_FOUND", "Task does not exist in the current project");
	const checkpoint = snapshot.lastCheckpoint;
	const attempts = provider.getAttempts(taskId);
	const checkpointIntegrity = checkpoint ? provider.checkpointIntegrity(checkpoint) : "missing";
	const interrupted = attempts.filter(
		(attempt) => attempt.state === "needs_reconciliation" || attempt.state === "started",
	);
	const verifyBeforeWrite = new Set(
		interrupted.filter((attempt) => attempt.riskClass !== "read_only").map(({ stepId }) => stepId),
	);
	const readOnlyRetryStepIds = [
		...new Set(
			interrupted
				.filter((attempt) => attempt.riskClass === "read_only" && !verifyBeforeWrite.has(attempt.stepId))
				.map(({ stepId }) => stepId),
		),
	];
	const unknown = new Set(interrupted.map(({ stepId }) => stepId));
	const currentWorkspace = observeWorkspace(provider.scope.rootPath, controlledFiles);
	const currentFingerprint = createHash("sha256").update(JSON.stringify(currentWorkspace)).digest("hex");
	const workspaceChanged = checkpoint ? checkpoint.workspaceFingerprint !== currentFingerprint : true;
	const driftReasons: string[] = [];
	if (checkpointIntegrity !== "verified") driftReasons.push(`checkpoint-${checkpointIntegrity}`);
	if (checkpoint) {
		if (checkpoint.workspaceObservation.realRoot !== currentWorkspace.realRoot)
			driftReasons.push("project-realpath-changed");
		if (checkpoint.workspaceObservation.gitHead !== currentWorkspace.gitHead) driftReasons.push("git-head-changed");
		if (checkpoint.workspaceObservation.gitStatusDigest !== currentWorkspace.gitStatusDigest)
			driftReasons.push("git-worktree-changed");
		if (
			JSON.stringify(checkpoint.workspaceObservation.trackedFiles) !== JSON.stringify(currentWorkspace.trackedFiles)
		)
			driftReasons.push("controlled-files-changed");
		if (checkpoint.planRevision !== snapshot.task.planRevision) driftReasons.push("plan-revision-changed");
		if (checkpoint.taskRevision !== snapshot.task.revision) driftReasons.push("task-revision-changed");
	}
	const bindingMatches = provider.hasSessionBinding(taskId, sessionId, branchLeafId);
	const limited = currentWorkspace.observationLimited || checkpoint?.workspaceObservation.observationLimited === true;
	if (limited) driftReasons.push("workspace-observation-limited");
	if (!bindingMatches) driftReasons.push("session-binding-missing");
	const consistencyValid = checkpointIntegrity !== "invalid" && provider.verifyConsistency(taskId);
	if (!consistencyValid) driftReasons.push("event-snapshot-inconsistent");
	const recommendations = ["恢复仅生成计划建议，不会自动重放任何工具。"];
	if (unknown.size > 0) recommendations.push("先人工核对结果不确定的工具调用，再决定失败、完成或重新执行。");
	if (workspaceChanged) recommendations.push("工作区有限指纹已变化，需要重新检查相关文件和 Git 状态。");
	if (limited) recommendations.push("工作区检查未覆盖全部变更，请先核对未完成内容校验的文件。");
	const requiresReconciliation = unknown.size > 0 || workspaceChanged || limited || !bindingMatches || !consistencyValid;
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
		checkpointIntegrity,
		readOnlyRetryStepIds,
		verifyBeforeWriteStepIds: [...verifyBeforeWrite],
		checkpointRevisionMatches:
			checkpoint && checkpointIntegrity !== "invalid"
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
		requiresReconciliation,
		consistencyValid,
		bindingMatches,
		driftReasons,
		safeContinueStepIds:
			snapshot.task.status !== "budget_exhausted" && !requiresReconciliation
				? safeContinueStepIds
				: [],
		automaticReplayAllowed: false,
		recommendations,
	};
}
