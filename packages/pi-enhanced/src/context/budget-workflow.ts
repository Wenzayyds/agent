import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KNOWLEDGE_READ, KNOWLEDGE_SEARCH, knowledgeResultReferences } from "../knowledge/tools.ts";

export interface BudgetState {
	requestsStarted: number;
	limits: { maxRequests: number; minOutputTokensPerRequest?: number; maxOutputTokensPerRequest: number };
}

// Preview is advisory. The transport still authorizes and settles each request.
export type BudgetPreview = (body: Record<string, unknown>) => {
	denial: string | null;
	diagnostics: { candidateReservedTokens: number; remainingTokenHeadroom: number };
};
export interface BudgetWireMessage {
	role: string;
	content?: string;
	tool_call_id?: string;
	tool_calls?: { id: string; function?: { name: string; arguments: string } }[];
}

type BudgetWorkflow = {
	publicPassId?: string;
	readOnly?: boolean;
	verifyReadOnly?: boolean;
	readOnlyRequestsRemaining?: number;
	runtimeProjection?: boolean;
};

const repeatableReads = new Set([
	"ls",
	"find",
	"grep",
	"read",
	"enhanced_memory_search",
	"enhanced_docs_search",
	"enhanced_docs_read",
]);

export function projectBudgetWorkflow(
	body: Record<string, unknown>,
	preview: BudgetPreview,
	successfulEditId?: string,
	workflow?: BudgetWorkflow,
) {
	const full = preview(body);
	const messages = Array.isArray(body.messages) ? (body.messages as BudgetWireMessage[]) : [];
	const toolCalls = new Map<string, { name: string; arguments: string } | undefined>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const call of message.tool_calls ?? [])
			toolCalls.set(call.id, toolCalls.has(call.id) ? undefined : call.function);
	}
	const resultsSeen = new Set<string>();
	let duplicates = 0;
	const projected = [...messages];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const call = message.tool_call_id ? toolCalls.get(message.tool_call_id) : undefined;
		if (message.role !== "tool" || typeof message.content !== "string" || !call || !repeatableReads.has(call.name))
			continue;
		if (workflow?.runtimeProjection && (discovery.has(call.name) || call.name === "read")) continue;
		const key = JSON.stringify([call.name, call.arguments, message.content]);
		if (resultsSeen.has(key) && message.content.length > 80) {
			projected[i] = { ...message, content: "Identical output is retained in a later result from this tool." };
			duplicates++;
		}
		resultsSeen.add(key);
	}
	let selected: Record<string, unknown> = duplicates ? { ...body, messages: projected } : body;
	let after = duplicates ? preview(selected) : full;
	let mode: "full" | "test-only" | "text-closeout" | "continue-work" = "full";
	const latest = messages.at(-1);
	const assistant = messages.findLast((msg) => msg.role === "assistant");
	const lastCall = assistant?.tool_calls?.length === 1 ? assistant.tool_calls[0] : undefined;
	if (
		(after.denial === "GATEWAY_TOKEN_BUDGET" || after.denial === "GATEWAY_COST_BUDGET") &&
		latest?.role === "tool" &&
		latest.tool_call_id === lastCall?.id &&
		lastCall?.function &&
		toolCalls.get(lastCall.id) === lastCall.function &&
		Array.isArray(body.tools) &&
		typeof latest.content === "string"
	) {
		if (lastCall.function.name === "edit" && lastCall.id === successfulEditId) {
			const tests = body.tools.filter((tool) => tool?.type === "function" && tool.function?.name === "run_tests");
			if (tests.length === 1) {
				const candidate = {
					...selected,
					tools: tests,
					tool_choice: { type: "function", function: { name: "run_tests" } },
				};
				const check = preview(candidate);
				if (!check.denial) {
					selected = candidate;
					after = check;
					mode = "test-only";
				}
			}
		}
		if (lastCall.function.name === "run_tests" && passedPytest(latest.content)) {
			const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, ...rest } = selected;
			const closeout = {
				...rest,
				messages: projected.map((message, index) =>
					message.role === "system" && index === 0 && typeof message.content === "string"
						? {
								...message,
								content: message.content.concat(
									"\nReport the verified outcome and any remaining work. This request can only return text.",
								),
							}
						: message,
				),
			};
			const check = preview(closeout);
			if (!check.denial) {
				selected = closeout;
				after = check;
				mode = "text-closeout";
			}
		}
	}
	const verifiedReadOnly = !!(
		workflow?.readOnly &&
		workflow.readOnlyRequestsRemaining !== undefined &&
		latest?.role === "tool" &&
		lastCall?.id === latest.tool_call_id &&
		lastCall?.function?.name === "run_tests" &&
		lastCall.id === workflow.publicPassId &&
		typeof latest.content === "string" &&
		passedPytest(latest.content)
	);
	const requestsRemaining = workflow?.readOnlyRequestsRemaining;
	const verifyReadOnly = !!(
		workflow?.readOnly &&
		!verifiedReadOnly &&
		requestsRemaining !== undefined &&
		requestsRemaining >= 2 &&
		(requestsRemaining <= 3 || budgetPressure(after.denial)) &&
		(latest?.role !== "tool" || lastCall?.function?.name !== "run_tests")
	);
	if (workflow && (verifiedReadOnly || verifyReadOnly || workflow.verifyReadOnly || budgetPressure(after.denial))) {
		const compact = compactBudgetTurn(
			verifiedReadOnly || verifyReadOnly ? { ...selected, tools: selected.tools ?? body.tools } : selected,
			preview,
			{ ...workflow, verifyReadOnly: workflow.verifyReadOnly || verifyReadOnly },
			successfulEditId,
		);
		if (compact) {
			selected = compact.body;
			after = compact.check;
			mode = compact.mode;
		}
	}
	return {
		selected,
		observation: {
			duplicates,
			mode,
			beforeDenial: full.denial,
			afterDenial: after.denial,
			beforeReserved: full.diagnostics.candidateReservedTokens,
			afterReserved: after.diagnostics.candidateReservedTokens,
		},
	};
}

