import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicPrivateJson } from "../../src/sandbox/audit.ts";
import { digestBytes } from "./evaluation-identity.ts";
import { assertFrozenPytest, assertFrozenSelection, FROZEN_CASE_COST_CENTS, FROZEN_TOTAL_COST_CENTS, frozenCases, frozenProfile } from "./swe-frozen-catalog.ts";
import { readSwePytestPolicy } from "./swe-test-feedback.ts";
import { loadTaskPairAuthorization } from "./task-pair-authorization.ts";

interface Entry {
	instanceId: string;
	batchId: string;
	grant: string;
	grantSha256: string;
	policy: string;
	policySha256: string;
	mirror: string;
}

interface BatchPlan {
	selection: string;
	outputBase: string;
	ci: string;
	entries: Entry[];
}

export interface FrozenScheduleResult {
	continued: boolean;
	chargeUsd: number;
	reason?: string;
}

function trustedFile(path: string, repository: string, max: number): Buffer {
	if (typeof path !== "string" || !isAbsolute(path)) throw new Error("SWE_FROZEN_FILE_UNTRUSTED");
	const stat = lstatSync(path);
	const location = realpathSync(path);
	const rel = relative(realpathSync(repository), location);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)))
		throw new Error("SWE_FROZEN_FILE_UNTRUSTED");
	const bytes = readFileSync(path);
	if (bytes.length > max) throw new Error("SWE_FROZEN_FILE_UNTRUSTED");
	return bytes;
}

function loadBatch(masterPath: string, repository: string, commit: string) {
	const bytes = trustedFile(masterPath, repository, 4096);
	const authorization = JSON.parse(bytes.toString("utf8"));
	const now = Date.now();
	const expiresAt = Date.parse(authorization?.expiresAt);
	if (
		!authorization || authorization.schemaVersion !== 1 || authorization.status !== "authorized" ||
		authorization.commit !== commit || authorization.maxCostCents !== FROZEN_TOTAL_COST_CENTS ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(authorization.authorizationId) ||
		!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 86_400_000
	) throw new Error("SWE_FROZEN_BATCH_UNAUTHORIZED");
	const planBytes = trustedFile(authorization.plan, repository, 128 * 1024);
	if (digestBytes(planBytes) !== authorization.planSha256) throw new Error("SWE_FROZEN_PLAN_MISMATCH");
	const plan = JSON.parse(planBytes.toString("utf8")) as BatchPlan;
	trustedFile(plan.selection, repository, 64 * 1024);
	assertFrozenSelection(plan.selection);
	const rel = relative(realpathSync(repository), realpathSync(plan.outputBase));
	if (!isAbsolute(plan.outputBase) || realpathSync(plan.outputBase) !== plan.outputBase ||
		!lstatSync(plan.outputBase).isDirectory() || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)))
		throw new Error("SWE_FROZEN_OUTPUT_UNTRUSTED");
	const ready = frozenCases.filter((c) => c.policy && !c.blockedReason);
	if (!Array.isArray(plan.entries) || plan.entries.length === 0 || plan.entries.length !== ready.length ||
		plan.entries.some((entry, i) => entry.instanceId !== ready[i]!.instanceId) ||
		new Set(plan.entries.map(({ batchId }) => batchId)).size !== plan.entries.length ||
		new Set(plan.entries.map(({ grant }) => grant)).size !== plan.entries.length)
		throw new Error("SWE_FROZEN_PLAN_SCOPE_INVALID");
	return { plan, masterSha256: digestBytes(bytes), root: join(plan.outputBase, "frozen-20") };
}

function assertEntryFiles(entry: Entry, repository: string): void {
	if (digestBytes(trustedFile(entry.grant, repository, 4096)) !== entry.grantSha256 ||
		digestBytes(trustedFile(entry.policy, repository, 64 * 1024)) !== entry.policySha256)
		throw new Error("SWE_FROZEN_CASE_INPUT_MISMATCH");
}

export function assertFrozenDispatch(
	masterPath: string | undefined,
	repository: string,
	commit: string,
	input: { instanceId?: string; batchId?: string; grant?: string; ci?: string; policy?: string; mirror?: string },
): void {
	if (!masterPath) throw new Error("SWE_FROZEN_BATCH_UNAUTHORIZED");
	const batch = loadBatch(masterPath, repository, commit);
	const entry = batch.plan.entries.find(({ instanceId }) => instanceId === input.instanceId);
	if (!entry || entry.batchId !== input.batchId || entry.grant !== input.grant ||
		entry.policy !== input.policy || entry.mirror !== input.mirror || batch.plan.ci !== input.ci)
		throw new Error("SWE_FROZEN_DISPATCH_SCOPE_INVALID");
	assertEntryFiles(entry, repository);
	const active = JSON.parse(readFileSync(join(batch.root, "active.json"), "utf8"));
	if (readFileSync(masterPath + ".used", "utf8") !== batch.masterSha256 ||
		active?.masterSha256 !== batch.masterSha256 || active.instanceId !== entry.instanceId || active.batchId !== entry.batchId)
		throw new Error("SWE_FROZEN_DISPATCH_INACTIVE");
}

