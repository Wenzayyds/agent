import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statfsSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { digestBytes as sha } from "./evaluation-identity.ts";
import { runSweGit as git } from "./swe-git.ts";
import { publicInstance, readSweManifest, SWE_EVALUATION_PROTOCOL } from "./swe-instance.ts";

export const SWE_HARNESS_COMMIT = "726c5461e2ef52d83cf1ea2107870a8bb3328d57";
export const SWE_DATA_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a";
const SWE_MODEL_NAME = /^(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/u;

export function officialOutcome(report: unknown, id: string, timeout = false) {
	if (timeout) return "timeout";
	if (!report) return "not_run";
	if (typeof report !== "object") throw new Error("SWE_REPORT_INVALID");
	const value = report as Record<string, unknown>;
	const categories = [
		["resolved_ids", "resolved"],
		["unresolved_ids", "unresolved"],
		["error_ids", "evaluation_error"],
		["incomplete_ids", "incomplete"],
		["empty_patch_ids", "incomplete"],
	] as const;
	const found = categories.filter(([key]) => {
		const ids = value[key];
		if (ids === undefined && (key === "incomplete_ids" || key === "empty_patch_ids")) return false;
		if (!Array.isArray(ids) || ids.some((item) => typeof item !== "string")) throw new Error("SWE_REPORT_INVALID");
		return ids.includes(id);
	});
	if (found.length > 1) throw new Error("SWE_REPORT_CONFLICT");
	const reasons = value.failure_reasons;
	const reason = reasons && typeof reasons === "object" ? (reasons as Record<string, unknown>)[id] : null;
	if (found[0]?.[1] !== "resolved" && typeof reason === "string" && /timeout|timed_out/iu.test(reason))
		return "timeout";
	if (found[0]?.[1] === "unresolved" && Array.isArray(value.infra_failure_ids) && value.infra_failure_ids.includes(id))
		return "evaluation_error";
	return found[0]?.[1] ?? "not_run";
}

export function readOfficialOutcome(
	reportPath: string,
	id: string,
	failure: "timeout" | "evaluation_error" | null,
	instanceDir?: string,
) {
	if (failure) return failure;
	try {
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		const status = report ? officialOutcome(report, id) : "evaluation_error";
		if (!instanceDir) return status;
		if (status === "evaluation_error" && report?.error_ids?.includes(id)) {
			// v4.1 records a test timeout under error_ids and appends this marker to the test output.
			const path = join(instanceDir, "test_output.txt");
			if (!existsSync(path)) return status;
			const fd = openSync(path, "r");
			try {
				const size = fstatSync(fd).size;
				const tail = Buffer.alloc(Math.min(size, 256));
				const length = readSync(fd, tail, 0, tail.length, size - tail.length);
				if (/\r?\n\r?\nTimeout error: \d+ seconds exceeded\.(?:\r?\n)?$/u.test(tail.toString("utf8", 0, length)))
					return "timeout";
			} finally {
				closeSync(fd);
			}
		}
		if (status === "resolved" || status === "unresolved") {
			const instance = JSON.parse(readFileSync(join(instanceDir, "report.json"), "utf8"))?.[id];
			if (instance?.patch_successfully_applied !== true || instance.resolved !== (status === "resolved"))
				return "evaluation_error";
		}
		return status === "not_run" ? "incomplete" : status;
	} catch {
		return "evaluation_error";
	}
}

/** Join only a matching exported patch to official scoring; an Agent exit code is never a benchmark score. */
export function assessSwePrediction(
	agent: Record<string, unknown>,
	prediction: { instance_id: string; model_patch: string },
	status: string,
) {
	if (
		agent.instanceId !== prediction.instance_id ||
		agent.patchExportStatus !== "exported" ||
		agent.patchSha256 !== sha(prediction.model_patch) ||
		!["resolved", "unresolved", "incomplete", "not_run", "timeout", "evaluation_error", "environment_blocked"].includes(status)
	)
		throw new Error("SWE_AGENT_PREDICTION_BINDING_INVALID");
	return {
		instanceId: agent.instanceId,
		agentCommit: agent.agentCommit ?? "unknown",
		runId: agent.runId ?? "unknown",
		taskMode: agent.taskMode,
		evaluationClass: agent.evaluationClass,
		evaluationProtocol: SWE_EVALUATION_PROTOCOL,
		patchSha256: agent.patchSha256,
		agentCompleted: agent.agentCompleted === true,
		auditComplete: agent.auditComplete === true,
		officialHarnessStatus: status,
		resolved: status === "resolved" ? true : status === "unresolved" ? false : null,
		evaluationAccepted: status === "resolved" && agent.agentCompleted === true && agent.auditComplete === true,
	};
}

/** One isolated invocation. The operator passes a fixed evaluator-only data file and records preflight separately. */
export function harnessCommand(input: {
	id: string;
	datasetPath: string;
	prediction: string;
	predictionHash: string;
	modelName?: string;
}) {
	if (
		!isAbsolute(input.datasetPath) ||
		!/^[a-zA-Z0-9_.-]+__[a-zA-Z0-9_.-]+-[0-9]+$/u.test(input.id) ||
		(input.prediction !== "gold" && !isAbsolute(input.prediction)) ||
		(input.prediction !== "gold" && !SWE_MODEL_NAME.test(input.modelName ?? "")) ||
		!/^[a-f0-9]{64}$/u.test(input.predictionHash)
	)
		throw new Error("SWE_HARNESS_INPUT_INVALID");
	const runId = `pi_${input.predictionHash.slice(0, 12)}_${randomUUID().replaceAll("-", "")}`;
	return {
		runId,
		reportFile: `${input.prediction === "gold" ? "gold" : input.modelName}.${runId}.json`,
		args: [
			"-m",
			"swebench.harness.run_evaluation",
			"--dataset_name",
			input.datasetPath,
			"--split",
			"test",
			"--instance_ids",
			input.id,
			"--predictions_path",
			input.prediction,
			"--max_workers",
			"1",
			"--cache_level",
			"instance",
			"--timeout",
			"1800",
			"--run_id",
			runId,
		],
	};
}

export function windowsDockerStorage(localAppData: string, appData: string): string | null {
	const settingsPath = join(appData, "Docker", "settings-store.json");
	const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
	const root = settings.CustomWslDistroDir ?? join(localAppData, "Docker", "wsl");
	if (typeof root !== "string" || !isAbsolute(root)) return null;
	const vhd = join(root, "disk", "docker_data.vhdx");
	return existsSync(vhd) && lstatSync(vhd).isFile() ? dirname(vhd) : null;
}

function harnessPreflight() {
	try {
		const endpoint = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
			encoding: "utf8",
			timeout: 10_000,
			windowsHide: true,
		}).trim();
		if (!/^(?:unix|npipe):\/\//u.test(endpoint) || (process.env.DOCKER_HOST && process.env.DOCKER_HOST !== endpoint))
			throw new Error("non-local Docker");
		const info = JSON.parse(
			execFileSync("docker", ["info", "--format", "{{json .}}"], {
				encoding: "utf8",
				timeout: 10_000,
				maxBuffer: 128 * 1024,
				windowsHide: true,
			}),
		);
		const storage =
			process.platform === "win32"
				? windowsDockerStorage(process.env.LOCALAPPDATA ?? "", process.env.APPDATA ?? "")
				: process.platform === "linux" && typeof info.DockerRootDir === "string"
					? info.DockerRootDir
					: null;
		const disk = storage ? statfsSync(storage) : null;
		const freeBytes = disk ? disk.bavail * disk.bsize : null;
		const reasons = [
			...(info.OSType !== "linux" || !["x86_64", "amd64"].includes(info.Architecture)
				? ["docker_architecture"]
				: []),
			...(!Number.isFinite(info.NCPU) || info.NCPU < 8 ? ["docker_cpu"] : []),
			...(!Number.isFinite(info.MemTotal) || info.MemTotal < 16_000_000_000 ? ["docker_memory"] : []),
			...(freeBytes === null || freeBytes < 120_000_000_000 ? ["docker_disk"] : []),
		];
		return {
			reasons,
			architecture: info.Architecture,
			cpu: info.NCPU,
			memoryBytes: info.MemTotal,
			freeBytes,
			storage,
		};
	} catch {
		return { reasons: ["docker_preflight_unavailable"] };
	}
}

