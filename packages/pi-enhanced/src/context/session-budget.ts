import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BudgetGatewayModel,
	type RunningBudgetGateway,
	startBudgetGateway,
} from "../../benchmarks/real-agent/budget-gateway.ts";
import { storedBudget } from "../../benchmarks/real-agent/budget-persistence.ts";
import { createProjectScope } from "../memory/project-scope.ts";
import { loadTaskBudget } from "../shared/config.ts";
import { TASK_TOKEN_TIERS, type TaskBudgetTier, taskBudgetTier } from "../shared/task-budget.ts";
import { currentScopedTaskReader } from "../task-manager/reader.ts";
import type { AgentBudgetWorkflow } from "./budget-workflow.ts";

const gatewayAnchor = "pi-enhanced:budget-scope";
const ccrWorkflowChannel = "pi-enhanced:ccr-budget-workflow";
const ccrLaunchCache = Symbol.for("pi-enhanced:ccr-launch");
const launchState = globalThis as typeof globalThis & {
	[ccrLaunchCache]?: { config: string; key: string };
};

export interface SessionBudgetProvider {
	provider: string;
	model: string;
	baseUrl: string;
	pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number };
	models?: readonly BudgetGatewayModel[];
}

const deepseek: SessionBudgetProvider = {
	provider: "deepseek",
	model: "deepseek-flash",
	baseUrl: "https://api.deepseek.com",
	pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
};

const ccrModels: Readonly<Record<string, Pick<BudgetGatewayModel, "responseModelId" | "pricing">>> = {
	"DeepSeek/deepseek-flash": { responseModelId: "deepseek-flash", pricing: deepseek.pricing },
	"DeepSeek/deepseek-v4-pro": {
		responseModelId: "deepseek-v4-pro",
		pricing: { inputUsdPerMillion: 1.32, outputUsdPerMillion: 3.96 },
	},
};

export function installCcrSessionBudget(pi: ExtensionAPI, agentDir: string): void {
	if (!process.env.PI_ENHANCED_CCR_BUDGET) throw new Error("GATEWAY_CCR_LAUNCH_REQUIRED");
	installSessionBudget(pi, agentDir);
}

function readCcrLaunch() {
	const raw = process.env.PI_ENHANCED_CCR_BUDGET;
	if (raw === undefined) return;
	const key =
		process.env.PI_ENHANCED_CCR_BUDGET_KEY ??
		(launchState[ccrLaunchCache]?.config === raw ? launchState[ccrLaunchCache].key : undefined);
	if (!key) throw new Error("GATEWAY_SECRET_MISSING");
	const config = JSON.parse(raw) as { baseUrl?: unknown; models?: unknown } | null;
	const { baseUrl, models } = config ?? {};
	if (
		typeof baseUrl !== "string" ||
		!/^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/v1$/u.test(baseUrl) ||
		new URL(baseUrl).href !== baseUrl ||
		!Array.isArray(models) ||
		!models.length ||
		new Set(models).size !== models.length ||
		!models.every((id) => typeof id === "string" && Object.hasOwn(ccrModels, id))
	)
		throw new Error("GATEWAY_CCR_CONFIG_INVALID");
	const profiles = models
		.map(
			(modelId: string): BudgetGatewayModel => ({
				modelId,
				...ccrModels[modelId]!,
				contextWindow: 64_000,
				maxOutputTokens: 4096,
				supportsTools: true,
			}),
		)
		.sort((a, b) => a.modelId.localeCompare(b.modelId));
	// Extension reloads reuse the launch credential in memory. Shell tools must not inherit it.
	launchState[ccrLaunchCache] = { config: raw, key };
	delete process.env.PI_ENHANCED_CCR_BUDGET_KEY;
	const { modelId: model, pricing } = profiles[0]!;
	return { key, host: { provider: "local-ccr", baseUrl, model, pricing, models: profiles } };
}

export function installSessionBudget(
	pi: ExtensionAPI,
	agentDir: string,
	provider?: SessionBudgetProvider,
): AgentBudgetWorkflow {
	const ccr = readCcrLaunch();
	const host = ccr?.host ?? provider ?? deepseek;
	if (ccr) {
		// The explicit launcher and optional Context can load separate copies of this module.
		let existing: AgentBudgetWorkflow | undefined;
		pi.events.emit(ccrWorkflowChannel, (workflow: AgentBudgetWorkflow) => {
			existing = workflow;
		});
		if (existing) return existing;
	}
	const endpoint = `${host.baseUrl}/chat/completions`;
	const alternateEndpoint = ccr ? endpoint : `${host.baseUrl}/v1/chat/completions`;
	const manages = (modelId: string) =>
		host.models ? host.models.some((model) => model.modelId === modelId) : modelId === host.model;
	const clientToken = randomUUID();
	const permits = new Map<string, { check(modelId: string): void; retryableUndelivered: boolean }>();
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
		loadTaskBudget({ agentDir, cwd: ctx.cwd, projectTrusted: !ccr && ctx.isProjectTrusted() });
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
			const key = ccr?.key ?? (await ctx.modelRegistry.getApiKeyForProvider(host.provider));
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
				models: host.models,
				guardedClientRetry: true,
				dispatchCheck: (permit) => (permit ? permits.get(permit)?.check : undefined),
				onRetryableUndelivered: ccr
					? (permit) => {
							const dispatch = permits.get(permit);
							if (dispatch) dispatch.retryableUndelivered = true;
						}
					: undefined,
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
			!manages(model.id) ||
			model.api !== "openai-completions" ||
			(baseUrl !== host.baseUrl && (ccr || baseUrl !== `${host.baseUrl}/v1`))
		) {
			if (ccr || (existsSync(databasePath) && stored(scope(ctx).id)))
				throw new Error("GATEWAY_BUDGET_MODEL_CHANGE_DENIED");
			return;
		}
		const gateway = await getGateway(ctx, scope(ctx));
		return async (input, init) => {
			const request = new Request(input, init);
			if ((request.url !== endpoint && request.url !== alternateEndpoint) || request.method !== "POST")
				throw new Error("GATEWAY_UPSTREAM_NOT_ALLOWED");
			const body = await request.text();
			const send = async () => {
				request.signal.throwIfAborted();
				const permit = randomUUID();
				const dispatch = {
					check(modelId: string) {
						if (modelId !== model.id) throw new Error("GATEWAY_BUDGET_MODEL_CHANGE_DENIED");
						beforeSend?.();
					},
					retryableUndelivered: false,
				};
				permits.set(permit, dispatch);
				try {
					const response = await fetch(`${gateway.url}/v1/chat/completions`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${clientToken}`,
							"Content-Type": "application/json",
							"x-pi-budget-permit": permit,
						},
						body,
						signal: request.signal,
						redirect: "error",
					});
					return { response, retryableUndelivered: dispatch.retryableUndelivered };
				} finally {
					permits.delete(permit);
				}
			};
			const first = await send();
			// A status or header alone cannot authorize replay. Only this local Gateway can attest
			// that this attempt's bytes were not sent and its durable reservation was released.
			if (
				!first.retryableUndelivered ||
				first.response.status !== 503 ||
				first.response.headers.get("x-should-retry") !== "true"
			)
				return first.response;
			await first.response.body?.cancel();
			return (await send()).response;
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
	const workflow: AgentBudgetWorkflow = {
		active: () => !!active,
		preview: (body) => active!.gateway.preview!(body),
		status: () => active!.gateway.status(),
	};
	if (ccr)
		pi.events.on(ccrWorkflowChannel, (claim) => {
			if (typeof claim === "function") claim(workflow);
		});
	return workflow;
}
