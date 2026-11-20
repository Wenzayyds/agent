import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ContextMessage } from "./contracts.ts";

export function estimateContextMessages(messages: readonly ContextMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

export function resolveContextTarget(options: {
	maximumEstimatedTokens: number;
	reserveEstimatedTokens: number;
	contextWindow?: number;
}): number | null {
	const fixed = options.maximumEstimatedTokens;
	const window = options.contextWindow ?? 0;
	if (window <= 0) return fixed > 0 ? fixed : null;
	const available = window - options.reserveEstimatedTokens;
	if (available < 1_000) return null;
	return Math.min(fixed, available);
}
