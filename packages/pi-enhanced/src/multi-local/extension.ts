import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadSandboxConfig } from "../sandbox/config.ts";
import { isPytestConfig } from "../sandbox/pytest.ts";
import { runMultiLocal } from "./coordinator.ts";
import { loadRoleModelOverrides } from "./model-config.ts";
import type { MultiLocalRequest } from "./protocol.ts";

export default function multiLocal(pi: ExtensionAPI): void {
	let active: AbortController | undefined;
	pi.on("session_shutdown", () => {
		active?.abort();
	});
	pi.registerCommand("enhanced-multi", {
		description: "Run an opted-in Code/Test task with local or A2A transport",
		handler: async (args, ctx) => {
			if (active || !ctx.hasUI || !ctx.isIdle() || !ctx.isProjectTrusted()) {
				ctx.ui.notify("MA-1 requires an idle, trusted interactive session.", "warning");
				return;
			}
			try {
				const sandbox = loadSandboxConfig(process.env, ctx.cwd);
				const pytest: unknown = JSON.parse(process.env.PI_ENHANCED_PYTEST_CONFIG_JSON ?? "null");
				const baseUrl = process.env.PI_ENHANCED_MA1_LOCAL_URL ?? "";
				const apiKey = process.env.PI_ENHANCED_MA1_LOCAL_KEY ?? "";
				const modelId = process.env.PI_ENHANCED_MA1_LOCAL_MODEL ?? "deepseek-flash";
				if (
					!sandbox.enabled ||
					!sandbox.trusted ||
					!isPytestConfig(pytest) ||
					!/^http:\/\/127\.0\.0\.1:\d+$/u.test(baseUrl) ||
					!apiKey
				)
					throw new Error("MA1_LOCAL_HOST_CONFIG_REQUIRED");
				const command = /^(start|resume)(-a2a)? (.+)$/su.exec(args.trim());
				if (!command) throw new Error("Usage: /enhanced-multi start[-a2a] <JSON> | resume[-a2a] <task-id>");
				const remoteTest = command[2]
					? {
							origin: process.env.PI_ENHANCED_A2A_URL ?? "",
							principalId: process.env.PI_ENHANCED_A2A_PRINCIPAL ?? "",
							token: process.env.PI_ENHANCED_A2A_TOKEN ?? "",
							timeoutMs:
								process.env.PI_ENHANCED_A2A_TIMEOUT_MS === undefined
									? undefined
									: Number(process.env.PI_ENHANCED_A2A_TIMEOUT_MS),
						}
					: undefined;
				const request: MultiLocalRequest | { resume: string } =
					command[1] === "resume" ? { resume: command[3]! } : JSON.parse(command[3]!);
				if (
					!request ||
					typeof request !== "object" ||
					(command[1] === "start" &&
						("resume" in request || typeof request.goal !== "string" || typeof request.target !== "string"))
				)
					throw new Error("MA1_REQUEST_DENIED");
				const agentDir = getAgentDir();
				const roleModels = command[1] === "start" ? loadRoleModelOverrides(agentDir) : undefined;
				if (modelId !== "deepseek-flash" && !!roleModels?.code !== !!roleModels?.test)
					throw new Error("MA1_INHERITED_MODEL_PRICING_UNCONFIRMED");
				if (
					!(await ctx.ui.confirm(
						remoteTest ? "MA-2 A2A" : "MA-1",
						"Allow the Code Agent to edit approved files and the configured Test Agent to run approved Docker tests?",
					))
				)
					return;
				active = new AbortController();
				const result = await runMultiLocal(
					{
						agentDir,
						sandbox,
						pytest,
						remoteTest,
						roleModels,
						signal: active.signal,
						provider: {
							apiKey,
							baseUrl,
							modelId,
							pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
						},
						onCheckpoint: (checkpoint, id) => {
							if (checkpoint === "initialized") ctx.ui.notify(`MA-1 task ${id}`, "info");
						},
					},
					request,
				);
				ctx.ui.notify(
					JSON.stringify({
						taskId: result.task.task.taskId,
						status: result.task.task.status,
						reason: result.state.reason,
						files: result.modifiedFiles,
						pytest: result.state.report?.receipt.status,
						requests: result.budget?.requestsStarted,
						tokens: result.budget?.actualTotalTokens,
					}),
					result.state.phase === "completed" ? "info" : "warning",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				ctx.ui.notify(/^(MA[12]_|GATEWAY_|Usage:)/u.test(message) ? message : "MA1_EXECUTION_FAILED", "error");
			} finally {
				active = undefined;
			}
		},
	});
}
