import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { atomicPrivateJson } from "../../src/sandbox/audit.ts";
import { assertSandboxWorkspaceIdentity } from "../../src/sandbox/config.ts";
import { createSandboxExtension } from "../../src/sandbox/extension.ts";
import { createPytestExecutor, isPytestConfig, MAX_PYTEST_TARGETS, pytestFileVersions, type PytestConfig, type PytestEvidence } from "../../src/sandbox/pytest.ts";
import { digest } from "./evaluation-identity.ts";
import { runSweGit as git } from "./swe-git.ts";
import { readSwePatch, safePatchPath } from "./swe-patch.ts";
import type { SweTask } from "./swe-workspace.ts";

export interface SwePytestPolicy extends PytestConfig {
	instanceId: string;
	baseCommit: string;
}

function parsePolicy(value: unknown, instanceId?: string): SwePytestPolicy {
	if (!isPytestConfig(value, true)) throw new Error("SWE_PYTEST_POLICY_INVALID");
	const policy = value as SwePytestPolicy;
	if (
		Object.keys(policy).some((key) => !["instanceId", "baseCommit", "image", "files", "tests", "timeoutMs", "candidateImport"].includes(key)) ||
		typeof policy.instanceId !== "string" || !/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+-\d+$/u.test(policy.instanceId) ||
		(instanceId !== undefined && policy.instanceId !== instanceId) ||
		typeof policy.baseCommit !== "string" || !/^[a-f0-9]{40}$/u.test(policy.baseCommit) ||
		(policy.candidateImport === "pytest" && !policy.instanceId.startsWith("pytest-dev__pytest-")) ||
		(policy.candidateImport === "requests" && !policy.instanceId.startsWith("psf__requests-")) ||
		new Set(policy.tests).size !== policy.tests.length ||
		!policy.tests.every((target) => {
			const file = target.split("::")[0]!;
			return /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/u.test(file) && !safePatchPath(file);
		})
	) throw new Error("SWE_PYTEST_POLICY_INVALID");
	return policy;
}

export function readSwePytestPolicy(path: string, instanceId: string): SwePytestPolicy {
	return parsePolicy(JSON.parse(readFileSync(path, "utf8")), instanceId);
}

export function assertSwePytestWorkspace(policy: SwePytestPolicy, task: SweTask | undefined, cwd: string): void {
	if (task?.issue.instance_id !== policy.instanceId || task.issue.base_commit !== policy.baseCommit)
		throw new Error("SWE_PYTEST_SCOPE_INVALID");
	const tracked = new Set(git(cwd, ["ls-files", "-z"]).split("\0"));
	if (!policy.files.every((path) => tracked.has(path))) throw new Error("SWE_PYTEST_UNTRACKED_FILE");
}

const evidenceName = "swe-local-verification.json";
type Verification = {
	status: "passed" | "failed" | "skipped" | "unavailable";
	reason: string;
	patchSha256: string | null;
	targets: string[];
	exitCode: number | null;
	passed: number | null;
	failed: number | null;
};

export function sweVerificationStatus(root: string, patchSha256: string | null): Verification & { checks?: Verification[] } {
	const unavailable: Verification = {
		status: "unavailable", reason: "not_run", patchSha256, targets: [], exitCode: null, passed: null, failed: null,
	};
	try {
		const attempts = JSON.parse(readFileSync(join(root, evidenceName), "utf8")) as Verification[];
		const current = attempts.filter((attempt) => attempt.patchSha256 === patchSha256);
		if (patchSha256 === null) return { ...unavailable, reason: current.at(-1)?.status === "unavailable" ? current.at(-1)!.reason : "no_exported_patch" };
		const tested = new Map<string, Verification>();
		for (const attempt of current) {
			if (attempt.status === "unavailable") continue;
			const key = JSON.stringify([...attempt.targets].sort());
			// Older executors reported a zero exit with no passing tests as a pass.
			tested.set(key, attempt.status === "passed" && attempt.passed === 0
				? { ...attempt, status: "unavailable", reason: "no_completed_passes" } : attempt);
		}
		const checks = [...tested.values()];
		const summary = checks.find((attempt) => attempt.status === "failed") ??
			checks.find((attempt) => attempt.status !== "passed") ?? checks.at(-1) ?? current.at(-1) ??
			{ ...unavailable, reason: attempts.length ? "patch_changed_or_unavailable" : "not_run" };
		// Selectors can overlap. Preserve each result without adding its counts twice.
		return checks.length > 1 ? { ...summary, checks } : summary;
	} catch {
		return unavailable;
	}
}

