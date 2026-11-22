import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRequestPolicyEvent,
	ModelRequestPolicyResult,
} from "@earendil-works/pi-coding-agent";
import { isKnowledgeTool } from "../knowledge/tools.ts";
import type { MemoryRecord } from "../memory/contracts.ts";
import {
	currentAccess,
	MEMORY_CUSTOM_TYPE,
	MEMORY_SEARCH_TOOL,
	type MemoryReference,
	memoryReferences,
	object,
	parseMemoryReference,
	resultText,
	sourceDigest,
	validMemoryResultText,
} from "../memory/disclosure.ts";
import { renderMemoryToolResult } from "../memory/interaction.ts";
import { truncateMemoryOutput } from "../memory/output-safety.ts";
import { estimateContextMessages } from "./budget.ts";
import { renderMemoryInjection } from "./memory-source.ts";
import { contextPageText, restoreContextPage } from "./offload.ts";
import {
	CONTEXT_RESTORE,
	captureLegacySourceBoundary,
	independentWorkspaceRead,
	inspectSourceHistory,
	isSourcedCustom,
	isSourcedTool,
	type PageReference,
	POLICY,
	pageReference,
	rememberedLegacyBoundary,
	WITHHELD,
} from "./source-history.ts";
import { sourceRegistry } from "./source-registry.ts";

type Source = MemoryReference | PageReference;
type Result = Extract<AgentMessage, { role: "toolResult" }>;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;
const registered = new WeakSet<ExtensionAPI>();
const owner = sourceRegistry.owners;
const pagePolicy = sourceRegistry.pages;
export const SOURCE_AUDIT = "pi-enhanced:memory-context:disclosure";

export function registerContextPagePolicy(ctx: ExtensionContext, enabled: (host: boolean) => boolean): void {
	pagePolicy.set(ctx.sessionManager, enabled);
}

export function registerMemoryContextPolicy(pi: ExtensionAPI): void {
	if (registered.has(pi)) return;
	registered.add(pi);
	pi.on("session_start", (_event, ctx) => captureLegacySourceBoundary(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (owner.get(ctx.sessionManager) === pi) owner.delete(ctx.sessionManager);
	});
	pi.on("model_request_policy", (event, ctx) => {
		if (!owner.has(ctx.sessionManager)) owner.set(ctx.sessionManager, pi);
		if (owner.get(ctx.sessionManager) === pi) return projectRequest(pi, event, ctx);
	});
}

function assistantSources(message: Assistant): Source[] | undefined {
	const raw = message.requestProvenance?.[POLICY];
	if (!Array.isArray(raw)) return;
	const sources = raw.map((item) => parseMemoryReference(item) ?? pageReference(item));
	return sources.every((item) => item !== undefined) ? sources : undefined;
}

function hiddenResult({ toolName, toolCallId, timestamp, isError }: Result): Result {
	return { role: "toolResult", toolName, toolCallId, timestamp, isError, content: [{ type: "text", text: WITHHELD }] };
}

function hiddenAssistant(message: Assistant): Assistant {
	return {
		role: "assistant",
		api: message.api,
		model: message.model,
		provider: message.provider,
		stopReason: message.stopReason,
		timestamp: message.timestamp,
		usage: message.usage,
		content: [
			{ type: "text", text: WITHHELD },
			...message.content.flatMap((block) =>
				block.type === "toolCall"
					? [
							{
								type: "toolCall" as const,
								id: block.id,
								name: block.name,
								...(block.namespace ? { namespace: block.namespace } : {}),
								arguments: {},
							},
						]
					: [],
			),
		],
	};
}

