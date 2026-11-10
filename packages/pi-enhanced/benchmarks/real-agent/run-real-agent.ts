import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { SWE_PRO_OFF_CONFIGURATION, SWE_PRO_OFF_LIMITS, SWE_PRO_OFF_PROFILE, SWE_PRO_TASK_CONFIGURATION, SWE_PRO_TASK_LIMITS, SWE_PRO_TASK_PROFILE, SWE_TASK_CONFIGURATION, SWE_TASK_LIMITS, SWE_TASK_PROFILE } from "./swe-profile.ts";
import { collectSweResult } from "./swe-results.ts";
import { loadSweTask } from "./swebench.ts";
import {
	claimTaskPairCell,
	loadTaskPairAuthorization,
	readSweModeInputs,
	readSweProTaskInputs,
	readTaskPairInput,
} from "./task-pair-authorization.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repositoryRoot = resolve(packageRoot, "../..");
async function main(): Promise<void> {
	const manifest = JSON.parse(readFileSync(join(here, "task-manifest.json"), "utf8")) as { tasks: ExperimentTask[] };
	const execute = process.argv.includes("--execute");
	const localStubUrl = argument("--local-stub-url");
	const cell = controlledCell(argument("--controlled-cell"));
	const sweId = argument("--swebench-id");
	const sweMirror = argument("--swebench-mirror");
	const taskMode = argument("--task-mode");
	const comparisonProfile = argument("--comparison-profile");
	const swePro = comparisonProfile === SWE_PRO_OFF_PROFILE;
	const sweProTask = comparisonProfile === SWE_PRO_TASK_PROFILE;
	const swe = comparisonProfile === SWE_TASK_PROFILE || swePro || sweProTask;
	const sweConfiguration = swePro ? SWE_PRO_OFF_CONFIGURATION : sweProTask ? SWE_PRO_TASK_CONFIGURATION : SWE_TASK_CONFIGURATION;
	const sweLimits = swePro ? SWE_PRO_OFF_LIMITS : sweProTask ? SWE_PRO_TASK_LIMITS : SWE_TASK_LIMITS;
	if (swe && (sweId !== sweConfiguration.instanceId || !sweMirror || !taskMode || (swePro && taskMode !== "off")))
		throw new Error("SWE_EXPERIMENT_SCOPE_INVALID");
	if (sweProTask && taskMode !== "v1" && taskMode !== "v2") throw new Error("SWE_EXPERIMENT_SCOPE_INVALID");
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
	const taskPair = comparisonProfile === TASK_PAIR_PROFILE;
	if (
		comparisonProfile &&
		![BATCH_L_PROFILE, NEXT_EVALUATION_PROFILE, TASK_PAIR_PROFILE, SWE_TASK_PROFILE, SWE_PRO_OFF_PROFILE, SWE_PRO_TASK_PROFILE].includes(comparisonProfile)
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
	const telemetryEnabled = Boolean(sweId) || taskPair || process.argv.includes("--evaluation-telemetry");
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
					swe ? (swePro ? SWE_PRO_OFF_PROFILE : sweProTask ? SWE_PRO_TASK_PROFILE : SWE_TASK_PROFILE) : TASK_PAIR_PROFILE,
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
		batchL || (cell ? cell.treatment && cell.module !== "context" : process.argv.includes("--readonly-module-tools"));
	const taskId = cell?.taskId ?? argument("--task-id");
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
	const requiredLimits = swe ? sweLimits : TASK_PAIR_LIMITS;
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
			input.model !== (swe ? sweConfiguration.model : "deepseek-flash") ||
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
	if (input.model === "deepseek-v4-pro" && !swePro && !sweProTask) throw new Error("SWE_PRO_PROFILE_REQUIRED");
	if (process.argv.includes("--preflight")) {
		const repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		}).trim();
		process.stdout.write(
			`${JSON.stringify({ repositoryCommit, ...preflightView(input, manifest.tasks.length) }, null, 2)}\n`,
		);
		process.exit(0);
	}
	if (localStubUrl) {
		if (!execute || process.env.PI_ENHANCED_LOCAL_STUB_EVAL !== "1" || !isLoopbackUrl(localStubUrl)) {
			throw new Error("EVAL_GATE_LOCAL_STUB_UNAUTHORIZED");
		}
	}
	if (taskPairAuthorization) {
		if (
			process.env.PI_ENHANCED_REAL_MODEL_EVAL !== "1" ||
			input.runId !== `${authorizationBatchId}_${swe ? taskMode : cell!.id}` ||
			!input.outputDir ||
			execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
				cwd: repositoryRoot,
				encoding: "utf8",
			}).trim()
		)
			throw new Error("TASK_PAIR_RUN_SCOPE_INVALID");
		claimTaskPairCell(taskPairPath!, taskPairAuthorization, swe ? taskMode! : cell!.id, input.outputDir);
	}
	if (execute && !localStubUrl) {
		const projectEnv = join(repositoryRoot, ".env");
		if (existsSync(projectEnv)) loadEnvFile(projectEnv);
	}
	const plan = execute ? buildEvaluationPlan(input, process.env) : undefined;
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
	const variant = cell?.variant ?? argument("--variant") ?? "baseline";
	const condition = cell
		? (batchL && cell.module === "memory") || cell.id === "m_memory"
			? "memory_seeded"
			: "cold"
		: (argument("--condition") ?? "cold");
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
	if (runOutput && existsSync(runOutput)) throw new Error("EVAL_GATE_RUN_ID_ALREADY_EXISTS");
	if (runOutput) mkdirSync(runOutput, { recursive: true });
	const root = mkdtempSync(join(tmpdir(), "pi-enhanced-real-agent-"));
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
	mkdirSync(join(root, "temp"));
	const results: Array<Record<string, unknown>> = [];
	let sweCleanup: Record<string, unknown> | undefined;
	try {
		let observedCost = 0;
		for (const task of selectedTasks.slice(0, plan?.maxTasks ?? selectedTasks.length)) {
			const workspace = prepareWorkspace(task, root, cell, batchL, comparisonProfile);
			const { repositoryCommit } = workspace;
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
				telemetryEnabled,
				localStubUrl,
				authorization,
				offlinePolicy,
				comparisonProfile,
				taskPairAuthorization,
				taskPairExpected:
					(swe && taskPairAuthorization
						? swePro ? taskPairAuthorization.input : taskPairAuthorization.modeInputs![taskMode as "off" | "v1" | "v2"]
						: taskPairAuthorization?.input) ??
					(taskPairExpectedPath
						? swe && !swePro
							? sweProTask
								? readSweProTaskInputs(JSON.parse(readFileSync(taskPairExpectedPath, "utf8")))[taskMode as "v1" | "v2"]
								: readSweModeInputs(JSON.parse(readFileSync(taskPairExpectedPath, "utf8")))[taskMode as "off" | "v1" | "v2"]
							: readTaskPairInput(JSON.parse(readFileSync(taskPairExpectedPath, "utf8")))
						: undefined),
				observedCost,
				taskMode: swebench ? ((taskMode as "off" | "v1" | "v2" | undefined) ?? "off") : undefined,
			};
			const prepared = await prepareAgent(context, workspace);
			const execution = await executeAgent(context, prepared);
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
			},
			results,
			observedCost,
		);
		process.stdout.write(`${JSON.stringify(summary)}\n`);
	} finally {
		rmSync(root, { recursive: true, force: true });
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