/** Bind tool availability and the host policy to the first-request fingerprint. */
export function createSweTestFeedback(policy: SwePytestPolicy, configSource?: Parameters<typeof createSandboxExtension>[0]) {
	return createSandboxExtension(configSource, undefined, undefined, false, (pi, config, isActive) => {
		const execute = createPytestExecutor(config, policy, true);
		const smokeOnlyTarget = policy.instanceId === "psf__requests-1142"
			? "test_requests.py::RequestsTestCase::test_basic_building" : undefined;
		const attempts: Verification[] = [];
		let unavailable = false;
		let busy = false;
		pi.registerTool({
			name: "run_tests",
			label: "Run approved public pytest tests",
			description: "Run approved public repository tests in an isolated snapshot. Select related files or file.py::test_name. After a source edit, use test feedback to revise the patch and rerun if budget permits. Stop with the validation status if tests are unavailable. Approved targets: " +
				policy.tests.join(", ") + ". Policy SHA-256 " + digest(policy) + ".",
			parameters: Type.Object({
				targets: Type.Array(Type.String({ maxLength: 240 }), { minItems: 1, maxItems: MAX_PYTEST_TARGETS }),
			}, { additionalProperties: false }),
			async execute(_id, { targets }, signal) {
				const feedback = (value: object, isError = false) => ({
					content: [{ type: "text" as const, text: JSON.stringify(value) }],
					details: undefined,
					isError,
				});
				if (!isActive()) return feedback({ status: "unavailable", reason: "inactive_sandbox" }, true);
				if (busy || unavailable || attempts.length >= 3)
					return feedback({ status: "unavailable", reason: "busy_or_test_limit", canRunAgain: false });
				busy = true;
				try {
					assertSandboxWorkspaceIdentity(config);
					const changed = () => git(config.workspace, ["diff", "--name-only", "-z", "HEAD", "--"]).split("\0").filter(Boolean);
					const changesFitSnapshot = () => changed().every((file) => safePatchPath(file) && policy.files.includes(file));
					const patch = readSwePatch(config.workspace);
					const patchSha256 = patch ? digest(patch) : null;
					if (!changesFitSnapshot() ||
						git(config.workspace, ["diff", "--cached", "--name-only"]) ||
						git(config.workspace, ["ls-files", "--others", "-z"]))
						return feedback({ status: "unavailable", reason: "patch_outside_test_snapshot", canRunAgain: false });
					let snapshot: PytestEvidence | undefined;
					const result = await execute(targets, signal, (evidence) => { snapshot = evidence; });
					if (result.status === "sandbox_error" && result.output !== "Test execution limit reached.")
						return feedback({ status: "unavailable", reason: "sandbox_error", output: result.output }, true);
					let status: Verification["status"] = "unavailable";
					let reason: string = result.status;
					if (snapshot && (result.status === "passed" || result.status === "failed" || result.status === "skipped")) {
						const live = pytestFileVersions(config, policy);
						if (changesFitSnapshot() && readSwePatch(config.workspace) === patch &&
							[...snapshot.files].every(([path, hash]) => live.get(path) === hash)) {
							status = result.status;
							reason = status === "passed" && targets.every((target) => target === smokeOnlyTarget)
								? "request_construction_only_issue_unverified" : "pytest";
						} else {
							reason = "patch_changed_during_tests";
						}
					}
					if (result.status === "execution_error" || result.output === "Test execution limit reached.") unavailable = true;
					const attempt = { status, reason, patchSha256, targets: result.targets, exitCode: result.exitCode, passed: result.passed, failed: result.failed };
					attempts.push(attempt);
					atomicPrivateJson(join(config.runRoot, evidenceName), attempts);
					return feedback({ ...result, status, reason, patchSha256, canRunAgain: !unavailable && attempts.length < 3 && (snapshot?.canRunAgain ?? true) });
				} catch {
					return feedback({ status: "unavailable", reason: "sandbox_or_evidence_error" }, true);
				} finally {
					busy = false;
				}
			},
		});
	});
}

export default function sweTestFeedback(pi: Parameters<ReturnType<typeof createSandboxExtension>>[0]): void {
	createSweTestFeedback(parsePolicy(JSON.parse(process.env.PI_ENHANCED_SWE_PYTEST_POLICY ?? "null")))(pi);
}
