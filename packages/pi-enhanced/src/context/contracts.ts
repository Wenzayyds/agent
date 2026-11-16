import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export type ContextMessage = ContextEvent["messages"][number];
export type ContextMode = "observe" | "select";
export type ContextRuntimeState = "disabled" | "blocked" | "ready" | "error";

export interface ContextBudgetConfig {
	maximumEstimatedTokens: number;
	reserveEstimatedTokens: number;
	recentMessagesToKeep: number;
}

export interface ContextToolOutputConfig {
	enabled: boolean;
	maximumTextCharacters: number;
	offload?: boolean;
}

export interface ContextMemoryInjectionConfig {
	enabled: boolean;
	maximumRecords: number;
	maximumTextCharacters: number;
	readerTimeoutMs: number;
}

export interface ContextPythonScoringConfig {
	enabled: boolean;
}

export interface ContextTaskInjectionConfig {
	enabled: boolean;
	maximumTextCharacters: number;
	readerTimeoutMs: number;
}

export interface ContextModuleConfig {
	enabled: boolean;
	mode: ContextMode;
	budget: ContextBudgetConfig;
	toolOutput: ContextToolOutputConfig;
	compaction?: { enabled: boolean };
	memoryInjection: ContextMemoryInjectionConfig;
	taskInjection: ContextTaskInjectionConfig;
	pythonScoring: ContextPythonScoringConfig;
}

export interface ContextDiagnostics {
	runtimeState: ContextRuntimeState;
	mode: ContextMode;
	estimated: true;
	contextWindow: number | null;
	targetEstimatedTokens: number | null;
	beforeEstimatedTokens: number;
	afterEstimatedTokens: number;
	removedMessages: number;
	truncatedToolResults: number;
	offloadedToolResults: number;
	preservedUnsafeGroups: number;
	injectedMemoryIds: readonly string[];
	memoryState: "disabled" | "ready" | "unavailable" | "skipped";
	taskState: "disabled" | "ready" | "unavailable" | "skipped" | "over-budget";
	injectedTaskId?: string;
	pythonScoring: "disabled" | "not-implemented";
	fallbackReason?: string;
	generation: number;
}

export interface ContextSelectionResult {
	messages: ContextMessage[];
	beforeEstimatedTokens: number;
	afterEstimatedTokens: number;
	targetEstimatedTokens: number | null;
	removedMessages: number;
	truncatedToolResults: number;
	preservedUnsafeGroups: number;
}
