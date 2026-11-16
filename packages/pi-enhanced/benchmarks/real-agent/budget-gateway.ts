import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DurableBudget, type DurableBudgetOptions, type PendingBudgetRequest } from "./budget-persistence.ts";
import type { EvaluationTelemetry, ReservationDiagnostics, ReservationSettlement } from "./evaluation-telemetry.ts";

export interface BudgetGatewayLimits {
	maxRequests: number;
	maxTotalTokens: number;
	maxTotalCostUsd: number;
	maxConcurrency: number;
	requestTimeoutMs: number;
	maxOutputTokensPerRequest: number;
	minOutputTokensPerRequest?: number;
	maxRequestBytes: number;
}

export interface BudgetGatewayPricing {
	inputUsdPerMillion: number;
	outputUsdPerMillion: number;
}

export interface BudgetGatewayOptions {
	runId: string;
	upstreamBaseUrl: string;
	upstreamApiKey: string;
	clientToken: string;
	adminToken: string;
	allowedModel: string;
	limits: BudgetGatewayLimits;
	pricing: BudgetGatewayPricing;
	fetch?: typeof globalThis.fetch;
	telemetry?: EvaluationTelemetry;
	persistence?: DurableBudgetOptions;
}

export interface GatewayDenialRecord {
	reservationDiagnostics: ReservationDiagnostics | null;
	runId: string;
	requestSequence: number;
	code: string;
	upstreamForwarded: false;
	requestsStarted: number;
	actualTotalTokens: number;
	committedTokenUpperBound: number;
	reservedTokens: number;
	actualCostUsd: number;
	committedCostUpperBoundUsd: number;
	reservedCostUsd: number;
}

interface ProviderUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

interface Reservation {
	requestSequence: number;
	diagnostics: ReservationDiagnostics;
	inputTokenUpperBound: number;
	outputTokenLimit: number;
	reservedTokens: number;
	reservedCostUsd: number;
}

export interface BudgetGatewayStatus {
	state: "ready" | "failed_closed" | "closed";
	requestsStarted: number;
	requestsCompleted: number;
	requestsRejected: number;
	requestAttempts: number;
	activeRequests: number;
	actualInputTokens: number;
	actualOutputTokens: number;
	actualTotalTokens: number;
	actualCostUsd: number;
	committedTokenUpperBound: number;
	committedCostUpperBoundUsd: number;
	reservedTokens: number;
	reservedCostUsd: number;
	lastError: string | null;
	denials: GatewayDenialRecord[];
	requestOutcomes: Array<{
		requestSequence: number;
		outcome: string;
		receivedBytes: number;
		usageSeen: boolean;
		doneSeen: boolean;
		elapsedMs: number;
		reservationDiagnostics: ReservationDiagnostics;
		settlement: ReservationSettlement;
		inputTokens: number | null;
		outputTokens: number | null;
		actualCostUsd: number | null;
	}>;
	limits: BudgetGatewayLimits;
}

class BudgetLedger {
	private state: BudgetGatewayStatus;
	private accepting = true;
	private readonly limits: BudgetGatewayLimits;
	private readonly pricing: BudgetGatewayPricing;
	private readonly runId: string;
	private readonly telemetry?: EvaluationTelemetry;
	private readonly durable?: DurableBudget;
	private readonly settlements = new WeakMap<Reservation, ReservationSettlement>();
	private readonly monotonicDeadline?: number;

