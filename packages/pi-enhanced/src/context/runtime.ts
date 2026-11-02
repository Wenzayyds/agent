import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ScopedMemoryReader } from "../memory/contracts.ts";
import type { ScopedTaskReader } from "../task-manager/contracts.ts";
import { estimateContextMessages } from "./budget.ts";
import type { ContextDiagnostics, ContextMessage, ContextModuleConfig, ContextRuntimeState } from "./contracts.ts";
import { injectVerifiedMemory } from "./memory-source.ts";
import { selectContextMessages } from "./selector.ts";
import { injectActiveTask } from "./task-source.ts";

export type ContextReaderProvider = (ctx: ExtensionContext, timeoutMs: number) => Promise<ScopedMemoryReader>;
export type ContextTaskReaderProvider = (ctx: ExtensionContext, timeoutMs: number) => Promise<ScopedTaskReader>;

export interface ContextRuntimeOptions {
	state: ContextRuntimeState;
	config: ContextModuleConfig;
	readerProvider?: ContextReaderProvider;
	taskReaderProvider?: ContextTaskReaderProvider;
	generation: number;
	error?: string;
}

export class ContextRuntime {
	readonly state: ContextRuntimeState;
	readonly config: ContextModuleConfig;
	readonly generation: number;
	readonly error?: string;
	private readonly readerProvider?: ContextReaderProvider;
	private readonly taskReaderProvider?: ContextTaskReaderProvider;
	private reader?: ScopedMemoryReader;
	private taskReader?: ScopedTaskReader;
	private closed = false;
	private lastValue: ContextDiagnostics;

	constructor(options: ContextRuntimeOptions) {
		this.state = options.state;
		this.config = options.config;
		this.readerProvider = options.readerProvider;
		this.taskReaderProvider = options.taskReaderProvider;
		this.generation = options.generation;
		this.error = options.error;
		this.lastValue = this.emptyDiagnostics();
	}

	get diagnostics(): Readonly<ContextDiagnostics> {
		return { ...this.lastValue, injectedMemoryIds: [...this.lastValue.injectedMemoryIds] };
	}

