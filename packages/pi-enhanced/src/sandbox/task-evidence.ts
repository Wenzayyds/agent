import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "./config.ts";
import { type PytestConfig, type PytestEvidence, type PytestResult, pytestFileVersions } from "./pytest.ts";

export interface PytestSnapshot {
	workspaceId: string;
	patchHash: string;
	testHash: string;
	policyHash: string;
}
export interface PytestReceipt extends PytestSnapshot {
	runId: string;
	target: string;
	usedDefaultTargets?: true;
	status: PytestResult["status"];
	exitCode: number | null;
	completedPasses: number | null;
	// Parsed terminal counts are diagnostic only. They never authorize a transition.
	passed: number | null;
	failed: number | null;
}

export interface TaskPytestSource {
	workspace: string;
	current(target: string): PytestSnapshot | undefined;
}
type ReceiptSink = (receipt: PytestReceipt) => void;
type OpenAttempt = (workspace: string, toolCallId: string) => ReceiptSink | undefined;
const attemptChannel = "pi-enhanced:task:open-pytest-attempt";

export function registerPytestAttempts(events: Events, open: OpenAttempt) {
	return events.on(attemptChannel, (request) => {
		if (typeof request === "function") request(open);
	});
}

const channel = "pi-enhanced:sandbox:task-pytest-source";
type Events = Pick<ExtensionAPI, "events">["events"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function taskPytestSource(events: Events, workspace: string): TaskPytestSource | undefined {
	const matches: TaskPytestSource[] = [];
	events.emit(channel, (source: TaskPytestSource) => {
		if (source.workspace === workspace) matches.push(source);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

export function registerTaskPytestSource(
	events: Events,
	config: SandboxConfig,
	policy: PytestConfig,
	active: () => boolean,
) {
	const workspaceId = hash([config.workspace, config.workspaceDevice, config.workspaceInode]);
	const policyHash = hash([
		policy.image,
		[...policy.files].sort(),
		[...policy.tests].sort(),
		policy.timeoutMs ?? 30_000,
		policy.candidateImport ?? null,
	]);
	const snapshot = (target: string, files: ReadonlyMap<string, string>): PytestSnapshot | undefined => {
		const file = target.split("::")[0]!;
		const testHash = files.get(file);
		if (!testHash || !(policy.tests.includes(file) || policy.tests.includes(target))) return undefined;
		const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return { workspaceId, testHash, patchHash: hash(entries), policyHash };
	};
	const source: TaskPytestSource = {
		workspace: config.workspace,
		current(target) {
			if (!active()) return undefined;
			try {
				return snapshot(target, pytestFileVersions(config, policy));
			} catch {
				return undefined;
			}
		},
	};
	const close = events.on(channel, (reply) => {
		if (active() && typeof reply === "function") reply(source);
	});
	return {
		close,
		begin(id: string, usedDefaultTargets: boolean) {
			const sinks: ReceiptSink[] = [];
			events.emit(attemptChannel, (open: OpenAttempt) => {
				const sink = open(config.workspace, id);
				if (sink) sinks.push(sink);
			});
			if (sinks.length !== 1) return undefined;
			const record = sinks[0]!;
			return (evidence: PytestEvidence, result: PytestResult) => {
				if (!active() || evidence.targets.length !== 1) return;
				const target = evidence.targets[0]!;
				const identity = snapshot(target, evidence.files);
				if (identity)
					record({
						...identity,
						runId: config.runId,
						target,
						...(usedDefaultTargets ? { usedDefaultTargets: true } : {}),
						status: evidence.status,
						completedPasses: evidence.completedPasses ?? null,
						exitCode: result.exitCode,
						passed: result.passed,
						failed: result.failed,
					});
			};
		},
	};
}