const budgetPressure = (code: string | null) => code === "GATEWAY_TOKEN_BUDGET" || code === "GATEWAY_COST_BUDGET";
const discovery = new Set(["ls", "find", "grep"]);

function compactBudgetTurn(
	body: Record<string, unknown>,
	preview: BudgetPreview,
	workflow: BudgetWorkflow,
	editId?: string,
) {
	const messages = Array.isArray(body.messages) ? (body.messages as BudgetWireMessage[]) : [];
	const tools: { type?: string; function?: { name?: string } }[] = Array.isArray(body.tools) ? body.tools : [];
	const last = messages.at(-1);
	const lastAssistant = messages.findLast(({ role }) => role === "assistant");
	const recentCall = lastAssistant?.tool_calls?.length === 1 ? lastAssistant.tool_calls[0] : undefined;
	const paired = last?.role === "tool" && last.tool_call_id === recentCall?.id && recentCall;
	const rollback = paired && recentCall.function?.name === "edit" && recentCall.id === editId;
	const closeout =
		paired &&
		recentCall.function?.name === "run_tests" &&
		recentCall.id === workflow.publicPassId &&
		typeof last?.content === "string" &&
		passedPytest(last.content);
	const mode: "text-closeout" | "test-only" | "continue-work" = closeout
		? "text-closeout"
		: rollback || workflow.verifyReadOnly
			? "test-only"
			: "continue-work";
	const kept: BudgetWireMessage[] = [];
	const seen = new Set<string>();
	const recentReads = new Set<string>();
	const latestEvidence = new Map<string, string>();
	const distinctEvidence = new Map<string, string>();
	if (workflow.readOnly) {
		const evidenceNames = new Map(
			messages.flatMap((message) =>
				(message.tool_calls ?? [])
					.filter((call) => call.function?.name.startsWith("enhanced_"))
					.map((call) => [call.id, call.function!.name] as const),
			),
		);
		const fullReads = new Set<string>();
		if (workflow.readOnlyRequestsRemaining !== undefined) {
			for (const { tool_call_id: id, content } of messages) {
				if (!id || evidenceNames.get(id) !== KNOWLEDGE_READ || typeof content !== "string") continue;
				for (const ref of knowledgeResultReferences({
					toolName: KNOWLEDGE_READ,
					content: [{ type: "text", text: content }],
				}) ?? []) {
					if (ref.disclosure) fullReads.add(JSON.stringify(ref.disclosure));
				}
			}
		}
		for (const message of messages) {
			const id = message.tool_call_id;
			const name = id && evidenceNames.get(id);
			if (!id || !name) continue;
			if (name === KNOWLEDGE_SEARCH && fullReads.size && typeof message.content === "string") {
				const refs = knowledgeResultReferences({
					toolName: KNOWLEDGE_SEARCH,
					content: [{ type: "text", text: message.content }],
				});
				if (
					refs?.length &&
					refs.every(
						(ref) =>
							ref.evidence !== "exact-reference" &&
							ref.disclosure &&
							fullReads.has(JSON.stringify(ref.disclosure)),
					)
				)
					continue;
			}
			latestEvidence.set(name, id);
			if (message.content && message.content !== "Identical output is retained in a later result from this tool.")
				distinctEvidence.set(JSON.stringify([name, message.content]), id);
		}
	}
	const evidenceIds = new Set([...latestEvidence.values(), ...distinctEvidence.values()]);
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "tool") return;
		if (message.role !== "assistant" || !message.tool_calls?.length) {
			if (!closeout || message.role !== "assistant") kept.push(message);
			continue;
		}
		const calls = message.tool_calls;
		const ids = new Set(calls.map(({ id }) => id));
		if (calls.some(({ id }) => seen.has(id))) return;
		for (const { id } of calls) seen.add(id);
		const names = calls.map((call) => call.function?.name ?? "");
		const results = messages.slice(i + 1, i + 1 + calls.length);
		if (
			ids.size !== calls.length ||
			results.length !== calls.length ||
			results.some((r) => r.role !== "tool" || !r.tool_call_id || !ids.delete(r.tool_call_id))
		)
			return;
		for (const name of names) recentReads.add(name);
		const latestGroup = i + calls.length === messages.length - 1;
		const usefulEvidence = calls.some(({ id }) => evidenceIds.has(id));
		const keep = closeout
			? names.includes("edit") || latestGroup || usefulEvidence
			: (latestGroup &&
					!(
						mode === "test-only" &&
						workflow.readOnly &&
						names.every((name) => discovery.has(name) || name === "read")
					)) ||
				(workflow.readOnly
					? names.includes("run_tests") || usefulEvidence
					: !names.every((name) => discovery.has(name) || (mode === "test-only" && name === "read")));
		if (keep) kept.push(message, ...results);
		i += calls.length;
	}
	const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, ...rest } = body;
	let draft: Record<string, unknown> = { ...rest, messages: kept };
	if (mode === "test-only") {
		const tests = tools.filter((tool) => tool.type === "function" && tool.function?.name === "run_tests");
		if (tests.length !== 1) return;
		draft = { ...draft, tools: tests, tool_choice: { type: "function", function: { name: "run_tests" } } };
	} else if (mode === "continue-work") {
		const lean = tools.filter(
			({ function: fn }) => !fn?.name || !(discovery.has(fn.name) && recentReads.has("read")),
		);
		if (!lean.length) return;
		draft = { ...draft, tools: lean };
	}
	const check = preview(draft);
	return check.denial ? undefined : { body: draft, mode, check };
}