	constructor(
		runId: string,
		limits: BudgetGatewayLimits,
		pricing: BudgetGatewayPricing,
		telemetry?: EvaluationTelemetry,
		persistence?: DurableBudgetOptions,
		policy?: string,
	) {
		this.telemetry = telemetry;
		this.runId = runId;
		this.limits = limits;
		this.pricing = pricing;
		this.state = {
			state: "ready",
			requestsStarted: 0,
			requestsCompleted: 0,
			requestsRejected: 0,
			requestAttempts: 0,
			activeRequests: 0,
			actualInputTokens: 0,
			actualOutputTokens: 0,
			actualTotalTokens: 0,
			actualCostUsd: 0,
			committedTokenUpperBound: 0,
			committedCostUpperBoundUsd: 0,
			reservedTokens: 0,
			reservedCostUsd: 0,
			lastError: null,
			denials: [],
			requestOutcomes: [],
			limits: { ...limits },
		};
		if (persistence) {
			this.durable = new DurableBudget(persistence, policy!, this.state);
			this.state = this.durable.snapshot();
			this.monotonicDeadline = performance.now() + this.durable.deadlineAt - Date.now();
		}
	}

	remainingTime(): number {
		if (!this.durable || this.monotonicDeadline === undefined) return Infinity;
		if (Date.now() < this.durable.updatedAt) return 0;
		return Math.max(0, Math.min(this.durable.deadlineAt - Date.now(), this.monotonicDeadline - performance.now()));
	}

	get deadlineAt(): number | undefined { return this.durable?.deadlineAt; }

	dispatch(reservation: Reservation): void {
		if (this.remainingTime() <= 0) throw new GatewayRejection("GATEWAY_RUN_TIMEOUT");
		this.persistReservation(reservation, "dispatched");
	}

	private persistReservation(reservation: Reservation, phase: PendingBudgetRequest["phase"]): void {
		this.durable?.save(this.state, {
			requestSequence: reservation.requestSequence,
			tokens: reservation.reservedTokens,
			costUsd: reservation.reservedCostUsd,
			phase,
			updatedAt: Date.now(),
		});
	}

	abortPersistence(): void {
		this.failClosed("GATEWAY_BUDGET_STORAGE_FAILURE");
	}

	nextRequestSequence(): number {
		this.state.requestAttempts += 1;
		return this.state.requestAttempts;
	}

	recordOutcome(value: BudgetGatewayStatus["requestOutcomes"][number]): void {
		this.state.requestOutcomes.push(value);
		if (this.state.requestOutcomes.length > 64) this.state.requestOutcomes.shift();
		this.durable?.save(this.state);
	}

