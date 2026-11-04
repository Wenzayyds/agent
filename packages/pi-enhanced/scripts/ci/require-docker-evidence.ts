import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DockerTestReport {
	numTotalTests: number;
	numFailedTests: number;
	numPendingTests: number;
	testResults: Array<{ name: string; assertionResults: Array<{ fullName: string; status: string }> }>;
}

/** The dedicated Linux job must execute these cases, rather than succeed by skipping Docker suites. */
export function requireDockerEvidence(report: DockerTestReport): void {
	if (!report.numTotalTests || report.numFailedTests || report.numPendingTests)
		throw new Error("CI_DOCKER_TESTS_NOT_ALL_PASSED");
	for (const file of [
		"sandbox-agent-session.test.ts",
		"controlled-batch.test.ts",
		"real-agent-runner-e2e.test.ts",
		"batch-j-runner.test.ts",
		"batch-n-observability.test.ts",
		"docker-verifier.test.ts",
	]) {
		const suites = report.testResults.filter((suite) => suite.name.replaceAll("\\", "/").endsWith(`/e2e/${file}`));
		if (
			!suites.length ||
			!suites.every(
				(suite) =>
					suite.assertionResults.length && suite.assertionResults.every((test) => test.status === "passed"),
			)
		)
			throw new Error(`CI_DOCKER_REQUIRED_SUITE_MISSING_OR_SKIPPED:${file}`);
	}
	const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
	for (const name of [
		"enforces identity through real Pi",
		"keeps early-exit patch execution",
		"keeps isolated-attack patch execution",
	]) {
		if (!assertions.some((test) => test.fullName.includes(name) && test.status === "passed"))
			throw new Error(`CI_DOCKER_REQUIRED_CASE_MISSING:${name}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.platform !== "linux") throw new Error("CI_LINUX_EVIDENCE_REQUIRED");
	const path = process.argv[2];
	if (!path) throw new Error("CI_DOCKER_REPORT_REQUIRED");
	const report = JSON.parse(readFileSync(path, "utf8")) as DockerTestReport;
	requireDockerEvidence(report);
	process.stdout.write(
		`${JSON.stringify({ status: "passed", platform: process.platform, tests: report.numTotalTests, skipped: 0 })}\n`,
	);
}
