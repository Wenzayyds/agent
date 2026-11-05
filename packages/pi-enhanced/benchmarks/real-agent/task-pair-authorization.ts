import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digest, TASK_PAIR_CELLS, TASK_PAIR_CONFIGURATION, TASK_PAIR_PROFILE } from "./batch-l-profile.ts";
import { verifyControlledCi } from "./controlled-policy.ts";

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
	profile: typeof TASK_PAIR_PROFILE;
	commit: string;
	batchId: string;
	outputBase: string;
	expiresAt: string;
	ciRunId: number;
	configurationSha256: string;
	input: TaskPairInput;
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
): TaskPairAuthorization {
	if (!path || !isAbsolute(path)) throw new Error("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
	const stat = lstatSync(path);
	const repo = realpathSync(repository);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || !outside(repo, realpathSync(path)))
		throw new Error("TASK_PAIR_AUTHORIZATION_UNTRUSTED");
	const grant = JSON.parse(readFileSync(path, "utf8")) as TaskPairAuthorization;
	const expiry = Date.parse(grant?.expiresAt);
	const now = Date.now();
	if (
		!grant ||
		Object.keys(grant).length !== 11 ||
		grant.schemaVersion !== 1 ||
		grant.status !== "authorized" ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(grant.authorizationId) ||
		grant.profile !== TASK_PAIR_PROFILE ||
		grant.commit !== commit ||
		!/^task_pair_[a-z0-9_]{4,20}$/u.test(batchId) ||
		grant.batchId !== batchId ||
		!Number.isFinite(expiry) ||
		expiry <= now ||
		expiry > now + 86_400_000 ||
		grant.configurationSha256 !== digest(TASK_PAIR_CONFIGURATION) ||
		typeof grant.outputBase !== "string" ||
		!isAbsolute(grant.outputBase) ||
		realpathSync(grant.outputBase) !== grant.outputBase ||
		!outside(repo, grant.outputBase) ||
		!lstatSync(grant.outputBase).isDirectory() ||
		!Number.isSafeInteger(grant.ciRunId) ||
		grant.ciRunId <= 0
	)
		throw new Error("TASK_PAIR_AUTHORIZATION_INVALID_OR_EXPIRED");
	readTaskPairInput(grant.input);
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
	const index = TASK_PAIR_CELLS.findIndex((cell) => cell.id === cellId);
	if (
		index < 0 ||
		batch.commit !== grant.commit ||
		batch.batchId !== grant.batchId ||
		batch.comparisonProfile !== TASK_PAIR_PROFILE ||
		batch.authorization?.id !== grant.authorizationId ||
		batch.stoppedReason !== null ||
		!isDeepStrictEqual(
			batch.cells?.map((cell: { id: string }) => cell.id),
			TASK_PAIR_CELLS.map((cell) => cell.id),
		) ||
		batch.cells[index]?.resultStatus !== "run" ||
		(index === 0
			? batch.cells[1]?.resultStatus !== "not_run"
			: !["passed", "failed"].includes(batch.cells[0]?.resultStatus) ||
				readFileSync(`${path}.used.${TASK_PAIR_CELLS[0].id}`, "utf8") !== digest(grant))
	)
		throw new Error("TASK_PAIR_CELL_ORDER_INVALID");
	writeFileSync(`${path}.used.${cellId}`, digest(grant), { flag: "wx", mode: 0o600 });
}

function outside(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}
