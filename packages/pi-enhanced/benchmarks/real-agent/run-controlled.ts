import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { claimBatchLAuthorization, loadBatchLAuthorization } from "./batch-l-authorization.ts";
import {
	BATCH_L_LIMITS,
	BATCH_L_PROFILE,
	digest,
	TASK_PAIR_CELLS,
	TASK_PAIR_CONFIGURATION,
	TASK_PAIR_LIMITS,
	TASK_PAIR_PROFILE,
} from "./batch-l-profile.ts";
import {
	CONTROLLED_CELLS,
	CONTROLLED_IMAGE,
	CONTROLLED_LIMITS as LEGACY_CONTROLLED_LIMITS,
} from "./controlled-cases.ts";
import { type ControlledResult, controlledStopReason, verifyControlledCi } from "./controlled-policy.ts";
import { NEXT_EVALUATION_PROFILE } from "./evaluation-telemetry.ts";
import {
	claimTaskPairAuthorization,
	loadTaskPairAuthorization,
	readTaskPairInput,
	type TaskPairInput,
} from "./task-pair-authorization.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../../..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const execute = process.argv.includes("--execute");
const batchId = argument("--batch-id");
const stub = argument("--local-stub-url");
const offlinePolicyPath = argument("--offline-denial-policy");
const comparisonProfile = argument("--comparison-profile");
const taskPair = comparisonProfile === TASK_PAIR_PROFILE;
const CONTROLLED_LIMITS = taskPair
	? TASK_PAIR_LIMITS
	: comparisonProfile === BATCH_L_PROFILE || comparisonProfile === NEXT_EVALUATION_PROFILE
		? BATCH_L_LIMITS
		: LEGACY_CONTROLLED_LIMITS;
if (comparisonProfile && ![BATCH_L_PROFILE, NEXT_EVALUATION_PROFILE, TASK_PAIR_PROFILE].includes(comparisonProfile))
	throw new Error("EVAL_UNKNOWN_COMPARISON_PROFILE");
if (comparisonProfile === NEXT_EVALUATION_PROFILE && execute && !stub)
	throw new Error("BATCH_N_SEPARATE_AUTHORIZATION_REQUIRED");
const authorizationPath = argument("--batch-l-authorization");
const taskPairPath = argument("--task-pair-authorization");
const taskPairExpected = argument("--task-pair-expected-input");
const ciPath = argument("--ci-evidence");
if (taskPair && (authorizationPath || offlinePolicyPath)) throw new Error("TASK_PAIR_STRICT_STUB_ONLY");
if (taskPairPath && (!taskPair || stub)) throw new Error("TASK_PAIR_AUTHORIZATION_SCOPE_INVALID");
if (taskPairExpected && (!taskPair || !stub)) throw new Error("TASK_PAIR_EXPECTED_INPUT_SCOPE_INVALID");
const taskPairAuthorization =
	taskPair && execute && !stub
		? loadTaskPairAuthorization(taskPairPath, repositoryRoot, commit, batchId ?? "", ciPath)
		: undefined;
const telemetryEnabled = taskPair || process.argv.includes("--evaluation-telemetry");
const authorization =
	comparisonProfile && !taskPair && execute && !stub
		? loadBatchLAuthorization(authorizationPath, repositoryRoot, commit, batchId ?? "")
		: undefined;
if (offlinePolicyPath && !stub) throw new Error("OFFLINE_DENIAL_POLICY_UNTRUSTED");
if (!execute) {
	process.stdout.write(
		JSON.stringify({
			status: "not_run",
			commit,
			limits: CONTROLLED_LIMITS,
			cells: taskPair ? TASK_PAIR_CELLS : CONTROLLED_CELLS,
			...(taskPair
				? { configuration: TASK_PAIR_CONFIGURATION, configurationSha256: digest(TASK_PAIR_CONFIGURATION) }
				: {}),
		}),
	);
	process.exit(0);
}
if (!batchId || !/^[a-z0-9][a-z0-9_]{7,39}$/u.test(batchId)) throw new Error("CONTROLLED_BATCH_ID_INVALID");
if (process.env.PI_ENHANCED_REAL_MODEL_EVAL !== "1") throw new Error("CONTROLLED_NOT_AUTHORIZED");
if (stub) {
	const url = new URL(stub);
	if (
		process.env.PI_ENHANCED_LOCAL_STUB_EVAL !== "1" ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		!url.port
	)
		throw new Error("CONTROLLED_STUB_NOT_AUTHORIZED");
} else {
	if (!ciPath) throw new Error("CONTROLLED_CI_REQUIRED");
	if (!taskPairAuthorization) verifyControlledCi(JSON.parse(readFileSync(ciPath, "utf8")), commit);
	if (
		execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		}).trim()
	)
		throw new Error("CONTROLLED_TRACKED_WORKTREE_DIRTY");
}
const outputBase = resolve(argument("--output-dir") ?? join(repositoryRoot, "packages/pi-enhanced/evaluation-output"));
if (taskPairAuthorization && realpathSync(outputBase) !== taskPairAuthorization.outputBase)
	throw new Error("TASK_PAIR_OUTPUT_MISMATCH");
