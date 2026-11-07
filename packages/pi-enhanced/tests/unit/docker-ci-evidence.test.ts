import { describe, expect, it } from "vitest";
import { type DockerTestReport, requireDockerEvidence } from "../../scripts/ci/require-docker-evidence.ts";

function report(): DockerTestReport {
	return {
		numTotalTests: 14,
		numFailedTests: 0,
		numPendingTests: 0,
		testResults: [
			"sandbox-agent-session.test.ts",
			"controlled-batch.test.ts",
			"real-agent-runner-e2e.test.ts",
			"batch-j-runner.test.ts",
			"batch-n-observability.test.ts",
			"docker-verifier.test.ts",
		]
			.map((file) => ({
				name: `/repo/tests/e2e/${file}`,
				assertionResults: [
					"suite passes",
					...(file === "batch-j-runner.test.ts" ? ["enforces identity through real Pi"] : []),
					...(file === "real-agent-runner-e2e.test.ts"
						? ["keeps early-exit patch execution", "keeps isolated-attack patch execution"]
						: []),
				].map((fullName) => ({ fullName, status: "passed" })),
			}))
			.concat([
				{
					name: "/repo/tests/e2e/swebench-stub.test.ts",
					assertionResults: [
						["astropy__astropy-13033", "off"],
						["astropy__astropy-13033", "v1"],
						["astropy__astropy-13033", "v2"],
						["astropy__astropy-13453", "off"],
						["astropy__astropy-14365", "v2"],
					].map(([id, mode]) => ({
						fullName: `exports an applicable non-Gold Stub patch for ${id} in ${mode}`,
						status: "passed",
					})),
				},
			]),
	};
}

describe("Linux Docker CI evidence requirements", () => {
	it("accepts only actually executed critical suites and cases", () => {
		expect(() => requireDockerEvidence(report())).not.toThrow();
	});
	it("rejects skipped Docker tests even when Vitest exits successfully", () => {
		const r = report();
		r.numPendingTests = 1;
		expect(() => requireDockerEvidence(r)).toThrow("NOT_ALL_PASSED");
	});
	it("rejects missing verifier or identity evidence", () => {
		const missingSuite = report();
		missingSuite.testResults = missingSuite.testResults.filter(
			(suite) => !suite.name.endsWith("docker-verifier.test.ts"),
		);
		expect(() => requireDockerEvidence(missingSuite)).toThrow("SUITE_MISSING");
		const missingCase = report();
		missingCase.testResults[3]!.assertionResults.pop();
		expect(() => requireDockerEvidence(missingCase)).toThrow("CASE_MISSING");
	});
	it("rejects a nominally green SWE suite with a missing or duplicated mode", () => {
		const missing = report();
		missing.testResults.at(-1)!.assertionResults.pop();
		expect(() => requireDockerEvidence(missing)).toThrow("SWE_CASE_COUNT");
		const duplicate = report();
		duplicate.testResults.at(-1)!.assertionResults[2] = duplicate.testResults.at(-1)!.assertionResults[1]!;
		expect(() => requireDockerEvidence(duplicate)).toThrow("SWE_CASE_COUNT");
		const skipped = report();
		skipped.testResults.at(-1)!.assertionResults[0]!.status = "pending";
		expect(() => requireDockerEvidence(skipped)).toThrow("SUITE_MISSING_OR_SKIPPED");
	});
});
