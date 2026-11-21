import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BudgetGatewayStatus } from "./budget-gateway.ts";

export const flashEndpoint = "https://api.deepseek.com";
export const flashVersion = "DeepSeek-V4.1-Flash-1017";
const unitsPerDollar = 1_000_000_000;
const cellReserve = 30_000_000;

export class Ma3Spending {
	private settled = 0;
	private active: string | undefined;
	private requests = 0;
	private readonly started = new Set<string>();
	private readonly cap: number;
	private readonly initial: number;
	private readonly incremental: number;
	private readonly record: (event: Record<string, unknown>) => void;

	constructor(cap: number, record: (event: Record<string, unknown>) => void, prior?: { attempted: string[]; heldUsd: number }, incremental = cap) {
		this.cap = cap;
		this.incremental = Math.round(incremental * unitsPerDollar);
		this.record = record;
		if (prior) {
			assert(Number.isFinite(prior.heldUsd) && prior.heldUsd >= 0 && prior.heldUsd <= cap);
			assert.equal(new Set(prior.attempted).size, prior.attempted.length);
			this.settled = Math.round(prior.heldUsd * unitsPerDollar);
			for (const cell of prior.attempted) this.started.add(cell);
		}
		this.initial = this.settled;
	}

	reserve(cell: string): boolean {
		assert(!this.active && !this.started.has(cell), "MA3 cell already started or another cell is active");
		if (this.settled + cellReserve > this.cap * unitsPerDollar) {
			this.record({ kind: "global-budget-denied", cell, remainingUsd: this.cap - this.settledUsd });
			return false;
		}
		if (this.settled - this.initial + cellReserve > this.incremental) {
			this.record({ kind: "batch-budget-denied", cell, remainingUsd: (this.incremental - this.settled + this.initial) / unitsPerDollar });
			return false;
		}
		this.record({ kind: "cell-reserved", cell, settledUsd: this.settledUsd, reservedUsd: cellReserve / unitsPerDollar });
		this.active = cell;
		this.started.add(cell);
		this.requests = 0;
		return true;
	}

	dispatch(cell: string, data: Record<string, unknown>): number {
		assert(this.active === cell && this.requests < 8, "MA3 request lacks a valid global reservation");
		assert(this.settled + cellReserve <= this.cap * unitsPerDollar);
		assert(this.settled - this.initial + cellReserve <= this.incremental);
		const request = this.requests + 1;
		this.record({ kind: "provider-dispatch", cell, request, settledUsd: this.settledUsd,
			reservedUsd: cellReserve / unitsPerDollar, ...data });
		this.requests = request;
		return request;
	}

	settle(cell: string, status: BudgetGatewayStatus | undefined): number {
		assert.equal(this.active, cell);
		const outcomes = status?.requestOutcomes ?? [];
		const reconciled = status && status.activeRequests === 0 && outcomes.length === this.requests &&
			outcomes.every((entry) => entry.usageSeen && entry.doneSeen && entry.actualCostUsd !== null);
		const used = this.requests === 0 ? 0 : reconciled ?
			Math.ceil(Math.max(status.committedCostUpperBoundUsd, status.actualCostUsd) * unitsPerDollar) : cellReserve;
		assert(Number.isFinite(used) && used >= 0 && used <= cellReserve, "MA3 provider exceeded the cost reservation");
		this.record({ kind: "cell-settled", cell, requests: this.requests, costUpperUsd: used / unitsPerDollar,
			previouslySettledUsd: this.settledUsd, mode: reconciled || !this.requests ? "settled" : "conservative-cell-cap" });
		this.settled += used;
		this.active = undefined;
		return used / unitsPerDollar;
	}

	get settledUsd(): number { return this.settled / unitsPerDollar; }
}

type ProviderRecord = (event: Record<string, unknown>) => void;