mkdirSync(outputBase, { recursive: true });
const batchDir = join(outputBase, batchId);
// Exclusive directory creation makes a started or interrupted batch non-resumable.
mkdirSync(batchDir);
if (authorization) claimBatchLAuthorization(authorizationPath!, authorization, batchDir);
if (taskPairAuthorization) claimTaskPairAuthorization(taskPairPath!, taskPairAuthorization);
const specs = taskPair
	? TASK_PAIR_CELLS
	: comparisonProfile
		? [
				CONTROLLED_CELLS[0],
				CONTROLLED_CELLS[1],
				CONTROLLED_CELLS[3],
				CONTROLLED_CELLS[2],
				CONTROLLED_CELLS[5],
				CONTROLLED_CELLS[4],
			]
		: CONTROLLED_CELLS;
const cells: Array<{
	id: string;
	status: string;
	resultStatus: string;
	endToEndMs?: number;
	terminationClassification?: string;
	result?: ControlledResult;
}> = specs.map(({ id }) => ({ id, status: "not_run", resultStatus: "not_run" }));
let stoppedReason: string | null = null;
let reservedMaximumUsd = 0;
let firstPairInput: TaskPairInput | undefined;
const save = () =>
	writeFileSync(
		join(batchDir, "batch.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				batchId,
				commit,
				comparisonProfile,
				authorization: taskPairAuthorization
					? { id: taskPairAuthorization.authorizationId, recovery: "strict" }
					: authorization
						? { id: authorization.authorizationId, recovery: authorization.recovery }
						: undefined,
				evaluationClass: stub ? "simulated_provider_real_runner_task" : "real_model_coding_agent_task",
				limits: CONTROLLED_LIMITS,
				reservedMaximumUsd,
				stoppedReason,
				cells,
			},
			null,
			2,
		),
	);
