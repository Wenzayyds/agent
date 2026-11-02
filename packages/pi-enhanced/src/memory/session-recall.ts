import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type ProjectScope,
	SESSION_RECALL_MODES,
	type SessionRecallHit,
	type SessionRecallQuery,
	type SessionRecallResult,
	type SessionRecallRole,
} from "./contracts.ts";
import { MemoryError } from "./errors.ts";

type RecallSessionManager = ExtensionContext["sessionManager"];
type RecallMessage = ReturnType<RecallSessionManager["buildSessionProjection"]>["messages"][number];

export interface SessionRecallLimits {
	defaultResults: number;
	maximumResults: number;
	maximumQueryCharacters: number;
	maximumScannedEntries: number;
	maximumScannedTexts: number;
	maximumSourceCharacters: number;
	maximumHitCharacters: number;
	maximumTotalBytes: number;
}

export const DEFAULT_SESSION_RECALL_LIMITS: SessionRecallLimits = Object.freeze({
	defaultResults: 10,
	maximumResults: 20,
	maximumQueryCharacters: 500,
	maximumScannedEntries: 2_000,
	maximumScannedTexts: 2_000,
	maximumSourceCharacters: 64 * 1_024,
	maximumHitCharacters: 4_096,
	maximumTotalBytes: 32 * 1_024,
});

interface RecallContribution {
	entry: SessionEntry;
	role: SessionRecallRole;
	text: string;
	sourceTruncated: boolean;
}

export class SessionRecallAdapter {
	readonly scope: ProjectScope;
	private readonly sessionManager: RecallSessionManager;
	private readonly limits: SessionRecallLimits;
	private closed = false;

	constructor(
		scope: ProjectScope,
		sessionManager: RecallSessionManager,
		limits: SessionRecallLimits = DEFAULT_SESSION_RECALL_LIMITS,
	) {
		let sessionCwd: string;
		try {
			sessionCwd = realpathSync.native(sessionManager.getCwd());
		} catch (error) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Session working directory is unavailable", { cause: error });
		}
		if (sessionCwd !== scope.rootPath) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Session Recall scope does not match the current project");
		}
		this.scope = scope;
		this.sessionManager = sessionManager;
		this.limits = limits;
	}

	search(query: SessionRecallQuery): SessionRecallResult {
		this.assertOpen();
		const searchText = validateQuery(query.text, this.limits.maximumQueryCharacters);
		const projection = query.mode ?? "raw-active-branch";
		if (!SESSION_RECALL_MODES.includes(projection)) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Unsupported Session Recall mode");
		}
		if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Session Recall limit must be a positive integer");
		}
		const resultLimit = Math.min(query.limit ?? this.limits.defaultResults, this.limits.maximumResults);
		const sessionId = this.sessionManager.getSessionId();
		const branchLeafId = this.sessionManager.getLeafId();
		const sourceEntries =
			projection === "raw-active-branch"
				? this.sessionManager.getBranch().map((entry) => ({
						entry,
						contributions: rawContributions(entry, this.limits.maximumSourceCharacters),
					}))
				: this.sessionManager.buildSessionProjection().entries.map(({ sourceEntry, messages }) => ({
						entry: sourceEntry,
						contributions: messages.flatMap((message) =>
							messageContribution(sourceEntry, message, this.limits.maximumSourceCharacters),
						),
					}));

		const normalizedQuery = normalizeForSearch(searchText);
		const hits: SessionRecallHit[] = [];
		let scannedEntries = 0;
		let scannedTexts = 0;
		let totalBytes = 0;
		let scanLimitReached = false;
		let sourceLimitReached = false;
		let resultLimitReached = false;

		outer: for (let index = sourceEntries.length - 1; index >= 0; index--) {
			if (scannedEntries >= this.limits.maximumScannedEntries) {
				scanLimitReached = true;
				break;
			}
			scannedEntries++;
			const source = sourceEntries[index];
			for (let contributionIndex = source.contributions.length - 1; contributionIndex >= 0; contributionIndex--) {
				if (scannedTexts >= this.limits.maximumScannedTexts) {
					scanLimitReached = true;
					break outer;
				}
				scannedTexts++;
				const contribution = source.contributions[contributionIndex];
				if (contribution.sourceTruncated) sourceLimitReached = true;
				if (!normalizeForSearch(contribution.text).includes(normalizedQuery)) continue;
				if (hits.length >= resultLimit) {
					resultLimitReached = true;
					break outer;
				}

				const redacted = redactSensitiveText(contribution.text, this.scope.rootPath);
				const hitBound = truncateCharacters(redacted, this.limits.maximumHitCharacters);
				const availableBytes = this.limits.maximumTotalBytes - totalBytes;
				if (availableBytes <= 0) {
					resultLimitReached = true;
					break outer;
				}
				const totalBound = truncateUtf8Bytes(hitBound.text, availableBytes);
				if (!totalBound.text) {
					resultLimitReached = true;
					break outer;
				}
				const truncated = contribution.sourceTruncated || hitBound.truncated || totalBound.truncated;
				totalBytes += Buffer.byteLength(totalBound.text, "utf8");
				hits.push({
					projectId: this.scope.projectId,
					sessionId,
					entryId: contribution.entry.id,
					branchLeafId,
					entryType: contribution.entry.type,
					role: contribution.role,
					projection,
					content: totalBound.text,
					contentHash: createHash("sha256").update(totalBound.text).digest("hex"),
					entryTimestamp: contribution.entry.timestamp,
					truncated,
				});
				if (totalBound.truncated || totalBytes >= this.limits.maximumTotalBytes) {
					resultLimitReached = true;
					break outer;
				}
			}
		}

		return {
			projectId: this.scope.projectId,
			sessionId,
			branchLeafId,
			projection,
			hits,
			scannedEntries,
			scannedTexts,
			scanLimitReached,
			sourceLimitReached,
			resultLimitReached,
		};
	}

	close(): void {
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) throw new MemoryError("MEMORY_RUNTIME_CLOSED", "Memory runtime is closed");
	}
}

