import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const offline = readFileSync(resolve(root, ".github/workflows/pi-enhanced-ci.yml"), "utf8");
const paid = readFileSync(resolve(root, ".github/workflows/pi-enhanced-real-model-eval.yml"), "utf8");

describe("Batch G CI authorization boundaries", () => {
	it("keeps ordinary push and pull request CI offline and secret-free", () => {
		expect(offline).toContain("pull_request:");
		expect(offline).toContain("push:");
		expect(offline).not.toContain("PI_EVAL_API_KEY");
		expect(offline).not.toContain("--execute");
		expect(offline).toContain("tests/e2e/sandbox-agent-session.test.ts");
		expect(offline).toContain("permissions:\n  contents: read");
	});

	it("keeps paid evaluation behind workflow dispatch, environment approval, and the sandbox gate", () => {
		expect(paid).toContain("workflow_dispatch:");
		expect(paid).toContain("environment: pi-enhanced-paid-evaluation");
		expect(paid).toContain("--budget-enforcement local_hard_gateway");
		expect(paid).not.toContain("PI_ENHANCED_BUDGET_GATEWAY_CONFIRMED");
		expect(paid).toContain("PI_EVAL_API_KEY: ${{ secrets.PI_EVAL_API_KEY }}");
		expect(paid.indexOf("npm run test:sandbox")).toBeLessThan(paid.indexOf("--execute"));
		expect(paid).toContain("--sandbox-image sha256:");
		expect(offline).toContain("tests/e2e/gateway-sandbox-e2e.test.ts");
	});
});
