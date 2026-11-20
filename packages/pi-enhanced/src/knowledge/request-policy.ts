import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionContext,
	ModelRequestPolicyEvent,
	ModelRequestPolicyResult,
} from "@earendil-works/pi-coding-agent";
import { CONTEXT_RESTORE, isSourcedCustom, POLICY } from "../context/source-history.ts";
import { sourceRegistry } from "../context/source-registry.ts";
import { object } from "../memory/disclosure.ts";
import type { KnowledgeService } from "./service.ts";
import type { StoredChunk } from "./store.ts";
import {
	type ChunkReference,
	type DocumentDisclosure,
	isKnowledgeTool,
	knowledgeResultReferences,
	parseDisclosure,
	projectKnowledgeToolContent,
	storeKnowledgeToolReferences,
} from "./tools.ts";

const pageAccess = sourceRegistry.knowledge;

export function registerKnowledgePageAccess(ctx: ExtensionContext, requireService: () => KnowledgeService | undefined) {
	pageAccess.set(ctx.sessionManager, requireService);
}

export function currentKnowledgePageText(
	ctx: ExtensionContext,
	message: { toolName: string; content: Extract<AgentMessage, { role: "toolResult" }>["content"]; details?: unknown },
): string | undefined {
	if (!isKnowledgeTool(message.toolName)) return;
	const result = { ...message, toolName: message.toolName };
	const service = pageAccess.get(ctx.sessionManager)?.();
	const references = knowledgeResultReferences(result);
	if (!service || !references?.length || !references.every(({ disclosure }) => disclosure)) return;
	const hits = new Map<string, StoredChunk>();
	for (const reference of references) {
		const hit = readDisclosedChunk(service, reference);
		if (!hit) return;
		hits.set(reference.chunkId, hit);
	}
	const [block] = projectKnowledgeToolContent(result, ({ chunkId }) => hits.get(chunkId));
	return block?.type === "text" ? block.text : undefined;
}

function readDisclosedChunk(service: KnowledgeService | undefined, reference: ChunkReference) {
	try {
		const proof = reference.disclosure;
		const { match } =
			service?.read(reference.chunkId, {
				audience: "agent",
				corpusId: proof?.corpusId,
				documentId: proof?.documentId,
			}) ?? {};
		return match && (!proof || match.chunk.documentVersion === proof.revision) ? match : undefined;
	} catch {
		return undefined;
	}
}

const WITHHELD = "此前的文档相关上下文已省略。";
type Proof = DocumentDisclosure[];

function assistantProof(message: Extract<AgentMessage, { role: "assistant" }>): Proof | undefined {
	const raw = message.requestProvenance?.knowledge;
	if (!Array.isArray(raw)) return;
	const parsed = raw.map(parseDisclosure);
	return parsed.every((value) => value !== undefined) ? parsed : undefined;
}

function isDocumentResult(message: AgentMessage): boolean {
	if (message.role !== "toolResult" || message.isError) return false;
	if (message.nestedCalls?.calls.some(({ name }) => isKnowledgeTool(name))) return true;
	if (!isKnowledgeTool(message.toolName)) return false;
	return knowledgeResultReferences({ ...message, toolName: message.toolName })?.length !== 0;
}

/** Use the retained session log, including entries hidden by compaction, as lineage evidence. */
function inspectHistory(ctx: Pick<ExtensionContext, "sessionManager">, incoming: AgentMessage[] = []) {
	const entries = ctx.sessionManager.getEntries();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const calls = new Map<string, { proof: Proof | undefined; timestamp: number }>();
	const ambiguousCalls = new Set<string>();
	let affectedAt = Infinity;
	const inspect = (message: AgentMessage, persisted: boolean) => {
		if (isDocumentResult(message)) affectedAt = Math.min(affectedAt, message.timestamp);
		if (message.role !== "assistant") return;
		const proof = assistantProof(message);
		if (proof?.length) affectedAt = Math.min(affectedAt, message.timestamp);
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const previous = calls.get(block.id);
			if (!previous) calls.set(block.id, { proof, timestamp: message.timestamp });
			// The incoming projection normally repeats persisted messages. A second
			// persisted issuer or a different projected issuer is ambiguous.
			else if (
				persisted ||
				previous.timestamp !== message.timestamp ||
				JSON.stringify(previous.proof) !== JSON.stringify(proof)
			)
				ambiguousCalls.add(block.id);
		}
	};
	for (const entry of entries) {
		if (entry.type === "message") inspect(entry.message, true);
		// A fork can carry a summary whose source entries live only in the original file.
		if (
			(entry.type === "branch_summary" && !byId.has(entry.fromId)) ||
			(entry.type === "compaction" && ctx.sessionManager.getHeader()?.parentSession)
		)
			affectedAt = Math.min(affectedAt, new Date(entry.timestamp).getTime());
	}
	for (const message of incoming) inspect(message, false);
	const edited = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "context_edit" || !entry.replacement || new Date(entry.timestamp).getTime() < affectedAt)
			continue;
		const target = byId.get(entry.targetId);
		if (target?.type === "message") edited.add(`${target.message.role}:${target.message.timestamp}`);
	}
	return { calls, ambiguousCalls, affectedAt, edited };
}

/** Context offload is a host view of the original audit log. Do not restore affected contents into a tool. */
export function independentContextResults(ctx: Pick<ExtensionContext, "sessionManager">) {
	const { calls, ambiguousCalls, affectedAt } = inspectHistory(ctx);
	return (message: Extract<AgentMessage, { role: "toolResult" }>) => {
		if (isKnowledgeTool(message.toolName) || isDocumentResult(message) || ambiguousCalls.has(message.toolCallId))
			return false;
		const call = calls.get(message.toolCallId);
		return call?.proof?.length === 0 || (call?.timestamp ?? message.timestamp) < affectedAt;
	};
}

