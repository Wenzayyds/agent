import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

interface Result {
	verifierPassed: boolean;
	runStatus: string;
	status: string;
	durationMs: number;
	auditComplete: boolean;
	terminationClassification: string;
	resumedTask?: { task: { status: string }; lastCheckpoint?: { checkpointId: string } };
	v3Evaluation: {
		fixtureSha256: string;
		model: { requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
		context?: ContextReport;
	};
}
interface ContextReport {
	diagnostics?: { offloadedToolResults: number; truncatedToolResults: number }[];
	restores?: { status: string }[];
}
interface Telemetry {
	complete: boolean;
	requests: { upstreamForwarded: boolean; reservationDiagnostics?: { requestBodyBytes: number } }[];
	tools: { phase: string; status: string; readClassification: string }[];
}

function read<T>(path: string): T | undefined {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined;
}

/** Summarizes persisted Runner evidence, keeping unsupported and unexecuted cells separate. */
export function writeV3Matrix(root: string, variants: readonly string[]) {
	const scenarios = ["long-output", "memory", "recovery"] as const;
	const longRequestBytes = read<Record<string, number[]>>(join(root, "ablation", "stub-request-bytes.json"));
	const rows = scenarios.flatMap((scenario) => variants.map((variant) => {
		const recovery = scenario === "recovery";
		const memory = scenario === "memory";
		if (recovery && !["task-only", "full"].includes(variant))
			return { scenario, variant, status: "unsupported", reason: "task-manager-disabled", report: null, metrics: null };
		const directory = recovery ? join(root, "joint-recovery", "joint_v3_" + variant)
			: memory ? join(root, "memory-matrix", variant, "v3_eval_" + variant)
				: join(root, "ablation", "v3_eval_" + variant);
		const reportPath = join(directory, "run.json");
		const result = read<{ results: Result[] }>(reportPath)?.results[0];
		if (!result) {
			const attempted = existsSync(directory);
			return { scenario, variant, status: attempted ? "failed" : "skipped",
				reason: attempted ? "runner-did-not-produce-result" : "case-not-started",
				report: relative(root, reportPath), metrics: null };
		}
		const taskDir = join(directory, scenario === "long-output" ? "controlled-long-report" : "memory-guided-regression");
		const telemetry = ["evaluation-telemetry.json", ...(recovery ? ["evaluation-telemetry-resumed.json"] : [])]
			.map((name) => read<Telemetry>(join(taskDir, name))).filter((value) => value !== undefined);
		const tools = telemetry.flatMap((item) => item.tools).filter(({ phase }) => phase === "end");
		const providers = telemetry.flatMap((item) => item.requests).filter(({ upstreamForwarded }) => upstreamForwarded);
		const model = result.v3Evaluation.model;
		const trajectory = recovery ? read<{
			repeatedWrites: number; validMemoryHits: number; elapsedMs: number; requestBytes: number[];
			boundary: { checkpoint: { completedWrites: number } };
		}>(join(directory, "recovery-trajectory.json")) : undefined;
		const memoryEvidence = memory ? read<{ validHits: number; staleHits: number | null; isolated: boolean | null; stubRequestBytes: number[] }>(
			join(directory, "memory-evidence.json")) : undefined;
		const contextReports = [result.v3Evaluation.context, recovery
			? read<ContextReport>(join(directory, "private", "previous-context-audit.json")) : undefined];
		const offloads = Math.max(0, ...contextReports.flatMap((value) => value?.diagnostics ?? [])
			.map(({ offloadedToolResults }) => offloadedToolResults));
		const restores = contextReports.flatMap((value) => value?.restores ?? []).filter(({ status }) => status === "restored").length;
		const stubRequestBytes = trajectory?.requestBytes ?? memoryEvidence?.stubRequestBytes ?? longRequestBytes?.[variant];
		const trims = Math.max(0, ...contextReports.flatMap((value) => value?.diagnostics ?? [])
			.map(({ truncatedToolResults }) => truncatedToolResults));
		const complete = stubRequestBytes?.length === model.requests && telemetry.length === (recovery ? 2 : 1) && telemetry.every(({ complete }) => complete) && providers.length === model.requests &&
			(!memory || Boolean(memoryEvidence)) &&
			(!recovery || (trajectory !== undefined && result.resumedTask?.task.status === "completed" &&
				(variant !== "full" || (offloads > 0 && restores === 1 && trajectory.validMemoryHits > 0))));
		const passed = result.verifierPassed && result.runStatus === "completed" && result.auditComplete && complete;
		return {
			scenario, variant, status: passed ? "passed" : "failed",
			reason: passed ? null : !complete ? "insufficient-scenario-evidence" : result.terminationClassification || result.status,
			report: relative(root, reportPath),
			log: relative(root, join(taskDir, "agent.stderr.log")),
			fixtureSha256: result.v3Evaluation.fixtureSha256,
			metrics: {
				independentVerification: result.verifierPassed, agentEndState: result.runStatus, auditComplete: result.auditComplete,
				taskEndState: result.resumedTask?.task.status ?? null,
				requests: model.requests, stubRequestBytes: stubRequestBytes ?? [],
				gatewayRequestBytes: providers.map(({ reservationDiagnostics }) => reservationDiagnostics?.requestBodyBytes ?? null),
				inputTokens: model.inputTokens, outputTokens: model.outputTokens, tokenSource: "stub_simulated",
				toolCalls: tools.length, toolFailures: tools.filter(({ status }) => status === "error").length,
				contextOffloadsMaxPerRequest: offloads, contextTrimsMaxPerRequest: trims, contextRestores: restores,
				memoryVerifiedHits: memoryEvidence?.validHits ?? trajectory?.validMemoryHits ?? 0,
				memoryStaleHits: memoryEvidence?.staleHits ?? null, memoryScopeIsolated: memoryEvidence?.isolated ?? null,
				taskCheckpoints: (trajectory ? 1 : 0) + (result.resumedTask?.lastCheckpoint ? 1 : 0),
				taskRestores: trajectory ? 1 : 0,
				repeatedWrites: trajectory?.repeatedWrites ?? null,
				elapsedMs: trajectory?.elapsedMs ?? result.durationMs,
				estimatedUsd: model.estimatedCostUsd, costSource: "gateway_rates_applied_to_stub_usage", apiUsd: 0,
			},
		};
	}));
	for (const scenario of scenarios) {
		const comparable = rows.filter((row) => row.scenario === scenario && row.fixtureSha256);
		if (new Set(comparable.map(({ fixtureSha256 }) => fixtureSha256)).size > 1)
			for (const row of comparable) {
				row.status = "failed";
				row.reason = "inconsistent-initial-fixture";
			}
	}
	writeFileSync(join(root, "matrix.json"), JSON.stringify({ mode: "stub", rows }, null, 2) + "\n");
	const title = [
		"# V3 Stub ablation", "",
		"Tokens are simulated. USD estimates apply the local Gateway rates to Stub usage.", "",
		"| Scenario | Variant | Status | Docker | Requests | Input / Output | Second request bytes | Offloads / restores | Verified hits | Reason |",
		"| --- | --- | --- | --- | ---: | --- | ---: | --- | ---: | --- |",
	];
	const table = rows.map(({ scenario, variant, status, reason, metrics: m }) =>
		`| ${scenario} | ${variant} | ${status} | ${m?.independentVerification ?? "-"} | ${m?.requests ?? "-"} | ${m ? m.inputTokens + " / " + m.outputTokens : "-"} | ${m?.stubRequestBytes[1] ?? "-"} | ${m ? m.contextOffloadsMaxPerRequest + " / " + m.contextRestores : "-"} | ${m?.memoryVerifiedHits ?? "-"} | ${reason ?? "-"} |`);
	writeFileSync(join(root, "matrix.md"), [...title, ...table, ""].join("\n"));
	return rows;
}
