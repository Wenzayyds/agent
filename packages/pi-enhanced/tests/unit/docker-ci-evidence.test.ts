import { describe, expect, it } from "vitest";
import { type DockerTestReport, requireDockerEvidence } from "../../scripts/ci/require-docker-evidence.ts";

function report(): DockerTestReport {
	return {
		numTotalTests: 24,
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
					...(file === "batch-n-observability.test.ts"
						? ["runs the SWE three-mode batch through production admission"]
						: []),
					...(file === "batch-j-runner.test.ts" ? ["enforces identity through real Pi"] : []),
					...(file === "real-agent-runner-e2e.test.ts"
						? ["keeps early-exit patch execution", "keeps isolated-attack patch execution"]
						: []),
				].map((fullName) => ({ fullName, status: "passed" })),
			}))
			.concat([
				{
					name: "/repo/tests/e2e/swebench-policy.test.ts",
					assertionResults: [
						...["off", "v1", "v2"].flatMap((mode) => [`edit_test in ${mode}`, `write_test in ${mode}`]),
						"budget in off",
						"export_failure in off",
						"abnormal_session in off",
					]
						.map((name) => ({ fullName: `SWE production policy ${name}`, status: "passed" }))
						.concat(
							[
								"no_patch",
								"requests",
								"cost",
								"timeout",
								"usage_failure",
								"container_failure",
								"audit_corrupt",
								"batch_cap",
							].map((name) => ({ fullName: `SWE independent continuation ${name}`, status: "passed" })),
						)
						.concat({ fullName: "rejects real-provider, wrong-run and expired Pi PID handshakes", status: "passed" }),
				},
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
					})).concat({
						fullName: "runs all five Flash OFF instances with distinct admission, fixed budgets and clean shutdown",
						status: "passed",
					}),
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
		const missingAdmission = report();
		missingAdmission.testResults[4]!.assertionResults.pop();
		expect(() => requireDockerEvidence(missingAdmission)).toThrow("CASE_MISSING");
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
		const missingPolicy = report();
		missingPolicy.testResults.at(-2)!.assertionResults.pop();
		expect(() => requireDockerEvidence(missingPolicy)).toThrow("SWE_POLICY_CASE_COUNT");
	});
	it("rejects every missing, skipped, failed, or duplicated required SWE case", () => {
		for (const suiteIndex of [6, 7]) {
			const count = report().testResults[suiteIndex]!.assertionResults.length;
			for (let index = 0; index < count; index++) {
				const missing = report();
				missing.testResults[suiteIndex]!.assertionResults.splice(index, 1);
				expect(() => requireDockerEvidence(missing)).toThrow();
				const skipped = report();
				skipped.testResults[suiteIndex]!.assertionResults[index]!.status = "pending";
				expect(() => requireDockerEvidence(skipped)).toThrow();
				const failed = report();
				failed.testResults[suiteIndex]!.assertionResults[index]!.status = "failed";
				expect(() => requireDockerEvidence(failed)).toThrow();
				const duplicate = report();
				duplicate.testResults[suiteIndex]!.assertionResults[index] =
					duplicate.testResults[suiteIndex]!.assertionResults[(index + 1) % count]!;
				expect(() => requireDockerEvidence(duplicate)).toThrow();
			}
		}
	});
});
