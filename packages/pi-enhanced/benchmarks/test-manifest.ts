import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

interface VitestJson {
	numTotalTests: number;
	numPassedTests: number;
	numFailedTests: number;
	numPendingTests: number;
	testResults: Array<{
		name: string;
		assertionResults: Array<{ fullName: string; status: string }>;
	}>;
}

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Vitest JSON report path is required");
const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJson;
const identities = report.testResults
	.flatMap((suite) =>
		suite.assertionResults.map((test) => {
			const normalized = suite.name.replaceAll("\\", "/");
			const marker = "/packages/pi-enhanced/";
			const markerIndex = normalized.indexOf(marker);
			const path = markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
			return `${path} :: ${test.fullName}`;
		}),
	)
	.sort((left, right) => left.localeCompare(right, "en-US"));
const baselinePath = process.argv[3] ?? new URL("../docs/batch-d-test-manifest-final.json", import.meta.url);
const outputPath = process.argv[4] ?? new URL("../docs/batch-e-test-manifest.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { identities: string[] };
const missingBaselineIdentities = baseline.identities.filter((identity) => !identities.includes(identity));
const sha256 = createHash("sha256").update(identities.join("\n")).digest("hex");
const manifest = {
	schemaVersion: 1,
	generatedAt: "2026-11-03",
	scope: "tests/unit + tests/integration + tests/e2e",
	count: identities.length,
	passed: report.numPassedTests,
	failed: report.numFailedTests,
	skipped: report.numPendingTests,
	sha256,
	baselineCount: baseline.identities.length,
	missingBaselineIdentities,
	identities,
};
if (identities.length !== report.numTotalTests || report.numFailedTests > 0 || missingBaselineIdentities.length > 0) {
	throw new Error(
		`Test manifest is incomplete or lost a baseline identity: identities=${identities.length} total=${report.numTotalTests} missing=${JSON.stringify(missingBaselineIdentities.slice(0, 3))}`,
	);
}
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ count: identities.length, sha256, missingBaselineIdentities })}\n`);
