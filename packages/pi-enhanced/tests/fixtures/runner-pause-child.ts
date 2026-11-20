import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const interrupt = process.argv.includes("--test-interrupt-after-write");
if (interrupt) {
	const spawn = childProcess.spawn;
	const fault = fileURLToPath(new URL("runner-write-fault.ts", import.meta.url));
	childProcess.spawn = ((command: string, args: string[], options: childProcess.SpawnOptions) => {
		const agent = command === process.execPath && args?.includes("--mode") && args?.includes("--print");
		return spawn(command, agent ? [...args.slice(0, 1), "--extension", fault, ...args.slice(1)] : args, options);
	}) as typeof spawn;
	syncBuiltinESMExports();
}
const { main } = await import("../../benchmarks/real-agent/run-real-agent.ts");
await main();

// The parent kills this Runner only after its pause record has been flushed.
const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1];
if (!interrupt && existsSync(join(value("--output-dir"), value("--run-id"), "private", "pause.json")))
	setInterval(() => {}, 1_000);
