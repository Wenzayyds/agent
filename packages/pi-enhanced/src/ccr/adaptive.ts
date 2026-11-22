import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PytestEvidence } from "../sandbox/pytest.ts";

const provider = "local-ccr";
const flash = "DeepSeek/deepseek-flash";
const pro = "DeepSeek/deepseek-v4-pro";
const readOnlyTools = new Set(["read", "find", "grep", "ls"]);
type Versions = ReadonlyMap<string, string>;

interface RepairState {
	failures: number;
	target?: string;
	failedVersions: readonly string[];
}

const initialRepairState: RepairState = { failures: 0, failedVersions: [] };

export function assessPytest(
	state: RepairState,
	evidence: Pick<PytestEvidence, "status" | "canRunAgain">,
	version: string,
	target: string,
	hasRepair: boolean,
): { state: RepairState; eligible: boolean; reason: string } {
	if (evidence.status === "passed") return { state: initialRepairState, eligible: false, reason: "pytest_passed" };
	if (evidence.status !== "failed") return { state, eligible: false, reason: evidence.status };
	if (!hasRepair || state.failedVersions.includes(version)) return { state, eligible: false, reason: "no_new_repair" };

	const failures = state.target === target ? state.failures + 1 : 1;
	const next = { failures, target, failedVersions: [...state.failedVersions, version] };
	if (failures < 2) return { state: next, eligible: false, reason: "first_repair_failure" };
	if (!evidence.canRunAgain) return { state: next, eligible: false, reason: "pytest_limit" };
	return { state: next, eligible: true, reason: "two_repair_failures" };
}

