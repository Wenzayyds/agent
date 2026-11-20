import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BATCH_L_LIMITS, BATCH_L_PROFILE } from "./batch-l-profile.ts";

export interface BatchLAuthorization {
	schemaVersion: 1;
	status: "authorized";
	authorizationId: string;
	batchId: string;
	commit: string;
	profile: typeof BATCH_L_PROFILE;
	provider: "deepseek";
	model: "deepseek-flash";
	expiresAt: string;
	recovery: "strict" | "readonly_denials_max2";
	maxRequestsPerRun: 8;
	maxTokensPerRun: 80000;
	maxCostPerRunUsd: 0.03;
	maxBatchCostUsd: 0.18;
	maxRuns: 6;
	timeoutMs: 180000;
}

/** Explicit host CLI capability; never read from the project config, model text or environment. */
export function loadBatchLAuthorization(
	path: string | undefined,
	repository: string,
	commit: string,
	batchId: string,
): BatchLAuthorization {
	if (!path || !isAbsolute(path)) throw new Error("BATCH_L_REAL_AUTHORIZATION_REQUIRED");
	const stat = lstatSync(path);
	const value = relative(realpathSync(repository), realpathSync(path));
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.size > 4096 ||
		!(value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value))
	)
		throw new Error("BATCH_L_AUTHORIZATION_UNTRUSTED");
	const grant = JSON.parse(readFileSync(path, "utf8")) as BatchLAuthorization;
	const keys = [
		"schemaVersion",
		"status",
		"authorizationId",
		"batchId",
		"commit",
		"profile",
		"provider",
		"model",
		"expiresAt",
		"recovery",
		"maxRequestsPerRun",
		"maxTokensPerRun",
		"maxCostPerRunUsd",
		"maxBatchCostUsd",
		"maxRuns",
		"timeoutMs",
	];
	const expiry = Date.parse(grant.expiresAt);
	if (
		Object.keys(grant).some((key) => !keys.includes(key)) ||
		grant.schemaVersion !== 1 ||
		grant.status !== "authorized" ||
		!/^[a-f0-9-]{36}$/u.test(grant.authorizationId) ||
		!/^batch_l_[a-z0-9_]{4,28}$/u.test(batchId) ||
		grant.batchId !== batchId ||
		grant.commit !== commit ||
		grant.profile !== BATCH_L_PROFILE ||
		grant.provider !== "deepseek" ||
		grant.model !== "deepseek-flash" ||
		!Number.isFinite(expiry) ||
		expiry <= Date.now() ||
		expiry > Date.now() + 24 * 3600_000 ||
		!["strict", "readonly_denials_max2"].includes(grant.recovery) ||
		grant.maxRequestsPerRun !== BATCH_L_LIMITS.maxRequests ||
		grant.maxTokensPerRun !== BATCH_L_LIMITS.maxTokens ||
		grant.maxCostPerRunUsd !== BATCH_L_LIMITS.maxCostUsd ||
		grant.maxBatchCostUsd !== BATCH_L_LIMITS.maxBatchCostUsd ||
		grant.maxRuns !== 6 ||
		grant.timeoutMs !== BATCH_L_LIMITS.timeoutMs
	)
		throw new Error("BATCH_L_AUTHORIZATION_INVALID_OR_EXPIRED");
	return grant;
}

export function claimBatchLAuthorization(path: string, grant: BatchLAuthorization, outputDir: string): void {
	writeFileSync(
		`${path}.used`,
		JSON.stringify({
			authorizationId: grant.authorizationId,
			commit: grant.commit,
			batchId: grant.batchId,
			outputDir: resolve(outputDir),
		}),
		{ flag: "wx", mode: 0o600 },
	);
}

export function claimBatchLCell(path: string, grant: BatchLAuthorization, cellId: string, outputDir: string): void {
	const claim = JSON.parse(readFileSync(`${path}.used`, "utf8")) as {
		authorizationId: string;
		commit: string;
		batchId: string;
		outputDir: string;
	};
	if (
		claim.authorizationId !== grant.authorizationId ||
		claim.commit !== grant.commit ||
		claim.batchId !== grant.batchId ||
		claim.outputDir !== resolve(outputDir) ||
		!["m_inline", "m_memory", "c_off", "c_on", "t_inline", "t_task"].includes(cellId)
	)
		throw new Error("BATCH_L_AUTHORIZATION_CLAIM_MISMATCH");
	writeFileSync(
		`${path}.used.${cellId}`,
		JSON.stringify({ authorizationId: grant.authorizationId, startedAt: new Date().toISOString() }),
		{ flag: "wx", mode: 0o600 },
	);
}
