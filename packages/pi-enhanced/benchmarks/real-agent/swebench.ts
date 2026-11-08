import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const manifestPath = fileURLToPath(new URL("./swebench-verified.json", import.meta.url));
export const SWE_HARNESS_COMMIT = "726c5461e2ef52d83cf1ea2107870a8bb3328d57";
export const SWE_DATA_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a";
export const SWE_EVALUATION_PROTOCOL = "swebench_verified_source_restricted_v1";
export const SWE_SOURCE_INSTRUCTIONS =
	"本次采用受限源码评测协议：允许读取工作区中的测试文件，但禁止修改、创建或删除测试文件。只能修改已有且被 Git 跟踪的 .py/.js/.ts/.rst/.md 源码文件；禁止新增文件、删除、重命名、权限变更及修改凭据或仓库元数据。不提供 Shell 或 Agent 内测试执行能力；完成最小源码修复后结束，由独立官方 Harness 判分。所有模式使用相同限制，没有按答案位置设置文件白名单。";
export function swePrompt(issue: string): string {
	return `${issue}\n\n${SWE_SOURCE_INSTRUCTIONS}`;
}

export function sweWritePathAllowed(cwd: string, input: unknown): boolean {
	if (typeof input !== "string") return false;
	const path = relative(resolve(cwd), resolve(cwd, input)).replaceAll("\\", "/");
	if (!safePatchPath(path)) return false;
	return git(cwd, ["ls-files", "-z", "--", path]).split("\0").filter(Boolean).includes(path);
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface Identity {
	instance_id: string;
	repo: string;
	base_commit: string;
}
export interface PublicIssue extends Identity {
	problem_statement: string;
}
interface Selection extends Identity {
	role: "gold" | "candidate";
	problem_sha256: string;
}
export type SweTask = { issue: PublicIssue; mirror: string };

export function publicInstance(value: unknown, expected: Identity): PublicIssue {
	if (!value || typeof value !== "object") throw new Error("SWE_ROW_INVALID");
	const { instance_id, repo, base_commit, problem_statement } = value as PublicIssue;
	if (
		typeof repo !== "string" ||
		!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/u.test(repo) ||
		typeof instance_id !== "string" ||
		!new RegExp(`^${repo.replace("/", "__").replaceAll(".", "\\.")}-[0-9]+$`, "u").test(instance_id) ||
		typeof base_commit !== "string" ||
		!/^[a-f0-9]{40}$/u.test(base_commit) ||
		instance_id !== expected.instance_id ||
		repo !== expected.repo ||
		base_commit !== expected.base_commit ||
		typeof problem_statement !== "string" ||
		!problem_statement.trim() ||
		problem_statement.length > 32_000 ||
		problem_statement.includes("\0")
	)
		throw new Error("SWE_ROW_IDENTITY_OR_ISSUE_INVALID");
	return { instance_id, repo, base_commit, problem_statement };
}

export function safePatchPath(path: string): boolean {
	return (
		/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:py|js|ts|rst|md)$/u.test(path) &&
		!path
			.split("/")
			.some((part) =>
				/^(?:tests?(?:\.[^.]+)?|__tests?__|specs?|__specs?__|tests?_.*|spec_.*|conftest\.py|.*(?:_test|\.test|\.spec)\.[^.]+|secrets?|credentials?)$/iu.test(
					part,
				),
			)
	);
}

export function safeBasePath(path: string): boolean {
	return !path
		.split("/")
		.some(
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				[".git", ".pi", "node_modules"].includes(part.toLowerCase()) ||
				/[. ]$/u.test(part) ||
				/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
		);
}

export function loadSweTask(id: string, mirror: string): SweTask {
	const selection = (
		JSON.parse(readFileSync(manifestPath, "utf8")) as { instances: Array<Selection & PublicIssue> }
	).instances.find((row) => row.instance_id === id && row.role === "candidate");
	if (!selection) throw new Error("SWE_CANDIDATE_NOT_SELECTED");
	const issue = publicInstance(selection, selection);
	if (sha(issue.problem_statement) !== selection.problem_sha256) throw new Error("SWE_ISSUE_HASH_MISMATCH");
	return { issue, mirror: realpathSync(mirror) };
}

function git(cwd: string, args: string[], input?: string): string {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
	return execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.autocrlf=false",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"submodule.recurse=false",
			"-c",
			"protocol.file.allow=always",
			...args,
		],
		{
			cwd,
			env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
			encoding: "utf8",
			input,
			timeout: 60_000,
			maxBuffer: 4 * 1024 * 1024,
			windowsHide: true,
		},
	);
}

