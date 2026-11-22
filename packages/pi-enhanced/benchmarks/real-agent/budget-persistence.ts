import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BudgetGatewayLimits, BudgetGatewayStatus } from "./budget-gateway.ts";

export interface DurableBudgetOptions {
	databasePath: string;
	id: string;
	mode: "create" | "resume";
	deadlineAt?: number;
	scope?: "session";
}

export interface PendingBudgetRequest {
	requestSequence: number;
	tokens: number;
	costUsd: number;
	phase: "reserved" | "dispatched";
	updatedAt: number;
}

/** Admission failed before any request or new reservation existed. */
export class ExpiredBudgetResume extends Error {
	readonly status: BudgetGatewayStatus;
	readonly deadlineAt: number;
	constructor(status: BudgetGatewayStatus, deadlineAt: number) {
		super("GATEWAY_RUN_TIMEOUT");
		this.status = status;
		this.deadlineAt = deadlineAt;
	}
}

interface RecordBody {
	resumeDeniedAt?: number;
	version: 1;
	policy: string;
	deadlineAt: number;
	updatedAt: number;
	ownerPid: number | null;
	owner: string | null;
	pending: PendingBudgetRequest[];
	status: BudgetGatewayStatus;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function storedBudget(options: Pick<DurableBudgetOptions, "databasePath" | "id">): BudgetGatewayStatus | undefined {
	const db = new DatabaseSync(options.databasePath, { readOnly: true, timeout: 1500 });
	try {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_budget_runs'").get()) return;
		return readRecord(db, options.id)?.status;
	} finally {
		db.close();
	}
}

function readRecord(db: DatabaseSync, id: string): RecordBody | undefined {
	const row = db.prepare("SELECT body, checksum FROM gateway_budget_runs WHERE id=?").get(id) as
		{ body: string; checksum: string } | undefined;
	if (!row) return;
	if (hash(row.body) !== row.checksum) throw new Error("GATEWAY_BUDGET_CORRUPT");
	let record: RecordBody;
	try { record = JSON.parse(row.body); } catch { throw new Error("GATEWAY_BUDGET_CORRUPT"); }
	if (record?.version !== 1) throw new Error("GATEWAY_BUDGET_VERSION");
	validateRecord(record);
	return record;
}

export class DurableBudget {
	private readonly db: DatabaseSync;
	private readonly owner = randomUUID();
	private readonly id: string;
	private record: RecordBody;
	private closed = false;

	constructor(options: DurableBudgetOptions, policy: string, initial: BudgetGatewayStatus) {
		this.id = options.id;
		const file = lstatSync(options.databasePath);
		if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !options.id || options.id.length > 250)
			throw new Error("GATEWAY_BUDGET_STORAGE_INVALID");
		this.db = new DatabaseSync(options.databasePath, { timeout: 1500 });
		try {
			this.db.exec("PRAGMA synchronous=FULL");
			this.record = this.transaction(() => {
				this.db.exec("CREATE TABLE IF NOT EXISTS gateway_budget_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL)");
				if (options.scope !== "session" && !this.db.prepare("SELECT 1 FROM tasks WHERE task_id=?").get(this.id))
					throw new Error("GATEWAY_BUDGET_TASK_NOT_FOUND");
				const previous = this.read();
				const now = Date.now();
				if (options.mode === "create") {
					if (previous) throw new Error("GATEWAY_BUDGET_ALREADY_EXISTS");
					if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt! <= now)
						throw new Error("GATEWAY_RUN_TIMEOUT");
					const record: RecordBody = { version: 1, policy, deadlineAt: options.deadlineAt!, updatedAt: now,
						ownerPid: process.pid, owner: this.owner, pending: [], status: initial };
					const body = JSON.stringify(record);
					this.db.prepare("INSERT INTO gateway_budget_runs VALUES (?, ?, ?)").run(this.id, body, hash(body));
					return record;
				}
				if (!previous) throw new Error("GATEWAY_BUDGET_NOT_FOUND");
				if (previous.policy !== policy || (options.deadlineAt !== undefined && options.deadlineAt !== previous.deadlineAt))
					throw new Error("GATEWAY_BUDGET_POLICY_MISMATCH");
				if (previous.ownerPid !== null && alive(previous.ownerPid)) throw new Error("GATEWAY_BUDGET_IN_USE");
				if (now < previous.updatedAt) throw new Error("GATEWAY_BUDGET_CLOCK_REGRESSION");
				if (previous.resumeDeniedAt !== undefined) return previous;
				const status = previous.status;
				if (previous.pending.some(({ phase }) => phase === "dispatched")) throw new Error("GATEWAY_BUDGET_UNCERTAIN_USAGE");
				if (status.state === "failed_closed") throw new Error(status.lastError ?? "GATEWAY_FAILED_CLOSED");
				for (const reservation of previous.pending) {
					// Only a reservation that never crossed the durable dispatch boundary is refundable.
					status.requestsStarted -= 1;
					status.activeRequests -= 1;
					status.reservedTokens -= reservation.tokens;
					status.reservedCostUsd -= reservation.costUsd;
				}
				status.reservedCostUsd = 0;
				previous.pending = [];
				if (now >= previous.deadlineAt) {
					previous.resumeDeniedAt = now;
					previous.updatedAt = now;
					status.lastError = "GATEWAY_RUN_TIMEOUT";
					status.state = "failed_closed";
					previous.owner = null;
					previous.ownerPid = null;
					this.write(previous);
					return previous;
				}
				previous.ownerPid = process.pid;
				previous.owner = this.owner;
				previous.updatedAt = now;
				this.write(previous);
				return previous;
			});
			if (this.record.resumeDeniedAt !== undefined) throw new ExpiredBudgetResume(this.record.status, this.record.deadlineAt);
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	get deadlineAt(): number { return this.record.deadlineAt; }
	get updatedAt(): number { return this.record.updatedAt; }
	snapshot(): BudgetGatewayStatus { return structuredClone(this.record.status); }

