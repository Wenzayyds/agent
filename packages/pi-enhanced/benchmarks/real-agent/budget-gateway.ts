import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface BudgetGatewayLimits {
	maxRequests: number;
	maxTotalTokens: number;
	maxTotalCostUsd: number;
	maxConcurrency: number;
	requestTimeoutMs: number;
	maxOutputTokensPerRequest: number;
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
}

export interface GatewayDenialRecord {
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
	id: number;
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
	limits: BudgetGatewayLimits;
}

class BudgetLedger {
	private nextId = 1;
	private state: BudgetGatewayStatus;
	private readonly limits: BudgetGatewayLimits;
	private readonly pricing: BudgetGatewayPricing;
	private readonly runId: string;

	constructor(runId: string, limits: BudgetGatewayLimits, pricing: BudgetGatewayPricing) {
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
			limits: { ...limits },
		};
	}

	nextRequestSequence(): number {
		this.state.requestAttempts += 1;
		return this.state.requestAttempts;
	}

	reserve(bodyBytes: number, requestedOutputTokens: number, requestSequence: number): Reservation {
		if (this.state.state !== "ready") return this.reject("GATEWAY_FAILED_CLOSED", requestSequence);
		if (this.state.activeRequests >= this.limits.maxConcurrency) return this.reject("GATEWAY_CONCURRENCY_LIMIT", requestSequence);
		if (this.state.requestsStarted >= this.limits.maxRequests) return this.reject("GATEWAY_REQUEST_LIMIT", requestSequence);
		const outputTokenLimit = Math.max(1, Math.min(requestedOutputTokens, this.limits.maxOutputTokensPerRequest));
		// A UTF-8 token cannot contain fewer than one byte. The fixed allowance covers provider-side
		// message framing that is not present in the serialized request body.
		const inputTokenUpperBound = bodyBytes + 4096;
		const reservedTokens = inputTokenUpperBound + outputTokenLimit;
		const reservedCostUsd =
			(inputTokenUpperBound * this.pricing.inputUsdPerMillion +
				outputTokenLimit * this.pricing.outputUsdPerMillion) /
			1_000_000;
		if (
			this.state.committedTokenUpperBound + this.state.reservedTokens + reservedTokens >
			this.limits.maxTotalTokens
		) {
			return this.reject("GATEWAY_TOKEN_BUDGET", requestSequence);
		}
		if (
			this.state.committedCostUpperBoundUsd + this.state.reservedCostUsd + reservedCostUsd >
			this.limits.maxTotalCostUsd + Number.EPSILON
		) {
			return this.reject("GATEWAY_COST_BUDGET", requestSequence);
		}
		this.state.requestsStarted += 1;
		this.state.activeRequests += 1;
		this.state.reservedTokens += reservedTokens;
		this.state.reservedCostUsd += reservedCostUsd;
		return {
			id: this.nextId++,
			inputTokenUpperBound,
			outputTokenLimit,
			reservedTokens,
			reservedCostUsd,
		};
	}

	complete(reservation: Reservation, usage: ProviderUsage | null): void {
		this.releaseActive(reservation);
		this.state.requestsCompleted += 1;
		if (!usage) {
			this.commitReservation(reservation, "GATEWAY_USAGE_MISSING");
			return;
		}
		const actualCostUsd =
			(usage.promptTokens * this.pricing.inputUsdPerMillion +
				usage.completionTokens * this.pricing.outputUsdPerMillion) /
			1_000_000;
		this.state.actualInputTokens += usage.promptTokens;
		this.state.actualOutputTokens += usage.completionTokens;
		this.state.actualTotalTokens += usage.totalTokens;
		this.state.actualCostUsd += actualCostUsd;
		this.state.committedTokenUpperBound += usage.totalTokens;
		this.state.committedCostUpperBoundUsd += actualCostUsd;
		if (
			usage.promptTokens > reservation.inputTokenUpperBound ||
			usage.completionTokens > reservation.outputTokenLimit ||
			usage.totalTokens > reservation.reservedTokens ||
			this.state.committedTokenUpperBound > this.limits.maxTotalTokens ||
			this.state.committedCostUpperBoundUsd > this.limits.maxTotalCostUsd + Number.EPSILON
		) {
			this.failClosed("GATEWAY_PROVIDER_USAGE_EXCEEDED_RESERVATION");
		}
	}

	fail(reservation: Reservation, reason: string): void {
		this.releaseActive(reservation);
		this.commitReservation(reservation, reason);
	}

	deny(reason: string, requestSequence: number): void {
		this.state.requestsRejected += 1;
		this.state.denials.push({
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

	reject(reason: string, requestSequence: number): never {
		this.deny(reason, requestSequence);
		throw new GatewayRejection(reason);
	}

	close(): void {
		this.state.state = "closed";
	}

	snapshot(): BudgetGatewayStatus {
		return JSON.parse(JSON.stringify(this.state)) as BudgetGatewayStatus;
	}

	private releaseActive(reservation: Reservation): void {
		this.state.activeRequests = Math.max(0, this.state.activeRequests - 1);
		this.state.reservedTokens = Math.max(0, this.state.reservedTokens - reservation.reservedTokens);
		this.state.reservedCostUsd = Math.max(0, this.state.reservedCostUsd - reservation.reservedCostUsd);
	}

	private commitReservation(reservation: Reservation, reason: string): void {
		this.state.committedTokenUpperBound += reservation.reservedTokens;
		this.state.committedCostUpperBoundUsd += reservation.reservedCostUsd;
		this.failClosed(reason);
	}

	private failClosed(reason: string): void {
		this.state.state = "failed_closed";
		this.state.lastError = reason;
	}
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
	status(): BudgetGatewayStatus;
	close(): Promise<void>;
}

export async function startBudgetGateway(options: BudgetGatewayOptions): Promise<RunningBudgetGateway> {
	validateOptions(options);
	const ledger = new BudgetLedger(options.runId, options.limits, options.pricing);
	const server = createServer((request, response) => {
		void handleRequest(request, response, options, ledger);
	});
	server.requestTimeout = options.limits.requestTimeoutMs + 5_000;
	server.headersTimeout = Math.min(server.requestTimeout, 30_000);
	server.maxRequestsPerSocket = options.limits.maxRequests + 4;
	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("GATEWAY_LISTEN_FAILED");
	return {
		url: `http://127.0.0.1:${address.port}`,
		status: () => ledger.snapshot(),
		close: async () => {
			ledger.close();
			await closeServer(server);
		},
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	options: BudgetGatewayOptions,
	ledger: BudgetLedger,
): Promise<void> {
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
	const requestedOutput = positiveInteger(body.max_tokens) ?? positiveInteger(body.max_completion_tokens) ?? options.limits.maxOutputTokensPerRequest;
	let reservation: Reservation;
	try {
		reservation = ledger.reserve(bodyBytes.byteLength, requestedOutput, requestSequence);
	} catch (error) {
		const code = error instanceof GatewayRejection ? error.code : "GATEWAY_REJECTED";
		return sendJson(response, 429, { error: code });
	}
	body.max_tokens = reservation.outputTokenLimit;
	delete body.max_completion_tokens;
	body.stream_options = { include_usage: true };
	body.user_id = "pi_enhanced_controlled_pilot";

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("GATEWAY_UPSTREAM_TIMEOUT")), options.limits.requestTimeoutMs);
	response.on("close", () => {
		if (!response.writableEnded) controller.abort(new Error("GATEWAY_CLIENT_DISCONNECTED"));
	});
	try {
		const upstream = await (options.fetch ?? globalThis.fetch)(`${options.upstreamBaseUrl.replace(/\/$/u, "")}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.upstreamApiKey}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		response.statusCode = upstream.status;
		response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		if (!upstream.body) {
			ledger.fail(reservation, "GATEWAY_UPSTREAM_BODY_MISSING");
			return response.end();
		}
		let usage: ProviderUsage | null = null;
		let pending = "";
		const decoder = new TextDecoder();
		for await (const chunk of upstream.body) {
			const bytes = Buffer.from(chunk);
			response.write(bytes);
			pending += decoder.decode(bytes, { stream: true });
			const parsed = consumeSseLines(pending);
			pending = parsed.remainder;
			usage = parsed.usage ?? usage;
		}
		pending += decoder.decode();
		usage = consumeSseLines(`${pending}\n`).usage ?? usage;
		response.end();
		if (upstream.ok) ledger.complete(reservation, usage);
		else ledger.fail(reservation, `GATEWAY_UPSTREAM_HTTP_${upstream.status}`);
	} catch (error) {
		ledger.fail(reservation, controller.signal.aborted ? "GATEWAY_UPSTREAM_TIMEOUT_OR_ABORT" : "GATEWAY_UPSTREAM_ERROR");
		if (!response.headersSent) sendJson(response, 502, { error: "GATEWAY_UPSTREAM_FAILED" });
		else response.destroy(error instanceof Error ? error : undefined);
	} finally {
		clearTimeout(timeout);
	}
}

function consumeSseLines(input: string): { remainder: string; usage: ProviderUsage | null } {
	const lines = input.split(/\r?\n/u);
	const remainder = lines.pop() ?? "";
	let usage: ProviderUsage | null = null;
	for (const line of lines) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data) as { usage?: Record<string, unknown> };
			if (parsed.usage) usage = parseUsage(parsed.usage);
		} catch {}
	}
	return { remainder, usage };
}

function parseUsage(value: Record<string, unknown>): ProviderUsage {
	const promptTokens = nonnegativeInteger(value.prompt_tokens) ?? 0;
	const completionTokens = nonnegativeInteger(value.completion_tokens) ?? 0;
	return {
		promptTokens,
		completionTokens,
		totalTokens: nonnegativeInteger(value.total_tokens) ?? promptTokens + completionTokens,
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
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function validateOptions(options: BudgetGatewayOptions): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(options.runId)) throw new Error("GATEWAY_RUN_ID_INVALID");
	if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(options.upstreamBaseUrl) && options.upstreamBaseUrl !== "https://api.deepseek.com") {
		throw new Error("GATEWAY_UPSTREAM_NOT_ALLOWED");
	}
	if (!options.upstreamApiKey || !options.clientToken || !options.adminToken) throw new Error("GATEWAY_SECRET_MISSING");
	for (const value of Object.values(options.limits)) if (!Number.isFinite(value) || value <= 0) throw new Error("GATEWAY_LIMIT_INVALID");
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
