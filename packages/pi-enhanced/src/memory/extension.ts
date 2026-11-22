import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerMemoryContextPolicy } from "../context/request-policy.ts";
import { requestScopedTaskReader } from "../task-manager/reader.ts";
import { registerMemoryCandidateWriterBroker } from "./candidate-writer.ts";
import { loadMemoryConfig } from "./config.ts";
import { MemoryError } from "./errors.ts";
import { registerMemoryInteractions, setMemorySearchToolAvailability } from "./interaction.ts";
import { registerScopedMemoryReaderBroker } from "./reader.ts";
import type { MemoryRuntime, OpenMemoryBackend } from "./runtime.ts";
import { startMemoryRuntime } from "./runtime.ts";
import { MemoryService, openMemoryService } from "./service.ts";

function formatStatus(runtime: MemoryRuntime | undefined): string {
	if (!runtime) return "pi-enhanced memory: not initialized";
	const details = [
		`pi-enhanced memory: ${runtime.state}`,
		...(runtime.scope ? [`Project: ${runtime.scope.rootPath}`, `Project ID: ${runtime.scope.projectId}`] : []),
		...(runtime.searchStatus ? [`Search: ${runtime.searchStatus}`] : []),
		...(runtime.intelligence
			? [
					`Retrieval: ${runtime.intelligence.status.state} configured=${runtime.intelligence.status.configuredMode} active=${runtime.intelligence.status.activeMode}`,
					`Embedding: ${runtime.intelligence.status.modelId ?? "not-loaded"} revision=${runtime.intelligence.status.modelRevision ?? "none"} dimensions=${runtime.intelligence.status.vectorDimensions ?? "unknown"} index=${runtime.intelligence.status.indexSize ?? "unknown"} reranker=${runtime.intelligence.status.reranker}`,
					...(runtime.intelligence.status.lastErrorCode
						? [`Retrieval error: ${runtime.intelligence.status.lastErrorCode}`]
						: []),
				]
			: []),
		...(runtime.error ? [`Error: ${runtime.error}`] : []),
	];
	return details.join("\n");
}

export interface MemoryExtensionOptions {
	agentDir?: string;
	openBackend?: OpenMemoryBackend;
}

export function createMemoryExtension(options: MemoryExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerMemoryExtension(pi, options);
}

function registerMemoryExtension(pi: ExtensionAPI, options: MemoryExtensionOptions): void {
	registerMemoryContextPolicy(pi);
	let runtime: MemoryRuntime | undefined;
	let interactionsRegistered = false;
	let unsubscribeReaderBroker: (() => void) | undefined;
	let unsubscribeCandidateWriter: (() => void) | undefined;

	const start = async (ctx: ExtensionContext) => {
		const previous = runtime;
		runtime = undefined;
		if (interactionsRegistered) setMemorySearchToolAvailability(pi, () => runtime, false);
		unsubscribeReaderBroker?.();
		unsubscribeReaderBroker = undefined;
		unsubscribeCandidateWriter?.();
		unsubscribeCandidateWriter = undefined;
		await previous?.close();
		const agentDir = options.agentDir ?? getAgentDir();
		const loaded = loadMemoryConfig({
			agentDir,
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const next = await startMemoryRuntime({
			enabled: loaded.config.enabled,
			configurationErrors: loaded.errors,
			intelligenceConfig: loaded.config.intelligence,
			governanceConfig: loaded.config.governance,
			projectTrusted: ctx.isProjectTrusted(),
			cwd: ctx.cwd,
			agentDir,
			sessionManager: ctx.sessionManager,
			resolveVisibility: async () => {
				if (!ctx.isProjectTrusted()) throw new MemoryError("MEMORY_RUNTIME_CLOSED", "Project trust was withdrawn");
				const sessionId = ctx.sessionManager.getSessionId();
				const conditions = [process.platform, `platform:${process.platform}`, `node:${process.versions.node}`];
				if (runtime?.scope) conditions.push(`project:${runtime.scope.projectId}`);
				for (const name of pi
					.getActiveTools()
					.filter((name) => /^[a-z_]{1,58}$/u.test(name))
					.sort()
					.slice(0, 28))
					conditions.push(`tool:${name}`);
				try {
					const reader = await requestScopedTaskReader(pi.events, ctx, 100);
					const task = await reader.getActive();
					if (
						task?.sessionId === sessionId &&
						task.projectId === runtime?.scope?.projectId &&
						(task.branchLeafId === null ||
							ctx.sessionManager.getBranch().some(({ id }) => id === task.branchLeafId))
					)
						return { sessionId, taskId: task.taskId, taskBranchId: task.branchLeafId, conditions };
				} catch {
					// Memory can run without the Task extension.
				}
				return { sessionId, conditions };
			},
			openBackend: options.openBackend ?? openMemoryService,
		});
		runtime = next;
		if (next.state === "ready" && next.scope && next.reader) {
			if (!interactionsRegistered) {
				try {
					registerMemoryInteractions(pi, () => runtime);
					interactionsRegistered = true;
				} catch (error) {
					runtime = undefined;
					await next.close();
					throw error;
				}
			}
			setMemorySearchToolAvailability(pi, () => runtime, true);
			unsubscribeReaderBroker = registerScopedMemoryReaderBroker(pi.events, {
				reader: next.reader,
				scope: next.scope,
				sessionId: ctx.sessionManager.getSessionId(),
			});
			if (next.backend instanceof MemoryService) {
				unsubscribeCandidateWriter = registerMemoryCandidateWriterBroker(pi.events, {
					service: next.backend,
					scope: next.scope,
					sessionId: ctx.sessionManager.getSessionId(),
					isCompletedTask: async (taskId) => {
						if (runtime !== next || !ctx.isProjectTrusted()) return false;
						const reader = await requestScopedTaskReader(pi.events, ctx, 100);
						const task = await reader.get(taskId);
						return (
							runtime === next &&
							task?.taskId === taskId &&
							task.status === "completed" &&
							task.projectId === next.scope?.projectId &&
							task.sessionId === ctx.sessionManager.getSessionId() &&
							(task.branchLeafId === null ||
								ctx.sessionManager.getBranch().some(({ id }) => id === task.branchLeafId))
						);
					},
				});
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await start(ctx);
	});

	pi.on("session_shutdown", async () => {
		const current = runtime;
		runtime = undefined;
		if (interactionsRegistered) setMemorySearchToolAvailability(pi, () => runtime, false);
		unsubscribeReaderBroker?.();
		unsubscribeReaderBroker = undefined;
		unsubscribeCandidateWriter?.();
		unsubscribeCandidateWriter = undefined;
		await current?.close();
	});

	pi.registerCommand("enhanced-memory-status", {
		description: "Show Memory lifecycle, project scope, and storage status",
		handler: async (_args, ctx) => {
			if (!runtime) await start(ctx);
			ctx.ui.notify(formatStatus(runtime), runtime?.state === "error" ? "warning" : "info");
		},
	});
}

export default createMemoryExtension();
