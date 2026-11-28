import type { SandboxConfig } from "../sandbox/config.ts";
import { createPytestExecutor, type PytestConfig } from "../sandbox/pytest.ts";
import { createTaskPytestEvidence, type PytestSnapshot } from "../sandbox/task-evidence.ts";
import type { DelegatedTask, TestReport } from "./protocol.ts";

export const pytestPassed = (receipt: TestReport["receipt"]): boolean =>
	receipt.status === "passed" && receipt.exitCode === 0 && (receipt.completedPasses ?? 0) > 0;

export function samePytestSnapshot(a: PytestSnapshot | undefined, b: PytestSnapshot): boolean {
	return (
		a?.patchHash === b.patchHash &&
		a.workspaceId === b.workspaceId &&
		a.testHash === b.testHash &&
		a.policyHash === b.policyHash
	);
}

export function createTestExecution(sandbox: SandboxConfig, policy: PytestConfig) {
	const pytest = createPytestExecutor(sandbox, policy);
	const evidence = createTaskPytestEvidence(sandbox, policy, () => true);
	return {
		async run(
			operation: Pick<DelegatedTask, "operationId" | "subtaskId">,
			sessionId: string,
			target: string,
			expected: PytestSnapshot,
			signal: AbortSignal | undefined,
			observe: (report: TestReport) => void,
		) {
			if (!samePytestSnapshot(evidence.source.current(target), expected)) throw new Error("MA1_STALE_WORKSPACE");
			let recorded = false;
			await pytest(
				[target],
				signal,
				(snapshot, outcome) => {
					const receipt = evidence.receipt(snapshot, outcome);
					if (!receipt || receipt.target !== target || !samePytestSnapshot(receipt, expected))
						throw new Error("MA1_RECEIPT_INVALID");
					observe({
						operationId: operation.operationId,
						subtaskId: operation.subtaskId,
						sessionId,
						workspaceRevision: expected.patchHash,
						approvedTarget: target,
						executedTarget: receipt.target,
						receipt,
						output: Buffer.from(outcome.output).subarray(0, 768).toString("utf8"),
						outputTruncated: outcome.truncated || Buffer.byteLength(outcome.output) > 768,
						failureKind: pytestPassed(receipt)
							? "none"
							: receipt.status === "failed" && (receipt.failed ?? 0) > 0
								? "assertion"
								: "test-failure",
					});
					recorded = true;
				},
			);
			if (!recorded) throw new Error("MA1_RECEIPT_MISSING");
		},
	};
}