	async transform(messages: readonly ContextMessage[], ctx: ExtensionContext): Promise<ContextMessage[] | undefined> {
		const before = estimateContextMessages(messages);
		if (this.closed || this.state !== "ready") {
			this.lastValue = { ...this.emptyDiagnostics(), beforeEstimatedTokens: before, afterEstimatedTokens: before };
			return undefined;
		}
		const contextWindow =
			ctx.model?.contextWindow && ctx.model.contextWindow > 0 ? ctx.model.contextWindow : undefined;
		if (this.config.mode === "observe") {
			this.lastValue = {
				...this.emptyDiagnostics(),
				contextWindow: contextWindow ?? null,
				beforeEstimatedTokens: before,
				afterEstimatedTokens: before,
				memoryState: this.config.memoryInjection.enabled ? "skipped" : "disabled",
				taskState: this.config.taskInjection.enabled ? "skipped" : "disabled",
			};
			return undefined;
		}
		const generation = this.generation;
		try {
			const selection = selectContextMessages(messages, {
				budget: this.config.budget,
				...(contextWindow === undefined ? {} : { contextWindow }),
				toolOutput: this.config.toolOutput,
			});
			let output = selection.messages;
			let injectedMemoryIds: readonly string[] = [];
			let memoryState: ContextDiagnostics["memoryState"] = "disabled";
			let taskState: ContextDiagnostics["taskState"] = "disabled";
			let injectedTaskId: string | undefined;
			let fallbackReason: string | undefined;
			if (this.config.memoryInjection.enabled) {
				try {
					const reader = this.reader ?? (await this.acquireReader(ctx));
					if (this.closed || generation !== this.generation) return undefined;
					const injection = await injectVerifiedMemory({
						messages: output,
						reader,
						config: this.config.memoryInjection,
						projectRoot: ctx.cwd,
					});
					output = injection.messages;
					injectedMemoryIds = injection.injectedMemoryIds;
					memoryState = injection.state;
				} catch {
					this.reader = undefined;
					memoryState = "unavailable";
					fallbackReason = "memory-reader-unavailable";
				}
			}
			if (this.config.taskInjection.enabled) {
				try {
					const reader = this.taskReader ?? (await this.acquireTaskReader(ctx));
					if (this.closed || generation !== this.generation) return undefined;
					const injection = await injectActiveTask({
						messages: output,
						reader,
						config: this.config.taskInjection,
						projectRoot: ctx.cwd,
						sessionId: ctx.sessionManager.getSessionId(),
						branchLeafId: ctx.sessionManager.getLeafId(),
					});
					const exceedsBudget =
						injection.injectedTaskId !== undefined &&
						selection.targetEstimatedTokens !== null &&
						estimateContextMessages(injection.messages) > selection.targetEstimatedTokens;
					if (exceedsBudget) taskState = "over-budget";
					else {
						output = injection.messages;
						injectedTaskId = injection.injectedTaskId;
						taskState = injection.state;
					}
				} catch {
					this.taskReader = undefined;
					taskState = "unavailable";
					fallbackReason ??= "task-reader-unavailable";
				}
			}
			this.lastValue = {
				runtimeState: this.state,
				mode: this.config.mode,
				estimated: true,
				contextWindow: contextWindow ?? null,
				targetEstimatedTokens: selection.targetEstimatedTokens,
				beforeEstimatedTokens: selection.beforeEstimatedTokens,
				afterEstimatedTokens: estimateContextMessages(output),
				removedMessages: selection.removedMessages,
				truncatedToolResults: selection.truncatedToolResults,
				preservedUnsafeGroups: selection.preservedUnsafeGroups,
				injectedMemoryIds,
				memoryState,
				taskState,
				...(injectedTaskId ? { injectedTaskId } : {}),
				pythonScoring: this.config.pythonScoring.enabled ? "not-implemented" : "disabled",
				...(fallbackReason ? { fallbackReason } : {}),
				generation: this.generation,
			};
			return output;
		} catch {
			this.lastValue = {
				...this.emptyDiagnostics(),
				contextWindow: contextWindow ?? null,
				beforeEstimatedTokens: before,
				afterEstimatedTokens: before,
				fallbackReason: "context-transform-error",
			};
			return undefined;
		}
	}

	invalidate(): void {
		this.reader = undefined;
		this.taskReader = undefined;
		this.lastValue = this.emptyDiagnostics();
	}

	close(): void {
		this.closed = true;
		this.reader = undefined;
		this.taskReader = undefined;
	}

	private async acquireReader(ctx: ExtensionContext): Promise<ScopedMemoryReader> {
		if (!this.readerProvider) throw new Error("Memory reader provider is unavailable");
		const reader = await this.readerProvider(ctx, this.config.memoryInjection.readerTimeoutMs);
		if (this.closed) throw new Error("Context runtime is closed");
		this.reader = reader;
		return reader;
	}

	private async acquireTaskReader(ctx: ExtensionContext): Promise<ScopedTaskReader> {
		if (!this.taskReaderProvider) throw new Error("Task reader provider is unavailable");
		const reader = await this.taskReaderProvider(ctx, this.config.taskInjection.readerTimeoutMs);
		if (this.closed) throw new Error("Context runtime is closed");
		this.taskReader = reader;
		return reader;
	}

	private emptyDiagnostics(): ContextDiagnostics {
		return {
			runtimeState: this.state,
			mode: this.config.mode,
			estimated: true,
			contextWindow: null,
			targetEstimatedTokens: null,
			beforeEstimatedTokens: 0,
			afterEstimatedTokens: 0,
			removedMessages: 0,
			truncatedToolResults: 0,
			preservedUnsafeGroups: 0,
			injectedMemoryIds: [],
			memoryState: this.config.memoryInjection.enabled ? "unavailable" : "disabled",
			taskState: this.config.taskInjection.enabled ? "unavailable" : "disabled",
			pythonScoring: this.config.pythonScoring.enabled ? "not-implemented" : "disabled",
			...(this.error ? { fallbackReason: "configuration-error" } : {}),
			generation: this.generation,
		};
	}
}