/** Copy only the selected base from an operator-provided public local mirror, with no hooks or submodules. */
export function prepareSweWorkspace(task: SweTask, cwd: string): string {
	const origin = git(task.mirror, ["config", "--get", "remote.origin.url"]).trim();
	if (origin !== `https://github.com/${task.issue.repo}.git` && origin !== `https://github.com/${task.issue.repo}`)
		throw new Error("SWE_MIRROR_ORIGIN_MISMATCH");
	const base = task.issue.base_commit;
	if (git(task.mirror, ["rev-parse", `${base}^{commit}`]).trim() !== base) throw new Error("SWE_BASE_MISMATCH");
	const tree = git(task.mirror, ["ls-tree", "-rlz", base]).split("\0").filter(Boolean);
	let bytes = 0;
	for (const entry of tree) {
		const match = /^(100644|100755) blob [a-f0-9]+ +([0-9]+)\t([A-Za-z0-9_./+@ -]+)$/u.exec(entry);
		if (!match || !safeBasePath(match[3]!)) throw new Error("SWE_UNSUPPORTED_BASE_TREE");
		bytes += Number(match[2]);
	}
	if (!tree.length || tree.length > 50_000 || bytes > 128 * 1024 * 1024) throw new Error("SWE_BASE_TOO_LARGE");
	// Fetch only the base tree (one commit, no tags) into an independent repository.
	mkdirSync(cwd);
	git(cwd, ["init", "--quiet", `--separate-git-dir=${join(dirname(cwd), "swe-git")}`]);
	git(cwd, ["fetch", "--quiet", "--no-tags", "--depth=1", pathToFileURL(task.mirror).href, base]);
	git(cwd, ["checkout", "--quiet", "--detach", base]);
	if (git(cwd, ["rev-parse", "HEAD"]).trim() !== base || git(cwd, ["status", "--porcelain", "-z"]))
		throw new Error("SWE_WORKSPACE_NOT_PRISTINE");
	return git(cwd, ["rev-parse", "HEAD^{tree}"]).trim();
}

export function exportSwePrediction(
	task: SweTask,
	cwd: string,
	output: string,
	model: string,
	diagnosticOutput?: string,
) {
	const parent = realpathSync(dirname(output));
	const rel = relative(realpathSync(cwd), parent);
	if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("SWE_OUTPUT_IN_WORKSPACE");
	if (diagnosticOutput && realpathSync(dirname(diagnosticOutput)) !== parent)
		throw new Error("SWE_DIAGNOSTIC_OUTPUT_INVALID");
	const diagnostic: {
		status: string;
		error: string | null;
		candidatePatchSha256: string | null;
		candidatePatchBytes: number | null;
		paths: Array<{ path: string | null; pathSha256: string }> | null;
		pathsTruncated: boolean;
		contentSaved: false;
	} = {
		status: "rejected",
		error: null,
		candidatePatchSha256: null,
		candidatePatchBytes: null,
		paths: null,
		pathsTruncated: false,
		contentSaved: false,
	};
	try {
		if (
			git(cwd, ["rev-parse", "HEAD"]).trim() !== task.issue.base_commit ||
			git(cwd, ["diff", "--cached", "--name-only"]) ||
			git(cwd, ["ls-files", "--others", "-z"])
		)
			throw new Error("SWE_WORKSPACE_DRIFT_OR_UNTRACKED_FILES");
		const changed = git(cwd, ["diff", "--name-only", "-z", "HEAD", "--"]).split("\0").filter(Boolean);
		diagnostic.paths = changed.slice(0, 64).map((path) => ({
			path:
				path.length <= 256 &&
				/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:py|js|ts|rst|md)$/u.test(path) &&
				!/secret|credential|password|token|api.?key/iu.test(path)
					? path
					: null,
			pathSha256: sha(path),
		}));
		diagnostic.pathsTruncated = changed.length > 64;
		const patch = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--"]);
		diagnostic.candidatePatchSha256 = sha(patch);
		diagnostic.candidatePatchBytes = Buffer.byteLength(patch);
		if (!changed.length) {
			diagnostic.error = "empty_patch";
			return { status: "agent_failed", reason: "empty_patch" } as const;
		}
		for (const path of changed) {
			const target = join(cwd, path);
			if (!safePatchPath(path) || !lstatSync(target).isFile() || realpathSync(target) !== target)
				throw new Error("SWE_PATCH_PATH_DENIED");
		}
		const raw = git(cwd, ["diff", "--raw", "--no-renames", "HEAD", "--"]);
		if (
			raw
				.split(/\r?\n/u)
				.filter(Boolean)
				.some((line) => !/^:(100644|100755) \1 [a-f0-9]+ [a-f0-9]+ M\t/u.test(line))
		)
			throw new Error("SWE_PATCH_MODE_DENIED");
		if (
			Buffer.byteLength(patch) > 256 * 1024 ||
			/(?:^Binary files |^GIT binary patch|-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}\b|\bAKIA[A-Z0-9]{16}\b|(?:api[_-]?key|password|secret|token)\s*[:=]\s*['"][^'"]{16,}['"])/imu.test(
				patch,
			)
		)
			throw new Error("SWE_PATCH_UNSAFE");
		git(cwd, ["apply", "--cached", "--check", "--whitespace=nowarn", "-"], patch);
		writeFileSync(
			output,
			`${JSON.stringify({ instance_id: task.issue.instance_id, model_name_or_path: model, model_patch: patch })}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		diagnostic.status = "exported";
		return {
			status: "not_run",
			reason: "official_harness_not_run",
			patchSha256: sha(patch),
			changedFiles: changed,
		} as const;
	} catch (error) {
		diagnostic.error =
			error instanceof Error && /^SWE_[A-Z_]+$/u.test(error.message) ? error.message : "SWE_PATCH_EXPORT_FAILED";
		throw error;
	} finally {
		if (diagnosticOutput)
			writeFileSync(diagnosticOutput, `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	}
}

