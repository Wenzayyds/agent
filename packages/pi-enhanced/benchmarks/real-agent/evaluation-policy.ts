export interface EvaluationPlan {
	runId: string;
	provider: string;
	model: string;
	apiKeyEnv: string;
	maxTotalCostUsd: number;
	maxTasks: number;
	maxTokensPerTask: number;
	maxCallsPerTask: number;
	timeoutMs: number;
	concurrency: 1;
	budgetEnforcement: "external_gateway" | "local_hard_gateway";
	outputDir: string;
	sandboxImage: string;
}

export function buildEvaluationPlan(input: Record<string, string | undefined>, env: NodeJS.ProcessEnv): EvaluationPlan {
	const required = [
		"runId",
		"provider",
		"model",
		"apiKeyEnv",
		"maxTotalCostUsd",
		"maxTasks",
		"maxTokensPerTask",
		"maxCallsPerTask",
		"timeoutMs",
		"concurrency",
		"budgetEnforcement",
		"outputDir",
		"sandboxImage",
	] as const;
	for (const field of required) if (!input[field]) throw new Error(`EVAL_GATE_MISSING:${field}`);
	if (env.PI_ENHANCED_REAL_MODEL_EVAL !== "1") throw new Error("EVAL_GATE_UNAUTHORIZED");
	if (input.budgetEnforcement === "external_gateway" && env.PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED !== "1") {
		throw new Error("EVAL_GATE_BUDGET_NOT_ENFORCED");
	}
	if (!/^[a-z0-9][a-z0-9_-]{7,79}$/u.test(input.runId!)) throw new Error("EVAL_GATE_INVALID:runId");
	if (!/^[A-Z][A-Z0-9_]{2,79}$/u.test(input.apiKeyEnv!)) throw new Error("EVAL_GATE_INVALID:apiKeyEnv");
	if (!env[input.apiKeyEnv!]) throw new Error("EVAL_GATE_KEY_UNAVAILABLE");
	if (!/^sha256:[a-f0-9]{64}$/u.test(input.sandboxImage!)) throw new Error("EVAL_GATE_INVALID:sandboxImage");
	const numeric = (field: keyof EvaluationPlan, minimum: number, maximum: number): number => {
		const value = Number(input[field]);
		if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`EVAL_GATE_INVALID:${field}`);
		return value;
	};
	const concurrency = numeric("concurrency", 1, 1);
	if (input.budgetEnforcement !== "external_gateway" && input.budgetEnforcement !== "local_hard_gateway") {
		throw new Error("EVAL_GATE_INVALID:budgetEnforcement");
	}
	if (
		input.budgetEnforcement === "local_hard_gateway" &&
		(input.provider !== "deepseek" || !["deepseek-flash", "deepseek-v4-pro"].includes(input.model ?? ""))
	) {
		throw new Error("EVAL_GATE_LOCAL_GATEWAY_MODEL_UNSUPPORTED");
	}
	return {
		runId: input.runId!,
		provider: input.provider!,
		model: input.model!,
		apiKeyEnv: input.apiKeyEnv!,
		maxTotalCostUsd: numeric("maxTotalCostUsd", 0.01, 100),
		maxTasks: Math.trunc(numeric("maxTasks", 1, 50)),
		maxTokensPerTask: Math.trunc(numeric("maxTokensPerTask", 1, 2_000_000)),
		maxCallsPerTask: Math.trunc(numeric("maxCallsPerTask", 1, 100)),
		timeoutMs: Math.trunc(numeric("timeoutMs", 1_000, 900_000)),
		concurrency: concurrency as 1,
		budgetEnforcement: input.budgetEnforcement,
		outputDir: input.outputDir!,
		sandboxImage: input.sandboxImage!,
	};
}