	reserve(bodyBytes: number, outboundBytes: number, requestedOutputTokens: number, defaultOutputTokenLimit: number, requestSequence: number): Reservation {
		if (!this.accepting) return this.reject("GATEWAY_CLOSING", requestSequence);
		if (this.remainingTime() <= 0) {
			this.stop("GATEWAY_RUN_TIMEOUT");
			return this.reject("GATEWAY_RUN_TIMEOUT", requestSequence);
		}
		if (this.state.state !== "ready") return this.reject("GATEWAY_FAILED_CLOSED", requestSequence);
		if (this.state.activeRequests >= this.limits.maxConcurrency)
			return this.reject("GATEWAY_CONCURRENCY_LIMIT", requestSequence);
		if (this.state.requestsStarted >= this.limits.maxRequests)
			return this.reject("GATEWAY_REQUEST_LIMIT", requestSequence);

		const minimumOutputTokens = this.limits.minOutputTokensPerRequest ?? defaultOutputTokenLimit;
		const inputEstimateBytes = Math.max(bodyBytes, outboundBytes);
		// At least one byte per token, plus a fixed allowance for provider-side framing.
		const inputSafetyMarginTokens = 4096;
		const inputTokenUpperBound = inputEstimateBytes + inputSafetyMarginTokens;
		const remainingTokenHeadroom = this.limits.maxTotalTokens - this.state.committedTokenUpperBound - this.state.reservedTokens;
		const remainingCostHeadroomUsd = this.limits.maxTotalCostUsd - this.state.committedCostUpperBoundUsd - this.state.reservedCostUsd;
		const outputRoomByTokens = Math.floor(remainingTokenHeadroom - inputTokenUpperBound);
		const inputCostUsd = this.cost(inputTokenUpperBound, 0);
		const outputRoomByCost = this.pricing.outputUsdPerMillion === 0
			? Infinity
			: Math.floor((remainingCostHeadroomUsd - inputCostUsd) * 1_000_000 / this.pricing.outputUsdPerMillion);
		const affordableOutputTokens = Math.min(defaultOutputTokenLimit, outputRoomByTokens, outputRoomByCost);
		const outputTokenLimit = Math.min(defaultOutputTokenLimit, Math.max(minimumOutputTokens, affordableOutputTokens));
		const reservedTokens = inputTokenUpperBound + outputTokenLimit;
		const reservedCostUsd = this.cost(inputTokenUpperBound, outputTokenLimit);
		const diagnostics: ReservationDiagnostics = {
			formulaVersion: "utf8_max_in_out_plus4096_v2",
			requestBodyBytes: bodyBytes,
			inputEstimateBytes,
			inputSafetyMarginTokens,
			requestedOutputTokens,
			defaultOutputTokenLimit,
			minimumOutputTokens,
			outputTokenLimit,
			outputLimitReduced: outputTokenLimit < defaultOutputTokenLimit,
			inputTokenUpperBound,
			candidateReservedTokens: reservedTokens,
			candidateReservedCostUsd: reservedCostUsd,
			maxTotalTokens: this.limits.maxTotalTokens,
			remainingTokenHeadroom,
			maxTotalCostUsd: this.limits.maxTotalCostUsd,
			remainingCostHeadroomUsd,
		};
		if (defaultOutputTokenLimit < minimumOutputTokens)
			return this.reject("GATEWAY_OUTPUT_LIMIT_TOO_LOW", requestSequence, diagnostics);
		if (reservedTokens > remainingTokenHeadroom)
			return this.reject("GATEWAY_TOKEN_BUDGET", requestSequence, diagnostics);
		if (reservedCostUsd > remainingCostHeadroomUsd)
			return this.reject("GATEWAY_COST_BUDGET", requestSequence, diagnostics);
		this.state.requestsStarted += 1;
		this.state.activeRequests += 1;
		this.state.reservedTokens += reservedTokens;
		this.state.reservedCostUsd += reservedCostUsd;
		const reservation = { requestSequence, diagnostics, inputTokenUpperBound, outputTokenLimit, reservedTokens, reservedCostUsd };
		this.persistReservation(reservation, "reserved");
		return reservation;
	}

	complete(reservation: Reservation, usage: ProviderUsage | null): ReservationSettlement {
		const previous = this.settlements.get(reservation);
		if (previous) return previous;
		this.state.requestsCompleted += 1;
		if (!usage) return this.fail(reservation, "GATEWAY_USAGE_MISSING");

		const actualCostUsd = this.cost(usage.promptTokens, usage.completionTokens);
		this.state.actualInputTokens += usage.promptTokens;
		this.state.actualOutputTokens += usage.completionTokens;
		this.state.actualTotalTokens += usage.totalTokens;
		this.state.actualCostUsd += actualCostUsd;
		if (
			usage.promptTokens > reservation.inputTokenUpperBound ||
			usage.completionTokens > reservation.outputTokenLimit ||
			usage.totalTokens > reservation.reservedTokens
		) {
			this.failClosed("GATEWAY_PROVIDER_USAGE_EXCEEDED_RESERVATION");
			return this.settle(reservation, Math.max(usage.totalTokens, reservation.reservedTokens),
				Math.max(actualCostUsd, reservation.reservedCostUsd));
		}
		return this.settle(reservation, usage.totalTokens, actualCostUsd);
	}

	fail(reservation: Reservation, reason: string): ReservationSettlement {
		const previous = this.settlements.get(reservation);
		if (previous) return previous;
		this.failClosed(reason);
		return this.settle(reservation, reservation.reservedTokens, reservation.reservedCostUsd);
	}

	private cost(input: number, output: number): number {
		return (input * this.pricing.inputUsdPerMillion + output * this.pricing.outputUsdPerMillion) / 1_000_000;
	}