function passedPytest(text: string): boolean {
	try {
		const result = JSON.parse(text) as {
			status?: string;
			exitCode?: number;
			passed?: number;
			failed?: number;
		} | null;
		return result?.status === "passed" && result.exitCode === 0 && (result.passed ?? 0) > 0 && result.failed === 0;
	} catch {
		return false;
	}
}

// Read-only lower bound. Future messages and settlement can require more headroom.
export function assessBudgetContinuation(
	stage: "edit" | "run_tests" | "restore",
	model: string,
	status: BudgetState,
	preview: BudgetPreview,
) {
	const remainingRequests = status.limits.maxRequests - status.requestsStarted;
	// A separate edit → pytest → reply sequence typically needs two requests.
	// A batch can already include pytest, so one remaining request is sufficient for admission.
	const recommendedRequests = stage === "edit" ? 2 : 1;
	const minimum = preview({
		model,
		messages: [],
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: status.limits.minOutputTokensPerRequest ?? status.limits.maxOutputTokensPerRequest,
	});
	return {
		stage,
		remainingRequests,
		recommendedRequests,
		tight: remainingRequests < recommendedRequests,
		minimumReservation: minimum.diagnostics.candidateReservedTokens,
		tokenHeadroom: minimum.diagnostics.remainingTokenHeadroom,
		denial: minimum.denial,
		// Local pytest may still produce evidence or useful diagnostics for a paused task.
		blocked: stage !== "run_tests" && minimum.denial !== null,
	};
}