export function preflightView(input: Record<string, string | undefined>, taskCount: number, singleFileTestFeedback = false): Record<string, unknown> {
	return {
		mode: "preflight",
		authorized: false,
		provider: input.provider ?? null,
		model: input.model ?? null,
		apiKeyEnv: input.apiKeyEnv ? "[configured-name-not-read]" : null,
		requestedTasks: Math.min(Number(input.maxTasks) || taskCount, taskCount),
		maxPotentialTokens: (Number(input.maxTasks) || taskCount) * (Number(input.maxTokensPerTask) || 0),
		maxTotalCostUsd: Number(input.maxTotalCostUsd) || null,
		maxCallsPerTask: Number(input.maxCallsPerTask) || null,
		timeoutMs: Number(input.timeoutMs) || null,
		concurrency: Number(input.concurrency) || 1,
		outputDir: input.outputDir ?? null,
		tools: ["read", "grep", "find", "ls", "write", "edit", ...(singleFileTestFeedback ? ["run_tests"] : [])],
		shell: false,
		sandbox: {
			mode: "docker-file-tools",
			image: input.sandboxImage ?? null,
			network: "none",
			readOnlyRoot: true,
			temporaryWorkspaceOnly: true,
			failClosed: true,
		},
		modelNetwork:
			input.budgetEnforcement === "local_hard_gateway"
				? "host provider channel forced through the loopback hard-budget gateway"
				: "host provider channel through separately approved external budget gateway",
	};
}

export function redactEvaluationText(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[REDACTED]");
	return result.replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._-]{8,}\b/giu, "[REDACTED]");
}

/** Public Pi JSONL events only; malformed lines and non-object values are ignored. */
export function parseAgentEvents(text: string): Record<string, unknown>[] {
	return text.split(/\r?\n/u).flatMap((line) => {
		try {
			const event = record(JSON.parse(line));
			return event ? [event] : [];
		} catch {
			return [];
		}
	});
}

export function summarizeUsage(events: string | readonly Record<string, unknown>[]): {
	calls: number;
	tokens: number;
	costUsd: number | null;
} {
	let calls = 0;
	let tokens = 0;
	let cost = 0;
	let hasCost = false;
	for (const value of typeof events === "string" ? parseAgentEvents(events) : events) {
		// Only final assistant messages are billable turns; update/turn_end/agent_end repeat them.
		const message = record(value.message);
		if (value.type !== "message_end" || message?.role !== "assistant") continue;
		const usage = record(message.usage);
		if (!usage || message.stopReason === "error" || message.stopReason === "aborted") continue;
		calls += 1;
		tokens += number(usage.totalTokens) ?? (number(usage.input) ?? 0) + (number(usage.output) ?? 0);
		const costObject = record(usage.cost);
		const totalCost = costObject ? number(costObject.total) : undefined;
		if (totalCost !== undefined) {
			cost += totalCost;
			hasCost = true;
		}
	}
	return { calls, tokens, costUsd: hasCost ? cost : null };
}
export function budgetExceeded(
	usage: { calls: number; tokens: number },
	observedCostUsd: number,
	plan: Pick<EvaluationPlan, "maxCallsPerTask" | "maxTokensPerTask" | "maxTotalCostUsd">,
): boolean {
	return (
		usage.calls > plan.maxCallsPerTask ||
		usage.tokens > plan.maxTokensPerTask ||
		observedCostUsd > plan.maxTotalCostUsd
	);
}
export function classifyExecution(input: {
	overBudget: boolean;
	timedOut: boolean;
	exitCode: number | null;
	verifierPassed: boolean;
}): "budget_exceeded" | "timeout" | "agent_error" | "passed" | "failed" {
	if (input.overBudget) return "budget_exceeded";
	if (input.timedOut) return "timeout";
	if (input.exitCode !== 0) return "agent_error";
	return input.verifierPassed ? "passed" : "failed";
}
export function executionOutcome(input: {
	overBudget: boolean;
	budgetRejected: boolean;
	gatewayFailed?: boolean;
	timedOut: boolean;
	exitCode: number | null;
	verifierPassed: boolean;
}): {
	patchStatus: "passed" | "failed";
	runStatus: "completed" | "budget_stopped" | "budget_exceeded" | "gateway_error" | "timeout" | "agent_error";
} {
	return {
		patchStatus: input.verifierPassed ? "passed" : "failed",
		runStatus: input.overBudget
			? "budget_exceeded"
			: input.timedOut
				? "timeout"
				: input.gatewayFailed
					? "gateway_error"
					: input.budgetRejected
						? "budget_stopped"
						: input.exitCode !== 0
							? "agent_error"
							: "completed",
	};
}
function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