	private settle(reservation: Reservation, committedTokens: number, committedCostUsd: number): ReservationSettlement {
		this.state.activeRequests -= 1;
		this.state.reservedTokens = Math.max(0, this.state.reservedTokens - reservation.reservedTokens);
		this.state.reservedCostUsd = Math.max(0, this.state.reservedCostUsd - reservation.reservedCostUsd);
		this.state.committedTokenUpperBound += committedTokens;
		this.state.committedCostUpperBoundUsd += committedCostUsd;
		this.durable?.save(this.state, { settled: reservation.requestSequence });
		const settlement = {
			committedTokens,
			committedCostUsd,
			releasedTokens: Math.max(0, reservation.reservedTokens - committedTokens),
			releasedCostUsd: Math.max(0, reservation.reservedCostUsd - committedCostUsd),
		};
		this.settlements.set(reservation, settlement);
		return settlement;
	}

	deny(reason: string, requestSequence: number, diagnostics: ReservationDiagnostics | null = null): void {
		this.telemetry?.provider({
			runId: this.runId,
			requestSequence,
			startedAt: Date.now(),
			endedAt: Date.now(),
			upstreamForwarded: false,
			outcome: reason,
			usageSeen: false,
			doneSeen: false,
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
			conservativeCostUsd: null,
			reservedTokenUpperBound: null,
			reservedCostUpperBoundUsd: null,
			responseIds: [],
			pricing: { ...this.pricing },
			reservationDiagnostics: diagnostics,
			budgetSnapshot: {
				requestsStarted: this.state.requestsStarted,
				actualTotalTokens: this.state.actualTotalTokens,
				committedTokenUpperBound: this.state.committedTokenUpperBound,
				committedCostUpperBoundUsd: this.state.committedCostUpperBoundUsd,
			},
		});
		this.state.requestsRejected += 1;
		this.state.denials.push({
			reservationDiagnostics: diagnostics,
			runId: this.runId,
			requestSequence,
			code: reason,
			upstreamForwarded: false,
			requestsStarted: this.state.requestsStarted,
			actualTotalTokens: this.state.actualTotalTokens,
			committedTokenUpperBound: this.state.committedTokenUpperBound,
			reservedTokens: this.state.reservedTokens,
			actualCostUsd: this.state.actualCostUsd,
			committedCostUpperBoundUsd: this.state.committedCostUpperBoundUsd,
			reservedCostUsd: this.state.reservedCostUsd,
		});
		if (this.state.denials.length > 64) this.state.denials.splice(0, this.state.denials.length - 64);
	}

	reject(reason: string, requestSequence: number, diagnostics: ReservationDiagnostics | null = null): never {
		this.deny(reason, requestSequence, diagnostics);
		if (this.durable && isHardBudgetStop(reason)) {
			this.failClosed(reason);
			this.durable.save(this.state);
		}
		throw new GatewayRejection(reason);
	}

	suspendAdmission(): void { this.accepting = false; }

	close(): void {
		this.durable?.close();
		this.state.state = "closed";
	}

	stop(reason: string): void {
		this.failClosed(reason);
		this.durable?.save(this.state);
	}

	snapshot(): BudgetGatewayStatus {
		return JSON.parse(JSON.stringify(this.state)) as BudgetGatewayStatus;
	}

	private failClosed(reason: string): void {
		this.state.state = "failed_closed";
		this.state.lastError = reason;
	}
}

export function isHardBudgetStop(reason: string): boolean {
	return ["GATEWAY_REQUEST_LIMIT", "GATEWAY_TOKEN_BUDGET", "GATEWAY_COST_BUDGET", "GATEWAY_RUN_TIMEOUT"].includes(reason);
}

class GatewayRejection extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export interface RunningBudgetGateway {
	url: string;
	deadlineAt?: number;
	status(): BudgetGatewayStatus;
	finalStatus?(): BudgetGatewayStatus | undefined;
	stop(reason: "GATEWAY_RUN_TIMEOUT"): void;
	close(): Promise<void>;
}

