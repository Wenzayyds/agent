import type { AuditOutcome } from "./errors.ts";
import type { McpToolIdentity } from "./identity.ts";
import type { PolicyAction } from "./policy.ts";

export interface AuditRecord extends McpToolIdentity {
	timestamp: string;
	sessionIdOrScope: string;
	toolCallId: string;
	parentToolCallId?: string;
	decision: PolicyAction;
	ruleId: string;
	durationMs?: number;
	outcome: AuditOutcome;
}

interface PendingAudit extends McpToolIdentity {
	timestamp: string;
	startedAt: number;
	sessionIdOrScope: string;
	toolCallId: string;
	parentToolCallId?: string;
	decision: PolicyAction;
	ruleId: string;
}

export class AuditTrail {
	readonly maxRecent: number;
	private readonly recent: AuditRecord[] = [];
	private readonly pending = new Map<string, PendingAudit>();

	constructor(maxRecent: number) {
		this.maxRecent = maxRecent;
	}

	start(value: Omit<PendingAudit, "timestamp" | "startedAt">): void {
		if (this.pending.size >= this.maxRecent) {
			const oldest = this.pending.keys().next().value;
			if (typeof oldest === "string") this.finish(oldest, "unknown");
		}
		this.pending.set(value.toolCallId, {
			...value,
			timestamp: new Date().toISOString(),
			startedAt: Date.now(),
		});
	}

	recordComplete(value: Omit<PendingAudit, "timestamp" | "startedAt">, outcome: AuditOutcome): void {
		this.start(value);
		this.finish(value.toolCallId, outcome);
	}

	finish(toolCallId: string, outcome: AuditOutcome): void {
		const pending = this.pending.get(toolCallId);
		if (!pending) return;
		this.pending.delete(toolCallId);
		const { startedAt, ...record } = pending;
		this.push({ ...record, durationMs: Math.max(0, Date.now() - startedAt), outcome });
	}

	snapshot(): readonly AuditRecord[] {
		return this.recent.map((record) => ({ ...record }));
	}

	pendingCount(): number {
		return this.pending.size;
	}

	clear(): void {
		this.pending.clear();
		this.recent.length = 0;
	}

	private push(record: AuditRecord): void {
		this.recent.push(record);
		if (this.recent.length > this.maxRecent) this.recent.splice(0, this.recent.length - this.maxRecent);
	}
}
