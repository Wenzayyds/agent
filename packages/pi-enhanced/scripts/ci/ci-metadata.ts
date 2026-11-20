import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const output = process.argv[2];
if (!output) throw new Error("CI metadata output path is required");
const includeDocker = process.argv.includes("--docker");

const version = (command: string, args: string[]): string | null => {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		}).trim();
	} catch {
		return null;
	}
};

const metadata = {
	schemaVersion: 1,
	commit: process.env.GITHUB_SHA ?? null,
	runId: process.env.GITHUB_RUN_ID ?? null,
	job: process.env.GITHUB_JOB ?? null,
	runnerOs: process.env.RUNNER_OS ?? null,
	platform: `${process.platform}/${process.arch}`,
	node: process.version,
	npm: process.platform === "win32" ? version("cmd.exe", ["/d", "/s", "/c", "npm --version"]) : version("npm", ["--version"]),
	python: version(process.platform === "win32" ? "python" : "python3", ["--version"]),
	docker: includeDocker ? version(process.platform === "win32" ? "docker.exe" : "docker", ["version", "--format", "{{.Server.Version}}"]) : null,
};
writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(metadata)}\n`);
