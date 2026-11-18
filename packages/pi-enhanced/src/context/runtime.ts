import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ScopedMemoryReader } from "../memory/contracts.ts";
import type { ScopedTaskReader } from "../task-manager/contracts.ts";
import { estimateContextMessages } from "./budget.ts";
import type { ContextDiagnostics, ContextMessage, ContextModuleConfig, ContextRuntimeState } from "./contracts.ts";
import { injectVerifiedMemory } from "./memory-source.ts";
import { offloadProjection, restoreContextPage } from "./offload.ts";
import { selectContextMessages } from "./selector.ts";
import { injectActiveTask } from "./task-source.ts";

export type ContextReaderProvider = (ctx: ExtensionContext, timeoutMs: number) => Promise<ScopedMemoryReader>;
export type ContextTaskReaderProvider = (ctx: ExtensionContext, timeoutMs: number) => Promise<ScopedTaskReader>;

export interface ContextHostRestore {
	page?: { reference: string; offset: number; limit: number };
	onResult?: (result: { reference: string; status: "restored" | "rejected"; characters: number }) => void;
}

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
	private epoch = 0;
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

	async transform(
		messages: readonly ContextMessage[],
		ctx: ExtensionContext,
		restoreToolActive: boolean,
		hostRestore?: ContextHostRestore,
	): Promise<ContextMessage[] | undefined> {
		const canRestore = restoreToolActive || hostRestore !== undefined;
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
		const epoch = this.epoch;
		try {
			let view = messages;
			let activeTaskId: string | undefined;
			let offloaded: ReadonlySet<string> | undefined;
			if (this.offloadEnabled && (canRestore || this.config.memoryInjection.enabled)) {
				try {
					activeTaskId = await this.activeTaskId(ctx);
					if (activeTaskId && canRestore) {
						const projected = offloadProjection(
							messages,
							ctx,
							activeTaskId,
							this.config.toolOutput.maximumTextCharacters,
							hostRestore !== undefined,
						);
						view = projected.messages;
						offloaded = projected.offloaded;
					}
				} catch {
					// A missing scope or original keeps the ordinary Context view available.
				}
			}
			if (this.closed || epoch !== this.epoch) return undefined;
			const selection = selectContextMessages(view, {
				compact: this.config.compaction?.enabled,
				offloaded,
				budget: this.config.budget,
				...(contextWindow === undefined ? {} : { contextWindow }),
				// Keep redaction active when the original cannot be paged back in.
				toolOutput: this.offloadEnabled && !canRestore
					? { ...this.config.toolOutput, maximumTextCharacters: Infinity }
					: this.config.toolOutput,
			});
			let output = selection.messages;
			let injectedMemoryIds: readonly string[] = [];
			let memoryState: ContextDiagnostics["memoryState"] = "disabled";
			let taskState: ContextDiagnostics["taskState"] = "disabled";
			let injectedTaskId: string | undefined;
			let fallbackReason: string | undefined;
			if (this.config.taskInjection.enabled) {
				try {
					const reader = this.taskReader ?? (await this.acquireTaskReader(ctx));
					if (this.closed || epoch !== this.epoch) return undefined;
					const injection = await injectActiveTask({
						messages: output,
						reader,
						config: this.config.taskInjection,
						projectRoot: ctx.cwd,
						sessionId: ctx.sessionManager.getSessionId(),
						branchLeafId: ctx.sessionManager.getLeafId(),
						branchEntryIds: new Set(ctx.sessionManager.getBranch().map(({ id }) => id)),
						showContextReferences: canRestore,
					});
					const exceedsBudget =
						!this.config.compaction?.enabled &&
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
			if (this.config.memoryInjection.enabled) {
				try {
					const reader = this.reader ?? (await this.acquireReader(ctx));
					if (this.closed || epoch !== this.epoch) return undefined;
					const injection = await injectVerifiedMemory({
						messages: output,
						reader,
						config: this.config.memoryInjection,
						projectRoot: ctx.cwd,
						...(activeTaskId ? { taskId: activeTaskId } : {}),
					});
					if (
						this.config.compaction?.enabled &&
						selection.targetEstimatedTokens !== null &&
						estimateContextMessages(injection.messages) > selection.targetEstimatedTokens
					) {
						memoryState = "skipped";
					} else {
						output = injection.messages;
						injectedMemoryIds = injection.injectedMemoryIds;
						memoryState = injection.state;
					}
				} catch {
					this.reader = undefined;
					memoryState = "unavailable";
					fallbackReason = "memory-reader-unavailable";
				}
			}
			if (this.closed || epoch !== this.epoch) return undefined;
			if (hostRestore?.page) {
				const { reference, offset, limit } = hostRestore.page;
				const userIndex = output.findLastIndex(({ role }) => role === "user");
				let characters = 0;
				if (activeTaskId && userIndex >= 0) {
					try {
						const page = restoreContextPage(ctx, activeTaskId, reference, offset, limit);
						const withPage = output.toSpliced(userIndex, 0, {
							role: "custom", customType: "pi-enhanced-restored-context", display: false,
							content: `[Untrusted output restored for ${reference}]\n${page.text}`, timestamp: output[userIndex].timestamp,
						});
						if (selection.targetEstimatedTokens === null ||
							estimateContextMessages(withPage) <= selection.targetEstimatedTokens) {
							output = withPage;
							characters = page.text.length;
						}
					} catch {
						// Out-of-scope data and unavailable pages leave the normal request view intact.
					}
				}
				hostRestore.onResult?.({ reference, status: characters ? "restored" : "rejected", characters });
			}
			this.lastValue = {
				runtimeState: this.state,
				mode: this.config.mode,
				estimated: true,
				contextWindow: contextWindow ?? null,
				targetEstimatedTokens: selection.targetEstimatedTokens,
				beforeEstimatedTokens: before,
				afterEstimatedTokens: estimateContextMessages(output),
				removedMessages: selection.removedMessages,
				truncatedToolResults: selection.truncatedToolResults,
				offloadedToolResults: output.filter(
					(message) => message.role === "toolResult" && offloaded?.has(message.toolCallId),
				).length,
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

	get offloadEnabled(): boolean {
		return (
			!this.closed &&
			this.state === "ready" &&
			this.config.mode === "select" &&
			this.config.toolOutput.enabled &&
			this.config.toolOutput.offload === true
		);
	}

	async activeTaskId(ctx: ExtensionContext): Promise<string | undefined> {
		if (!this.offloadEnabled || !ctx.isProjectTrusted()) return undefined;
		const epoch = this.epoch;
		const reader = this.taskReader ?? (await this.acquireTaskReader(ctx));
		const task = await reader.getActive();
		return !this.closed &&
			epoch === this.epoch &&
			task?.sessionId === ctx.sessionManager.getSessionId() &&
			(task.branchLeafId === null || ctx.sessionManager.getBranch().some(({ id }) => id === task.branchLeafId))
			? task.taskId
			: undefined;
	}

	invalidate(): void {
		this.epoch += 1;
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
			offloadedToolResults: 0,
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