function readScoringInput(path: string, maxBytes: number, sizeError: string): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error(sizeError);
		const bytes = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > maxBytes) throw new Error(sizeError);
		return bytes.subarray(0, length);
	} finally {
		closeSync(fd);
	}
}

export function readSweEvaluationPrediction(predictionPath: string, agentResultPath: string) {
	if (realpathSync(agentResultPath) !== agentResultPath) throw new Error("SWE_AGENT_RESULT_UNTRUSTED");
	const predictionBytes = readScoringInput(predictionPath, 300_000, "SWE_PREDICTION_TOO_LARGE");
	const agentResultBytes = readScoringInput(agentResultPath, 4 * 1024 * 1024, "SWE_AGENT_RESULT_UNTRUSTED");
	const prediction: unknown = JSON.parse(predictionBytes.toString("utf8"));
	const agent: unknown = JSON.parse(agentResultBytes.toString("utf8"));
	if (!prediction || typeof prediction !== "object" || Array.isArray(prediction))
		throw new Error("SWE_PREDICTION_INVALID");
	if (!agent || typeof agent !== "object" || Array.isArray(agent))
		throw new Error("SWE_AGENT_RESULT_UNTRUSTED");
	return {
		prediction: prediction as { instance_id: string; model_name_or_path: string; model_patch: string },
		agent: agent as Record<string, unknown>,
		predictionSha256: sha(predictionBytes),
		agentResultSha256: sha(agentResultBytes),
	};
}