save();
for (let index = 0; index < specs.length; index++) {
	const spec = specs[index]!;
	const state = cells[index]!;
	if (reservedMaximumUsd + CONTROLLED_LIMITS.maxCostUsd > CONTROLLED_LIMITS.maxBatchCostUsd + Number.EPSILON) {
		stoppedReason = "batch_budget_reservation";
		save();
		break;
	}
	reservedMaximumUsd += CONTROLLED_LIMITS.maxCostUsd;
	state.status = "started";
	state.resultStatus = "run";
	save();
	const runId = `${batchId}_${spec.id}`;
	const args = [
		"--experimental-strip-types",
		join(here, "run-real-agent.ts"),
		"--execute",
		"--controlled-cell",
		spec.id,
		"--run-id",
		runId,
		"--provider",
		"deepseek",
		"--model",
		"deepseek-flash",
		"--api-key-env",
		stub ? "MOCK_PROVIDER_KEY" : "DEEPSEEK_API_KEY",
		"--max-total-cost-usd",
		String(CONTROLLED_LIMITS.maxCostUsd),
		"--max-tasks",
		"1",
		"--max-tokens-per-task",
		String(CONTROLLED_LIMITS.maxTokens),
		"--max-calls-per-task",
		String(CONTROLLED_LIMITS.maxRequests),
		"--timeout-ms",
		String(CONTROLLED_LIMITS.timeoutMs),
		"--concurrency",
		"1",
		"--budget-enforcement",
		"local_hard_gateway",
		"--output-dir",
		batchDir,
		"--sandbox-image",
		CONTROLLED_IMAGE,
		...(stub ? ["--local-stub-url", stub] : []),
	];
	if (offlinePolicyPath) args.push("--offline-denial-policy", offlinePolicyPath);
	if (telemetryEnabled) args.push("--evaluation-telemetry");
	if (comparisonProfile) args.push("--comparison-profile", comparisonProfile);
	if (authorization) args.push("--batch-l-authorization", authorizationPath!, "--authorization-batch-id", batchId!);
	if (taskPairAuthorization)
		args.push(
			"--task-pair-authorization",
			taskPairPath!,
			"--authorization-batch-id",
			batchId!,
			"--ci-evidence",
			ciPath!,
		);
	if (taskPairExpected) args.push("--task-pair-expected-input", taskPairExpected);
	const cellStarted = performance.now();
	const child = spawnSync(process.execPath, args, {
		cwd: repositoryRoot,
		env: process.env,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 210_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	state.endToEndMs = Number((performance.now() - cellStarted).toFixed(3));
	if (child.status !== 0 || child.error) {
		state.status = "execution_error";
		state.resultStatus = "stopped";
		state.terminationClassification = /SANDBOX_/u.test(child.stderr?.toString() ?? "")
			? "sandbox_runtime_error"
			: "agent_execution_error";
		stoppedReason = /TASK_PAIR_INPUT_/u.test(child.stderr?.toString() ?? "")
			? "task_pair_input_admission_failed"
			: "runner_or_isolation_failure";
		save();
		break;
	}
	try {
		const report = JSON.parse(readFileSync(join(batchDir, runId, "run.json"), "utf8")) as {
			results: ControlledResult[];
		};
		const result = report.results[0];
		if (!result || result.controlledCell !== spec.id) throw new Error("CONTROLLED_RESULT_MISMATCH");
		state.result = result;
		state.terminationClassification = String(result.terminationClassification ?? "legacy_result");
		state.status = "run";
		stoppedReason = controlledStopReason(result, CONTROLLED_LIMITS);
		if (telemetryEnabled) {
			const trace = result.telemetry as { complete?: boolean; contextTelemetryComplete?: boolean } | undefined;
			if (!stoppedReason && (!trace?.complete || trace.contextTelemetryComplete === false))
				stoppedReason = "evaluation_telemetry_incomplete";
		}
		if (taskPair) {
			const admission = JSON.parse(readFileSync(join(batchDir, runId, spec.taskId, "input-admission.json"), "utf8"));
			const input = readTaskPairInput(admission.input);
			if (firstPairInput && !isDeepStrictEqual(firstPairInput, input))
				stoppedReason = "task_pair_input_admission_failed";
			firstPairInput ??= input;
		}
		if (comparisonProfile) {
			const own = result.fairness as {
				userPromptSha256: string;
				inputFixtureSha256: string;
				inputAudit: { toolSchemaSha256: string; canonicalSystemPromptSha256: string } | null;
			};
			if (!own?.inputAudit) stoppedReason = "comparison_input_audit_missing";
			const peerResult = cells
				.slice(0, index)
				.find((cell) => specs.find((s) => s.id === cell.id)?.module === spec.module)?.result;
			const peer = peerResult?.fairness as typeof own | undefined;
			if (
				peer &&
				(peer.userPromptSha256 !== own.userPromptSha256 ||
					peer.inputFixtureSha256 !== own.inputFixtureSha256 ||
					peer.inputAudit?.toolSchemaSha256 !== own.inputAudit?.toolSchemaSha256 ||
					peer.inputAudit?.canonicalSystemPromptSha256 !== own.inputAudit?.canonicalSystemPromptSha256)
			)
				stoppedReason = "comparison_fairness_mismatch";
			if (
				(comparisonProfile === NEXT_EVALUATION_PROFILE || taskPair) &&
				peerResult &&
				peerResult.repositoryCommit !== result.repositoryCommit
			)
				stoppedReason = "comparison_fixture_commit_mismatch";
		}
		state.resultStatus = stoppedReason ? "stopped" : result.patchStatus === "passed" ? "passed" : "failed";
	} catch {
		state.status = "evidence_error";
		state.resultStatus = "stopped";
		stoppedReason = "result_evidence_invalid";
	}
	save();
	if (stoppedReason) break;
}
process.stdout.write(
	JSON.stringify({
		batchId,
		started: cells.filter((c) => c.status !== "not_run").length,
		stoppedReason,
		report: join(batchDir, "batch.json"),
	}),
);

function argument(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i < 0 ? undefined : process.argv[i + 1];
}