export async function startBudgetGateway(options: BudgetGatewayOptions): Promise<RunningBudgetGateway> {
	validateOptions(options);
	const policy = JSON.stringify(["utf8_max_in_out_plus4096_v2", options.runId, options.allowedModel, options.upstreamBaseUrl,
		Object.entries(options.limits).sort(), Object.entries(options.pricing).sort()]);
	const ledger = new BudgetLedger(options.runId, options.limits, options.pricing, options.telemetry, options.persistence, policy);
	const active = new Set<AbortController>();
	const inFlight = new Set<Promise<void>>();
	let finalStatus: BudgetGatewayStatus | undefined;
	let closing: Promise<void> | undefined;
	const server = createServer((request, response) => {
		if (closing) return sendJson(response, 503, { error: "GATEWAY_CLOSING" });
		const work = handleRequest(request, response, options, ledger, active).catch(() => {
			ledger.abortPersistence();
			for (const controller of active) controller.abort(new Error("GATEWAY_BUDGET_STORAGE_FAILURE"));
			if (!response.headersSent) sendJson(response, 503, { error: "GATEWAY_BUDGET_STORAGE_FAILURE" });
			else response.destroy();
		}).finally(() => { inFlight.delete(work); });
		inFlight.add(work);
	});
	server.requestTimeout = options.limits.requestTimeoutMs + 5_000;
	server.headersTimeout = Math.min(server.requestTimeout, 30_000);
	server.maxRequestsPerSocket = options.limits.maxRequests + 4;
	try { await listen(server); } catch (error) { ledger.close(); throw error; }
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("GATEWAY_LISTEN_FAILED");
	return {
		url: `http://127.0.0.1:${address.port}`,
		deadlineAt: ledger.deadlineAt,
		status: () => ledger.snapshot(),
		finalStatus: () => finalStatus && structuredClone(finalStatus),
		stop: (reason) => {
			ledger.stop(reason);
			for (const controller of active) controller.abort(new Error(reason));
		},
		close: () => closing ??= (async () => {
			ledger.suspendAdmission();
			for (const controller of active) controller.abort(new Error("GATEWAY_RUN_EXIT"));
			try {
				await closeServer(server);
				await Promise.allSettled(inFlight);
			} finally {
				finalStatus = ledger.snapshot();
				ledger.close();
			}
		})(),
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	options: BudgetGatewayOptions,
	ledger: BudgetLedger,
	active: Set<AbortController>,
): Promise<void> {
	if (request.method === "POST" && request.url === "/__budget/stop-isolation") {
		if (!hasBearer(request, options.clientToken)) return sendJson(response, 401, { error: "GATEWAY_CLIENT_AUTH" });
		ledger.stop("GATEWAY_ISOLATION_STOP");
		return sendJson(response, 200, { state: "failed_closed" });
	}
	if (request.method === "GET" && request.url === "/__budget/health") {
		if (!hasBearer(request, options.adminToken)) return sendJson(response, 401, { error: "GATEWAY_ADMIN_AUTH" });
		return sendJson(response, 200, { status: ledger.snapshot().state });
	}
	if (request.method === "GET" && request.url === "/__budget/status") {
		if (!hasBearer(request, options.adminToken)) return sendJson(response, 401, { error: "GATEWAY_ADMIN_AUTH" });
		return sendJson(response, 200, ledger.snapshot());
	}
	const requestSequence = ledger.nextRequestSequence();
	if (request.method !== "POST" || !isChatPath(request.url)) {
		ledger.deny("GATEWAY_ROUTE_DENIED", requestSequence);
		return sendJson(response, 404, { error: "GATEWAY_ROUTE_DENIED" });
	}
	if (!hasBearer(request, options.clientToken)) {
		ledger.deny("GATEWAY_CLIENT_AUTH", requestSequence);
		return sendJson(response, 401, { error: "GATEWAY_CLIENT_AUTH" });
	}

	let bodyBytes: Buffer;
	try {
		bodyBytes = await readBoundedBody(request, options.limits.maxRequestBytes);
	} catch (error) {
		const code = error instanceof Error ? error.message : "GATEWAY_REQUEST_TOO_LARGE";
		ledger.deny(code, requestSequence);
		return sendJson(response, 413, { error: code });
	}
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
	} catch {
		ledger.deny("GATEWAY_INVALID_JSON", requestSequence);
		return sendJson(response, 400, { error: "GATEWAY_INVALID_JSON" });
	}
	if (body.model !== options.allowedModel) {
		ledger.deny("GATEWAY_MODEL_DENIED", requestSequence);
		return sendJson(response, 400, { error: "GATEWAY_MODEL_DENIED" });
	}
	if (body.stream !== true) {
		ledger.deny("GATEWAY_STREAM_REQUIRED", requestSequence);
		return sendJson(response, 400, { error: "GATEWAY_STREAM_REQUIRED" });
	}
	if ((body.n !== undefined && body.n !== 1) || (body.best_of !== undefined && body.best_of !== 1)) {
		ledger.deny("GATEWAY_MULTIPLE_OUTPUTS_DENIED", requestSequence);
		return sendJson(response, 400, { error: "GATEWAY_MULTIPLE_OUTPUTS_DENIED" });
	}
	const requestedOutput = Math.min(
		positiveInteger(body.max_tokens) ?? Infinity,
		positiveInteger(body.max_completion_tokens) ?? Infinity,
		positiveInteger(body.max_output_tokens) ?? Infinity,
		options.limits.maxOutputTokensPerRequest,
	);
	const requestedOutputTokens =
		positiveInteger(body.max_tokens) ?? positiveInteger(body.max_completion_tokens) ??
		positiveInteger(body.max_output_tokens) ?? options.limits.maxOutputTokensPerRequest;
	delete body.max_completion_tokens;
	delete body.max_output_tokens;
	delete body.best_of;
	body.max_tokens = requestedOutput;
	body.stream_options = { include_usage: true };
	body.user_id = "pi_enhanced_controlled_pilot";
	let reservation: Reservation;
	try {
		reservation = ledger.reserve(
			bodyBytes.byteLength, Buffer.byteLength(JSON.stringify(body)), requestedOutputTokens, requestedOutput, requestSequence,
		);
	} catch (error) {
		if (!(error instanceof GatewayRejection)) throw error;
		const code = error.code;
		return sendJson(response, 429, { error: code });
	}
	body.max_tokens = reservation.outputTokenLimit;

	const controller = new AbortController();
	active.add(controller);
	let settled = false;
	let usage: ProviderUsage | null = null;
	let doneSeen = false;
	let receivedBytes = 0;
	const startedAt = Date.now();
	let usageAccounted = false;
	let invalidUsage = false;
	let settlement: ReservationSettlement | undefined;
	const responseIds = new Set<string>();
	const started = performance.now();
	const recordOutcome = (outcome: string) => {
		if (!settlement) throw new Error("GATEWAY_SETTLEMENT_MISSING");
		const inputTokens = usageAccounted ? usage!.promptTokens : null;
		const outputTokens = usageAccounted ? usage!.completionTokens : null;
		const actualCostUsd = inputTokens !== null && outputTokens !== null
			? (inputTokens * options.pricing.inputUsdPerMillion + outputTokens * options.pricing.outputUsdPerMillion) / 1_000_000
			: null;
		ledger.recordOutcome({
			requestSequence,
			outcome,
			receivedBytes,
			usageSeen: usage !== null,
			doneSeen,
			elapsedMs: Number((performance.now() - started).toFixed(3)),
			reservationDiagnostics: reservation.diagnostics,
			settlement,
			inputTokens,
			outputTokens,
			actualCostUsd,
		});
		options.telemetry?.provider({
			runId: options.runId,
			requestSequence,
			startedAt,
			endedAt: Date.now(),
			upstreamForwarded: true,
			outcome,
			usageSeen: usage !== null,
			doneSeen,
			inputTokens,
			outputTokens,
			totalTokens: usageAccounted ? usage!.totalTokens : null,
			conservativeCostUsd: actualCostUsd,
			reservationDiagnostics: reservation.diagnostics,
			settlement,
			reservedTokenUpperBound: reservation.reservedTokens,
			reservedCostUpperBoundUsd: reservation.reservedCostUsd,
			responseIds: [...responseIds],
			pricing: { ...options.pricing },
		});
	};
	const timeout = setTimeout(
		() => controller.abort(new Error(ledger.remainingTime() <= 0 ? "GATEWAY_RUN_TIMEOUT" : "GATEWAY_UPSTREAM_TIMEOUT")),
		Math.min(options.limits.requestTimeoutMs, ledger.remainingTime()),
	);
	response.on("close", () => {
		if (!settled && !response.writableEnded) controller.abort(new Error("GATEWAY_CLIENT_DISCONNECTED"));
	});
	try {
		ledger.dispatch(reservation);
		const upstream = await (options.fetch ?? globalThis.fetch)(
			`${options.upstreamBaseUrl.replace(/\/$/u, "")}/chat/completions`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.upstreamApiKey}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			},
		);
		response.statusCode = upstream.status;
		response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		if (!upstream.body) {
			settled = true;
			settlement = ledger.fail(reservation, "GATEWAY_UPSTREAM_BODY_MISSING");
			recordOutcome("GATEWAY_UPSTREAM_BODY_MISSING");
			response.end();
			return;
		}
		let pending = "";
		const decoder = new TextDecoder();
		for await (const chunk of upstream.body) {
			const bytes = Buffer.from(chunk);
			receivedBytes += bytes.length;
			pending += decoder.decode(bytes, { stream: true });
			const parsed = consumeSseLines(pending, options.telemetry ? responseIds : undefined);
			pending = parsed.remainder;
			if (parsed.hasUsage) usage = parsed.usage;
			invalidUsage ||= parsed.invalidUsage;
			doneSeen ||= parsed.done;
			// Settle before exposing DONE: Pi may close the downstream immediately.
			if (doneSeen) {
				settled = true;
				if (upstream.ok) settlement = ledger.complete(reservation, invalidUsage ? null : usage);
				else settlement = ledger.fail(reservation, `GATEWAY_UPSTREAM_HTTP_${upstream.status}`);
				usageAccounted = upstream.ok && !invalidUsage && usage !== null;
				recordOutcome(ledger.snapshot().lastError ?? "completed_done");
			}
			response.write(bytes);
			if (doneSeen) break;
		}
		pending += decoder.decode();
		const final = consumeSseLines(`${pending}\n`, options.telemetry ? responseIds : undefined);
		if (final.hasUsage) usage = final.usage;
		invalidUsage ||= final.invalidUsage;
		if (!settled) {
			settled = true;
			if (upstream.ok) settlement = ledger.complete(reservation, invalidUsage ? null : usage);
			else settlement = ledger.fail(reservation, `GATEWAY_UPSTREAM_HTTP_${upstream.status}`);
			usageAccounted = upstream.ok && !invalidUsage && usage !== null;
			recordOutcome(ledger.snapshot().lastError ?? "completed_eof");
		}
		response.end();
	} catch (error) {
		if (settled && !settlement) throw error;
		if (!settled) {
			const reason = controller.signal.reason;
			const code = controller.signal.aborted && reason instanceof Error ? reason.message : "GATEWAY_UPSTREAM_ERROR";
			settlement = ledger.fail(reservation, code);
			settled = true;
			recordOutcome(code);
		}
		if (!response.headersSent) sendJson(response, 502, { error: "GATEWAY_UPSTREAM_FAILED" });
		else response.destroy(error instanceof Error ? error : undefined);
	} finally {
		clearTimeout(timeout);
		active.delete(controller);
	}
}

