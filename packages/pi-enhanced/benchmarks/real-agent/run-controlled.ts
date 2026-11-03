import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROLLED_CELLS, CONTROLLED_IMAGE, CONTROLLED_LIMITS } from "./controlled-cases.ts";
import { controlledStopReason, type ControlledResult, verifyControlledCi } from "./controlled-policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../../..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const execute = process.argv.includes("--execute");
const batchId = argument("--batch-id");
const stub = argument("--local-stub-url");
if (!execute) { process.stdout.write(JSON.stringify({ status: "not_run", commit, limits: CONTROLLED_LIMITS, cells: CONTROLLED_CELLS })); process.exit(0); }
if (!batchId || !/^[a-z0-9][a-z0-9_]{7,39}$/u.test(batchId)) throw new Error("CONTROLLED_BATCH_ID_INVALID");
if (process.env.PI_ENHANCED_REAL_MODEL_EVAL !== "1") throw new Error("CONTROLLED_NOT_AUTHORIZED");
if (stub) {
	const url = new URL(stub);
	if (process.env.PI_ENHANCED_LOCAL_STUB_EVAL !== "1" || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("CONTROLLED_STUB_NOT_AUTHORIZED");
} else {
	const path = argument("--ci-evidence");
	if (!path) throw new Error("CONTROLLED_CI_REQUIRED");
	verifyControlledCi(JSON.parse(readFileSync(path, "utf8")), commit);
	if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repositoryRoot, encoding: "utf8" }).trim()) throw new Error("CONTROLLED_TRACKED_WORKTREE_DIRTY");
}
const outputBase = resolve(argument("--output-dir") ?? join(repositoryRoot, "packages/pi-enhanced/evaluation-output"));
mkdirSync(outputBase, { recursive: true });
const batchDir = join(outputBase, batchId);
// Exclusive directory creation makes a started or interrupted batch non-resumable.
mkdirSync(batchDir);
const cells: Array<{ id: string; status: string; result?: ControlledResult }> = CONTROLLED_CELLS.map(({ id }) => ({ id, status: "not_run" }));
let stoppedReason: string | null = null;
let reservedMaximumUsd = 0;
const save = () => writeFileSync(join(batchDir, "batch.json"), JSON.stringify({ schemaVersion: 1, batchId, commit, evaluationClass: stub ? "simulated_provider_real_runner_task" : "real_model_coding_agent_task", limits: CONTROLLED_LIMITS, reservedMaximumUsd, stoppedReason, cells }, null, 2));
save();
for (let index = 0; index < CONTROLLED_CELLS.length; index++) {
	const spec = CONTROLLED_CELLS[index]!;
	const state = cells[index]!;
	if (reservedMaximumUsd + CONTROLLED_LIMITS.maxCostUsd > CONTROLLED_LIMITS.maxBatchCostUsd + Number.EPSILON) { stoppedReason = "batch_budget_reservation"; save(); break; }
	reservedMaximumUsd += CONTROLLED_LIMITS.maxCostUsd;
	state.status = "started"; save();
	const runId = `${batchId}_${spec.id}`;
	const args = ["--experimental-strip-types", join(here, "run-real-agent.ts"), "--execute", "--controlled-cell", spec.id, "--run-id", runId, "--provider", "deepseek", "--model", "deepseek-flash", "--api-key-env", stub ? "MOCK_PROVIDER_KEY" : "DEEPSEEK_API_KEY", "--max-total-cost-usd", "0.03", "--max-tasks", "1", "--max-tokens-per-task", "40000", "--max-calls-per-task", "8", "--timeout-ms", "180000", "--concurrency", "1", "--budget-enforcement", "local_hard_gateway", "--output-dir", batchDir, "--sandbox-image", CONTROLLED_IMAGE, ...(stub ? ["--local-stub-url", stub] : [])];
	const child = spawnSync(process.execPath, args, { cwd: repositoryRoot, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 210_000, maxBuffer: 8 * 1024 * 1024 });
	if (child.status !== 0 || child.error) { state.status = "execution_error"; stoppedReason = "runner_or_isolation_failure"; save(); break; }
	try {
		const report = JSON.parse(readFileSync(join(batchDir, runId, "run.json"), "utf8")) as { results: ControlledResult[] };
		const result = report.results[0];
		if (!result || result.controlledCell !== spec.id) throw new Error("CONTROLLED_RESULT_MISMATCH");
		state.result = result;
		state.status = "run";
		stoppedReason = controlledStopReason(result);
	} catch { state.status = "evidence_error"; stoppedReason = "result_evidence_invalid"; }
	save();
	if (stoppedReason) break;
}
process.stdout.write(JSON.stringify({ batchId, started: cells.filter((c) => c.status !== "not_run").length, stoppedReason, report: join(batchDir, "batch.json") }));

function argument(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
