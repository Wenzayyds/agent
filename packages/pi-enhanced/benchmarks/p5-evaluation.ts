import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_COMMIT_DATE = "2026-01-01T00:00:00Z";
const root = mkdtempSync(join(tmpdir(), "pi-p5-evaluation-"));
const results: Array<Record<string, unknown>> = [];

try {
	for (let index = 1; index <= 8; index++) {
		const repo = join(root, `task-${index}`);
		execFileSync("git", ["init", repo], { stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "evaluation@example.invalid"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Evaluation Fixture"], { cwd: repo });
		writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", private: true }));
		writeFileSync(join(repo, "value.js"), `export function value() { return ${index}; }\n`);
		writeFileSync(
			join(repo, "test.mjs"),
			`import { value } from "./value.js"; if (value() !== ${index + 1}) { throw new Error("expected ${index + 1}"); }\n`,
		);
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-m", "deterministic fixture"], {
			cwd: repo,
			stdio: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE,
				GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE,
			},
		});
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		const started = performance.now();
		const before = readFileSync(join(repo, "value.js"), "utf8");
		writeFileSync(join(repo, "value.js"), before.replace(`return ${index};`, `return ${index + 1};`));
		let patchValid = false;
		let testPassed = false;
		try {
			execFileSync("git", ["diff", "--check"], { cwd: repo, stdio: "ignore" });
			patchValid = true;
		} catch {}
		try {
			execFileSync(process.execPath, ["test.mjs"], { cwd: repo, stdio: "ignore", timeout: 5_000 });
			testPassed = true;
		} catch {}
		results.push({
			taskId: `deterministic-mini-repo-${index}`,
			executionClass: "deterministic_tool_replay",
			repository: "generated-local-fixture",
			repositoryCommit: commit,
			patchValid,
			testPassed,
			status: patchValid && testPassed ? "passed" : "failed",
			durationMs: Number((performance.now() - started).toFixed(3)),
		});
	}

	const passed = results.filter(({ status }) => status === "passed").length;
	const report = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		classification: {
			deterministicToolReplay: "run",
			realModelCodingAgentTasks: "not_run",
			officialSweBench: "not_run",
		},
		disclaimer:
			"该结果只衡量固定本地夹具的工具回放和验证器，不代表真实模型编程任务成功率，也不是官方 SWE-bench 结果。",
		environment: { node: process.version, platform: process.platform, architecture: process.arch },
		fixture: { taskCount: results.length, fixedCommitDate: FIXTURE_COMMIT_DATE },
		summary: { passed, failed: results.length - passed, passRate: passed / results.length },
		results,
	};
	writeFileSync(new URL("../docs/p5-evaluation-results.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify(report.summary)}\n`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
