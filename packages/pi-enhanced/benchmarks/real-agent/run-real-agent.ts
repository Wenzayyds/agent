import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { readSandboxAuditSnapshot } from "../../src/sandbox/audit.ts";
import { assertSandboxWorkspaceIdentity } from "../../src/sandbox/config.ts";
import { claimBatchLCell, loadBatchLAuthorization } from "./batch-l-authorization.ts";
import {
	BATCH_L_LIMITS,
	BATCH_L_PROFILE,
	SWE_TASK_CONFIGURATION,
	SWE_TASK_PROFILE,
	TASK_PAIR_LIMITS,
	TASK_PAIR_PROFILE,
} from "./batch-l-profile.ts";
import {
	CONTROLLED_IMAGE,
	CONTROLLED_LIMITS,
	controlledCell,
	LONG_REPORT_TASK,
	MEMORY_TASK_PROMPT,
} from "./controlled-cases.ts";
import type { SafetyEvent } from "./controlled-stop.ts";
import {
	buildEvaluationPlan,
	executionOutcome,
	parseAgentEvents,
	preflightView,
	redactEvaluationText,
} from "./evaluation-policy.ts";
import { NEXT_EVALUATION_PROFILE } from "./evaluation-telemetry.ts";
import { gatewayEvidence } from "./gateway-integration.ts";
import { loadOfflineDenialPolicy } from "./offline-denial-policy.ts";
import { classifyTermination } from "./result-classification.ts";
import { executeAgent } from "./runner-execution.ts";
import { type ExperimentTask, prepareAgent, prepareWorkspace, type RunnerContext } from "./runner-preparation.ts";
import { collectTaskResult, saveRunReport } from "./runner-results.ts";
import { exportSwePrediction, loadSweTask, SWE_EVALUATION_PROTOCOL } from "./swebench.ts";
import {
	claimTaskPairCell,
	loadTaskPairAuthorization,
	readSweModeInputs,
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
	const swe = comparisonProfile === SWE_TASK_PROFILE;
	if (swe && (sweId !== SWE_TASK_CONFIGURATION.instanceId || !sweMirror || !taskMode))
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
	const taskPair = comparisonProfile === TASK_PAIR_PROFILE;
	if (
		comparisonProfile &&
		![BATCH_L_PROFILE, NEXT_EVALUATION_PROFILE, TASK_PAIR_PROFILE, SWE_TASK_PROFILE].includes(comparisonProfile)
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
					swe ? SWE_TASK_PROFILE : TASK_PAIR_PROFILE,
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
			plan.maxCallsPerTask > 12 ||
			plan.maxTokensPerTask > 80_000 ||
			plan.maxTotalCostUsd > 0.03 ||
			plan.timeoutMs > 180_000)
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
						? taskPairAuthorization.modeInputs![taskMode as "off" | "v1" | "v2"]
						: taskPairAuthorization?.input) ??
					(taskPairExpectedPath
						? swe
							? readSweModeInputs(JSON.parse(readFileSync(taskPairExpectedPath, "utf8")))[
									taskMode as "off" | "v1" | "v2"
								]
							: readTaskPairInput(JSON.parse(readFileSync(taskPairExpectedPath, "utf8")))
						: undefined),
				observedCost,
				taskMode: swebench ? ((taskMode as "off" | "v1" | "v2" | undefined) ?? "off") : undefined,
			};
			const prepared = await prepareAgent(context, workspace);
			const execution = await executeAgent(context, prepared);
			if (task.swebench) {
				const dir = join(runOutput!, task.id);
				let audit: Record<string, unknown> | null = null;
				try {
					audit = readSandboxAuditSnapshot(execution.sandboxAuditPath);
				} catch {}
				writeFileSync(
					join(dir, "sandbox-audit.json"),
					JSON.stringify(
						audit ?? {
							complete: false,
							integrity: "invalid_or_missing",
						},
						null,
						2,
					),
				);
				const inputAuditPath = join(root, "batch-l-input-audit.json");
				const inputAudit = existsSync(inputAuditPath) ? JSON.parse(readFileSync(inputAuditPath, "utf8")) : null;
				const trace = execution.telemetry?.finish(execution.gatewayStatus, audit);
				const agentCompleted =
					execution.child.status === 0 &&
					!execution.child.timedOut &&
					execution.gatewayStatus.state === "ready" &&
					execution.gatewayStatus.requestsRejected === 0;
				const secrets = [process.env[plan!.apiKeyEnv!]!];
				writeFileSync(join(dir, "agent.stdout.jsonl"), redactEvaluationText(execution.child.stdout, secrets), {
					flag: "wx",
					mode: 0o600,
				});
				writeFileSync(join(dir, "agent.stderr.log"), redactEvaluationText(execution.child.stderr, secrets), {
					flag: "wx",
					mode: 0o600,
				});
				let prediction: ReturnType<typeof exportSwePrediction> | { status: "agent_failed"; reason: string };
				try {
					// Preserve a safe partial patch too. Runtime completion never substitutes for official grading.
					assertSandboxWorkspaceIdentity(execution.workspaceScope);
					prediction = exportSwePrediction(
						task.swebench,
						prepared.cwd,
						join(dir, "predictions.jsonl"),
						`pi-enhanced-${localStubUrl ? "stub" : "real"}-${context.taskMode}-${plan!.model}`,
					);
					if (prediction.status === "not_run") {
						const exported = JSON.parse(readFileSync(join(dir, "predictions.jsonl"), "utf8"));
						writeFileSync(join(dir, "patch.diff"), exported.model_patch, { flag: "wx", mode: 0o600 });
					}
				} catch (error) {
					prediction = {
						status: "agent_failed",
						reason:
							error instanceof Error && /^(?:SWE|SANDBOX)_[A-Z_]+$/u.test(error.message)
								? error.message
								: "SWE_PATCH_EXPORT_FAILED",
					};
				}
				const events = parseAgentEvents(execution.child.stdout);
				const safetyPath = join(root, "tool-safety.json");
				const safety = existsSync(safetyPath)
					? (JSON.parse(readFileSync(safetyPath, "utf8")) as { events: SafetyEvent[] })
					: { events: [] };
				const { runStatus } = executionOutcome({
					overBudget: false,
					budgetRejected: execution.gatewayStatus.requestsRejected > 0,
					gatewayFailed: execution.gatewayStatus.state !== "ready",
					timedOut: execution.child.timedOut,
					exitCode: execution.child.status,
					verifierPassed: false,
				});
				const result = {
					...prediction,
					// These fields let the existing batch safety checks apply unchanged. No local test claims resolution.
					controlledCell: context.taskMode,
					runStatus,
					patchStatus: "not_run",
					terminationClassification:
						prediction.status === "agent_failed" && prediction.reason !== "empty_patch"
							? "isolation_boundary_stop"
							: classifyTermination({
									events: safety.events,
									lastError: execution.gatewayStatus.lastError,
									gatewayState: execution.gatewayStatus.state,
									rejected: execution.gatewayStatus.requestsRejected,
									runStatus,
									verifierPassed: null,
									auditComplete: audit?.complete === true,
								}),
					sandboxAudit: audit,
					toolFailures: events
						.filter((event) => event.type === "tool_execution_end" && event.isError)
						.map((event) => ({ toolName: event.toolName, result: event.result })),
					fairness: {
						userPromptSha256: inputAudit?.userPromptSha256,
						inputFixtureSha256: prepared.inputFixtureHash,
						inputAudit,
					},
					agentCommit: execFileSync("git", ["rev-parse", "HEAD"], {
						cwd: repositoryRoot,
						encoding: "utf8",
					}).trim(),
					runId: plan!.runId,
					evaluationClass: localStubUrl ? "simulated_provider_real_runner_task" : "real_model_coding_agent_task",
					agentAttempted: true,
					patchExportStatus: prediction.status === "not_run" ? "exported" : "not_exported",
					officialHarnessStatus: "not_run",
					evaluationProtocol: SWE_EVALUATION_PROTOCOL,
					instanceId: task.swebench.issue.instance_id,
					repositoryCommit,
					taskMode: context.taskMode,
					inputFixtureSha256: prepared.inputFixtureHash,
					inputAudit,
					exposedModuleTools: prepared.moduleTools,
					taskSeeded: prepared.seededTaskId !== undefined,
					configuration: {
						provider: plan!.provider,
						model: plan!.model,
						maxRequests: plan!.maxCallsPerTask,
						maxTokens: plan!.maxTokensPerTask,
						maxCostUsd: plan!.maxTotalCostUsd,
						timeoutMs: plan!.timeoutMs,
						memory: false,
						context: false,
						thinking: "off",
					},
					agentCompleted,
					auditComplete: audit?.complete === true,
					durationMs: performance.now() - execution.started,
					gateway: gatewayEvidence(execution.gatewayStatus),
					telemetry: trace,
					resolved: null,
				};
				writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
				results.push(result);
				observedCost = execution.gatewayStatus.actualCostUsd;
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