function consumeSseLines(
	input: string,
	responseIds?: Set<string>,
): { remainder: string; usage: ProviderUsage | null; done: boolean; hasUsage: boolean; invalidUsage: boolean } {
	const lines = input.split(/\r?\n/u);
	const remainder = lines.pop() ?? "";
	let usage: ProviderUsage | null = null;
	let done = false;
	let hasUsage = false;
	let invalidUsage = false;
	for (const line of lines) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (data === "[DONE]") {
			done = true;
			continue;
		}
		if (!data) continue;
		try {
			const parsed = JSON.parse(data) as { id?: unknown; usage?: Record<string, unknown> };
			if (
				responseIds &&
				typeof parsed.id === "string" &&
				parsed.id.length > 0 &&
				parsed.id.length <= 512 &&
				responseIds.size < 8
			)
				responseIds.add(parsed.id);
			if (parsed.usage !== undefined && parsed.usage !== null) {
				hasUsage = true;
				usage = typeof parsed.usage === "object" ? parseUsage(parsed.usage) : null;
				invalidUsage ||= usage === null;
			}
		} catch {}
	}
	return { remainder, usage, done, hasUsage, invalidUsage };
}

function parseUsage(value: Record<string, unknown>): ProviderUsage | null {
	const promptTokens = nonnegativeInteger(value.prompt_tokens);
	const completionTokens = nonnegativeInteger(value.completion_tokens);
	if (promptTokens === undefined || completionTokens === undefined) return null;
	const totalTokens =
		value.total_tokens === undefined ? promptTokens + completionTokens : nonnegativeInteger(value.total_tokens);
	if (totalTokens === undefined || !Number.isSafeInteger(totalTokens)) return null;
	if (totalTokens !== promptTokens + completionTokens) return null;
	return {
		promptTokens,
		completionTokens,
		totalTokens,
	};
}