export function guardMa3Upstream(options: {
	cell: string;
	mode: string;
	upstream: string;
	key: string;
	spending: Ma3Spending;
	record: ProviderRecord;
	project: (body: Record<string, unknown>) => { body: Record<string, unknown>; metadata: Record<string, unknown> };
}) {
	const original = globalThis.fetch;
	const apiKey = randomUUID() + randomUUID();
	// The gateway accepts a loopback origin. This benchmark-only origin is intercepted in-process.
	const baseUrl = "http://127.0.0.1:1";
	const source = `${baseUrl}/chat/completions`;
	const real = `${flashEndpoint}/chat/completions`;
	const destination = `${options.upstream}/chat/completions`;
	const violations: string[] = [];
	const trace: Record<string, unknown>[] = [];
	const fail = (reason: string) => { violations.push(reason); throw new Error(reason); };
	const guarded: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === real) throw new Error("MA3_DIRECT_PROVIDER_DENIED");
		if (url !== source) return original(input, init);
		const headers = new Headers(init?.headers);
		if (headers.get("authorization") !== `Bearer ${apiKey}` || init?.method !== "POST" ||
			init.redirect !== "error" || typeof init.body !== "string") throw new Error("MA3_GATEWAY_CREDENTIAL_REQUIRED");
		if (init.signal?.aborted) throw init.signal.reason;
		const raw = JSON.parse(init.body) as Record<string, unknown>;
		if (raw.model !== "deepseek-flash" || raw.stream !== true || !Number.isInteger(raw.max_tokens) ||
			Number(raw.max_tokens) < 1 || Number(raw.max_tokens) > 512) return fail("MA3_MODEL_CONTRACT_VIOLATION");
		let projection: ReturnType<typeof options.project>;
		try { projection = options.project(raw); }
		catch (error) { return fail(error instanceof Error ? error.message : "MA3_INVALID_PROVIDER_REQUEST"); }
		const { body, metadata } = projection;
		const record = { mode: options.mode, model: body.model, expectedVersion: flashVersion, thinking: body.thinking,
			temperature: body.temperature, maxOutputTokens: body.max_tokens, ...metadata };
		trace.push(record);
		const request = options.spending.dispatch(options.cell, record);
		try {
			// No asynchronous work occurs between the gateway's send-time check and provider dispatch.
			const response = await original(destination, { ...init, headers: { authorization: `Bearer ${options.key}`,
				"content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body) });
			options.record({ kind: "provider-http", cell: options.cell, request, status: response.status });
			if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
			const decoder = new TextDecoder();
			let remaining = "";
			const labels = new Set<string>();
			const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, target) {
					remaining += decoder.decode(chunk, { stream: true });
					let end: number;
					while ((end = remaining.indexOf("\n")) >= 0) {
						const line = remaining.slice(0, end).trim();
						remaining = remaining.slice(end + 1);
						if (!line.startsWith("data: {") && !line.startsWith("data:{")) continue;
						let event: { model?: string; usage?: Record<string, unknown> };
						try { event = JSON.parse(line.slice(5)); } catch { continue; }
						if (event.model && !labels.has(event.model)) {
							labels.add(event.model);
							options.record({ kind: "provider-model", cell: options.cell, request, model: event.model });
							if (event.model !== "deepseek-flash" && event.model.toLowerCase() !== flashVersion.toLowerCase())
								fail("MA3_UNEXPECTED_PROVIDER_MODEL");
						}
						if (event.usage) {
							const { prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens } = event.usage;
							options.record({ kind: "provider-usage", cell: options.cell, request, prompt_tokens, completion_tokens,
								total_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens });
						}
					}
					if (remaining.length > 1_000_000) fail("MA3_PROVIDER_FRAME_TOO_LARGE");
					target.enqueue(chunk);
				},
			}));
			return new Response(stream, { status: response.status, headers: response.headers });
		} catch (error) {
			options.record({ kind: "provider-transport-error", cell: options.cell, request,
				code: (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name });
			throw error;
		}
	};
	globalThis.fetch = guarded;
	return { baseUrl, apiKey, trace, violations, restore() { globalThis.fetch = original; } };
}
