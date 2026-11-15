import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { readSandboxAuditSnapshot } from "../../src/sandbox/audit.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import { batchLGroup, batchLReferences } from "./batch-l-profile.ts";
import { longReport, MEMORY_RULE, TASK_STEPS } from "./controlled-cases.ts";
import type { SafetyEvent } from "./controlled-stop.ts";
import { digest } from "./evaluation-identity.ts";
import {
	budgetExceeded,
	classifyExecution,
	type EvaluationPlan,
	executionOutcome,
	parseAgentEvents,
	redactEvaluationText,
	summarizeUsage,
} from "./evaluation-policy.ts";
import { memoryTouchMetadata } from "./evaluation-telemetry.ts";
import { gatewayEvidence } from "./gateway-integration.ts";
import { INPUT_AUDIT_FILE } from "./input-audit.ts";
import { classifyTermination } from "./result-classification.ts";
import type { AgentExecution } from "./runner-execution.ts";
import type { PreparedAgent, RunnerContext } from "./runner-preparation.ts";
/** Interprets completed evidence and persists results; never starts an Agent, model request or container. */
export function collectTaskResult(context: RunnerContext, prepared: PreparedAgent, execution: AgentExecution) {
	const { task, root, runOutput, plan, cell, batchL, switches, comparisonProfile, localStubUrl, authorization, testFeedback } =
		context;
	const {
		cwd,
		inputFixtureHash,
		repositoryCommit,
		agentDir,
		memorySeed,
		seededTaskId,
		taskStateBefore,
		moduleTools,
		prompt,
	} = prepared;
	const { child, gatewayStatus, verification, telemetry, sandboxAuditPath, contextReportPath, started, hostLifecycle } = execution;
	if (!verification) throw new Error("SYNTHETIC_VERIFIER_REQUIRED");
	const apiKeyEnv = plan.apiKeyEnv;
	const events = parseAgentEvents(child.stdout ?? "");
	const agentReportedUsage = summarizeUsage(events);
	const usage = {
		calls: gatewayStatus.requestsStarted,
		tokens: gatewayStatus.actualTotalTokens,
		costUsd: gatewayStatus.actualCostUsd,
	};
	const observedCost = context.observedCost + gatewayStatus.actualCostUsd;
	const referencesUnchanged =
		!batchL ||
		Object.entries(batchLReferences(cell!)).every(
			([name, content]) => existsSync(join(cwd, name)) && readFileSync(join(cwd, name), "utf8") === content,
		);
	if (!referencesUnchanged) {
		verification.passed = false;
		verification.status = "verification_failed";
		verification.errorCode = "EVAL_REFERENCE_CHANGED";
	}
	const verifierPassed = verification.passed;
	const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff"], { cwd, encoding: "utf8" });
	let sandboxAudit: Record<string, unknown>;
	try {
		sandboxAudit = readSandboxAudit(sandboxAuditPath);
	} catch (error) {
		sandboxAudit = {
			evidence: null,
			audit: [],
			complete: false,
			integrity: "invalid_or_missing",
			error: error instanceof Error ? error.message : "EVAL_SANDBOX_AUDIT_INVALID",
		};
	}
	const safetyPath = join(root, "tool-safety.json");
	const toolSafety = existsSync(safetyPath)
		? (JSON.parse(readFileSync(safetyPath, "utf8")) as { events: SafetyEvent[]; deniedCount: number })
		: { events: [], deniedCount: 0 };
	const contextAudit = existsSync(contextReportPath)
		? (JSON.parse(readFileSync(contextReportPath, "utf8")) as Record<string, unknown>)
		: { state: switches.context ? "missing" : "disabled", diagnostics: [] };
	const overBudget = budgetExceeded(usage, observedCost, plan!) || gatewayStatus.requestsRejected > 0;
	const timedOut = child.timedOut || (testFeedback === true && gatewayStatus.lastError === "GATEWAY_UPSTREAM_TIMEOUT");
	const agentFailed = testFeedback && (gatewayStatus.state === "failed_closed" || events.some((event) => {
		const message = event.message as { role?: string; stopReason?: string } | undefined;
		return event.type === "message_end" && message?.role === "assistant" &&
			["error", "aborted", "length"].includes(message.stopReason ?? "");
	}));
	const exitCode = agentFailed ? 1 : child.status;
	const status = classifyExecution({ overBudget, timedOut, exitCode, verifierPassed });
	const outcome = executionOutcome({
		overBudget: budgetExceeded(usage, observedCost, plan!),
		budgetRejected: gatewayStatus.requestsRejected > 0,
		gatewayFailed: gatewayStatus.state === "failed_closed",
		timedOut,
		exitCode,
		verifierPassed,
	});
	const auditComplete = sandboxAudit.complete === true && Boolean(sandboxAudit.evidence);
	let terminationClassification = classifyTermination({
		events: toolSafety.events,
		lastError: gatewayStatus.lastError,
		gatewayState: gatewayStatus.state,
		rejected: gatewayStatus.requestsRejected,
		runStatus: outcome.runStatus,
		verifierPassed,
		auditComplete,
	});
	if (
		["completed", "verification_failed"].includes(terminationClassification) &&
		!["passed", "verification_failed"].includes(verification.status)
	)
		terminationClassification = "sandbox_runtime_error";
	const taskOutput = join(runOutput!, task.id);
	mkdirSync(taskOutput, { recursive: true });
	writeFileSync(join(taskOutput, "patch.diff"), patch);
	writeFileSync(
		join(taskOutput, "agent.stderr.log"),
		redactEvaluationText(child.stderr ?? "", [process.env[apiKeyEnv!]!]),
	);
	const record = {
		taskId: task.id,
		category: task.category,
		experimentClass: localStubUrl ? "simulated_provider_real_runner_task" : "real_model_coding_agent_task",
		repositoryCommit,
		status,
		verifierPassed,
		agentExitCode: child.status,
		timedOut,
		usage,
		agentReportedUsage,
		gateway: gatewayEvidence(gatewayStatus),
		sandboxAudit,
		...(testFeedback ? { hostLifecycle } : {}),
		patchSha256: createHash("sha256").update(patch).digest("hex"),
		durationMs: Number((performance.now() - started).toFixed(3)),
	};
	const moduleToolEvents = events
		.filter((event) => event.type === "tool_execution_end" && moduleTools.includes(String(event.toolName)))
		.map((event) => ({ toolName: event.toolName, isError: event.isError, result: event.result }));
	const moduleToolCalls = events
		.filter((event) => event.type === "tool_execution_start" && moduleTools.includes(String(event.toolName)))
		.map((event) => ({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: JSON.parse(redactEvaluationText(JSON.stringify(event.args ?? {}), [process.env[apiKeyEnv!]!])) as Record<
				string,
				unknown
			>,
		}));
	const fileToolCalls = events
		.filter((event) => event.type === "tool_execution_start")
		.map((event) => ({ toolName: event.toolName, args: event.args }));
	const toolFailures = events
		.filter((event) => event.type === "tool_execution_end" && event.isError)
		.map((event) => ({ toolName: event.toolName, result: event.result }));
	const memoryEvents = moduleToolEvents.filter((event) => event.toolName === "enhanced_memory_search");
	const taskEvents = moduleToolEvents.filter((event) => event.toolName === "enhanced_task_get");
	let taskStateAfter: ReturnType<TaskService["get"]> = null;
	const classifiedRecord = {
		...record,
		...outcome,
		...(cell
			? {
					controlledCell: cell.id,
					moduleSwitches: switches,
					referenceHash: createHash("sha256")
						.update(
							cell.module === "memory"
								? MEMORY_RULE
								: cell.module === "task"
									? JSON.stringify(TASK_STEPS)
									: longReport(),
						)
						.digest("hex"),
					retriesEnabled: false,
					fileToolCalls,
					toolFailures,
				}
			: {}),
		...(context.testFeedback
			? {
					toolTrace: events
						.filter((event) => event.type === "tool_execution_start" || event.type === "tool_execution_end")
						.map(({ type, toolName, toolCallId, isError, result }) => ({
							phase: type === "tool_execution_start" ? "start" : "end",
							toolName,
							toolCallId,
							isError,
							...(type === "tool_execution_end" && toolName === "run_tests"
								? { result: JSON.parse(redactEvaluationText(JSON.stringify(result ?? null), [process.env[apiKeyEnv!]!])) }
								: {}),
						})),
				}
			: {}),
		memorySeed,
		moduleTools,
		moduleToolCalls,
		moduleToolEvents,
		contextEnabled: switches.context,
		contextAudit,
		usageSource: "local_hard_gateway",
	};
	Object.assign(classifiedRecord, {
		terminationClassification,
		agentTermination: outcome.runStatus === "completed" ? "normal" : "abnormal",
		patchGenerated: patch.length > 0,
		toolSafety,
		auditComplete,
		verification,
		...(authorization
			? {
					batchLAuthorization: {
						id: authorization.authorizationId,
						recovery: authorization.recovery,
						batchId: authorization.batchId,
					},
				}
			: {}),
	});
	if (batchL) {
		const inputAuditPath = join(root, INPUT_AUDIT_FILE);
		const inputAudit = existsSync(inputAuditPath)
			? (JSON.parse(readFileSync(inputAuditPath, "utf8")) as Record<string, unknown>)
			: null;
		if (seededTaskId) {
			const service = new TaskService(
				new TaskProvider(createTaskStorageScope(createProjectScope({ cwd, agentDir }), agentDir)),
				20,
			);
			try {
				taskStateAfter = service.get(seededTaskId);
			} finally {
				service.close();
			}
		}
		Object.assign(classifiedRecord, {
			comparisonProfile,
			comparisonGroup: batchLGroup(cell!),
			fairness: {
				userPromptSha256: digest(prompt),
				inputFixtureSha256: inputFixtureHash,
				referencesUnchanged,
				declaredTools: ["read", "grep", "find", "ls", "write", "edit", ...moduleTools],
				inputAudit,
			},
			observations: {
				memory: {
					enabled: switches.memory,
					calls: memoryEvents.length,
					matchedSeedReturned: Boolean(
						memorySeed &&
							memoryEvents.some(
								(event) => !event.isError && JSON.stringify(event.result).includes(`id=${memorySeed.id}`),
							),
					),
				},
				task: {
					enabled: switches.task,
					calls: taskEvents.length,
					planReturned: Boolean(
						seededTaskId &&
							taskEvents.some((event) => !event.isError && JSON.stringify(event.result).includes(seededTaskId!)),
					),
					before: taskStateBefore,
					after: taskStateAfter,
				},
			},
			monetaryAccounting: {
				gatewayCostUsd: usage.costUsd,
				basis: "peak_uncached_conservative_estimate",
				providerInvoiceUsd: null,
				note: "Gateway pricing reserves peak uncached rates; cache/time discounts and invoice deductions are not measured.",
			},
		});
	}
	if (telemetry) {
		const trace = telemetry.finish(gatewayStatus, sandboxAudit);
		const returnedIds = new Set(
			trace.tools.filter((t) => t.phase === "end" && t.status === "returned").map((t) => t.toolCallId),
		);
		const starts = trace.tools.filter((t) => t.phase === "start" && returnedIds.has(t.toolCallId));
		const touches = memoryEvents.map((e) =>
			memoryTouchMetadata(e.result, Boolean(e.isError), memorySeed?.id ?? null),
		);
		const touchState = (key: "runtimeAvailable" | "retrieved" | "matchedSeed") =>
			touches.some((t) => t[key] === true)
				? true
				: touches.length && touches.every((t) => t[key] === false)
					? false
					: null;
		const matchedSeed = touchState("matchedSeed");
		const memoryCalls = trace.tools.filter(
			(t) => t.phase === "start" && t.toolName === "enhanced_memory_search",
		).length;
		const taskCalls = trace.tools.filter((t) => t.phase === "start" && t.toolName === "enhanced_task_get").length;
		const planReturned = Boolean(
			seededTaskId &&
				taskEvents.some(
					(e) => !e.isError && (e.result as { details?: { taskId?: string } }).details?.taskId === seededTaskId,
				),
		);
		const samePlanFileAccessed = starts.some((t) => t.toolName === "read" && t.pathCategory === "same_task_plan");
		const contextTelemetryComplete = !switches.context || contextAudit.telemetryComplete === true;
		Object.assign(classifiedRecord, {
			schemaVersion: 2,
			telemetryVersion: trace.telemetryVersion,
			evaluationAccepted:
				outcome.runStatus === "completed" &&
				verification.passed &&
				auditComplete &&
				trace.complete &&
				contextTelemetryComplete,
			telemetry: {
				...trace,
				contextViews: contextAudit.views ?? [],
				contextTelemetryComplete,
				modules: {
					memory: {
						called: memoryCalls > 0 || memoryEvents.length > 0,
						runtimeAvailable: touchState("runtimeAvailable"),
						retrieved: touchState("retrieved"),
						returnedRecordCount: memoryEvents.map(
							(e) => (e.result as { details?: { count?: number } }).details?.count ?? null,
						),
						matched_seed: matchedSeed,
						same_rule_file_accessed: starts.some(
							(t) => t.toolName === "read" && t.pathCategory === "same_rule_reference",
						),
						patch_satisfies_rule:
							cell?.module === "memory" && ["passed", "verification_failed"].includes(verification.status)
								? verification.passed
								: null,
						sourceCategory: matchedSeed === true ? "fixture_verified_project_rule" : "unknown",
						calls: memoryCalls,
					},
					task: {
						called: taskCalls > 0 || taskEvents.length > 0,
						planReturned,
						same_plan_file_accessed: samePlanFileAccessed,
						duplicatePlanSources: planReturned && samePlanFileAccessed,
						before: batchL ? (taskStateBefore?.task.status ?? null) : null,
						after: taskStateAfter?.task.status ?? null,
						revisionBefore: batchL ? (taskStateBefore?.task.revision ?? null) : null,
						revisionAfter: taskStateAfter?.task.revision ?? null,
						calls: taskCalls,
					},
				},
			},
		});
	}
	writeFileSync(join(taskOutput, "result.json"), `${JSON.stringify(classifiedRecord, null, 2)}\n`);
	writeFileSync(
		join(taskOutput, "sandbox-audit.json"),
		sandboxAudit.integrity === "valid"
			? readFileSync(sandboxAuditPath)
			: `${JSON.stringify(sandboxAudit, null, 2)}\n`,
	);
	writeFileSync(join(taskOutput, "context-audit.json"), `${JSON.stringify(contextAudit, null, 2)}\n`);
	return { record: classifiedRecord, observedCost, overBudget };
}
export function saveRunReport(
	options: {
		plan?: EvaluationPlan;
		execute: boolean;
		localStubUrl?: string;
		variant: string;
		condition: string;
		telemetryEnabled: boolean;
		packageRoot: string;
		runOutput?: string;
		batchL: boolean;
		swebench?: boolean;
		testFeedback?: boolean;
	},
	results: Record<string, unknown>[],
	observedCost: number,
) {
	const { plan, execute, localStubUrl, variant, condition, telemetryEnabled, packageRoot, runOutput, batchL } =
		options;
	const provider = plan?.provider,
		model = plan?.model;
	const ran = results.filter((item) => item.agentAttempted === true || item.status !== "not_run");
	const outcomeSummary = {
		patchPassed: ran.filter((item) => item.patchStatus === "passed").length,
		normallyCompleted: ran.filter((item) => item.agentCompleted === true || item.runStatus === "completed").length,
		budgetStopped: ran.filter((item) => item.runStatus === "budget_stopped").length,
	};
	const report = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		evaluationClass: localStubUrl ? "simulated_provider_real_runner_task" : "real_model_coding_agent_task",
		runId: plan?.runId ?? null,
		variant,
		condition,
		model: execute ? { provider, model } : null,
		authorization: localStubUrl ? "local_stub_only" : execute ? "explicit" : "absent",
		sandbox: plan
			? {
					mode: "docker-file-tools",
					image: plan.sandboxImage,
					tools: ["read", "grep", "find", "ls", "write", "edit", ...(options.testFeedback ? ["run_tests"] : [])],
					network: "none",
					failClosed: true,
				}
			: null,
		limits: plan
			? {
					maxTotalCostUsd: plan.maxTotalCostUsd,
					maxTasks: plan.maxTasks,
					maxTokensPerTask: plan.maxTokensPerTask,
					maxCallsPerTask: plan.maxCallsPerTask,
					timeoutMs: plan.timeoutMs,
					concurrency: plan.concurrency,
					budgetEnforcement: plan.budgetEnforcement,
				}
			: null,
		summary: {
			total: results.length,
			run: ran.length,
			passed: ran.filter((item) => item.status === "passed").length,
			notRun: results.length - ran.length,
			observedCostUsd: execute ? observedCost : 0,
		},
		results,
	};
	Object.assign(report.summary, outcomeSummary);
	if (telemetryEnabled)
		Object.assign(report.summary, {
			evaluationPassed: ran.filter((item) => item.evaluationAccepted === true).length,
		});
	if (!localStubUrl && !batchL && !options.swebench && !options.testFeedback)
		writeFileSync(join(packageRoot, "docs", "p5-real-model-results.json"), `${JSON.stringify(report, null, 2)}\n`);
	if (runOutput) writeFileSync(join(runOutput, "run.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	return report.summary;
}
function readSandboxAudit(path: string): Record<string, unknown> {
	if (!existsSync(path)) throw new Error("EVAL_SANDBOX_AUDIT_MISSING");
	return readSandboxAuditSnapshot(path);
}
