import { estimateContextMessages, resolveContextTarget } from "./budget.ts";
import type { ContextBudgetConfig, ContextMessage, ContextSelectionResult } from "./contracts.ts";
import { collectToolCallIds, hasValidToolPairing, truncatePairedToolOutputs } from "./tool-output.ts";

export interface SelectContextOptions {
	budget: ContextBudgetConfig;
	contextWindow?: number;
	toolOutput: { enabled: boolean; maximumTextCharacters: number };
}

interface MessageGroup {
	indices: number[];
	removable: boolean;
}

export function selectContextMessages(
	input: readonly ContextMessage[],
	options: SelectContextOptions,
): ContextSelectionResult {
	const beforeEstimatedTokens = estimateContextMessages(input);
	const targetEstimatedTokens = resolveContextTarget({
		maximumEstimatedTokens: options.budget.maximumEstimatedTokens,
		reserveEstimatedTokens: options.budget.reserveEstimatedTokens,
		...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
	});
	const toolView = options.toolOutput.enabled
		? truncatePairedToolOutputs(input, options.toolOutput.maximumTextCharacters)
		: { messages: [...input], truncated: 0 };
	if (targetEstimatedTokens === null) {
		return result(toolView.messages, beforeEstimatedTokens, null, 0, toolView.truncated, 0);
	}
	let current = toolView.messages;
	let currentEstimate = estimateContextMessages(current);
	if (currentEstimate <= targetEstimatedTokens) {
		return result(current, beforeEstimatedTokens, targetEstimatedTokens, 0, toolView.truncated, 0);
	}

	const groups = buildGroups(current, options.budget.recentMessagesToKeep);
	const removed = new Set<number>();
	let preservedUnsafeGroups = 0;
	for (const group of groups) {
		if (currentEstimate <= targetEstimatedTokens) break;
		if (!group.removable) {
			preservedUnsafeGroups += 1;
			continue;
		}
		for (const index of group.indices) removed.add(index);
		current = toolView.messages.filter((_message, index) => !removed.has(index));
		if (!hasValidToolPairing(current)) {
			for (const index of group.indices) removed.delete(index);
			current = toolView.messages.filter((_message, index) => !removed.has(index));
			preservedUnsafeGroups += 1;
			continue;
		}
		currentEstimate = estimateContextMessages(current);
	}
	return result(
		current,
		beforeEstimatedTokens,
		targetEstimatedTokens,
		removed.size,
		toolView.truncated,
		preservedUnsafeGroups,
	);
}

function buildGroups(messages: readonly ContextMessage[], recentMessagesToKeep: number): MessageGroup[] {
	const boundaries = new Set<number>([0]);
	for (let index = 1; index < messages.length; index++) if (isTurnStart(messages[index])) boundaries.add(index);
	const starts = [...boundaries].sort((left, right) => left - right);
	const recentStart = Math.max(0, messages.length - recentMessagesToKeep);
	const latestUser = findLatestUser(messages);
	const allCalls = collectToolCallIds(messages);
	const resultIndices = new Map<string, number[]>();
	for (const [index, message] of messages.entries()) {
		if (message.role !== "toolResult") continue;
		const indices = resultIndices.get(message.toolCallId) ?? [];
		indices.push(index);
		resultIndices.set(message.toolCallId, indices);
	}
	return starts.map((start, position) => {
		const end = starts[position + 1] ?? messages.length;
		const indices = Array.from({ length: end - start }, (_value, offset) => start + offset);
		const indexSet = new Set(indices);
		let removable = end <= recentStart && !indices.includes(latestUser);
		for (const index of indices) {
			const message = messages[index];
			if (message.role === "branchSummary" || message.role === "compactionSummary") removable = false;
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const results = resultIndices.get(block.id) ?? [];
					if (results.length !== 1 || !indexSet.has(results[0])) removable = false;
				}
			}
			if (message.role === "toolResult") {
				if (!allCalls.has(message.toolCallId) || resultIndices.get(message.toolCallId)?.length !== 1)
					removable = false;
				const callInGroup = indices.some((candidate) =>
					messages[candidate]?.role === "assistant"
						? messages[candidate].content.some(
								(block) => block.type === "toolCall" && block.id === message.toolCallId,
							)
						: false,
				);
				if (!callInGroup) removable = false;
			}
		}
		return { indices, removable };
	});
}

function isTurnStart(message: ContextMessage): boolean {
	return (
		message.role === "user" ||
		message.role === "custom" ||
		message.role === "bashExecution" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

function findLatestUser(messages: readonly ContextMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === "user") return index;
	return -1;
}

function result(
	messages: ContextMessage[],
	beforeEstimatedTokens: number,
	targetEstimatedTokens: number | null,
	removedMessages: number,
	truncatedToolResults: number,
	preservedUnsafeGroups: number,
): ContextSelectionResult {
	return {
		messages,
		beforeEstimatedTokens,
		afterEstimatedTokens: estimateContextMessages(messages),
		targetEstimatedTokens,
		removedMessages,
		truncatedToolResults,
		preservedUnsafeGroups,
	};
}