	changePolicy(status: BudgetGatewayStatus, policy: string): void {
		const record = { ...this.record, policy, status: structuredClone(status), updatedAt: Date.now() };
		if (record.updatedAt < this.record.updatedAt) throw new Error("GATEWAY_BUDGET_CLOCK_REGRESSION");
		if (record.updatedAt >= this.record.deadlineAt) throw new Error("GATEWAY_RUN_TIMEOUT");
		if (record.pending.length) throw new Error("GATEWAY_BUDGET_TIER_CHANGE_DENIED");
		this.transaction(() => this.writeOwned(record));
		this.record = record;
	}

	save(status: BudgetGatewayStatus, change?: PendingBudgetRequest | { settled: number }): void {
		const record = structuredClone(this.record);
		if (change && "settled" in change) {
			if (!record.pending.some(({ requestSequence }) => requestSequence === change.settled)) return;
			record.pending = record.pending.filter(({ requestSequence }) => requestSequence !== change.settled);
		} else if (change) {
			const previous = record.pending.find(({ requestSequence }) => requestSequence === change.requestSequence);
			if (change.phase === "reserved" ? previous !== undefined :
				!previous || previous.phase !== "reserved" || previous.tokens !== change.tokens || previous.costUsd !== change.costUsd)
				throw new Error("GATEWAY_BUDGET_PHASE_INVALID");
			record.pending = record.pending.filter(({ requestSequence }) => requestSequence !== change.requestSequence);
			record.pending.push(change);
		}
		record.status = structuredClone(status);
		record.updatedAt = Math.max(Date.now(), record.updatedAt);
		this.transaction(() => this.writeOwned(record));
		this.record = record;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.transaction(() => this.writeOwned({ ...this.record, ownerPid: null, owner: null }));
		} finally {
			this.db.close();
		}
	}

	private read(): RecordBody | undefined {
		return readRecord(this.db, this.id);
	}

	private writeOwned(record: RecordBody): void {
		if (this.read()?.owner !== this.owner) throw new Error("GATEWAY_BUDGET_OWNERSHIP_LOST");
		this.write(record);
	}

	private write(record: RecordBody): void {
		validateRecord(record);
		const body = JSON.stringify(record);
		this.db.prepare("UPDATE gateway_budget_runs SET body=?, checksum=? WHERE id=?").run(body, hash(body), this.id);
	}

	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function validateRecord(record: RecordBody): void {
	const status = record.status;
	const validCount = (n: number) => Number.isSafeInteger(n) && n >= 0;
	const validCost = (n: number) => Number.isFinite(n) && n >= 0;
	const limits = status?.limits as BudgetGatewayLimits | undefined;
	if (!status || !limits || (record.resumeDeniedAt !== undefined && (!validCount(record.resumeDeniedAt) ||
		record.resumeDeniedAt < record.deadlineAt || record.resumeDeniedAt !== record.updatedAt ||
		status.lastError !== "GATEWAY_RUN_TIMEOUT" || status.state !== "failed_closed" || record.owner !== null)) || !validCount(record.deadlineAt) || !validCount(record.updatedAt) ||
		(record.ownerPid !== null && (!validCount(record.ownerPid) || record.ownerPid === 0)) ||
		(record.ownerPid === null ? record.owner !== null : typeof record.owner !== "string") ||
		!Array.isArray(record.pending) || !Array.isArray(status.denials) || !Array.isArray(status.requestOutcomes) ||
		!["ready", "failed_closed"].includes(status.state) ||
		![status.requestsStarted, status.requestsCompleted, status.requestAttempts, status.requestsRejected,
			status.actualInputTokens, status.actualOutputTokens, status.actualTotalTokens, status.committedTokenUpperBound,
			status.reservedTokens, status.activeRequests].every(validCount) ||
		![status.actualCostUsd, status.committedCostUpperBoundUsd, status.reservedCostUsd].every(validCost) ||
		status.activeRequests !== record.pending.length || status.requestsStarted > limits.maxRequests ||
		status.requestsCompleted + status.activeRequests > status.requestsStarted ||
		status.actualInputTokens + status.actualOutputTokens !== status.actualTotalTokens ||
		status.actualTotalTokens > status.committedTokenUpperBound ||
		status.actualCostUsd > status.committedCostUpperBoundUsd + 1e-12 ||
		(status.state === "ready" && (status.committedTokenUpperBound + status.reservedTokens > limits.maxTotalTokens ||
			status.committedCostUpperBoundUsd + status.reservedCostUsd > limits.maxTotalCostUsd + 1e-12)) ||
		new Set(record.pending.map((item) => item?.requestSequence)).size !== record.pending.length ||
		record.pending.some((item) => !item || !validCount(item.requestSequence) || item.requestSequence === 0 ||
			item.requestSequence > status.requestAttempts || !validCount(item.updatedAt) || !validCount(item.tokens) ||
			!validCost(item.costUsd) || !["reserved", "dispatched"].includes(item.phase)) ||
		record.pending.reduce((n, item) => n + item.tokens, 0) !== status.reservedTokens ||
		Math.abs(record.pending.reduce((n, item) => n + item.costUsd, 0) - status.reservedCostUsd) > 1e-12)
		throw new Error("GATEWAY_BUDGET_CORRUPT");
}
