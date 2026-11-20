import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSandboxAuditSnapshot } from "../../src/sandbox/audit.ts";
import { assertSandboxWorkspaceIdentity } from "../../src/sandbox/config.ts";
import type { SafetyEvent } from "./controlled-stop.ts";
import { digest } from "./evaluation-identity.ts";
import { executionOutcome, parseAgentEvents, redactEvaluationText } from "./evaluation-policy.ts";
import { gatewayEvidence } from "./gateway-integration.ts";
import { INPUT_AUDIT_FILE } from "./input-audit.ts";
import { classifyTermination } from "./result-classification.ts";
import type { AgentExecution } from "./runner-execution.ts";
import type { PreparedAgent, RunnerContext } from "./runner-preparation.ts";
import { SWE_EVALUATION_PROTOCOL } from "./swe-instance.ts";
import { exportSwePrediction } from "./swe-patch.ts";
import { sweVerificationStatus } from "./swe-test-feedback.ts";

/** Persist SWE evidence and export a safe patch; official grading remains a separate invocation. */
export function collectSweResult(context: RunnerContext, prepared: PreparedAgent, execution: AgentExecution) {
	const { task, root, runOutput, plan, localStubUrl, repositoryRoot } = context;
	if (!task.swebench) throw new Error("SWE_TASK_REQUIRED");
	const { repositoryCommit } = prepared;
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
	const inputAuditPath = join(root, INPUT_AUDIT_FILE);
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
			join(dir, "patch-export-diagnostics.json"),
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
		...(context.swePytest ? {
			localVerification: sweVerificationStatus(root, prediction.status === "not_run" ? prediction.patchSha256 : null),
		} : {}),
		patchExportError: prediction.status === "agent_failed" ? prediction.reason : null,
		patchDiagnostic: existsSync(join(dir, "patch-export-diagnostics.json"))
			? JSON.parse(readFileSync(join(dir, "patch-export-diagnostics.json"), "utf8"))
			: { status: "unavailable", candidatePatchSha256: null, paths: null, contentSaved: false },
		gatewayRejections: execution.gatewayStatus.denials,
		auditStatus: {
			complete: audit?.complete === true,
			integrity: audit?.integrity ?? "invalid_or_missing",
			recoveryState: audit?.recoveryState ?? "unknown",
		},
		terminationClassification: classifyTermination({
			events: safety.events,
			lastError: execution.gatewayStatus.lastError,
			gatewayState: execution.gatewayStatus.state,
			rejected: execution.gatewayStatus.requestsRejected,
			runStatus,
			verifierPassed: null,
			auditComplete: audit?.complete === true,
		}),
		sandboxAudit: audit,
		safetyEvents: safety.events,
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
	const cleanup = {
		runId: plan!.runId,
		cell: context.taskMode,
		...execution.hostLifecycle,
		workspaceSha256: digest(prepared.cwd),
		resultSha256: digest(readFileSync(join(dir, "result.json"), "utf8")),
	};
	return { record: result, observedCost: execution.gatewayStatus.actualCostUsd, cleanup };
}