export function officialOutcome(report: unknown, id: string, timeout = false) {
	if (timeout) return "timeout";
	if (!report) return "not_run";
	if (typeof report !== "object") throw new Error("SWE_REPORT_INVALID");
	const value = report as Record<string, unknown>;
	const categories = [
		["resolved_ids", "resolved"],
		["unresolved_ids", "unresolved"],
		["error_ids", "evaluation_error"],
	] as const;
	const found = categories.filter(([key]) => {
		const ids = value[key];
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
		!["resolved", "unresolved", "not_run", "timeout", "evaluation_error", "environment_blocked"].includes(status)
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
		(input.prediction !== "gold" && !/^[a-zA-Z0-9_.-]{1,100}$/u.test(input.modelName ?? "")) ||
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

function runOfficialHarness() {
	const arg = (key: string) => {
		const index = process.argv.indexOf(key);
		return index === -1 ? undefined : process.argv[index + 1];
	};
	const instance = arg("--instance");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { parquetSha256: string; instances: Selection[] };
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
	if (lstatSync(dataset).size > 10_000_000 || sha(readFileSync(dataset)) !== manifest.parquetSha256)
		throw new Error("SWE_DATASET_HASH_MISMATCH");
	if (predictionPath && lstatSync(predictionPath).size > 300_000) throw new Error("SWE_PREDICTION_TOO_LARGE");
	const prediction = predictionPath ? JSON.parse(readFileSync(predictionPath, "utf8")) : null;
	if (
		agentResultPath &&
		(lstatSync(agentResultPath).size > 4 * 1024 * 1024 || realpathSync(agentResultPath) !== agentResultPath)
	)
		throw new Error("SWE_AGENT_RESULT_UNTRUSTED");
	const agent = agentResultPath
		? (JSON.parse(readFileSync(agentResultPath, "utf8")) as Record<string, unknown>)
		: null;
	if (
		prediction &&
		(Object.keys(prediction).sort().join(",") !== "instance_id,model_name_or_path,model_patch" ||
			prediction.instance_id !== row.instance_id ||
			!/^[a-zA-Z0-9_.-]{1,100}$/u.test(prediction.model_name_or_path) ||
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
			"import json,sys,pyarrow.parquet as p; t=p.read_table(sys.argv[1], filters=[('instance_id','=',sys.argv[2])]); print(json.dumps(t.to_pylist()))",
			dataset,
			row.instance_id,
		],
		{ cwd: output, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
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
	const provenance = prediction
		? {
				predictionSha256: sha(readFileSync(predictionPath!)),
				patchSha256: sha(prediction.model_patch),
				agentResultSha256: sha(readFileSync(agentResultPath!)),
			}
		: {};
	writeFileSync(join(output, "invocation.json"), JSON.stringify({ ...record, ...command, ...provenance }, null, 2), {
		flag: "wx",
	});
	let failure: string | null = null;
	try {
		execFileSync("python", command.args, { cwd: output, env, timeout: 3_600_000, stdio: "inherit" });
	} catch (error) {
		failure = (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "evaluation_error";
	}
	const reportPath = join(output, command.reportFile);
	const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
	const status = failure ?? (report ? officialOutcome(report, row.instance_id) : "evaluation_error");
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runOfficialHarness();
