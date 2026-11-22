import type { BudgetWireMessage } from "../../src/context/budget-workflow.ts";

export {
	assessBudgetContinuation as assessEvaluationContinuation,
	type BudgetWireMessage as EvaluationWireMessage,
	projectBudgetWorkflow as applyEvaluationContextBudget,
} from "../../src/context/budget-workflow.ts";
export function measureEvaluationContext(
	payload: Record<string, unknown>,
	isTaskPrompt: (text: string) => boolean,
	injectedText: ReadonlySet<string>,
) {
	const size = (data: unknown) => Buffer.byteLength(JSON.stringify(data ?? null), "utf8");
	const messages: Record<string, number> = {};
	const components = {
		system: 0,
		currentTask: 0,
		toolSchema: Array.isArray(payload.tools) ? size(payload.tools) : 0,
		historyUser: 0,
		historyAssistant: 0,
		historyToolResult: 0,
		memory: 0,
		rag: 0,
		contextInjection: 0,
	};
	const items = Array.isArray(payload.messages) ? payload.messages : [];
	const names = new Map<string, string | undefined>();
	const text = (content: unknown): string =>
		typeof content === "string"
			? content
			: Array.isArray(content) && content.every((part) => part?.type === "text" && typeof part.text === "string")
				? content.map((part) => part.text).join("")
				: "";
	const current = items.findLastIndex(
		(item) => item?.role === "user" && !injectedText.has(text(item.content)) && isTaskPrompt(text(item.content)),
	);
	for (const item of items) {
		if (item?.role !== "assistant" || !Array.isArray(item.tool_calls)) continue;
		for (const call of item.tool_calls) {
			if (typeof call?.id !== "string") continue;
			names.set(call.id, names.has(call.id) ? undefined : call.function?.name);
		}
	}
	for (const [index, item] of items.entries()) {
		const role = typeof item?.role === "string" ? item.role : "other";
		const bytes = size(item);
		messages[role] = (messages[role] ?? 0) + bytes;
		switch (role) {
			case "system":
				components.system += bytes;
				break;
			case "user":
				if (injectedText.has(text(item.content))) components.contextInjection += bytes;
				else if (index === current) components.currentTask += bytes;
				else components.historyUser += bytes;
				break;
			case "assistant":
				components.historyAssistant += bytes;
				break;
			case "tool": {
				const name = names.get(item.tool_call_id);
				if (name === "enhanced_memory_search") components.memory += bytes;
				else if (name === "enhanced_docs_search" || name === "enhanced_docs_read") components.rag += bytes;
				else components.historyToolResult += bytes;
				break;
			}
		}
	}
	const bytes = size(payload);
	return {
		bytes,
		toolBytes: size(payload.tools),
		messages,
		components,
		envelopeBytes: bytes - Object.values(components).reduce((total, value) => total + value, 0),
	};
}

// Reserve a whole cell before the next session opens. Rounding up prevents
// floating point settlement or an unclosed cell from overstating headroom.
export function canReserveE17Cell(settled: number, active: number, global: number, cell: number): boolean {
	if (
		![settled, active, global, cell].every((value) => Number.isFinite(value) && value >= 0) ||
		active !== 0 ||
		cell === 0
	)
		return false;
	return Math.ceil(settled * 1_000_000) + Math.ceil(cell * 1_000_000) <= Math.floor(global * 1_000_000);
}
