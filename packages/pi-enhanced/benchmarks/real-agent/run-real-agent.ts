import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { atomicPrivateJson } from "../../src/sandbox/audit.ts";
import { claimBatchLCell, loadBatchLAuthorization } from "./batch-l-authorization.ts";
import { BATCH_L_LIMITS, BATCH_L_PROFILE, TASK_PAIR_LIMITS, TASK_PAIR_PROFILE } from "./batch-l-profile.ts";
import {
	CONTROLLED_IMAGE,
	CONTROLLED_LIMITS,
	controlledCell,
	LONG_REPORT_TASK,
	MEMORY_TASK_PROMPT,
} from "./controlled-cases.ts";
import { digest } from "./evaluation-identity.ts";
import { buildEvaluationPlan, preflightView } from "./evaluation-policy.ts";
import { NEXT_EVALUATION_PROFILE } from "./evaluation-telemetry.ts";
import { loadOfflineDenialPolicy } from "./offline-denial-policy.ts";
import { executeAgent } from "./runner-execution.ts";
import { type ExperimentTask, prepareAgent, prepareWorkspace, type RunnerContext } from "./runner-preparation.ts";
import { collectTaskResult, saveRunReport } from "./runner-results.ts";
import { loadSuspendedRun, saveSuspendedRun } from "./runner-resume.ts";
import { resolveSweProfile, SWE_FLASH_OFF_PYTEST_SINGLE_PROFILE, SWE_TASK_LIMITS } from "./swe-profile.ts";
import { collectSweResult } from "./swe-results.ts";
import { readSwePytestPolicy } from "./swe-test-feedback.ts";
import { loadSweTask } from "./swe-workspace.ts";
import {
	claimTaskPairCell,
	loadTaskPairAuthorization,
	readSweFlashOffInputs,
	readSweModeInputs,
	readSweProTaskInputs,
	readTaskPairInput,
	type TaskPairInput,
} from "./task-pair-authorization.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repositoryRoot = resolve(packageRoot, "../..");
export async function main(): Promise<void> {
	const manifest = JSON.parse(readFileSync(join(here, "task-manifest.json"), "utf8")) as { tasks: ExperimentTask[] };
	const execute = process.argv.includes("--execute");
	const jointRecovery = process.argv.includes("--v3-joint-recovery");
	const stubRecovery = process.argv.includes("--v3-stub-recovery");
	const v3Evaluation = jointRecovery || process.argv.includes("--v3-evaluation");
	const recoveryPhase = argument(jointRecovery ? "--v3-joint-recovery" : "--v3-stub-recovery");
	if (recoveryPhase !== undefined && recoveryPhase !== "pause" && recoveryPhase !== "resume")
		throw new Error("EVAL_V3_RECOVERY_MODE_INVALID");
	if ((jointRecovery && stubRecovery) || ((jointRecovery || stubRecovery) && recoveryPhase === undefined))
		throw new Error("EVAL_V3_RECOVERY_MODE_INVALID");
	const localStubUrl = argument("--local-stub-url");
	const cell = controlledCell(argument("--controlled-cell"));
	const sweId = argument("--swebench-id");
	const sweMirror = argument("--swebench-mirror");
	const taskMode = argument("--task-mode");
	const swePytestPath = argument("--swe-pytest-policy");
	if (process.argv.includes("--swe-pytest-policy") && (!swePytestPath || !sweId || !execute || (taskMode !== undefined && taskMode !== "off")))
		throw new Error("SWE_PYTEST_SCOPE_INVALID");
	const comparisonProfile = argument("--comparison-profile");
	const swe = resolveSweProfile(comparisonProfile);
	if (execute && comparisonProfile === SWE_FLASH_OFF_PYTEST_SINGLE_PROFILE && !swePytestPath)
		throw new Error("SWE_PYTEST_POLICY_REQUIRED");
	if (swePytestPath && ((!localStubUrl || swe) && (swe?.admission !== "instances" || swe.cells.length !== 1)))
		throw new Error("SWE_PYTEST_REQUIRES_ONE_INSTANCE");
	const flashInstance = swe?.admission === "instances"
		? swe.configuration.instances.find((instance) => instance.instanceId === sweId)
		: undefined;
	if (
		swe &&
		(!sweMirror ||
			!taskMode ||
			(swe.admission === "instances"
				? !flashInstance || taskMode !== "off"
				: sweId !== swe.configuration.instanceId ||
					(swe.admission !== "all" && !swe.cells.some((cell) => cell.id === taskMode))))
	)
		throw new Error("SWE_EXPERIMENT_SCOPE_INVALID");
	if (sweId || sweMirror) {
		if (
			!sweId ||
			!sweMirror ||
			!execute ||
			(!localStubUrl && !swe) ||
			cell ||
			(comparisonProfile && !swe) ||
			argument("--offline-denial-policy") ||
			argument("--condition") ||
			argument("--variant") ||
			argument("--api-key-env") !== (localStubUrl ? "MOCK_PROVIDER_KEY" : "DEEPSEEK_API_KEY")
		)
			throw new Error("SWE_STUB_ONLY");
	}
	if (taskMode && (!sweId || (taskMode !== "off" && taskMode !== "v1" && taskMode !== "v2")))
		throw new Error("SWE_TASK_MODE_INVALID");
	const swePytest = swePytestPath ? readSwePytestPolicy(swePytestPath, sweId!) : undefined;
	const taskPair = comparisonProfile === TASK_PAIR_PROFILE;
	if (
		comparisonProfile &&
		!swe &&
		![BATCH_L_PROFILE, NEXT_EVALUATION_PROFILE, TASK_PAIR_PROFILE].includes(comparisonProfile)
	)
		throw new Error("EVAL_UNKNOWN_COMPARISON_PROFILE");
	if (comparisonProfile === NEXT_EVALUATION_PROFILE && execute && !localStubUrl)
		throw new Error("BATCH_N_SEPARATE_AUTHORIZATION_REQUIRED");
	const taskPairPath = argument("--task-pair-authorization");
	const taskPairExpectedPath = argument("--task-pair-expected-input");
	if (taskPairPath && (!(taskPair || swe) || localStubUrl)) throw new Error("TASK_PAIR_AUTHORIZATION_SCOPE_INVALID");
	if (taskPairExpectedPath && (!(taskPair || swe) || !localStubUrl))
		throw new Error("TASK_PAIR_EXPECTED_INPUT_SCOPE_INVALID");
	if ((taskPair || swe) && execute && !localStubUrl && !taskPairPath)
		throw new Error("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
	if ((taskPair || swe) && (argument("--batch-l-authorization") || argument("--offline-denial-policy")))
		throw new Error("TASK_PAIR_STRICT_STUB_ONLY");
	if (taskPair && cell?.module !== "task") throw new Error("TASK_PAIR_INVALID_CELL");
	const batchL = taskPair || comparisonProfile === BATCH_L_PROFILE || comparisonProfile === NEXT_EVALUATION_PROFILE;
	const telemetryEnabled = v3Evaluation || Boolean(sweId) || taskPair || process.argv.includes("--evaluation-telemetry");
	const experimentalLimits = taskPair ? TASK_PAIR_LIMITS : batchL ? BATCH_L_LIMITS : CONTROLLED_LIMITS;
	if (batchL && !cell) throw new Error("BATCH_L_REAL_AUTHORIZATION_REQUIRED");
	const authorizationBatchId = argument("--authorization-batch-id");
	const taskPairAuthorization =
		(taskPair || swe) && execute && !localStubUrl
			? loadTaskPairAuthorization(
					taskPairPath,
					repositoryRoot,
					execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
					authorizationBatchId ?? "",
					argument("--ci-evidence"),
					swe?.configuration.profile ?? TASK_PAIR_PROFILE,
					Boolean(swePytest),
				)
			: undefined;
	const authorization =
		batchL && !taskPair && execute && !localStubUrl
			? loadBatchLAuthorization(
					argument("--batch-l-authorization"),
					repositoryRoot,
					execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
					authorizationBatchId ?? "",
				)
			: undefined;
	const offlinePolicy = loadOfflineDenialPolicy(argument("--offline-denial-policy"), localStubUrl, repositoryRoot);
	if (offlinePolicy && !cell) throw new Error("OFFLINE_DENIAL_POLICY_REQUIRES_CONTROLLED_CELL");
	const readonlyModuleTools =
		v3Evaluation || batchL || (cell ? cell.treatment && cell.module !== "context" : process.argv.includes("--readonly-module-tools"));
	const taskId = cell?.taskId ?? argument("--task-id");
	const singleFileTestFeedback = process.argv.includes("--single-file-test-feedback");
	const configDefaultTestFeedback = process.argv.includes("--config-default-test-feedback");
	const baselineFixture = !cell && !sweId && !comparisonProfile &&
		(v3Evaluation || (argument("--variant") ?? "baseline") === "baseline");
	if (v3Evaluation && !jointRecovery && (!baselineFixture || !localStubUrl || !taskId || !["controlled-long-report", ...manifest.tasks.map(({ id }) => id)].includes(taskId)))
		throw new Error("EVAL_V3_LOCAL_STUB_SCOPE_REQUIRED");
	if (singleFileTestFeedback && (taskId !== "single-file-off-by-one" || !baselineFixture))
		throw new Error("EVAL_SINGLE_FILE_TEST_SCOPE_INVALID");
	if (configDefaultTestFeedback && (taskId !== "config-default" || !baselineFixture))
		throw new Error("EVAL_CONFIG_DEFAULT_TEST_SCOPE_INVALID");
	if (jointRecovery && (!baselineFixture || sweMirror || taskId !== "memory-guided-regression" ||
		singleFileTestFeedback || configDefaultTestFeedback ||
		(argument("--variant") ?? "full") !== "full" || (argument("--condition") ?? "memory_seeded") !== "memory_seeded"))
		throw new Error("EVAL_V3_JOINT_RECOVERY_SCOPE_REQUIRED");
	const testFeedback = singleFileTestFeedback || configDefaultTestFeedback ||
		Boolean(recoveryPhase && taskId === "memory-guided-regression");
	if (stubRecovery && (!v3Evaluation || !taskId ||
		!["task-only", "full"].includes(argument("--variant") ?? "")))
		throw new Error("EVAL_V3_RECOVERY_SCOPE_REQUIRED");
	const swebench = sweId && sweMirror ? loadSweTask(sweId, sweMirror) : undefined;
	const selectedTasks: ExperimentTask[] = swebench
		? [
				{
					id: "swebench",
					category: localStubUrl ? "swebench_verified_stub" : "swebench_verified_real",
					prompt: swebench.issue.problem_statement,
					swebench,
				},
			]
		: (taskId ? [...manifest.tasks, LONG_REPORT_TASK].filter((task) => task.id === taskId) : manifest.tasks).map(
				(task) => (cell?.module === "memory" ? { ...task, prompt: MEMORY_TASK_PROMPT } : task),
			);
	if (selectedTasks.length === 0) throw new Error("EVAL_UNKNOWN_TASK");
	const requiredLimits = swe?.configuration.limits ?? TASK_PAIR_LIMITS;
	const sweLimits = swe?.configuration.limits ?? SWE_TASK_LIMITS;
	const input = {
		runId: argument("--run-id"),
		provider: argument("--provider"),
		model: argument("--model"),
		apiKeyEnv: argument("--api-key-env"),
		maxTotalCostUsd: argument("--max-total-cost-usd"),
		maxTasks: argument("--max-tasks"),
		maxTokensPerTask: argument("--max-tokens-per-task"),
		maxCallsPerTask: argument("--max-calls-per-task"),
		timeoutMs: argument("--timeout-ms"),
		concurrency: argument("--concurrency"),
		budgetEnforcement: argument("--budget-enforcement"),
		outputDir: argument("--output-dir"),
		sandboxImage: argument("--sandbox-image"),
	};
	if (
		(taskPair || swe) &&
		execute &&
		(input.apiKeyEnv !== (localStubUrl ? "MOCK_PROVIDER_KEY" : "DEEPSEEK_API_KEY") ||
			input.provider !== "deepseek" ||
			input.model !== (swe?.configuration.model ?? "deepseek-flash") ||
			input.sandboxImage !== CONTROLLED_IMAGE ||
			input.budgetEnforcement !== "local_hard_gateway" ||
			input.maxTasks !== "1" ||
			input.concurrency !== "1" ||
			(localStubUrl
				? Number(input.maxTotalCostUsd) > requiredLimits.maxCostUsd
				: input.maxTotalCostUsd !== String(requiredLimits.maxCostUsd)) ||
			(localStubUrl
				? Number(input.maxTokensPerTask) > requiredLimits.maxTokens
				: input.maxTokensPerTask !== String(requiredLimits.maxTokens)) ||
			(localStubUrl
				? Number(input.maxCallsPerTask) > requiredLimits.maxRequests
				: input.maxCallsPerTask !== String(requiredLimits.maxRequests)) ||
			(localStubUrl
				? Number(input.timeoutMs) > requiredLimits.timeoutMs
				: input.timeoutMs !== String(requiredLimits.timeoutMs)))
	)
		throw new Error("TASK_PAIR_CONFIGURATION_MISMATCH");
	if (input.model === "deepseek-v4-pro" && swe?.configuration.model !== input.model)
		throw new Error("SWE_PRO_PROFILE_REQUIRED");
	if (jointRecovery && (input.provider !== "deepseek" || input.model !== "deepseek-flash" ||
		input.apiKeyEnv !== (localStubUrl ? "MOCK_PROVIDER_KEY" : "DEEPSEEK_API_KEY")))
		throw new Error("EVAL_V3_JOINT_PROVIDER_INVALID");
	if (process.argv.includes("--preflight")) {
		const repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		}).trim();
		process.stdout.write(
			`${JSON.stringify({ repositoryCommit, ...preflightView(input, testFeedback ? selectedTasks.length : manifest.tasks.length, testFeedback) }, null, 2)}\n`,
		);
		process.exit(0);
	}
	if (localStubUrl) {
		if (!execute || process.env.PI_ENHANCED_LOCAL_STUB_EVAL !== "1" || !isLoopbackUrl(localStubUrl)) {
			throw new Error("EVAL_GATE_LOCAL_STUB_UNAUTHORIZED");
		}
	}
	let taskPairExpected: TaskPairInput | undefined;
	if (taskPairExpectedPath) {
		const input = JSON.parse(readFileSync(taskPairExpectedPath, "utf8"));
		if (swe?.admission === "instances" && flashInstance)
			taskPairExpected = readSweFlashOffInputs(input, swe.configuration.instances, Boolean(swePytest))[flashInstance.instanceId];
		else if (swe?.admission === "task") taskPairExpected = readSweProTaskInputs(input)[taskMode as "v1" | "v2"];
		else if (swe?.admission === "all") taskPairExpected = readSweModeInputs(input)[taskMode as "off" | "v1" | "v2"];
		else taskPairExpected = readTaskPairInput(input);
	}
	if (taskPairAuthorization) {
		const authorizationCell = flashInstance?.cellId ?? (swe ? taskMode! : cell!.id);
		if (
			process.env.PI_ENHANCED_REAL_MODEL_EVAL !== "1" ||
			input.runId !== `${authorizationBatchId}_${authorizationCell}` ||
			!input.outputDir ||
			execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
				cwd: repositoryRoot,
				encoding: "utf8",
			}).trim()
		)
			throw new Error("TASK_PAIR_RUN_SCOPE_INVALID");
		claimTaskPairCell(taskPairPath!, taskPairAuthorization, authorizationCell, input.outputDir);
		if (flashInstance) taskPairExpected = taskPairAuthorization.instanceInputs?.[flashInstance.instanceId];
		else if (swe?.admission === "all" || swe?.admission === "task")
			taskPairExpected = taskPairAuthorization.modeInputs![taskMode as "off" | "v1" | "v2"];
		else taskPairExpected = taskPairAuthorization.input;
	}
	if (jointRecovery && (!execute || process.env.PI_ENHANCED_REAL_MODEL_EVAL !== "1"))
		throw new Error("EVAL_V3_JOINT_RECOVERY_UNAUTHORIZED");
	if (execute && !localStubUrl) {
		const projectEnv = join(repositoryRoot, ".env");
		if (existsSync(projectEnv)) loadEnvFile(projectEnv);
	}
	const plan = execute ? buildEvaluationPlan(input, process.env) : undefined;
	if (v3Evaluation && (!plan || plan.maxTasks !== 1 || plan.apiKeyEnv !== (jointRecovery && !localStubUrl ? "DEEPSEEK_API_KEY" : "MOCK_PROVIDER_KEY") ||
		plan.sandboxImage !== CONTROLLED_IMAGE || plan.budgetEnforcement !== "local_hard_gateway" ||
		plan.maxCallsPerTask > CONTROLLED_LIMITS.maxRequests ||
		plan.maxTokensPerTask > (jointRecovery ? 48_000 : CONTROLLED_LIMITS.maxTokens) ||
		plan.maxTotalCostUsd > CONTROLLED_LIMITS.maxCostUsd || plan.timeoutMs > CONTROLLED_LIMITS.timeoutMs))
		throw new Error("EVAL_V3_LIMIT_INVALID");
	if (
		swebench &&
		(!plan ||
			plan.maxTasks !== 1 ||
			plan.sandboxImage !== CONTROLLED_IMAGE ||
			plan.budgetEnforcement !== "local_hard_gateway" ||
			plan.maxCallsPerTask > sweLimits.maxRequests ||
			plan.maxTokensPerTask > sweLimits.maxTokens ||
			plan.maxTotalCostUsd > sweLimits.maxCostUsd ||
			plan.timeoutMs > sweLimits.timeoutMs)
	)
		throw new Error("SWE_BUDGET_OR_SANDBOX_INVALID");
	if (
		authorization &&
		plan &&
		(plan.runId !== `${authorizationBatchId}_${cell!.id}` ||
			plan.provider !== authorization.provider ||
			plan.model !== authorization.model)
	)
		throw new Error("BATCH_L_AUTHORIZATION_RUN_MISMATCH");
	if (authorization && plan)
		claimBatchLCell(argument("--batch-l-authorization")!, authorization, cell!.id, plan.outputDir);
	if (
		cell &&
		plan &&
		(plan.maxTasks !== 1 ||
			plan.maxCallsPerTask > experimentalLimits.maxRequests ||
			plan.maxTokensPerTask > experimentalLimits.maxTokens ||
			plan.maxTotalCostUsd > experimentalLimits.maxCostUsd ||
			plan.timeoutMs > experimentalLimits.timeoutMs)
	)
		throw new Error("EVAL_CONTROLLED_LIMIT_EXCEEDED");
	const variant = cell?.variant ?? argument("--variant") ?? (jointRecovery ? "full" : "baseline");
	const condition = cell
		? (batchL && cell.module === "memory") || cell.id === "m_memory"
			? "memory_seeded"
			: "cold"
		: (argument("--condition") ?? (jointRecovery ? "memory_seeded" : "cold"));
	if (condition !== "cold" && condition !== "memory_seeded") throw new Error(`Unknown condition: ${condition}`);
	const variants: Record<string, { memory: boolean; context: boolean; task: boolean }> = {
		baseline: { memory: false, context: false, task: false },
		"memory-only": { memory: true, context: false, task: false },
		"context-only": { memory: false, context: true, task: false },
		"task-only": { memory: false, context: false, task: true },
		"memory-context": { memory: true, context: true, task: false },
		full: { memory: true, context: true, task: true },
	};
	if (!variants[variant]) throw new Error(`Unknown ablation variant: ${variant}`);

	const runOutput = plan ? resolve(plan.outputDir, plan.runId) : undefined;
	if (runOutput && existsSync(runOutput) && recoveryPhase !== "resume")
		throw new Error("EVAL_GATE_RUN_ID_ALREADY_EXISTS");
	if (runOutput && recoveryPhase !== "resume") mkdirSync(runOutput, { recursive: true });
	const root = recoveryPhase ? join(runOutput!, "private") : mkdtempSync(join(tmpdir(), "pi-enhanced-real-agent-"));
	if (recoveryPhase === "pause") mkdirSync(root, { mode: 0o700 });
	if (recoveryPhase === "resume" &&
		(lstatSync(runOutput!).isSymbolicLink() || lstatSync(root).isSymbolicLink()))
		throw new Error("EVAL_V3_RESUME_ROOT_INVALID");
	if (recoveryPhase === "resume" && existsSync(join(runOutput!, "run.json")))
		throw new Error("EVAL_V3_RESUME_TERMINAL_RUN");
	if (offlinePolicy)
		writeFileSync(join(root, "offline-denial-policy.json"), JSON.stringify(offlinePolicy), {
			flag: "wx",
			mode: 0o600,
		});
	if (authorization)
		writeFileSync(join(root, "batch-l-authorization.json"), JSON.stringify(authorization), {
			flag: "wx",
			mode: 0o600,
		});
	if (recoveryPhase !== "resume") mkdirSync(join(root, "temp"));
	const results: Array<Record<string, unknown>> = [];
	let sweCleanup: Record<string, unknown> | undefined;
	try {
		let observedCost = 0;
		for (const task of selectedTasks.slice(0, plan?.maxTasks ?? selectedTasks.length)) {
			const workspace = recoveryPhase === "resume" ? undefined : prepareWorkspace(task, root, cell, batchL, comparisonProfile, v3Evaluation);
			const repositoryCommit = workspace?.repositoryCommit;
			if (!execute) {
				results.push({
					taskId: task.id,
					category: task.category,
					experimentClass: "real_model_coding_agent_task",
					status: "not_run",
					reason: "explicit-model-authorization-required",
					fixtureInitiallyFailed: taskPair ? null : true,
					repositoryCommit,
				});
				continue;
			}

			const context: RunnerContext = {
				task,
				root,
				packageRoot,
				repositoryRoot,
				runOutput: runOutput!,
				plan: plan!,
				cell,
				batchL,
				switches: swebench
					? { memory: false, context: false, task: taskMode === "v1" || taskMode === "v2" }
					: variants[variant]!,
				condition,
				readonlyModuleTools,
				testFeedback,
				swePytest,
				telemetryEnabled,
				v3Evaluation,
				recoveryPhase,
				jointRecovery,
				localStubUrl,
				authorization,
				offlinePolicy,
				comparisonProfile,
				taskPairAuthorization,
				taskPairExpected,
				observedCost,
				taskMode: swebench ? ((taskMode as "off" | "v1" | "v2" | undefined) ?? "off") : undefined,
			};
			const prepared = workspace ? await prepareAgent(context, workspace) : loadSuspendedRun(context);
			const execution = await executeAgent(context, prepared);
			if (recoveryPhase === "pause" && execution.child.status === 0 && execution.child.closed &&
				execution.hostLifecycle.childAbsent && execution.hostLifecycle.containersRemoved &&
				execution.gatewayStatus.state === "ready" && execution.gatewayStatus.requestsRejected === 0) {
				const checkpoint = saveSuspendedRun(context, prepared, execution);
				process.stdout.write(JSON.stringify({
					state: "paused", checkpoint, budgetDeadlineAt: execution.deadlineAt,
					requests: execution.gatewayStatus.requestsStarted,
					inputTokens: execution.gatewayStatus.actualInputTokens, outputTokens: execution.gatewayStatus.actualOutputTokens,
					estimatedCostUsd: execution.gatewayStatus.actualCostUsd,
				}) + "\n");
				return;
			}
			if (task.swebench) {
				const result = collectSweResult(context, prepared, execution);
				sweCleanup = result.cleanup;
				results.push(result.record);
				observedCost = result.observedCost;
				continue;
			}
			const result = collectTaskResult(context, prepared, execution);
			results.push(result.record);
			observedCost = result.observedCost;
			if (result.overBudget) break;
		}
		const summary = saveRunReport(
			{
				plan,
				execute,
				localStubUrl,
				variant,
				condition,
				telemetryEnabled,
				packageRoot,
				runOutput,
				batchL,
				swebench: Boolean(swebench),
				testFeedback,
			},
			results,
			observedCost,
		);
		process.stdout.write(`${JSON.stringify(summary)}\n`);
	} finally {
		if (!recoveryPhase) rmSync(root, { recursive: true, force: true });
		if (sweCleanup && runOutput)
			atomicPrivateJson(join(runOutput, "host-cleanup.json"), {
				...sweCleanup,
				privateRootRemoved: !existsSync(root),
				runReportSha256: digest(readFileSync(join(runOutput, "run.json"), "utf8")),
			});
	}
}
function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}
function isLoopbackUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (
			parsed.protocol === "http:" &&
			parsed.hostname === "127.0.0.1" &&
			Boolean(parsed.port) &&
			parsed.pathname === "/"
		);
	} catch {
		return false;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
