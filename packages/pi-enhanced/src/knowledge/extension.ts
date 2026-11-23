import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createProjectScope } from "../memory/project-scope.ts";
import { createLocalEmbedding } from "../shared/embedding/e5.ts";
import { runKnowledgeCommand } from "./commands.ts";
import { type KnowledgeState, loadKnowledgeConfig } from "./config.ts";
import { KnowledgeDocumentError } from "./contracts.ts";
import { projectKnowledgeRequest, registerKnowledgePageAccess } from "./request-policy.ts";
import { createLocalKnowledgeReranker } from "./reranker.ts";
import { errorCode, KnowledgeService, type KnowledgeVectors } from "./service.ts";
import { isKnowledgeTool, registerKnowledgeTools, storeKnowledgeToolReferences } from "./tools.ts";
import { KNOWLEDGE_COLLECTION, openDocumentIndex } from "./vector.ts";

interface ActiveKnowledge {
	service: KnowledgeService;
	sessionId: string;
	cwd: string;
}

export function createKnowledgeExtension(options: { agentDir?: string } = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		let state: KnowledgeState | "inactive" | "error" = "inactive";
		let runtime: ActiveKnowledge | undefined;
		let generation = 0;
		let lastError: string | undefined;
		const stop = async () => {
			const old = runtime;
			runtime = undefined;
			state = "inactive";
			if (!old) return;
			try {
				registerKnowledgeTools(pi, false, () => {
					throw new KnowledgeDocumentError("knowledge-disabled");
				});
			} finally {
				await old.service.close();
			}
		};
		pi.on("session_start", async (_event, ctx) => {
			const next = ++generation;
			try {
				await stop();
				if (generation !== next) return;
				const agentDir = options.agentDir ?? getAgentDir();
				const config = loadKnowledgeConfig({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
				state = config.state;
				lastError = undefined;
				if (state !== "enabled") return;
				const { projectId } = createProjectScope({ agentDir, cwd: ctx.cwd });
				let vectors: KnowledgeVectors | undefined;
				if (config.mode !== "lexical") {
					const local = createLocalEmbedding();
					vectors = {
						...local,
						collection: KNOWLEDGE_COLLECTION,
						index: openDocumentIndex(config.qdrantEndpoint, local.embedding.model),
					};
				}
				try {
					const active: ActiveKnowledge = {
						service: new KnowledgeService({
							projectId,
							filename: join(agentDir, "pi-enhanced", "knowledge", "projects", projectId, "knowledge.sqlite3"),
							mode: config.mode,
							vectors,
							reranker: config.rerank && config.mode === "hybrid" ? createLocalKnowledgeReranker() : undefined,
							background: true,
						}),
						cwd: ctx.cwd,
						sessionId: ctx.sessionManager.getSessionId(),
					};
					runtime = active;
					registerKnowledgePageAccess(ctx, () => {
						try {
							return requireService(ctx, active);
						} catch {
							return undefined;
						}
					});
					registerKnowledgeTools(pi, true, (executionContext) => requireService(executionContext, active));
				} catch (error) {
					await vectors?.close?.();
					throw error;
				}
			} catch (error) {
				if (generation !== next) return;
				await stop().catch(() => undefined);
				state = "error";
				lastError = errorCode(error);
			}
		});
		pi.on("session_shutdown", async () => {
			generation += 1;
			await stop().catch(() => undefined);
		});
		pi.on("tool_result", (event) => {
			// The session and generic Context offload only need references, never the document body.
			const toolName = event.toolName;
			if (isKnowledgeTool(toolName)) {
				return storeKnowledgeToolReferences({ toolName, content: event.content, details: event.details });
			}
		});
		pi.on("model_request_policy", (event, ctx) =>
			projectKnowledgeRequest(event, ctx, () => {
				const active = runtime;
				if (!active) return;
				try {
					return requireService(ctx, active);
				} catch {
					return undefined;
				}
			}),
		);
		pi.registerCommand("enhanced-docs", {
			description: "Manage project Knowledge with add, list, sync, remove and status",
			handler: async (args, ctx) => {
				if (!runtime) {
					ctx.ui.notify(
						`pi-enhanced knowledge: ${state}${lastError ? ` (${lastError})` : ""}`,
						state === "error" || state === "invalid-config" ? "warning" : "info",
					);
					return;
				}
				try {
					await runKnowledgeCommand(args, ctx, requireService(ctx, runtime));
				} catch (error) {
					ctx.ui.notify(`Knowledge 操作失败（${errorCode(error)}）。`, "warning");
				}
			},
		});

		function requireService(ctx: ExtensionContext, expected: ActiveKnowledge): KnowledgeService {
			if (
				runtime !== expected ||
				!ctx.isProjectTrusted() ||
				ctx.cwd !== expected.cwd ||
				ctx.sessionManager.getSessionId() !== expected.sessionId
			)
				throw new KnowledgeDocumentError("knowledge-disabled");
			return expected.service;
		}
	};
}

export default createKnowledgeExtension();
