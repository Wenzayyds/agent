import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type RunningBudgetGateway, startBudgetGateway } from "../../benchmarks/real-agent/budget-gateway.ts";
import { storedBudget } from "../../benchmarks/real-agent/budget-persistence.ts";
import { createProjectScope } from "../memory/project-scope.ts";
import { loadTaskBudget } from "../shared/config.ts";
import { TASK_TOKEN_TIERS, type TaskBudgetTier, taskBudgetTier } from "../shared/task-budget.ts";
import { currentScopedTaskReader } from "../task-manager/reader.ts";
import type { AgentBudgetWorkflow } from "./budget-workflow.ts";

const gatewayAnchor = "pi-enhanced:budget-scope";
export interface SessionBudgetProvider {
	provider: string;
	model: string;
	baseUrl: string;
	pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number };
}

const deepseek: SessionBudgetProvider = {
	provider: "deepseek",
	model: "deepseek-flash",
	baseUrl: "https://api.deepseek.com",
	pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
};

export function installSessionBudget(pi: ExtensionAPI, agentDir: string, host = deepseek): AgentBudgetWorkflow {
	const clientToken = randomUUID();
	const permits = new Map<string, () => void>();
	const databasePath = join(agentDir, "pi-enhanced-budget.sqlite3");
	let active: { id: string; gateway: RunningBudgetGateway } | undefined;
	let selection: { id: string; tier: TaskBudgetTier } | undefined;
	let opening: Promise<RunningBudgetGateway> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

	const scope = (ctx: ExtensionContext) => {
		const project = createProjectScope({ cwd: ctx.cwd, agentDir });
		const task = currentScopedTaskReader(pi.events, ctx)?.getActiveNow?.();
		const anchor = ctx.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "custom" && entry.customType === gatewayAnchor);
		const persisted =
			anchor?.type === "custom" ? (anchor.data as { projectId?: string; taskId?: string }) : undefined;
		const taskId = task?.taskId ?? (persisted?.projectId === project.projectId ? persisted.taskId : undefined);
		const id = createHash("sha256")
			.update(
				JSON.stringify([
					project.projectId,
					taskId ? "task" : "session",
					taskId ?? ctx.sessionManager.getSessionId(),
				]),
			)
			.digest("hex");
		return { id, projectId: project.projectId, taskId };
	};
	const settings = (ctx: ExtensionContext) =>
		loadTaskBudget({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
	const stored = (id: string) => {
		if (!existsSync(databasePath)) return undefined;
		const file = lstatSync(databasePath);
		if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)
			throw new Error("GATEWAY_BUDGET_STORAGE_INVALID");
		return storedBudget({ databasePath, id });
	};
	const close = async () => {
		const previous = active;
		active = undefined;
		clearTimeout(deadlineTimer);
		deadlineTimer = undefined;
		await previous?.gateway.close();
	};
	const getGateway = async (ctx: ExtensionContext, destination: ReturnType<typeof scope>) => {
		if (opening) await opening;
		if (active?.id === destination.id) return active.gateway;
		opening = (async () => {
			await close();
			const previous = stored(destination.id);
			const config = previous ? undefined : settings(ctx);
			const tier = config
				? selection?.id === destination.id
					? selection.tier
					: config.tier
				: previous?.limits.tier;
			if (!tier) throw new Error("GATEWAY_BUDGET_TIER_INVALID");
			const key = await ctx.modelRegistry.getApiKeyForProvider(host.provider);
			if (!key) throw new Error("GATEWAY_SECRET_MISSING");
			mkdirSync(agentDir, { recursive: true });
			if (!existsSync(databasePath)) {
				try {
					writeFileSync(databasePath, "", { flag: "wx", mode: 0o600 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			const gateway = await startBudgetGateway({
				runId: destination.id,
				upstreamBaseUrl: host.baseUrl,
				upstreamApiKey: key,
				clientToken,
				adminToken: randomUUID(),
				allowedModel: host.model,
				pricing: host.pricing,
				guardedClientRetry: true,
				dispatchCheck: (permit) => (permit ? permits.get(permit) : undefined),
				limits: previous?.limits ?? {
					tier,
					maxTotalTokens: TASK_TOKEN_TIERS[tier],
					maxRequests: config!.maxRequests,
					maxTotalCostUsd: config!.maxTotalCostUsd,
					maxOutputTokensPerRequest: config!.maxOutputTokensPerRequest,
					minOutputTokensPerRequest: Math.min(128, config!.maxOutputTokensPerRequest),
					maxConcurrency: 1,
					maxRequestBytes: 96_000,
					requestTimeoutMs: Math.min(20_000, config!.timeoutMs),
				},
				persistence: {
					id: destination.id,
					databasePath,
					scope: "session",
					...(config ? { mode: "create", deadlineAt: Date.now() + config.timeoutMs } : { mode: "resume" }),
				},
			});
			active = { id: destination.id, gateway };
			deadlineTimer = setTimeout(
				() => {
					if (active?.gateway !== gateway) return;
					try {
						gateway.stop("GATEWAY_RUN_TIMEOUT");
					} finally {
						if (!ctx.isIdle()) ctx.abort();
					}
				},
				Math.max(0, gateway.deadlineAt! - Date.now()),
			).unref();
			pi.appendEntry(gatewayAnchor, { projectId: destination.projectId, taskId: destination.taskId });
			return gateway;
		})();
		try {
			return await opening;
		} finally {
			opening = undefined;
		}
	};

	pi.on("model_request_fetch", async ({ model, beforeSend }, ctx) => {
		const baseUrl = model.baseUrl.replace(/\/$/u, "");
		if (
			model.provider !== host.provider ||
			model.id !== host.model ||
			model.api !== "openai-completions" ||
			(baseUrl !== host.baseUrl && baseUrl !== `${host.baseUrl}/v1`)
		) {
			if (existsSync(databasePath) && stored(scope(ctx).id)) throw new Error("GATEWAY_BUDGET_MODEL_CHANGE_DENIED");
			return;
		}
		const gateway = await getGateway(ctx, scope(ctx));
		return async (input, init) => {
			const request = new Request(input, init);
			if (
				(request.url !== `${host.baseUrl}/chat/completions` &&
					request.url !== `${host.baseUrl}/v1/chat/completions`) ||
				request.method !== "POST"
			)
				throw new Error("GATEWAY_UPSTREAM_NOT_ALLOWED");
			const permit = randomUUID();
			permits.set(permit, () => beforeSend?.());
			try {
				return await fetch(`${gateway.url}/v1/chat/completions`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${clientToken}`,
						"Content-Type": "application/json",
						"x-pi-budget-permit": permit,
					},
					body: await request.text(),
					signal: request.signal,
					redirect: "error",
				});
			} finally {
				permits.delete(permit);
			}
		};
	});
	pi.on("session_shutdown", async () => {
		if (opening) await opening.catch(() => undefined);
		await close();
		selection = undefined;
	});
	pi.registerCommand("enhanced-budget", {
		description: "Show or choose Economy, Standard or Premium task budget",
		handler: async (args, ctx) => {
			try {
				if (!ctx.isIdle() || opening) throw new Error("GATEWAY_BUDGET_TASK_BUSY");
				const destination = scope(ctx);
				const current = active?.id === destination.id ? active.gateway.status() : stored(destination.id);
				if (!args.trim()) {
					const tier =
						current?.limits.tier ?? (selection?.id === destination.id ? selection.tier : settings(ctx).tier);
					ctx.ui.notify(`${tier}: ${current?.actualTotalTokens ?? 0}/${TASK_TOKEN_TIERS[tier]} tokens`, "info");
					return;
				}
				const tier = taskBudgetTier(args.trim());
				if (current) {
					if (current.limits.tier === tier) return;
					if (
						!ctx.hasUI ||
						!(await ctx.ui.confirm("调整当前任务预算", `切换为 ${tier}，保留已用额度和截止时间？`))
					)
						return;
					const gateway = await getGateway(ctx, destination);
					if (!ctx.isIdle() || scope(ctx).id !== destination.id) throw new Error("GATEWAY_BUDGET_TASK_BUSY");
					gateway.changeTier!(tier);
				} else selection = { id: destination.id, tier };
				ctx.ui.notify(`预算档位为 ${tier}（${TASK_TOKEN_TIERS[tier]} Token）`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "GATEWAY_BUDGET_ERROR", "error");
			}
		},
	});
	return {
		active: () => !!active,
		preview: (body) => active!.gateway.preview!(body),
		status: () => active!.gateway.status(),
	};
}