/** Count the full per-case limit at dispatch. Any uncertain settlement stops the schedule. */
export function scheduleFrozenCases(
	cases: readonly { instanceId: string; batch: 1 | 2; blockedReason: string | null }[],
	execute: (instanceId: string) => FrozenScheduleResult,
	notify: (state: { reservedCents: number; stoppedReason: string | null; cases: Record<string, unknown>[] }) => void = () => {},
) {
	const state = { reservedCents: 0, stoppedReason: null as string | null, cases: [] as Record<string, unknown>[] };
	const phaseCents = { 1: 0, 2: 0 };
	for (const row of cases) {
		if (row.blockedReason) {
			state.cases.push({ ...row, status: "blocked" });
			continue;
		}
		if (state.reservedCents + FROZEN_CASE_COST_CENTS > FROZEN_TOTAL_COST_CENTS ||
			phaseCents[row.batch] + FROZEN_CASE_COST_CENTS > (row.batch === 1 ? 40 : 120)) {
			state.stoppedReason = "batch_budget_exhausted";
			break;
		}
		state.reservedCents += FROZEN_CASE_COST_CENTS;
		phaseCents[row.batch] += FROZEN_CASE_COST_CENTS;
		const record: Record<string, unknown> = { ...row, status: "started" };
		state.cases.push(record);
		notify(state);
		try {
			const outcome = execute(row.instanceId);
			Object.assign(record, outcome, { status: "finished" });
			if (!Number.isFinite(outcome.chargeUsd) || outcome.chargeUsd < 0 || outcome.chargeUsd > FROZEN_CASE_COST_CENTS / 100 + Number.EPSILON)
				state.stoppedReason = "batch_usage_invalid";
			else if (!outcome.continued) state.stoppedReason = outcome.reason ?? "batch_safety_stop";
		} catch {
			state.stoppedReason = "batch_dispatch_unconfirmed";
		}
		if (state.stoppedReason) break;
	}
	notify(state);
	return state;
}

function main(): void {
	const masterPath = process.argv[2];
	if (!masterPath || process.argv.length !== 3 || process.env.PI_ENHANCED_REAL_MODEL_EVAL !== "1" ||
		process.env.PI_ENHANCED_LOCAL_STUB_EVAL === "1") throw new Error("SWE_FROZEN_BATCH_UNAUTHORIZED");
	const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true }).trim();
	const commit = git("rev-parse", "HEAD");
	if (git("status", "--porcelain=v1")) throw new Error("SWE_FROZEN_DIRTY_CHECKOUT");
	const batch = loadBatch(masterPath, repository, commit);
	for (const entry of batch.plan.entries) {
		assertEntryFiles(entry, repository);
		const row = frozenCases.find((c) => c.instanceId === entry.instanceId)!;
		assertFrozenPytest(row, readSwePytestPolicy(entry.policy, entry.instanceId));
		const grant = loadTaskPairAuthorization(entry.grant, repository, commit, entry.batchId, batch.plan.ci, frozenProfile(row.order), true);
		if (grant.outputBase !== batch.plan.outputBase || existsSync(entry.grant + ".used") ||
			existsSync(join(grant.outputBase, grant.batchId))) throw new Error("SWE_FROZEN_CASE_ALREADY_CLAIMED");
	}
	mkdirSync(batch.root);
	writeFileSync(masterPath + ".used", batch.masterSha256, { flag: "wx", mode: 0o600 });
	const statusFile = join(batch.root, "status.json");
	const controller = fileURLToPath(new URL("./run-controlled.ts", import.meta.url));
	const state = scheduleFrozenCases(frozenCases, (id) => {
		const entry = batch.plan.entries.find((e) => e.instanceId === id)!;
		const row = frozenCases.find((c) => c.instanceId === id)!;
		atomicPrivateJson(join(batch.root, "active.json"), { masterSha256: batch.masterSha256, instanceId: id, batchId: entry.batchId });
		try {
			const child = spawnSync(process.execPath, [
				"--experimental-strip-types", controller, "--execute", "--comparison-profile", frozenProfile(row.order),
				"--swebench-id", id, "--swebench-mirror", entry.mirror, "--swe-pytest-policy", entry.policy,
				"--batch-id", entry.batchId, "--output-dir", batch.plan.outputBase, "--ci-evidence", batch.plan.ci,
				"--task-pair-authorization", entry.grant, "--swe-frozen-authorization", masterPath,
			], { cwd: repository, windowsHide: true, stdio: ["ignore", "inherit", "inherit"], timeout: 690_000 });
			if (child.status !== 0 || child.error) throw new Error("SWE_FROZEN_CHILD_FAILED");
			const report = JSON.parse(readFileSync(join(batch.plan.outputBase, entry.batchId, "batch.json"), "utf8"));
			const cell = report.cells?.[0];
			if (report.commit !== commit || cell?.instanceId !== id || report.cells.length !== 1)
				throw new Error("SWE_FROZEN_RESULT_SCOPE_INVALID");
			return { continued: report.stoppedReason === null && cell.continuationReady === true,
				chargeUsd: cell.result?.gateway?.actualCostUsd, reason: report.stoppedReason ?? undefined };
		} finally {
			atomicPrivateJson(join(batch.root, "active.json"), null);
		}
	}, (snapshot) => atomicPrivateJson(statusFile, { commit, ...snapshot }));
	if (state.stoppedReason) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
