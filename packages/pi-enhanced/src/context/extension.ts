import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { requestScopedMemoryReader } from "../memory/reader.ts";
import { requestScopedTaskReader } from "../task-manager/reader.ts";
import { loadContextConfig } from "./config.ts";
import type { ContextDiagnostics, ContextMessage, ContextModuleConfig, ContextRuntimeState } from "./contracts.ts";
import { ContextRuntime } from "./runtime.ts";

export interface ContextExtensionOptions {
	agentDir?: string;
	onDiagnostics?: (diagnostics: Readonly<ContextDiagnostics>, config: Readonly<ContextModuleConfig>) => void;
	onView?: (before: readonly ContextMessage[], after: readonly ContextMessage[]) => void;
}

export function createContextExtension(options: ContextExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerContextExtension(pi, options);
}

function registerContextExtension(pi: ExtensionAPI, options: ContextExtensionOptions): void {
	let runtime: ContextRuntime | undefined;
	let generation = 0;

	const start = (ctx: ExtensionContext): void => {
		runtime?.close();
		generation += 1;
		const loaded = loadContextConfig({
			agentDir: options.agentDir ?? getAgentDir(),
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const state: ContextRuntimeState =
			loaded.errors.length > 0
				? "error"
				: !loaded.config.enabled
					? "disabled"
					: !ctx.isProjectTrusted()
						? "blocked"
						: "ready";
		runtime = new ContextRuntime({
			state,
			config: loaded.config,
			generation,
			readerProvider: (context, timeoutMs) => requestScopedMemoryReader(pi.events, context, timeoutMs),
			taskReaderProvider: (context, timeoutMs) => requestScopedTaskReader(pi.events, context, timeoutMs),
			...(loaded.errors.length > 0 ? { error: loaded.errors.join("; ") } : {}),
		});
	};

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => {
		runtime?.close();
		runtime = undefined;
	});
	pi.on("session_tree", () => runtime?.invalidate());
	pi.on("session_compact", () => runtime?.invalidate());
	pi.on("session_compact_failed", () => runtime?.invalidate());
	pi.on("context", async (event, ctx) => {
		const current = runtime;
		if (!current) return undefined;
		const messages = await current.transform(event.messages, ctx);
		try {
			options.onView?.(event.messages, messages ?? event.messages);
			options.onDiagnostics?.(current.diagnostics, structuredClone(current.config));
		} catch {
			/* Observation must not affect Context output. */
		}
		if (!messages || runtime !== current) return undefined;
		return { messages };
	});

	pi.registerCommand("enhanced-context-status", {
		description: "Show Context runtime, mode, estimated budget, and fallback status",
		handler: async (_args, ctx) => {
			if (!runtime) start(ctx);
			ctx.ui.notify(formatStatus(runtime), runtime?.state === "error" ? "warning" : "info");
		},
	});
	pi.registerCommand("enhanced-context-inspect", {
		description: "Show redacted diagnostics for the last Context request",
		handler: async (_args, ctx) => {
			if (!runtime) start(ctx);
			ctx.ui.notify(formatDiagnostics(runtime), runtime?.diagnostics.fallbackReason ? "warning" : "info");
		},
	});
}

function formatStatus(runtime: ContextRuntime | undefined): string {
	if (!runtime) return "pi-enhanced context: not initialized";
	const diagnostics = runtime.diagnostics;
	return [
		`pi-enhanced context: ${runtime.state}`,
		`Mode: ${runtime.config.mode}`,
		`Budget: estimated maximum=${runtime.config.budget.maximumEstimatedTokens} reserve=${runtime.config.budget.reserveEstimatedTokens}`,
		`Tool output: ${runtime.config.toolOutput.enabled ? "enabled" : "disabled"}`,
		`Memory injection: ${runtime.config.memoryInjection.enabled ? diagnostics.memoryState : "disabled"}`,
		`Task injection: ${runtime.config.taskInjection.enabled ? diagnostics.taskState : "disabled"}`,
		`Python scoring: ${diagnostics.pythonScoring}`,
		...(runtime.error ? [`Error: ${runtime.error}`] : []),
	].join("\n");
}

function formatDiagnostics(runtime: ContextRuntime | undefined): string {
	if (!runtime) return "pi-enhanced context: not initialized";
	const value = runtime.diagnostics;
	return [
		`State: ${value.runtimeState}; mode=${value.mode}; generation=${value.generation}`,
		`Estimated tokens: before=${value.beforeEstimatedTokens} after=${value.afterEstimatedTokens} target=${value.targetEstimatedTokens ?? "unknown"} window=${value.contextWindow ?? "unknown"}`,
		`Selection: removedMessages=${value.removedMessages} truncatedToolResults=${value.truncatedToolResults} preservedUnsafeGroups=${value.preservedUnsafeGroups}`,
		`Memory: ${value.memoryState}; ids=${value.injectedMemoryIds.join(",") || "none"}`,
		`Task: ${value.taskState}; id=${value.injectedTaskId ?? "none"}`,
		`Python scoring: ${value.pythonScoring}`,
		`Fallback: ${value.fallbackReason ?? "none"}`,
		"Token values are estimates, not provider-exact guarantees.",
	].join("\n");
}

export default createContextExtension();