function rawContributions(entry: SessionEntry, maximumCharacters: number): RecallContribution[] {
	if (entry.type === "message") return messageContribution(entry, entry.message, maximumCharacters);
	if (entry.type === "custom_message") {
		const bounded = textContent(entry.content, maximumCharacters);
		return bounded.text ? [{ entry, role: "custom", text: bounded.text, sourceTruncated: bounded.truncated }] : [];
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const bounded = truncateCharacters(entry.summary, maximumCharacters);
		return bounded.text ? [{ entry, role: "custom", text: bounded.text, sourceTruncated: bounded.truncated }] : [];
	}
	return [];
}

function messageContribution(
	entry: SessionEntry,
	message: RecallMessage,
	maximumCharacters: number,
): RecallContribution[] {
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult": {
			const bounded = textContent(message.content, maximumCharacters);
			return bounded.text
				? [{ entry, role: message.role, text: bounded.text, sourceTruncated: bounded.truncated }]
				: [];
		}
		case "custom": {
			const bounded = textContent(message.content, maximumCharacters);
			return bounded.text ? [{ entry, role: "custom", text: bounded.text, sourceTruncated: bounded.truncated }] : [];
		}
		case "branchSummary":
		case "compactionSummary": {
			const bounded = truncateCharacters(message.summary, maximumCharacters);
			return bounded.text ? [{ entry, role: "custom", text: bounded.text, sourceTruncated: bounded.truncated }] : [];
		}
		case "bashExecution": {
			const bounded = joinedText([message.command, message.output], maximumCharacters);
			return bounded.text ? [{ entry, role: "custom", text: bounded.text, sourceTruncated: bounded.truncated }] : [];
		}
		case "system":
			return [];
	}
}

function textContent(content: unknown, maximumCharacters: number): { text: string; truncated: boolean } {
	if (typeof content === "string") return truncateCharacters(content, maximumCharacters);
	if (!Array.isArray(content)) return { text: "", truncated: false };
	let text = "";
	let count = 0;
	let includedBlock = false;
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || !block.text) continue;
		if (includedBlock) {
			if (count >= maximumCharacters) return { text, truncated: true };
			text += "\n";
			count++;
		}
		includedBlock = true;
		for (const character of block.text) {
			if (count >= maximumCharacters) return { text, truncated: true };
			text += character;
			count++;
		}
	}
	return { text, truncated: false };
}

function joinedText(parts: readonly string[], maximumCharacters: number): { text: string; truncated: boolean } {
	let text = "";
	let count = 0;
	let includedPart = false;
	for (const part of parts) {
		if (!part) continue;
		if (includedPart) {
			if (count >= maximumCharacters) return { text, truncated: true };
			text += "\n";
			count++;
		}
		includedPart = true;
		for (const character of part) {
			if (count >= maximumCharacters) return { text, truncated: true };
			text += character;
			count++;
		}
	}
	return { text, truncated: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validateQuery(value: string, maximum: number): string {
	if (typeof value !== "string") {
		throw new MemoryError("MEMORY_VALIDATION_ERROR", "Session Recall query must be a string");
	}
	const trimmed = value.trim();
	if (!trimmed) throw new MemoryError("MEMORY_VALIDATION_ERROR", "Session Recall query must not be empty");
	if (trimmed.includes("\0")) {
		throw new MemoryError("MEMORY_VALIDATION_ERROR", "Session Recall query contains an invalid null character");
	}
	if ([...trimmed].length > maximum) {
		throw new MemoryError("MEMORY_VALIDATION_ERROR", "Session Recall query is too long");
	}
	return trimmed;
}

function normalizeForSearch(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("und");
}

function redactSensitiveText(value: string, projectRoot: string): string {
	let redacted = value;
	for (const path of new Set([projectRoot, projectRoot.replaceAll("\\", "/"), projectRoot.replaceAll("/", "\\")])) {
		if (path) redacted = redacted.replaceAll(path, "[PROJECT_PATH]");
	}
	return redacted
		.replace(
			/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
			"[REDACTED_PRIVATE_KEY]",
		)
		.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*/gu, "[REDACTED_PRIVATE_KEY]")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED_TOKEN]")
		.replace(/\bghp_[A-Za-z0-9]{20,}\b/gu, "[REDACTED_TOKEN]")
		.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_TOKEN]")
		.replace(/\bAKIA[A-Z0-9]{16}\b/gu, "[REDACTED_TOKEN]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu, "Bearer [REDACTED]")
		.replace(
			/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gu,
			"$1=[REDACTED]",
		)
		.replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{8,}["']?/giu, "$1=[REDACTED]")
		.replace(/\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|]+[\\/])*[^\\/\s"'<>|]*/gu, "[REDACTED_PATH]")
		.replace(/\/(?:home|Users)\/[^\s"'<>]+/gu, "[REDACTED_PATH]");
}

function truncateCharacters(value: string, maximum: number): { text: string; truncated: boolean } {
	let text = "";
	let count = 0;
	for (const character of value) {
		if (count >= maximum) return { text, truncated: true };
		text += character;
		count++;
	}
	return { text, truncated: false };
}

function truncateUtf8Bytes(value: string, maximum: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maximum) return { text: value, truncated: false };
	let text = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maximum) return { text, truncated: true };
		text += character;
		bytes += characterBytes;
	}
	return { text, truncated: false };
}
