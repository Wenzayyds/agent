import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const config = JSON.parse(readFileSync(join(here, "ablation-configs.json"), "utf8")) as {
	variants: Array<{ id: string }>;
	conditions: string[];
};
const execute = process.argv.includes("--execute");
if (!execute) {
	const matrix = config.variants.flatMap(({ id }) =>
		config.conditions.map((condition) => ({ variant: id, condition, status: "not_run" })),
	);
	const result = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		status: "not_run",
		reason: "No explicitly authorized model, API key, or spending budget was supplied",
		runs: 0,
		cost: 0,
		matrix,
	};
	writeFileSync(join(packageRoot, "docs", "p5-ablation-results.json"), `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ cells: matrix.length, status: result.status })}\n`);
	process.exit(0);
}
const baseRunId = argument("--run-id");
if (!baseRunId) throw new Error("Ablation execute requires --run-id");
const raw = process.argv.slice(2);
const passthrough: string[] = [];
for (let index = 0; index < raw.length; index++) {
	if (raw[index] === "--execute") continue;
	if (["--run-id", "--variant", "--condition"].includes(raw[index]!)) {
		index += 1;
		continue;
	}
	passthrough.push(raw[index]!);
}
const matrix = [];
for (const { id } of config.variants)
	for (const condition of config.conditions) {
		const cellRunId = `${baseRunId}_${id.replaceAll("-", "_")}_${condition}`;
		const child = spawnSync(
			process.execPath,
			[
				join(here, "../real-agent/run-real-agent.ts"),
				"--execute",
				...passthrough,
				"--run-id",
				cellRunId,
				"--variant",
				id,
				"--condition",
				condition,
			],
			{ cwd: packageRoot, stdio: "inherit", env: process.env },
		);
		if (child.status !== 0) throw new Error(`Ablation cell failed to execute: ${id}/${condition}`);
		matrix.push(JSON.parse(readFileSync(join(packageRoot, "docs", "p5-real-model-results.json"), "utf8")));
	}
writeFileSync(
	join(packageRoot, "docs", "p5-ablation-results.json"),
	`${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), status: "run", matrix }, null, 2)}\n`,
);

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}