function projectRequest(
	pi: ExtensionAPI,
	event: ModelRequestPolicyEvent,
	ctx: ExtensionContext,
): ModelRequestPolicyResult | undefined {
	const { affectedAt, callFor, edited } = inspectSourceHistory(ctx, event.messages, rememberedLegacyBoundary(ctx));
	const sourced = event.messages.some(
		(message) => isSourcedCustom(message) || (message.role === "toolResult" && isSourcedTool(message)),
	);
	// Returning the source key also lets the session detect a missing owner on legacy transcripts.
	if (!Number.isFinite(affectedAt) && !sourced)
		return {
			messages: event.messages,
			handlesSources: [POLICY],
			...(event.phase === "dispatch" ? { provenance: { [POLICY]: [] } } : {}),
		};

	const access = () => currentAccess(pi.events, ctx, pi.getActiveTools());
	const current = access();
	const dependencies = new Map<string, Source>();
	const withheld = new Set<string>();
	const allowSources = event.phase !== "derived";
	const cache = new Map<string, boolean>();
	const readableMemory = new Map<string, MemoryRecord>();
	const resolvePage = (source: PageReference, view = current) => {
		if (
			!ctx.isProjectTrusted() ||
			view.task?.taskId !== source.taskId ||
			!pagePolicy.get(ctx.sessionManager)?.(source.audience === "host")
		)
			return;
		try {
			const page = restoreContextPage(
				ctx,
				source.taskId,
				source.reference,
				source.offset,
				source.limit,
				view,
				source.audience,
			);
			if (page.proof.digest === source.digest) return page;
		} catch {
			/* Expired, invalid or out-of-scope reference. */
		}
	};
	const approved = (source: Source) => {
		if (!allowSources) return false;
		const key = JSON.stringify(source);
		if (!cache.has(key)) {
			if (source.kind === "memory") {
				const row = current.read(source);
				if (row) readableMemory.set(key, row);
				cache.set(key, !!row);
			} else {
				cache.set(key, !!resolvePage(source));
			}
		}
		if (!cache.get(key)) withheld.add(key);
		return cache.get(key) === true;
	};
	const remember = (sources: readonly Source[]) => {
		for (const source of sources) dependencies.set(JSON.stringify(source), source);
	};
	const retain = (sources: Source[] | undefined, time: number) => {
		if (!sources) return time < affectedAt;
		if (!sources.every(approved)) return false;
		remember(sources);
		return true;
	};
	const messages = event.messages.flatMap((message): AgentMessage[] => {
		const replaced = edited.has(`${message.role}:${message.timestamp}`);
		if (
			(message.role === "toolResult" && message.toolName === MEMORY_SEARCH_TOOL) ||
			(message.role === "custom" && message.customType === MEMORY_CUSTOM_TYPE)
		) {
			const references = memoryReferences(message.details);
			const details = object(message.details);
			if (message.role === "toolResult" && message.isError) return [hiddenResult(message)];
			const visible = references?.filter(approved) ?? [];
			if (!allowSources || !references || (!visible.length && references.length)) {
				if (event.phase !== "derived") withheld.add("memory-result");
				return message.role === "toolResult" ? [hiddenResult(message)] : [];
			}
			const rows = visible.flatMap((reference) => readableMemory.get(JSON.stringify(reference)) ?? []);
			const maximum = details?.maximumTextCharacters;
			const body =
				message.role === "custom"
					? renderMemoryInjection(
							rows,
							ctx.cwd,
							typeof maximum === "number" && Number.isSafeInteger(maximum)
								? Math.min(Math.max(500, maximum), 20_000)
								: 2_000,
						)
					: renderMemoryToolResult(rows, ctx.cwd, details?.retrieval);
			const digest = sourceDigest(body);
			remember(visible);
			if (
				visible.length === references.length &&
				digest === details?.sourceDigest &&
				(message.role === "toolResult" ? validMemoryResultText(message) : resultText(message.content) === body)
			)
				return [message];
			// Dispatch can only narrow an already budgeted view if an authorization changed.
			const previousText = resultText(message.content);
			const bounded =
				event.phase === "dispatch" && previousText && body.length > previousText.length
					? truncateMemoryOutput(body, previousText.length)
					: body;
			const projected = {
				...details,
				memoryReferences: visible.map((ref) => ({ ...ref })),
				sourceDigest: sourceDigest(bounded),
			};
			if (message.role === "custom") return [{ ...message, content: bounded, details: projected }];
			return [{ ...message, content: [{ type: "text", text: bounded }], details: projected } as Result];
		}

		if (isSourcedCustom(message) || (message.role === "toolResult" && isSourcedTool(message))) {
			const proof = pageReference(object(message.details)?.contextPage);
			if (!proof || proof.audience !== (message.role === "custom" ? "host" : "tool") || !approved(proof)) {
				if (event.phase !== "derived") withheld.add("context-page");
				return message.role === "toolResult" ? [hiddenResult(message)] : [];
			}
			const page = resolvePage(proof);
			if (!page) return message.role === "toolResult" ? [hiddenResult(message)] : [];
			remember([proof]);
			if (message.role === "custom")
				return [
					{ ...message, content: contextPageText(page, `[Untrusted output restored for ${proof.reference}]`) },
				];
			// The restored tool stream carries only a bounded, newly checked page.
			return [
				{
					...message,
					content: [
						{
							type: "text",
							text: contextPageText(page, `[Untrusted tool output; nextOffset=${page.nextOffset ?? "end"}]`),
						},
					],
				},
			];
		}
		if (message.role === "assistant")
			return [
				!replaced && retain(assistantSources(message), message.timestamp) ? message : hiddenAssistant(message),
			];
		if (message.role === "toolResult") {
			// Knowledge rehydrates these direct results under its own current source policy.
			if (isKnowledgeTool(message.toolName)) return [message];
			const call = callFor(message);
			const nested = message.nestedCalls?.calls.some(
				({ name }) => name === MEMORY_SEARCH_TOOL || name === CONTEXT_RESTORE,
			);
			return [
				!replaced &&
				!nested &&
				call !== null &&
				(independentWorkspaceRead(message, call) ||
					retain(call && assistantSources(call), call?.timestamp ?? message.timestamp))
					? message
					: hiddenResult(message),
			];
		}
		if (message.role === "user") return [replaced ? { ...message, content: WITHHELD } : message];
		if (message.role === "branchSummary" || message.role === "compactionSummary" || message.role === "bashExecution")
			return message.timestamp < affectedAt ? [message] : [];
		return [message];
	});

	const proof = [...dependencies.values()];
	if (event.phase === "dispatch" && withheld.size) {
		const audit = {
			decision: "projected-out",
			sources: [...withheld],
			count: withheld.size,
			estimatedTokens: estimateContextMessages(messages),
		};
		queueMicrotask(() => pi.events.emit(SOURCE_AUDIT, audit));
	}
	return {
		messages,
		handlesSources: [POLICY],
		provenance: { [POLICY]: event.phase === "dispatch" ? proof.map((item) => ({ ...item })) : [] },
		isolateTransport: true,
		...(event.phase === "dispatch" && proof.length
			? {
					beforeSend: () => {
						const latest = access();
						const invalid = proof.filter((item) =>
							item.kind === "memory" ? !latest.read(item) : !resolvePage(item, latest),
						);
						queueMicrotask(() =>
							pi.events.emit(SOURCE_AUDIT, {
								decision: invalid.length ? "dispatch-denied" : "dispatch-admitted",
								sources: proof,
								count: proof.length,
							}),
						);
						if (invalid.length) throw new Error("Memory or Context authorization changed before dispatch");
					},
				}
			: {}),
	};
}