export function projectKnowledgeRequest(
	event: ModelRequestPolicyEvent,
	ctx: ExtensionContext,
	requireService: () => KnowledgeService | undefined,
): ModelRequestPolicyResult | undefined {
	const { calls, ambiguousCalls, affectedAt, edited } = inspectHistory(ctx, event.messages);
	const hasDocumentResult = event.messages.some(
		(message) => message.role === "toolResult" && isKnowledgeTool(message.toolName),
	);
	if (!Number.isFinite(affectedAt) && !hasDocumentResult)
		return { messages: event.messages, handlesSources: ["knowledge"] };

	const includeDocuments = event.phase !== "derived";
	const hydrated = new Map<string, StoredChunk | undefined>();
	const dependencies = new Map<string, DocumentDisclosure>();
	const service = requireService();
	const read = (reference: ChunkReference, current = service) => readDisclosedChunk(current, reference);
	const lookup = (reference: ChunkReference) => {
		const key = JSON.stringify(reference.disclosure ?? reference.chunkId);
		if (!hydrated.has(key)) hydrated.set(key, read(reference));
		return hydrated.get(key);
	};
	const retainProof = (proof: Proof | undefined, timestamp: number) => {
		if (!proof) return timestamp < affectedAt;
		if (!includeDocuments && proof.length > 0) return false;
		if (!proof.every((item) => lookup({ chunkId: item.chunkId, disclosure: item }))) return false;
		for (const item of proof) dependencies.set(item.chunkId, item);
		return true;
	};
	const messages = event.messages.flatMap((message): AgentMessage[] => {
		const replaced = edited.has(`${message.role}:${message.timestamp}`);
		switch (message.role) {
			case "toolResult": {
				// Erase local details/nested audit data from the transport projection.
				const { toolName, toolCallId, timestamp, isError } = message;
				if (isKnowledgeTool(toolName)) {
					const hint = object(message.details)?.contextPageHint;
					const page = typeof hint === "string" && /^v1:[a-f0-9]{64}$/u.test(hint) ? hint : undefined;
					if (event.phase === "transcript") {
						const stored = storeKnowledgeToolReferences({ ...message, toolName });
						const details = page ? { ...object(stored.details), contextPageHint: page } : stored.details;
						return [{ ...message, ...stored, details } as AgentMessage];
					}
					const content = projectKnowledgeToolContent({ ...message, toolName }, (ref) => {
						if (!includeDocuments) return;
						const hit = lookup(ref);
						if (hit) {
							dependencies.set(ref.chunkId, {
								corpusId: hit.document.corpusId,
								documentId: hit.document.documentId,
								revision: hit.chunk.documentVersion,
								chunkId: ref.chunkId,
								accessPolicy: "allow-external",
							});
						}
						return hit;
					});
					if (page && includeDocuments && currentKnowledgePageText(ctx, message))
						content.push({
							type: "text",
							text: `[This task can also read the source with ${CONTEXT_RESTORE} reference ${page}.]`,
						});
					return [{ role: "toolResult", toolName, toolCallId, timestamp, isError, content }];
				}
				if (toolName === CONTEXT_RESTORE && object(message.details)?.modelRequestPolicy === POLICY)
					return [message];
				const call = calls.get(toolCallId);
				if (
					replaced ||
					isDocumentResult(message) ||
					ambiguousCalls.has(toolCallId) ||
					!retainProof(call?.proof, call?.timestamp ?? timestamp)
				) {
					return [
						{
							role: "toolResult",
							toolName,
							toolCallId,
							timestamp,
							isError,
							content: [{ type: "text", text: WITHHELD }],
						},
					];
				}
				return [message];
			}
			case "assistant":
				if (!replaced && retainProof(assistantProof(message), message.timestamp)) return [message];
				return [
					{
						role: "assistant",
						api: message.api,
						provider: message.provider,
						model: message.model,
						stopReason: message.stopReason,
						usage: message.usage,
						timestamp: message.timestamp,
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
					},
				];
			case "branchSummary":
			case "compactionSummary":
			case "bashExecution":
				return message.timestamp < affectedAt ? [message] : [];
			case "custom":
				return (isSourcedCustom(message) && object(message.details)?.modelRequestPolicy === POLICY) ||
					message.timestamp < affectedAt
					? [message]
					: [];
			case "user":
				return replaced ? [{ ...message, content: WITHHELD }] : [message];
			default:
				return [message];
		}
	});

	if (event.phase !== "dispatch") return { messages, isolateTransport: true, handlesSources: ["knowledge"] };
	const proof = [...dependencies.values()];
	const documentIds = [...new Set(proof.map(({ documentId }) => documentId))];
	return {
		messages,
		isolateTransport: true,
		handlesSources: ["knowledge"],
		provenance: { knowledge: proof.map((item) => ({ ...item })) },
		...(proof.length > 0
			? {
					beforeSend: () => {
						const current = requireService();
						if (
							!current ||
							current !== service ||
							!current.admitDisclosure(documentIds, () =>
								proof.every((item) => read({ chunkId: item.chunkId, disclosure: item }, current) !== undefined),
							)
						) {
							throw new Error("Knowledge document disclosure changed before dispatch");
						}
					},
				}
			: {}),
	};
}
