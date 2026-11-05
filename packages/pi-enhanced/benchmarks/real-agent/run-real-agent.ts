import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { claimBatchLCell, loadBatchLAuthorization } from "./batch-l-authorization.ts";
import { BATCH_L_LIMITS, BATCH_L_PROFILE, TASK_PAIR_LIMITS, TASK_PAIR_PROFILE } from "./batch-l-profile.ts";
import {
	CONTROLLED_IMAGE,
	CONTROLLED_LIMITS,
	controlledCell,
	LONG_REPORT_TASK,
	MEMORY_TASK_PROMPT,
} from "./controlled-cases.ts";
import { buildEvaluationPlan, preflightView } from "./evaluation-policy.ts";
import { NEXT_EVALUATION_PROFILE } from "./evaluation-telemetry.ts";
import { loadOfflineDenialPolicy } from "./offline-denial-policy.ts";
import { executeAgent } from "./runner-execution.ts";
import { type ExperimentTask, prepareAgent, prepareWorkspace, type RunnerContext } from "./runner-preparation.ts";
import { collectTaskResult, saveRunReport } from "./runner-results.ts";
import { claimTaskPairCell, loadTaskPairAuthorization, readTaskPairInput } from "./task-pair-authorization.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repositoryRoot = resolve(packageRoot, "../..");
async function main(): Promise<void> {
	const manifest = JSON.parse(readFileSync(join(here, "task-manifest.json"), "utf8")) as { tasks: ExperimentTask[] };
	const execute = process.argv.includes("--execute");
	const localStubUrl = argument("--local-stub-url");
	const cell = controlledCell(argument("--controlled-cell"));
	const comparisonProfile = argument("--comparison-profile");
	const taskPair = comparisonProfile === TASK_PAIR_PROFILE;
	if (comparisonProfile && ![BATCH_L_PROFILE, NEXT_EVALUATION_PROFILE, TASK_PAIR_PROFILE].includes(comparisonProfile))
		throw new Error("EVAL_UNKNOWN_COMPARISON_PROFILE");
	if (comparisonProfile === NEXT_EVALUATION_PROFILE && execute && !localStubUrl)
		throw new Error("BATCH_N_SEPARATE_AUTHORIZATION_REQUIRED");
	const taskPairPath = argument("--task-pair-authorization");
	const taskPairExpectedPath = argument("--task-pair-expected-input");
	if (taskPairPath && (!taskPair || localStubUrl)) throw new Error("TASK_PAIR_AUTHORIZATION_SCOPE_INVALID");
	if (taskPairExpectedPath && (!taskPair || !localStubUrl)) throw new Error("TASK_PAIR_EXPECTED_INPUT_SCOPE_INVALID");
	if (taskPair && execute && !localStubUrl && !taskPairPath) throw new Error("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
	if (taskPair && (argument("--batch-l-authorization") || argument("--offline-denial-policy")))
		throw new Error("TASK_PAIR_STRICT_STUB_ONLY");
	if (taskPair && cell?.module !== "task") throw new Error("TASK_PAIR_INVALID_CELL");
	const batchL = taskPair || comparisonProfile === BATCH_L_PROFILE || comparisonProfile === NEXT_EVALUATION_PROFILE;
	const telemetryEnabled = taskPair || process.argv.includes("--evaluation-telemetry");
	const experimentalLimits = taskPair ? TASK_PAIR_LIMITS : batchL ? BATCH_L_LIMITS : CONTROLLED_LIMITS;
	if (batchL && !cell) throw new Error("BATCH_L_REAL_AUTHORIZATION_REQUIRED");
	const authorizationBatchId = argument("--authorization-batch-id");
	const taskPairAuthorization =
		taskPair && execute && !localStubUrl
			? loadTaskPairAuthorization(
					taskPairPath,
					repositoryRoot,
					execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
					authorizationBatchId ?? "",
					argument("--ci-evidence"),
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
	const selectedTasks = (
		taskId ? [...manifest.tasks, LONG_REPORT_TASK].filter((task) => task.id === taskId) : manifest.tasks
	).map((task) => (cell?.module === "memory" ? { ...task, prompt: MEMORY_TASK_PROMPT } : task));
	if (selectedTasks.length === 0) throw new Error("EVAL_UNKNOWN_TASK");
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
		taskPair &&
		execute &&
		(input.apiKeyEnv !== (localStubUrl ? "MOCK_PROVIDER_KEY" : "DEEPSEEK_API_KEY") ||
			input.provider !== "deepseek" ||
			input.model !== "deepseek-flash" ||
			input.sandboxImage !== CONTROLLED_IMAGE ||
			input.budgetEnforcement !== "local_hard_gateway" ||
			input.maxTasks !== "1" ||
			input.concurrency !== "1" ||
			input.maxTotalCostUsd !== String(TASK_PAIR_LIMITS.maxCostUsd) ||
			input.maxTokensPerTask !== String(TASK_PAIR_LIMITS.maxTokens) ||
			input.maxCallsPerTask !== String(TASK_PAIR_LIMITS.maxRequests) ||
			input.timeoutMs !== String(TASK_PAIR_LIMITS.timeoutMs))
	)
		throw new Error("TASK_PAIR_CONFIGURATION_MISMATCH");
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
			input.runId !== `${authorizationBatchId}_${cell!.id}` ||
			!input.outputDir ||
			execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
				cwd: repositoryRoot,
				encoding: "utf8",
			}).trim()
		)
			throw new Error("TASK_PAIR_RUN_SCOPE_INVALID");
		claimTaskPairCell(taskPairPath!, taskPairAuthorization, cell!.id, input.outputDir);
	}
	if (execute && !localStubUrl) {
		const projectEnv = join(repositoryRoot, ".env");
		if (existsSync(projectEnv)) loadEnvFile(projectEnv);
	}
	const plan = execute ? buildEvaluationPlan(input, process.env) : undefined;
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
				switches: variants[variant]!,
				condition,
				readonlyModuleTools,
				telemetryEnabled,
				localStubUrl,
				authorization,
				offlinePolicy,
				comparisonProfile,
				taskPairAuthorization,
				taskPairExpected:
					taskPairAuthorization?.input ??
					(taskPairExpectedPath
						? readTaskPairInput(JSON.parse(readFileSync(taskPairExpectedPath, "utf8")))
						: undefined),
				observedCost,
			};
			const prepared = await prepareAgent(context, workspace);
			const execution = await executeAgent(context, prepared);
			const result = collectTaskResult(context, prepared, execution);
			results.push(result.record);
			observedCost = result.observedCost;
			if (result.overBudget) break;
		}
		const summary = saveRunReport(
			{ plan, execute, localStubUrl, variant, condition, telemetryEnabled, packageRoot, runOutput, batchL },
			results,
			observedCost,
		);
		process.stdout.write(`${JSON.stringify(summary)}\n`);
	} finally {
		rmSync(root, { recursive: true, force: true });
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