type Continuation = ReturnType<typeof assessBudgetContinuation> & { validationReservation?: number };

export interface AgentBudgetWorkflow {
	active?: () => boolean;
	preview: BudgetPreview;
	status: () => BudgetState;
	/** A trusted host explicitly configures this task as read-only. */
	readOnly?: boolean;
	verifyReadOnly?: () => boolean;
	onProjection?: (result: ReturnType<typeof projectBudgetWorkflow>) => void;
	onContinuation?: (result: Continuation) => void;
}

const readOnlyTools = new Set([...repeatableReads, "run_tests", "enhanced_context_restore"]);

/** Binds budget decisions to native AgentSession hooks for hosts with a shared admission ledger. */
export function registerAgentBudgetWorkflow(
	pi: ExtensionAPI,
	workflow: AgentBudgetWorkflow,
	deduplicateReads: () => boolean,
) {
	let editId: string | undefined;
	let publicPassId: string | undefined;
	let validationFloor: Record<string, unknown> | undefined;
	let mode: ReturnType<typeof projectBudgetWorkflow>["observation"]["mode"] = "full";
	pi.on("tool_result", (event, ctx) => {
		if (!ctx.isProjectTrusted() || event.parentToolCallId) return;
		editId = event.toolName === "edit" && !event.isError ? event.toolCallId : undefined;
		publicPassId = event.toolName === "run_tests" && !event.isError ? event.toolCallId : undefined;
	});
	pi.on("before_provider_request", ({ payload }, ctx) => {
		mode = "full";
		validationFloor = undefined;
		if (
			!ctx.isProjectTrusted() ||
			workflow.active?.() === false ||
			!payload ||
			typeof payload !== "object" ||
			Array.isArray(payload)
		)
			return;
		const body = payload as Record<string, unknown>;
		if (body.stream !== true || !Array.isArray(body.messages) || typeof body.model !== "string") return;
		const messages = body.messages as BudgetWireMessage[];
		if (messages.some((message) => !message || typeof message.role !== "string")) return;
		const tools = Array.isArray(body.tools) ? body.tools : [];
		const tests = tools.filter((tool) => tool?.type === "function" && tool.function?.name === "run_tests");
		if (tests.length === 1) {
			validationFloor = {
				...body,
				tools: tests,
				tool_choice: { type: "function", function: { name: "run_tests" } },
				messages: messages.filter(({ role }) => role === "system" || role === "user"),
			};
		}
		const status = workflow.status();
		const result = projectBudgetWorkflow(
			workflow.readOnly ? { ...body, tools: tools.filter((tool) => readOnlyTools.has(tool?.function?.name)) } : body,
			workflow.preview,
			editId,
			{
				publicPassId,
				runtimeProjection: deduplicateReads(),
				readOnly: workflow.readOnly,
				verifyReadOnly: messages.at(-1)?.role === "user" && workflow.verifyReadOnly?.(),
				readOnlyRequestsRemaining: status.limits.maxRequests - status.requestsStarted,
			},
		);
		mode = result.observation.mode;
		workflow.onProjection?.(result);
		return result.selected;
	});
	pi.on("tool_call", (event, ctx) => {
		if (!ctx.isProjectTrusted() || workflow.active?.() === false) return;
		if (mode === "text-closeout") return { block: true, reason: "The closing turn only permits a text response." };
		if (mode === "test-only" && event.toolName !== "run_tests")
			return { block: true, reason: "This budget-limited turn only permits the approved pytest." };
		if (workflow.readOnly && !readOnlyTools.has(event.toolName))
			return { block: true, reason: "The approved task is read-only." };
		if (event.toolName !== "edit" && event.toolName !== "run_tests") return;
		const decision: Continuation = assessBudgetContinuation(
			event.toolName,
			ctx.model?.id ?? "",
			workflow.status(),
			workflow.preview,
		);
		if (event.toolName === "edit" && validationFloor && !decision.blocked) {
			const test = workflow.preview(validationFloor);
			decision.validationReservation = test.diagnostics.candidateReservedTokens;
			if (test.denial) {
				decision.denial = test.denial;
				decision.blocked = true;
				decision.minimumReservation = test.diagnostics.candidateReservedTokens;
			}
		}
		workflow.onContinuation?.(decision);
		if (decision.blocked)
			return {
				block: true,
				reason: `Edit blocked before writing: ${decision.denial}. Verification and final response need model budget.`,
			};
	});
}
