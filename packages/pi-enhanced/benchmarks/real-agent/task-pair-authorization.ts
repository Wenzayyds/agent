import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TASK_PAIR_CELLS, TASK_PAIR_CONFIGURATION, TASK_PAIR_PROFILE } from "./batch-l-profile.ts";
import { verifyControlledCi } from "./controlled-policy.ts";
import { digest } from "./evaluation-identity.ts";
import { readSweManifest, swePrompt } from "./swe-instance.ts";
import {
	resolveSweProfile,
	SWE_FLASH_OFF_CONFIGURATION,
	SWE_PRO_TASK_CONFIGURATION,
	SWE_TASK_CONFIGURATION,
	type SweProfileName,
} from "./swe-profile.ts";

export interface TaskPairInput {
	fixtureSha256: string;
	fixtureCommit: string;
	userPromptSha256: string;
	systemPromptSha256: string;
	toolSchemaSha256: string;
	firstRequestSha256: string;
}

export interface TaskPairAuthorization {
	schemaVersion: 1;
	status: "authorized";
	authorizationId: string;
	profile: typeof TASK_PAIR_PROFILE | SweProfileName;
	commit: string;
	batchId: string;
	outputBase: string;
	expiresAt: string;
	ciRunId: number;
	configurationSha256: string;
	input?: TaskPairInput;
	modeInputs?: Record<"v1" | "v2", TaskPairInput> & Partial<Record<"off", TaskPairInput>>;
	instanceInputs?: Record<string, TaskPairInput>;
}