/** The only evidence source is the Sandbox instance owning these tools. */
export function registerAdaptiveRouter(
	pi: ExtensionAPI,
	readVersions: () => Versions | undefined,
	testFiles: () => readonly string[],
	relativePath: (path: string) => string | undefined,
): (id: string, result: PytestEvidence) => void {
	let versions: Versions | undefined;
	let repair: RepairState = initialRepairState;
	let hasRepair = false;
	let active = false;
	let upgraded = false;
	let epoch = 0;
	let input = 0;
	let output = 0;
	let evidence: { id: string; result: PytestEvidence } | undefined;

	const resetTask = () => {
		epoch++;
		versions = undefined;
		repair = initialRepairState;
		hasRepair = false;
		evidence = undefined;
	};
	const disable = () => {
		active = false;
		resetTask();
	};
	const record = (
		ctx: ExtensionContext,
		reason: string,
		model = ctx.model?.id,
		target = repair.target,
		version?: string,
	) => {
		pi.appendEntry("ccr-adaptive", {
			model,
			failures: repair.failures,
			target,
			version,
			upgrades: Number(upgraded),
			reason,
		});
		ctx.ui.setStatus("ccr-adaptive", "CCR " + model + " · " + reason);
	};
	pi.on("session_start", (event, ctx) => {
		resetTask();
		upgraded = false;
		input = 0;
		output = 0;
		active =
			(event.reason === "startup" || event.reason === "new") &&
			ctx.model?.provider === provider &&
			ctx.model.id === flash &&
			!ctx.sessionManager
				.getBranch()
				.some((entry) => entry.type === "message" && entry.message.role === "assistant");
	});
	pi.on("session_before_switch", disable);
	pi.on("session_before_fork", disable);
	pi.on("session_shutdown", disable);
	pi.on("session_tree", disable);
	pi.on("user_bash", disable);
	pi.on("input", resetTask);
	pi.on("model_select", (event) => {
		if (event.previousModel?.id !== event.model.id || event.previousModel?.provider !== event.model.provider)
			disable();
	});
	pi.on("before_agent_start", () => {
		resetTask();
		if (active) {
			versions = readVersions();
			if (versions) repair = { failures: 0, failedVersions: [versionId(versions)] };
		}
	});
	pi.on("tool_call", (event) => {
		if (!active || !versions || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const current = readVersions();
		if (!current || versionId(current) !== versionId(versions)) resetTask();
	});
	pi.on("turn_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		input += event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite;
		output += event.message.usage.output;
		const test = evidence;
		evidence = undefined;
		if (!active || upgraded || ctx.model?.provider !== provider || ctx.model.id !== flash) return;
		if (event.message.provider !== provider || event.message.model !== flash || event.outcome !== "completed") {
			resetTask();
			return;
		}
		const current = readVersions();
		if (!versions || !current) {
			record(ctx, "source_version_unavailable");
			resetTask();
			return;
		}
		const changed = [...current.keys()].filter((file) => current.get(file) !== versions?.get(file));
		const version = versionId(current);
		versions = current;
		const calls = event.message.content.filter((part) => part.type === "toolCall");
		const call = calls[0];
		const result = event.toolResults[0];
		const paired = calls.length === 1 && event.toolResults.length === 1 && call?.id === result?.toolCallId;
		const hasUnknownTools = calls.some(
			(tool) =>
				!readOnlyTools.has(tool.name) && tool.name !== "edit" && tool.name !== "write" && tool.name !== "run_tests",
		);
		const write = calls.some((tool) => tool.name === "edit" || tool.name === "write");
		if (hasUnknownTools || write || changed.length > 0) {
			const isWrite = paired && (call.name === "edit" || call.name === "write");
			const path =
				isWrite && typeof call.arguments.path === "string" ? relativePath(call.arguments.path) : undefined;
			if (
				!path ||
				!current.has(path) ||
				testFiles().includes(path) ||
				result.isError ||
				changed.some((file) => file !== path)
			) {
				record(ctx, "unverified_write", ctx.model.id, repair.target, version);
				resetTask();
				return;
			}
			if (changed.length > 0) {
				hasRepair = true;
				record(ctx, "source_changed", ctx.model.id, repair.target, version);
			}
			return;
		}
		if (!test) return;
		if (!paired || call.name !== "run_tests" || call.id !== test.id || versionId(test.result.files) !== version) {
			record(ctx, "unverified_test_snapshot", ctx.model.id, repair.target, version);
			resetTask();
			return;
		}
		const target = JSON.stringify([...new Set(test.result.targets)].sort());
		const decision = assessPytest(repair, test.result, version, target, hasRepair);
		repair = decision.state;
		if (test.result.status === "failed" || test.result.status === "passed") hasRepair = false;
		record(ctx, decision.reason, ctx.model.id, target, version);
		if (!decision.eligible) return;

		const model = ctx.scopedModels.find(
			({ model }) =>
				model.provider === provider &&
				model.id === pro &&
				model.api === ctx.model?.api &&
				model.baseUrl === ctx.model?.baseUrl,
		)?.model;
		if (!model || !ctx.hasUI || !ctx.signal || ctx.signal.aborted || ctx.hasPendingMessages()) {
			record(ctx, "upgrade_unavailable", ctx.model.id, target, version);
			return;
		}
		const promptEpoch = epoch;
		const approved = await ctx.ui.confirm(
			"CCR 切换到 DeepSeek Pro",
			"两次代码修复后的 pytest 均失败。当前 DeepSeek Flash 已知会话用量为输入 " +
				input +
				"、输出 " +
				output +
				" Token。是否允许本会话接下来使用 Pro？",
			{ signal: ctx.signal },
		);
		if (!active || epoch !== promptEpoch || ctx.signal.aborted || ctx.hasPendingMessages()) return;
		const latest = readVersions();
		if (!approved || !latest || versionId(latest) !== version) {
			record(
				ctx,
				approved ? "source_changed_during_confirmation" : "upgrade_declined",
				ctx.model.id,
				target,
				version,
			);
			disable();
			return;
		}
		const failures = repair.failures;
		try {
			upgraded = await pi.setModel(model);
		} catch {
			upgraded = false;
		}
		// model_select invalidates previous evidence, including our own switch.
		if (upgraded) {
			pi.appendEntry("ccr-adaptive", {
				model: model.id,
				failures,
				target,
				version,
				upgrades: 1,
				reason: "upgrade_confirmed",
			});
			ctx.ui.setStatus("ccr-adaptive", "CCR " + model.id + " · upgrade_confirmed");
		} else {
			record(ctx, "model_switch_failed", ctx.model.id, target, version);
			disable();
		}
	});
	return (id, result) => {
		if (active) evidence = { id, result };
	};
}

function versionId(files: Versions): string {
	return createHash("sha256")
		.update(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
}