export function runOfficialHarness() {
	const arg = (key: string) => {
		const index = process.argv.indexOf(key);
		return index === -1 ? undefined : process.argv[index + 1];
	};
	const instance = arg("--instance");
	const manifest = readSweManifest();
	const row = manifest.instances.find((item) => item.instance_id === instance);
	if (!row) throw new Error("SWE_HARNESS_INSTANCE_NOT_SELECTED");
	const preflight = harnessPreflight();
	const record = {
		harnessCommit: SWE_HARNESS_COMMIT,
		datasetRevision: SWE_DATA_REVISION,
		instanceId: row.instance_id,
		baseCommit: row.base_commit,
		role: row.role,
		preflight,
		officialResolved: null,
		imageDigest: null,
	};
	if (preflight.reasons.length || !process.argv.includes("--execute")) {
		console.log(JSON.stringify({ ...record, status: preflight.reasons.length ? "environment_blocked" : "not_run" }));
		return;
	}
	const checkout = arg("--harness-checkout");
	const dataset = arg("--parquet");
	const output = arg("--output-dir");
	const predictionPath = arg("--prediction");
	const agentResultPath = arg("--agent-result");
	if (
		!checkout ||
		!dataset ||
		!output ||
		![checkout, dataset, output].every(isAbsolute) ||
		(row.role === "gold"
			? predictionPath !== undefined || agentResultPath !== undefined
			: !predictionPath || !isAbsolute(predictionPath) || !agentResultPath || !isAbsolute(agentResultPath))
	)
		throw new Error("SWE_HARNESS_PATHS_REQUIRED");
	if (git(checkout, ["rev-parse", "HEAD"]).trim() !== SWE_HARNESS_COMMIT || git(checkout, ["status", "--porcelain"]))
		throw new Error("SWE_HARNESS_CHECKOUT_MISMATCH");
	if (
		output.split(/[\\/]/u).some((part) => /^pi-enhanced-real-agent-/u.test(part)) ||
		realpathSync(dirname(output)) !== dirname(output)
	)
		throw new Error("SWE_EVALUATOR_OUTPUT_UNTRUSTED");
	const datasetBytes = readScoringInput(dataset, 10_000_000, "SWE_DATASET_HASH_MISMATCH");
	if (sha(datasetBytes) !== manifest.parquetSha256) throw new Error("SWE_DATASET_HASH_MISMATCH");
	const scoringInput = predictionPath && agentResultPath ? readSweEvaluationPrediction(predictionPath, agentResultPath) : null;
	const prediction = scoringInput?.prediction ?? null;
	const agent = scoringInput?.agent ?? null;
	if (
		prediction &&
		(Object.keys(prediction).sort().join(",") !== "instance_id,model_name_or_path,model_patch" ||
			prediction.instance_id !== row.instance_id ||
			typeof prediction.model_name_or_path !== "string" ||
			!SWE_MODEL_NAME.test(prediction.model_name_or_path) ||
			typeof prediction.model_patch !== "string" ||
			!prediction.model_patch.trim())
	)
		throw new Error("SWE_PREDICTION_INVALID");
	if (agent && prediction) {
		assessSwePrediction(agent, prediction, "not_run");
		const rel = relative(realpathSync(dirname(agentResultPath!)), resolve(output));
		if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
			throw new Error("SWE_EVALUATOR_OUTPUT_IN_AGENT_OUTPUT");
	}
	const command = harnessCommand({
		id: row.instance_id,
		datasetPath: join(output, "verified-one.json"),
		prediction: predictionPath ? join(output, "predictions.jsonl") : "gold",
		predictionHash: prediction ? sha(prediction.model_patch) : manifest.parquetSha256,
		modelName: prediction?.model_name_or_path,
	});
	// Exclusive evaluator directory prevents cache or artifacts from any prior run entering this invocation.
	mkdirSync(output);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) =>
			/^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|COMSPEC|PATHEXT|LANG|VIRTUAL_ENV)$/iu.test(
				key,
			),
		),
	);
	env.PYTHONPATH = realpathSync(checkout);
	// The official dependency loads dotenv on import. Evaluation must not discover host provider credentials.
	env.PYTHON_DOTENV_DISABLED = "1";
	const selection = execFileSync(
		"python",
		[
			"-c",
			"import json,sys,pyarrow as pa,pyarrow.parquet as p; t=p.read_table(pa.BufferReader(sys.stdin.buffer.read()), filters=[('instance_id','=',sys.argv[1])], use_threads=False, pre_buffer=False); print(json.dumps(t.to_pylist()))",
			row.instance_id,
		],
		{ cwd: output, env, input: datasetBytes, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
	);
	const rows = JSON.parse(selection);
	if (
		!Array.isArray(rows) ||
		rows.length !== 1 ||
		sha(publicInstance(rows[0], row).problem_statement) !== row.problem_sha256
	)
		throw new Error("SWE_EVALUATOR_ROW_INVALID");
	writeFileSync(join(output, "verified-one.json"), selection, { flag: "wx", mode: 0o600 });
	if (prediction)
		writeFileSync(join(output, "predictions.jsonl"), `${JSON.stringify(prediction)}\n`, { flag: "wx", mode: 0o600 });
	const provenance = scoringInput && prediction
		? {
				predictionSha256: scoringInput.predictionSha256,
				patchSha256: sha(prediction.model_patch),
				agentResultSha256: scoringInput.agentResultSha256,
			}
		: {};
	writeFileSync(join(output, "invocation.json"), JSON.stringify({ ...record, ...command, ...provenance }, null, 2), {
		flag: "wx",
	});
	let failure: "timeout" | "evaluation_error" | null = null;
	try {
		execFileSync("python", command.args, { cwd: output, env, timeout: 3_600_000, stdio: "inherit" });
	} catch (error) {
		failure = (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "evaluation_error";
	}
	const reportPath = join(output, command.reportFile);
	const instanceDir = join(
		output, "logs", "run_evaluation", command.runId, prediction?.model_name_or_path ?? "gold", row.instance_id,
	);
	const status = readOfficialOutcome(reportPath, row.instance_id, failure, instanceDir);
	writeFileSync(
		join(output, "outcome.json"),
		JSON.stringify(
			{
				...record,
				...provenance,
				runId: command.runId,
				status,
				evaluationClass: prediction ? "official_harness_prediction" : "gold_environment_probe",
				officialResolved: status === "resolved" ? true : status === "unresolved" ? false : null,
			},
			null,
			2,
		),
		{ flag: "wx" },
	);
	if (agent && prediction)
		writeFileSync(
			join(output, "assessment.json"),
			JSON.stringify(assessSwePrediction(agent, prediction, status), null, 2),
			{ flag: "wx" },
		);
}