async function readBoundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const bytes = Buffer.from(chunk);
		length += bytes.length;
		if (length > maximum) throw new Error("GATEWAY_REQUEST_TOO_LARGE");
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

function hasBearer(request: IncomingMessage, expected: string): boolean {
	return request.headers.authorization === `Bearer ${expected}`;
}

function isChatPath(url: string | undefined): boolean {
	return url === "/chat/completions" || url === "/v1/chat/completions";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	if (response.writableEnded) return;
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.setHeader("Cache-Control", "no-store");
	response.end(`${JSON.stringify(value)}\n`);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validateOptions(options: BudgetGatewayOptions): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(options.runId)) throw new Error("GATEWAY_RUN_ID_INVALID");
	if (
		!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(options.upstreamBaseUrl) &&
		options.upstreamBaseUrl !== "https://api.deepseek.com"
	) {
		throw new Error("GATEWAY_UPSTREAM_NOT_ALLOWED");
	}
	if (!options.upstreamApiKey || !options.clientToken || !options.adminToken)
		throw new Error("GATEWAY_SECRET_MISSING");
	for (const value of Object.values(options.limits))
		if (!Number.isFinite(value) || value <= 0) throw new Error("GATEWAY_LIMIT_INVALID");
	const minimumOutput = options.limits.minOutputTokensPerRequest;
	if (minimumOutput !== undefined &&
		(!Number.isSafeInteger(minimumOutput) || minimumOutput > options.limits.maxOutputTokensPerRequest))
		throw new Error("GATEWAY_OUTPUT_LIMIT_INVALID");
	for (const rate of Object.values(options.pricing))
		if (!Number.isFinite(rate) || rate < 0) throw new Error("GATEWAY_PRICING_INVALID");
	if (options.limits.maxConcurrency !== 1) throw new Error("GATEWAY_CONCURRENCY_MUST_BE_ONE");
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
