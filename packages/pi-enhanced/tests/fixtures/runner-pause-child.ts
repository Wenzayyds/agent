import childProcess from "node:child_process";
import fs, { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1];
const root = join(value("--output-dir"), value("--run-id"), "private");
const stale = process.argv.includes("--test-stale-finish");
const oldClaim = stale ? JSON.parse(readFileSync(join(root, "resume-owner.json"), "utf8")).claimId : undefined;
const { finishResumedRun } = await import("../../benchmarks/real-agent/runner-resume.ts");
const drift = process.argv.includes("--test-drift-after-retest");
const faultAtCheckpoint = process.argv.includes("--test-final-checkpoint-loss");
if (drift || faultAtCheckpoint) {
	const { TaskProvider } = await import("../../src/task-manager/provider.ts");
	const save = TaskProvider.prototype.createCheckpoint;
	TaskProvider.prototype.createCheckpoint = function (checkpoint) {
		if (faultAtCheckpoint) process.kill(process.pid, "SIGKILL");
		if (drift) childProcess.execFileSync(process.execPath, ["-e",
			'require("node:fs").appendFileSync(process.argv[1], "// concurrent change")', join(root, "config-default", "config.js")]);
		return save.call(this, checkpoint);
	};
}
if (process.argv.includes("--test-before-report")) {
	const publish = fs.linkSync;
	fs.linkSync = (source, target) => {
		if (String(target).endsWith("run.json")) throw new Error("TEST_REPORT_PUBLICATION_INTERRUPTED");
		return publish(source, target);
	};
	syncBuiltinESMExports();
}
const interrupt = process.argv.includes("--test-interrupt-after-write");
const beforeSpawn = process.argv.includes("--test-claim-before-spawn");
if (process.argv.includes("--test-claim-after-write")) {
	const { TaskService } = await import("../../src/task-manager/service.ts");
	const transition = TaskService.prototype.transitionStep;
	TaskService.prototype.transitionStep = function (...args) {
		if (args[1] === "repair" && args[3] === "running") process.kill(process.pid, "SIGKILL");
		return transition.apply(this, args);
	};
}
const beforeRegistration = process.argv.includes("--test-before-child-registration");
if (interrupt || beforeSpawn || beforeRegistration || stale) {
	const spawn = childProcess.spawn;
	const fault = fileURLToPath(new URL("runner-write-fault.ts", import.meta.url));
	childProcess.spawn = ((command: string, args: string[], options: childProcess.SpawnOptions) => {
		const agent = command === process.execPath && args?.includes("--mode") && args?.includes("--print");
		if (agent && stale) {
			const state = JSON.parse(JSON.parse(readFileSync(join(root, "previous-pause.json"), "utf8")).body);
			try {
				finishResumedRun({ root }, { ...state.prepared, recovery: { claimId: oldClaim } }, false, false, false,
					{ actualTotalTokens: 0, actualCostUsd: 0 });
				throw new Error("TEST_STALE_RESULT_ACCEPTED");
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "EVAL_V3_RESUME_OWNERSHIP_LOST") throw error;
				process.stderr.write("TEST_STALE_RESULT_REJECTED\n");
			}
		}
		if (agent && beforeSpawn) process.kill(process.pid, "SIGKILL");
		const child = spawn(command, agent && interrupt ? [...args.slice(0, 1), "--extension", fault, ...args.slice(1)] : args, options);
		if (agent && beforeRegistration) process.kill(process.pid, "SIGKILL");
		return child;
	}) as typeof spawn;
	syncBuiltinESMExports();
}
const { main } = await import("../../benchmarks/real-agent/run-real-agent.ts");
await main();

// The parent kills this Runner only after its pause record has been flushed.
if (!interrupt && existsSync(join(value("--output-dir"), value("--run-id"), "private", "pause.json")))
	setInterval(() => {}, 1_000);