export function readTaskPairInput(value: unknown): TaskPairInput {
	if (!value || typeof value !== "object") throw new Error("TASK_PAIR_INPUT_INVALID");
	const input = value as TaskPairInput;
	const keys = [
		"fixtureSha256",
		"fixtureCommit",
		"userPromptSha256",
		"systemPromptSha256",
		"toolSchemaSha256",
		"firstRequestSha256",
	] as const;
	if (
		Object.keys(input).length !== keys.length ||
		keys.some(
			(key) =>
				typeof input[key] !== "string" ||
				!(key === "fixtureCommit" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(input[key]),
		)
	)
		throw new Error("TASK_PAIR_INPUT_INVALID");
	return input;
}

export function loadTaskPairAuthorization(
	path: string | undefined,
	repository: string,
	commit: string,
	batchId: string,
	ciPath: string | undefined,
	expectedProfile: typeof TASK_PAIR_PROFILE | SweProfileName = TASK_PAIR_PROFILE,
	publicTests = false,
): TaskPairAuthorization {
	if (!path || !isAbsolute(path)) throw new Error("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
	const stat = lstatSync(path);
	const repo = realpathSync(repository);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || !outside(repo, realpathSync(path)))
		throw new Error("TASK_PAIR_AUTHORIZATION_UNTRUSTED");
	const grant = JSON.parse(readFileSync(path, "utf8")) as TaskPairAuthorization;
	const expiry = Date.parse(grant?.expiresAt);
	const now = Date.now();
	const swe = resolveSweProfile(expectedProfile);
	if (publicTests && (swe?.admission !== "instances" || swe.cells.length !== 1))
		throw new Error("SWE_PYTEST_REQUIRES_ONE_INSTANCE");
	if (
		!grant ||
		Object.keys(grant).length !== (swe?.admission === "all" || swe?.admission === "task" ? 12 : 11) ||
		grant.schemaVersion !== 1 ||
		grant.status !== "authorized" ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(grant.authorizationId) ||
		grant.profile !== expectedProfile ||
		grant.commit !== commit ||
		!(swe?.batchIdPattern ?? /^task_pair_[a-z0-9_]{4,20}$/u).test(batchId) ||
		grant.batchId !== batchId ||
		!Number.isFinite(expiry) ||
		expiry <= now ||
		expiry > now + 86_400_000 ||
		grant.configurationSha256 !== digest(swe?.configuration ?? TASK_PAIR_CONFIGURATION) ||
		typeof grant.outputBase !== "string" ||
		!isAbsolute(grant.outputBase) ||
		realpathSync(grant.outputBase) !== grant.outputBase ||
		!outside(repo, grant.outputBase) ||
		!lstatSync(grant.outputBase).isDirectory() ||
		!Number.isSafeInteger(grant.ciRunId) ||
		grant.ciRunId <= 0
	)
		throw new Error("TASK_PAIR_AUTHORIZATION_INVALID_OR_EXPIRED");
	const input = swe?.admission === "instances" ? undefined : readTaskPairInput(grant.input);
	if (swe?.admission === "instances") readSweFlashOffInputs(grant.instanceInputs, swe.configuration.instances, publicTests);
	if (swe?.admission === "all") {
		const inputs = readSweModeInputs(grant.modeInputs);
		if (!isDeepStrictEqual(inputs.off, grant.input)) throw new Error("SWE_AUTHORIZATION_INPUT_MISMATCH");
	}
	if (swe?.admission === "task") {
		const inputs = readSweProTaskInputs(grant.modeInputs);
		if (!isDeepStrictEqual(inputs.v1, grant.input)) throw new Error("SWE_AUTHORIZATION_INPUT_MISMATCH");
	}
	if (
		swe?.admission === "off" &&
		(input?.fixtureCommit !== swe.configuration.baseCommit ||
			input?.userPromptSha256 !== swe.configuration.userPromptSha256)
	)
		throw new Error("SWE_AUTHORIZATION_INPUT_MISMATCH");
	if (!ciPath) throw new Error("CONTROLLED_CI_REQUIRED");
	const ci = JSON.parse(readFileSync(ciPath, "utf8"));
	verifyControlledCi(ci, commit);
	if (ci.runId !== grant.ciRunId || ci.runUrl !== `https://github.com/Wenzayyds/agent/actions/runs/${grant.ciRunId}`)
		throw new Error("TASK_PAIR_CI_RUN_MISMATCH");
	return grant;
}

export function claimTaskPairAuthorization(path: string, grant: TaskPairAuthorization): void {
	writeFileSync(`${path}.used`, digest(grant), { flag: "wx", mode: 0o600 });
}

export function claimTaskPairCell(path: string, grant: TaskPairAuthorization, cellId: string, outputDir: string): void {
	const batchDir = join(grant.outputBase, grant.batchId);
	if (realpathSync(outputDir) !== batchDir || readFileSync(`${path}.used`, "utf8") !== digest(grant))
		throw new Error("TASK_PAIR_AUTHORIZATION_CLAIM_MISMATCH");
	const batch = JSON.parse(readFileSync(join(batchDir, "batch.json"), "utf8"));
	const swe = resolveSweProfile(grant.profile);
	const cells = swe?.cells ?? TASK_PAIR_CELLS;
	const index = cells.findIndex((cell) => cell.id === cellId);
	if (
		index < 0 ||
		Date.parse(grant.expiresAt) <= Date.now() ||
		batch.commit !== grant.commit ||
		batch.batchId !== grant.batchId ||
		batch.comparisonProfile !== grant.profile ||
		batch.authorization?.id !== grant.authorizationId ||
		batch.stoppedReason !== null ||
		!isDeepStrictEqual(
			batch.cells?.map((cell: { id: string }) => cell.id),
			cells.map((cell) => cell.id),
		) ||
		(swe?.admission === "instances" && !isDeepStrictEqual(
			batch.cells.map((cell: { instanceId: string }) => cell.instanceId),
			swe.configuration.instances.map((instance) => instance.instanceId),
		)) ||
		batch.cells[index]?.resultStatus !== "run" ||
		cells.some((cell, position) =>
			position > index
				? batch.cells[position]?.resultStatus !== "not_run"
				: position < index &&
					(!(swe ? ["run", "failed", "stopped"] : ["passed", "failed"]).includes(
						batch.cells[position]?.resultStatus,
					) ||
						(swe && batch.cells[position]?.continuationReady !== true) ||
						readFileSync(`${path}.used.${cell.id}`, "utf8") !== digest(grant)),
		)
	)
		throw new Error("TASK_PAIR_CELL_ORDER_INVALID");
	writeFileSync(`${path}.used.${cellId}`, digest(grant), { flag: "wx", mode: 0o600 });
}

export function sweFlashOffPromptSha256(
	instance: (typeof SWE_FLASH_OFF_CONFIGURATION)["instances"][number],
	publicTests: boolean,
): string {
	if (!publicTests) return instance.userPromptSha256;
	const issue = readSweManifest().instances.find((row) => row.instance_id === instance.instanceId && row.role === "candidate");
	if (!issue?.problem_statement || digest(issue.problem_statement) !== instance.problemSha256)
		throw new Error("SWE_ISSUE_HASH_MISMATCH");
	return digest(swePrompt(issue.problem_statement, true));
}

/** Every OFF authorization binds one selected issue to its own calibrated request. */
export function readSweFlashOffInputs(
	value: unknown,
	instances: (typeof SWE_FLASH_OFF_CONFIGURATION)["instances"] = SWE_FLASH_OFF_CONFIGURATION.instances,
	publicTests = false,
): Record<string, TaskPairInput> {
	if (!value || typeof value !== "object" || Object.keys(value).length !== instances.length)
		throw new Error("SWE_INSTANCE_INPUTS_INVALID");
	const inputs = value as Record<string, TaskPairInput>;
	for (const instance of instances) {
		if (!Object.hasOwn(inputs, instance.instanceId)) throw new Error("SWE_INSTANCE_INPUTS_INVALID");
		const input = readTaskPairInput(inputs[instance.instanceId]);
		if (input.fixtureCommit !== instance.baseCommit || input.userPromptSha256 !== sweFlashOffPromptSha256(instance, publicTests))
			throw new Error("SWE_INSTANCE_INPUT_MISMATCH");
	}
	return inputs;
}

/** Full schemas intentionally differ by mode; the issue, base, tree and system input must remain identical. */
export function readSweModeInputs(value: unknown): Record<"off" | "v1" | "v2", TaskPairInput> {
	if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "off,v1,v2")
		throw new Error("SWE_MODE_INPUTS_INVALID");
	const inputs = value as Record<"off" | "v1" | "v2", TaskPairInput>;
	for (const mode of ["off", "v1", "v2"] as const) {
		const input = readTaskPairInput(inputs[mode]);
		if (
			input.fixtureCommit !== SWE_TASK_CONFIGURATION.baseCommit ||
			input.userPromptSha256 !== SWE_TASK_CONFIGURATION.userPromptSha256 ||
			input.fixtureSha256 !== inputs.off.fixtureSha256 ||
			input.systemPromptSha256 !== inputs.off.systemPromptSha256
		)
			throw new Error("SWE_MODE_INPUTS_MISMATCH");
	}
	return inputs;
}

export function readSweProTaskInputs(value: unknown): Record<"v1" | "v2", TaskPairInput> {
	if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "v1,v2")
		throw new Error("SWE_MODE_INPUTS_INVALID");
	const inputs = value as Record<"v1" | "v2", TaskPairInput>;
	for (const mode of ["v1", "v2"] as const) {
		const input = readTaskPairInput(inputs[mode]);
		if (
			input.fixtureCommit !== SWE_PRO_TASK_CONFIGURATION.baseCommit ||
			input.userPromptSha256 !== SWE_PRO_TASK_CONFIGURATION.userPromptSha256 ||
			input.fixtureSha256 !== inputs.v1.fixtureSha256 ||
			input.systemPromptSha256 !== inputs.v1.systemPromptSha256
		)
			throw new Error("SWE_MODE_INPUTS_MISMATCH");
	}
	if (inputs.v1.toolSchemaSha256 === inputs.v2.toolSchemaSha256 || inputs.v1.firstRequestSha256 === inputs.v2.firstRequestSha256)
		throw new Error("SWE_MODE_INPUTS_MISMATCH");
	return inputs;
}

function outside(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}
