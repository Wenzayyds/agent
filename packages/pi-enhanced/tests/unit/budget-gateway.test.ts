import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retryProviderRequest } from "../../../ai/src/utils/provider-retry.ts";
import {
	type BudgetGatewayLimits,
	type RunningBudgetGateway,
	startBudgetGateway,
} from "../../benchmarks/real-agent/budget-gateway.ts";
import {
	applyEvaluationContextBudget,
	assessEvaluationContinuation,
	canReserveE17Cell,
	measureEvaluationContext,
} from "../../benchmarks/real-agent/evaluation-context-budget.ts";
import { finalizeAgentExecution } from "../../benchmarks/real-agent/runner-cleanup.ts";
import { SWE_FLASH_OFF_CONFIGURATION } from "../../benchmarks/real-agent/swe-profile.ts";
import { TASK_BUDGET_DEFAULTS, TASK_TOKEN_TIERS, type TaskBudgetTier } from "../../src/shared/task-budget.ts";

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	await Promise.allSettled(running.splice(0).map((item) => item.close()));
});

const baseLimits: BudgetGatewayLimits = {
	maxRequests: 3,
	maxTotalTokens: 50_000,
	maxTotalCostUsd: 1,
	maxConcurrency: 1,
	requestTimeoutMs: 2_000,
	maxOutputTokensPerRequest: 256,
	maxRequestBytes: 100_000,
};

describe("Batch H hard budget gateway", () => {
	it.each(Object.entries(TASK_TOKEN_TIERS))("enforces the %s Token tier before forwarding", async (tier, limit) => {
		const gateway = await gatewayFor("http://127.0.0.1:1", {
			...baseLimits, tier: tier as TaskBudgetTier, maxTotalTokens: limit,
		});
		const response = await callGateway(gateway.url, "client-token", {
			messages: [{ role: "user", content: "x".repeat(limit) }],
		});
		expect(response.status).toBe(429);
		expect(gateway.status()).toMatchObject({
			requestsStarted: 0, limits: { tier, maxTotalTokens: limit },
			denials: [{ code: "GATEWAY_TOKEN_BUDGET", upstreamForwarded: false }],
		});
	});

	it("keeps the Premium output cap and checks authorization again at upstream dispatch", async () => {
		let bytes = 0;
		let allow = true;
		const upstream = await mockUpstream(async (_request, response, body) => {
			bytes += Buffer.byteLength(JSON.stringify(body));
			expect(body.max_tokens).toBe(512);
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
		});
		const gateway = await startBudgetGateway({
			runId: "premium-dispatch-check", upstreamBaseUrl: upstream.url, upstreamApiKey: "local",
			clientToken: "client-token", adminToken: "admin-token", allowedModel: "deepseek-flash",
			limits: { ...baseLimits, tier: "premium", maxTotalTokens: 30_000, maxTotalCostUsd: TASK_BUDGET_DEFAULTS.maxTotalCostUsd,
				maxOutputTokensPerRequest: TASK_BUDGET_DEFAULTS.maxOutputTokensPerRequest },
			pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
			dispatchCheck: permit => permit === "local-permit" ? () => { if (!allow) throw new Error("revoked"); } : undefined,
		});
		running.push(gateway);
		const request = (content: string) => fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST", headers: { Authorization: "Bearer client-token", "Content-Type": "application/json",
				"x-pi-budget-permit": "local-permit" },
			body: JSON.stringify({ model: "deepseek-flash", stream: true, max_tokens: 9900, messages: [{ role: "user", content }] }),
		});
		allow = false;
		const blocked = await request("E20_REVOKED_REFERENCE");
		expect(await blocked.json()).toEqual({ error: "GATEWAY_DISPATCH_AUTHORIZATION_CHANGED" });
		expect(bytes).toBe(0);
		expect(gateway.status()).toMatchObject({ requestsStarted: 1, actualTotalTokens: 0, reservedTokens: 0 });
		allow = true;
		expect(await (await request("authorized")).text()).toContain("[DONE]");
		expect(bytes).toBeGreaterThan(0);
		expect(gateway.status().limits.maxTotalCostUsd).toBe(0.03);
		const paid = await startBudgetGateway({
			runId: "premium-cost-check", upstreamBaseUrl: upstream.url, upstreamApiKey: "local", clientToken: "client-token",
			adminToken: "admin-token", allowedModel: "deepseek-flash",
			limits: { ...baseLimits, tier: "premium", maxTotalTokens: 30_000, maxTotalCostUsd: 0.00001 },
			pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
		});
		running.push(paid);
		const refusal = await callGateway(paid.url, "client-token", { messages: [{ role: "user", content: "short" }] });
		expect(await refusal.json()).toEqual({ error: "GATEWAY_COST_BUDGET" });
		expect(paid.status().requestsStarted).toBe(0);
	});
	it("blocks a Flash request at the exact $0.08 task cap while request and Token budget remain", async () => {
		let forwarded = 0;
		const upstream = await mockUpstream(async (_request, response) => {
			forwarded++;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				'data: {"choices":[],"usage":{"prompt_tokens":8000,"completion_tokens":2048,"total_tokens":10048}}\n\ndata: [DONE]\n\n',
			);
		});
		const { limits, maxOutputTokens } = SWE_FLASH_OFF_CONFIGURATION;
		const gateway = await startBudgetGateway({
			runId: "swe-flash-off-budget-test",
			upstreamBaseUrl: upstream.url,
			upstreamApiKey: "upstream-key",
			clientToken: "client-token",
			adminToken: "admin-token",
			allowedModel: "deepseek-flash",
			limits: {
				...baseLimits,
				maxRequests: limits.maxRequests,
				maxTotalTokens: limits.maxTokens,
				maxTotalCostUsd: limits.maxCostUsd,
				maxOutputTokensPerRequest: maxOutputTokens,
			},
			pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
		});
		running.push(gateway);
		const body = { max_tokens: maxOutputTokens, messages: [{ role: "user", content: "a".repeat(8_100) }] };
		for (let request = 0; request < 16; request++)
			expect((await callGateway(gateway.url, "client-token", body)).status).toBe(200);
		expect((await callGateway(gateway.url, "client-token", body)).status).toBe(429);
		const status = gateway.status();
		expect(forwarded).toBe(16);
		expect(status.actualCostUsd).toBeCloseTo(0.0777216, 10);
		expect(status.denials.at(-1)).toMatchObject({
			code: "GATEWAY_COST_BUDGET",
			upstreamForwarded: false,
			reservationDiagnostics: { maxTotalCostUsd: 0.08, remainingTokenHeadroom: 39_232 },
		});
	});

	it("still closes the gateway and removes containers when final evidence cannot be written", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-gateway-cleanup-"));
		try {
			mkdirSync(join(dir, "gateway-final.json"));
			const gateway = await gatewayFor("http://127.0.0.1:1", baseLimits);
			let removed = false;
			const executionError = new Error("setup failed");
			const closeError = new Error("close reported an error");
			await expect(
				finalizeAgentExecution(
					{
						status: gateway.status,
						async close() {
							await gateway.close();
							throw closeError;
						},
					},
					dir,
					() => {
						removed = true;
						return true;
					},
					{ error: executionError },
				),
			).rejects.toMatchObject({
				errors: [executionError, expect.objectContaining({ path: join(dir, "gateway-final.json") }), closeError],
			});
			expect(gateway.status().state).toBe("closed");
			expect(removed).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("charges Pro at peak rates and keeps the 200K token and $0.40 reservations hard", async () => {
		let forwarded = 0;
		const upstream = await mockUpstream(async (_request, response, body) => {
			forwarded++;
			expect(body).toMatchObject({
				model: "deepseek-v4-pro",
				max_tokens: 2048,
				stream_options: { include_usage: true },
			});
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\ndata: [DONE]\n\n',
			);
		});
		const limits = {
			...baseLimits,
			maxRequests: 20,
			maxTotalTokens: 200_000,
			maxTotalCostUsd: 0.4,
			maxOutputTokensPerRequest: 2048,
			maxRequestBytes: 300_000,
		};
		const proGateway = async (overrides: Partial<BudgetGatewayLimits> = {}, upstreamBaseUrl = upstream.url) => {
			const gateway = await startBudgetGateway({
				runId: "swe-pro-off-test",
				upstreamBaseUrl,
				upstreamApiKey: "upstream-key",
				clientToken: "client-token",
				adminToken: "admin-token",
				allowedModel: "deepseek-v4-pro",
				limits: { ...limits, ...overrides },
				pricing: { inputUsdPerMillion: 1.32, outputUsdPerMillion: 3.96 },
			});
			running.push(gateway);
			return gateway;
		};
		const gateway = await proGateway();
		expect((await callGateway(gateway.url, "client-token", { max_tokens: 9999 }, "deepseek-flash")).status).toBe(400);
		expect((await callGateway(gateway.url, "client-token", { max_tokens: 9999 }, "deepseek-v4-pro")).status).toBe(
			200,
		);
		expect(forwarded).toBe(1);
		expect(gateway.status()).toMatchObject({
			requestsStarted: 1,
			requestsCompleted: 1,
			actualTotalTokens: 110,
			state: "ready",
		});
		expect(gateway.status().actualCostUsd).toBeCloseTo(0.0001716, 9);
		const tokenLimited = await proGateway();
		expect(
			(
				await callGateway(
					tokenLimited.url,
					"client-token",
					{ messages: [{ role: "user", content: "a".repeat(200_000) }] },
					"deepseek-v4-pro",
				)
			).status,
		).toBe(429);
		expect(tokenLimited.status().denials[0]?.code).toBe("GATEWAY_TOKEN_BUDGET");
		const costLimited = await proGateway({ maxTotalCostUsd: 0.001 });
		expect((await callGateway(costLimited.url, "client-token", {}, "deepseek-v4-pro")).status).toBe(429);
		expect(costLimited.status().denials[0]?.code).toBe("GATEWAY_COST_BUDGET");
		expect(forwarded).toBe(1);
		const noUsage = await mockUpstream(async (_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end("data: [DONE]\n\n");
		});
		const failedClosed = await proGateway({}, noUsage.url);
		expect((await callGateway(failedClosed.url, "client-token", {}, "deepseek-v4-pro")).status).toBe(200);
		expect(failedClosed.status()).toMatchObject({ state: "failed_closed", lastError: "GATEWAY_USAGE_MISSING" });
		expect(failedClosed.status().committedCostUpperBoundUsd).toBeGreaterThan(0);
		const maxOutput = 20 * 2048;
		const theoreticalMaxUsd = ((200_000 - maxOutput) * 1.32 + maxOutput * 3.96) / 1_000_000;
		expect(theoreticalMaxUsd).toBeCloseTo(0.3721344, 9);
		expect(theoreticalMaxUsd).toBeLessThan(0.4);
	});
	it("sends the affordable cap, holds it once, and refunds unused Tokens and USD", async () => {
		const outbound = {
			model: "deepseek-flash",
			messages: [{ role: "user", content: "test" }],
			stream: true,
			max_tokens: 256,
			stream_options: { include_usage: true },
			user_id: "pi_enhanced_controlled_pilot",
		};
		const inputBound = Buffer.byteLength(JSON.stringify(outbound)) + 4096;
		let release!: () => void;
		let reached!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const caps: unknown[] = [];
		const upstream = await mockUpstream(async (_request, response, body) => {
			caps.push(body.max_tokens);
			expect(body).not.toHaveProperty("max_output_tokens");
			if (caps.length === 1) {
				reached();
				await hold;
			}
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				'data: {"usage":{"prompt_tokens":15,"completion_tokens":5,"total_tokens":20}}\n\ndata: [DONE]\n\n',
			);
		});
		const gateway = await gatewayFor(upstream.url, {
			...baseLimits,
			maxTotalTokens: inputBound + 120,
			minOutputTokensPerRequest: 64,
		});
		const first = callGateway(gateway.url, "client-token", { max_output_tokens: 512 });
		await started;
		try {
			expect(gateway.status()).toMatchObject({ reservedTokens: inputBound + 120, activeRequests: 1 });
			const concurrent = await callGateway(gateway.url, "client-token", { max_output_tokens: 512 });
			expect(await concurrent.json()).toEqual({ error: "GATEWAY_CONCURRENCY_LIMIT" });
		} finally {
			release();
		}
		await (await first).text();
		const [outcome] = gateway.status().requestOutcomes;
		expect(outcome).toMatchObject({
			inputTokens: 15,
			outputTokens: 5,
			reservationDiagnostics: {
				inputTokenUpperBound: inputBound,
				defaultOutputTokenLimit: 256,
				minimumOutputTokens: 64,
				requestedOutputTokens: 512,
				outputTokenLimit: 120,
				outputLimitReduced: true,
				candidateReservedTokens: inputBound + 120,
			},
			settlement: { committedTokens: 20, releasedTokens: inputBound + 100 },
		});
		expect(outcome!.settlement.releasedCostUsd).toBeCloseTo(
			outcome!.reservationDiagnostics.candidateReservedCostUsd - outcome!.actualCostUsd!,
			12,
		);
		await (await callGateway(gateway.url, "client-token", { max_output_tokens: 512 })).text();
		expect(caps).toEqual([120, 100]);
		const denied = await callGateway(gateway.url, "client-token", {
			max_output_tokens: 512,
			messages: [{ role: "user", content: "x".repeat(200) }],
		});
		expect(await denied.json()).toEqual({ error: "GATEWAY_TOKEN_BUDGET" });
		expect(caps).toEqual([120, 100]);
		expect(gateway.status()).toMatchObject({ reservedTokens: 0, activeRequests: 0, actualTotalTokens: 40 });
	});

	it("honors the USD cap and keeps the reservation when reported usage exceeds the effective cap", async () => {
		let outputLimit = 0;
		const upstream = await mockUpstream(async (_request, response, body) => {
			outputLimit = Number(body.max_tokens);
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			const tooMany = outputLimit + 1;
			response.end(`data: {"usage":{"prompt_tokens":1,"completion_tokens":${tooMany}}}\n\ndata: [DONE]\n\n`);
		});
		const gateway = await gatewayFor(upstream.url, {
			...baseLimits,
			maxTotalCostUsd: 0.00145,
			minOutputTokensPerRequest: 64,
		});
		await (await callGateway(gateway.url, "client-token")).text();
		expect(outputLimit).toBeGreaterThanOrEqual(64);
		expect(outputLimit).toBeLessThan(256);
		const status = gateway.status();
		expect(status).toMatchObject({
			state: "failed_closed",
			lastError: "GATEWAY_PROVIDER_USAGE_EXCEEDED_RESERVATION",
			reservedTokens: 0,
		});
		expect(status.requestOutcomes[0]).toMatchObject({ settlement: { releasedTokens: 0, releasedCostUsd: 0 } });
		expect(status.committedCostUpperBoundUsd).toBeLessThanOrEqual(0.00145);
	});

	it("accepts only authenticated isolation-stop signals and never forwards them upstream", async () => {
		const upstream = await mockUpstream(async (_request, response) => {
			response.writeHead(500).end();
		});
		const gateway = await gatewayFor(upstream.url, baseLimits);
		expect(
			(
				await fetch(`${gateway.url}/__budget/stop-isolation`, {
					method: "POST",
					headers: { Authorization: "Bearer wrong" },
				})
			).status,
		).toBe(401);
		expect(gateway.status().state).toBe("ready");
		expect(
			(
				await fetch(`${gateway.url}/__budget/stop-isolation`, {
					method: "POST",
					headers: { Authorization: "Bearer client-token" },
				})
			).status,
		).toBe(200);
		expect(gateway.status()).toMatchObject({
			state: "failed_closed",
			lastError: "GATEWAY_ISOLATION_STOP",
			requestsStarted: 0,
		});
		expect((await callGateway(gateway.url, "client-token")).status).toBe(429);
	});
	it("forces the provider request through loopback, clamps output, and accounts usage", async () => {
		let seenAuthorization = "";
		let seenBody: Record<string, unknown> = {};
		const upstream = await mockUpstream(async (request, response, body) => {
			seenAuthorization = request.headers.authorization ?? "";
			seenBody = body;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\ndata: [DONE]\n\n',
			);
		});
		const gateway = await gatewayFor(upstream.url, { ...baseLimits, maxOutputTokensPerRequest: 64 });
		const result = await callGateway(gateway.url, "client-token", { max_tokens: 999 });
		expect(result.status).toBe(200);
		expect(seenAuthorization).toBe("Bearer upstream-key");
		expect(seenBody.max_tokens).toBe(64);
		expect(seenBody.stream_options).toEqual({ include_usage: true });
		expect(gateway.status()).toMatchObject({
			state: "ready",
			requestsStarted: 1,
			requestsCompleted: 1,
			actualInputTokens: 100,
			actualOutputTokens: 50,
			actualTotalTokens: 150,
		});
	});

	it("rejects wrong credentials, models, request counts, and token reservations", async () => {
		const upstream = await mockUpstream(async (_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
		});
		const gateway = await gatewayFor(upstream.url, { ...baseLimits, maxRequests: 1 });
		expect((await callGateway(gateway.url, "wrong-token")).status).toBe(401);
		expect((await callGateway(gateway.url, "client-token", {}, "other-model")).status).toBe(400);
		expect((await callGateway(gateway.url, "client-token")).status).toBe(200);
		expect((await callGateway(gateway.url, "client-token")).status).toBe(429);
		expect(gateway.status().denials.map((item) => item.code)).toEqual([
			"GATEWAY_CLIENT_AUTH",
			"GATEWAY_MODEL_DENIED",
			"GATEWAY_REQUEST_LIMIT",
		]);
		expect(gateway.status().denials.every((item) => item.upstreamForwarded === false)).toBe(true);

		const small = await gatewayFor(upstream.url, { ...baseLimits, maxTotalTokens: 100 });
		expect((await callGateway(small.url, "client-token")).status).toBe(429);
		expect(small.status().requestsStarted).toBe(0);
		expect(small.status().denials[0]).toMatchObject({
			runId: "budget-gateway-test",
			requestSequence: 1,
			code: "GATEWAY_TOKEN_BUDGET",
			upstreamForwarded: false,
			reservationDiagnostics: {
				formulaVersion: "utf8_max_in_out_plus4096_v2",
				requestBodyBytes: Buffer.byteLength(
					JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "test" }], stream: true }),
				),
				inputSafetyMarginTokens: 4096,
				inputEstimateBytes: Buffer.byteLength(
					JSON.stringify({
						model: "deepseek-flash",
						messages: [{ role: "user", content: "test" }],
						stream: true,
						max_tokens: 256,
						stream_options: { include_usage: true },
						user_id: "pi_enhanced_controlled_pilot",
					}),
				),
				inputTokenUpperBound: 4280,
				requestedOutputTokens: 256,
				outputTokenLimit: 256,
				maxTotalTokens: 100,
				remainingTokenHeadroom: 100,
			},
		});
		const costLimited = await gatewayFor(upstream.url, { ...baseLimits, maxTotalCostUsd: 0.000001 });
		expect((await callGateway(costLimited.url, "client-token")).status).toBe(429);
		expect(costLimited.status().denials[0]?.code).toBe("GATEWAY_COST_BUDGET");
		expect(costLimited.status().denials[0]?.reservationDiagnostics?.remainingCostHeadroomUsd).toBe(0.000001);
		expect(JSON.stringify(small.status().denials)).not.toContain('"content"');
	});

	it("allows only one concurrent request and fails closed when usage is missing", async () => {
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const upstream = await mockUpstream(async (_request, response) => {
			reached?.();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end("data: [DONE]\n\n");
		});
		const gateway = await gatewayFor(upstream.url, baseLimits);
		const first = callGateway(gateway.url, "client-token");
		await started;
		expect((await callGateway(gateway.url, "client-token")).status).toBe(429);
		release?.();
		expect((await first).status).toBe(200);
		expect(gateway.status()).toMatchObject({ state: "failed_closed", lastError: "GATEWAY_USAGE_MISSING" });
		expect((await callGateway(gateway.url, "client-token")).status).toBe(429);
		expect(gateway.status().denials.map((item) => item.code)).toEqual([
			"GATEWAY_CONCURRENCY_LIMIT",
			"GATEWAY_FAILED_CLOSED",
		]);
	});

	it("times out the upstream and preserves the full reservation", async () => {
		const upstream = await mockUpstream(async () => {
			await new Promise((resolve) => setTimeout(resolve, 500));
		});
		const gateway = await gatewayFor(upstream.url, { ...baseLimits, requestTimeoutMs: 30 });
		expect((await callGateway(gateway.url, "client-token")).status).toBe(502);
		const status = gateway.status();
		expect(status.state).toBe("failed_closed");
		expect(status.lastError).toBe("GATEWAY_UPSTREAM_TIMEOUT");
		expect(status.committedTokenUpperBound).toBeGreaterThan(0);
		expect(status.committedCostUpperBoundUsd).toBeGreaterThan(0);
	});

	it("settles usage at SSE DONE before a client closes a still-open upstream stream", async () => {
		const upstream = await mockUpstream(async (_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(
				'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n',
			);
			setTimeout(() => response.end(), 200);
		});
		const gateway = await gatewayFor(upstream.url, baseLimits);
		const response = await callGateway(gateway.url, "client-token");
		const reader = response.body!.getReader();
		let text = "";
		while (!text.includes("[DONE]")) {
			const part = await reader.read();
			if (part.done) break;
			text += new TextDecoder().decode(part.value);
		}
		await reader.cancel();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(gateway.status()).toMatchObject({
			state: "ready",
			requestsCompleted: 1,
			actualTotalTokens: 120,
			activeRequests: 0,
		});
		expect(gateway.status().requestOutcomes[0]).toMatchObject({
			outcome: "completed_done",
			usageSeen: true,
			doneSeen: true,
		});
	});

	it("keeps incomplete client disconnects failed closed with a distinct cause and full reservation", async () => {
		const upstream = await mockUpstream(async (_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
			setTimeout(() => response.end(), 200);
		});
		const gateway = await gatewayFor(upstream.url, baseLimits);
		const response = await callGateway(gateway.url, "client-token");
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();
		await new Promise((resolve) => setTimeout(resolve, 30));
		const status = gateway.status();
		expect(status).toMatchObject({
			state: "failed_closed",
			lastError: "GATEWAY_CLIENT_DISCONNECTED",
			requestsCompleted: 0,
			actualTotalTokens: 0,
			activeRequests: 0,
		});
		expect(status.committedTokenUpperBound).toBeGreaterThan(0);
		expect(status.requestOutcomes[0]).toMatchObject({
			outcome: "GATEWAY_CLIENT_DISCONNECTED",
			usageSeen: false,
			doneSeen: false,
		});
		expect((await callGateway(gateway.url, "client-token")).status).toBe(429);
	});
	it("does not treat malformed provider usage as a free completed request", async () => {
		const upstream = await mockUpstream(async (_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end('data: {"usage":{}}\n\ndata: [DONE]\n\n');
		});
		const gateway = await gatewayFor(upstream.url, baseLimits);
		await (await callGateway(gateway.url, "client-token")).text();
		expect(gateway.status()).toMatchObject({
			state: "failed_closed",
			lastError: "GATEWAY_USAGE_MISSING",
			actualTotalTokens: 0,
		});
		expect(gateway.status().committedCostUpperBoundUsd).toBeGreaterThan(0);
	});
	it("rejects invalid final usage instead of retaining an earlier valid sample", async () => {
		for (const finalUsage of [
			{},
			{ prompt_tokens: 1, completion_tokens: 1, total_tokens: -1 },
			{ prompt_tokens: 1, completion_tokens: 1, total_tokens: 99 },
		]) {
			const upstream = await mockUpstream(async (_request, response) => {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.write('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
				response.end(`data: ${JSON.stringify({ usage: finalUsage })}\n\ndata: [DONE]\n\n`);
			});
			const gateway = await gatewayFor(upstream.url, baseLimits);
			await (await callGateway(gateway.url, "client-token")).text();
			expect(gateway.status()).toMatchObject({
				state: "failed_closed",
				lastError: "GATEWAY_USAGE_MISSING",
				actualTotalTokens: 0,
			});
			expect(gateway.status().requestOutcomes[0]?.outcome).toBe("GATEWAY_USAGE_MISSING");
			expect(gateway.status().committedCostUpperBoundUsd).toBeGreaterThan(0);
		}
	});
	it.each([
		{ code: "EAI_AGAIN", outcome: "GATEWAY_UPSTREAM_CONNECTION_FAILED", retry: true },
		{ code: "ENOTFOUND", outcome: "GATEWAY_UPSTREAM_CONNECTION_FAILED", retry: true },
		{ code: "ECONNREFUSED", outcome: "GATEWAY_UPSTREAM_CONNECTION_FAILED", retry: false },
		{ code: "UND_ERR_CONNECT_TIMEOUT", outcome: "GATEWAY_UPSTREAM_CONNECT_TIMEOUT", retry: true },
		{ code: "UND_ERR_HEADERS_TIMEOUT", outcome: "GATEWAY_UPSTREAM_TIMEOUT", retry: false },
		{ code: "UND_ERR_SOCKET", outcome: "GATEWAY_UPSTREAM_ERROR", retry: false },
	])(
		"classifies $code and only offers client retries before an upstream connection",
		async ({ code, outcome, retry }) => {
			let attempts = 0;
			const gateway = await gatewayFor("http://127.0.0.1:1", baseLimits, {
				guardedClientRetry: true,
				fetch: async () => {
					if (++attempts === 1) throw new TypeError("fetch failed", { cause: { code } });
					return new Response(
						'data: {"choices":[{"finish_reason":"stop","delta":{"content":"done"}}],"usage":{"prompt_tokens":120,"completion_tokens":10}}\n\ndata: [DONE]\n\n',
					);
				},
			});
			const response = await callGateway(gateway.url, "client-token");
			await response.text();
			expect(response.status).toBe(retry ? 503 : 502);
			expect(response.headers.get("x-should-retry")).toBe(String(retry));
			expect(attempts).toBe(1);
			if (retry) expect(await (await callGateway(gateway.url, "client-token")).text()).toContain("[DONE]");
			expect(attempts).toBe(retry ? 2 : 1);
			const status = gateway.status();
			expect(status).toMatchObject({
				requestsStarted: attempts,
				reservedTokens: 0,
				reservedCostUsd: 0,
				actualTotalTokens: retry ? 130 : 0,
			});
			expect(status.requestOutcomes[0]).toMatchObject({ outcome, transportCode: code });
			expect(status.requestOutcomes[0]?.settlement.committedTokens).toBe(
				retry ? 0 : status.requestOutcomes[0]?.reservationDiagnostics.candidateReservedTokens,
			);
			if (retry) {
				expect(status.committedTokenUpperBound).toBe(130);
				expect(status.requestOutcomes[1]).toMatchObject({
					requestSequence: 2,
					outcome: "completed_done",
					httpStatus: 200,
					modelStopReason: "stop",
					modelRequestedTools: false,
				});
			}
		},
	);

	it.each([1, 2, 8])(
		"consumes a request for DNS failure and never retries more than once at cap %i",
		async (maxRequests) => {
			let attempts = 0;
			const gateway = await gatewayFor(
				"http://127.0.0.1:1",
				{ ...baseLimits, maxRequests },
				{
					guardedClientRetry: true,
					fetch: async () => {
						attempts += 1;
						throw new TypeError("fetch failed", { cause: { code: "EAI_AGAIN" } });
					},
				},
			);
			await expect(
				retryProviderRequest(
					async () => {
						const response = await callGateway(gateway.url, "client-token");
						await response.text();
						throw Object.assign(new Error("Gateway response"), {
							status: response.status,
							headers: response.headers,
						});
					},
					{ maxRetries: 1 },
				),
			).rejects.toMatchObject({ status: maxRequests === 1 ? 429 : 503 });
			expect(attempts).toBe(Math.min(2, maxRequests));
			expect(gateway.status()).toMatchObject({
				requestsStarted: attempts,
				committedTokenUpperBound: 0,
				reservedTokens: 0,
			});
			if (maxRequests === 1) expect(gateway.status().denials[0]?.code).toBe("GATEWAY_REQUEST_LIMIT");
		},
	);

	it.each([429, 500, 503])("records HTTP %i without retrying or refunding uncertain usage", async (httpStatus) => {
		let attempts = 0;
		const gateway = await gatewayFor("http://127.0.0.1:1", baseLimits, {
			guardedClientRetry: true,
			fetch: async () => {
				attempts += 1;
				return new Response("unavailable", { status: httpStatus });
			},
		});
		const res = await callGateway(gateway.url, "client-token");
		expect(res.status).toBe(httpStatus);
		expect(res.headers.get("x-should-retry")).toBe("false");
		await res.text();
		expect(attempts).toBe(1);
		expect(gateway.status().requestOutcomes[0]).toMatchObject({
			outcome: `GATEWAY_UPSTREAM_HTTP_${httpStatus}`,
			httpStatus,
		});
		expect(gateway.status().committedTokenUpperBound).toBeGreaterThan(0);
	});

	it("fails closed after SSE disconnect, keeping the unresolved reservation", async () => {
		const gateway = await gatewayFor("http://127.0.0.1:1", baseLimits, {
			guardedClientRetry: true,
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n'));
							setTimeout(() => controller.error(new Error("simulated disconnect")), 20);
						},
					}),
				),
		});
		const response = await callGateway(gateway.url, "client-token");
		await expect(response.text()).rejects.toThrow();
		const status = gateway.status();
		expect(status).toMatchObject({
			requestsStarted: 1,
			reservedTokens: 0,
			actualTotalTokens: 0,
			state: "failed_closed",
		});
		expect(status.requestOutcomes[0]).toMatchObject({
			outcome: "GATEWAY_UPSTREAM_STREAM_INTERRUPTED",
			transportStage: "partial-stream",
			httpStatus: 200,
		});
		expect(status.requestOutcomes[0]?.settlement.committedTokens).toBe(status.committedTokenUpperBound);
		expect(status.committedTokenUpperBound).toBeGreaterThan(0);
	});

	it("distinguishes the next input reservation from an exhausted budget", async () => {
		const limits = {
			...baseLimits,
			maxTotalTokens: 6_000,
			maxOutputTokensPerRequest: 512,
			minOutputTokensPerRequest: 128,
		};
		const upstream = await mockUpstream(async (_request, response, body) => {
			const prompt = body.user_id && Buffer.byteLength(JSON.stringify(body)) + 4_096;
			const output = body.max_tokens as number;
			response.end(
				`data: ${JSON.stringify({ usage: { prompt_tokens: prompt, completion_tokens: output } })}\n\ndata: [DONE]\n\n`,
			);
		});
		const gateway = await gatewayFor(upstream.url, limits);
		const body = (n: number) => ({ max_tokens: 512, messages: [{ role: "user", content: "a".repeat(n) }] });
		expect((await callGateway(gateway.url, "client-token", body(3_000))).status).toBe(429);
		expect(gateway.status().denials[0]).toMatchObject({
			code: "GATEWAY_TOKEN_BUDGET",
			budgetConstraint: "next-input",
			actualTotalTokens: 0,
			reservedTokens: 0,
			upstreamForwarded: false,
		});
		const accepted = await callGateway(gateway.url, "client-token", body(1_500));
		expect(accepted.status).toBe(200);
		await accepted.text();
		expect(gateway.status().actualTotalTokens).toBe(limits.maxTotalTokens);
		expect(gateway.status().requestOutcomes[0]?.reservationDiagnostics.outputLimitReduced).toBe(true);
		expect((await callGateway(gateway.url, "client-token")).status).toBe(429);
		expect(gateway.status().denials.at(-1)).toMatchObject({
			budgetConstraint: "actual-exhausted",
			reservedTokens: 0,
		});
	});
	it("forecasts exactly the admission reserve without mutating budget or holding a slot", async () => {
		const gateway = await gatewayFor("http://127.0.0.1:1", { ...baseLimits, maxTotalTokens: 5_000 });
		const body = { model: "deepseek-flash", stream: true, messages: [{ role: "user", content: "x".repeat(2_000) }] };
		const before = gateway.status();
		const preview = gateway.preview!(body);
		expect(gateway.preview!(body)).toEqual(preview);
		expect(gateway.status()).toEqual(before);
		expect(preview.denial).toBe("GATEWAY_TOKEN_BUDGET");
		const response = await callGateway(gateway.url, "client-token", body);
		expect(response.status).toBe(429);
		expect(gateway.status().denials[0]).toMatchObject({
			code: preview.denial,
			reservationDiagnostics: preview.diagnostics,
		});
	});

	it("keeps the latest authorized reference when identical historical tool output is elided", async () => {
		const gateway = await gatewayFor("http://127.0.0.1:1", baseLimits);
		const protectedResult = JSON.stringify({ revision: 2, chunkId: "owned", excerpt: "control ".repeat(70) });
		const messages = [
			{ role: "system", content: "Keep this task constraint." },
			{
				role: "assistant",
				tool_calls: [{ id: "earlier", function: { name: "enhanced_docs_read", arguments: '{"chunkId":"owned"}' } }],
			},
			{ role: "tool", tool_call_id: "earlier", content: protectedResult },
			{
				role: "assistant",
				tool_calls: [{ id: "later", function: { name: "enhanced_docs_read", arguments: '{"chunkId":"owned"}' } }],
			},
			{ role: "tool", tool_call_id: "later", content: protectedResult },
		];
		const body = { model: "deepseek-flash", stream: true, messages };
		const { selected, observation } = applyEvaluationContextBudget(body, gateway.preview!);
		expect(observation.duplicates).toBe(1);
		expect(observation.afterReserved).toBeLessThan(observation.beforeReserved);
		expect(selected.messages).toEqual([
			messages[0],
			messages[1],
			{ role: "tool", tool_call_id: "earlier", content: expect.stringContaining("later result") },
			messages[3],
			messages[4],
		]);
		expect(body.messages[2]?.content).toBe(protectedResult);
		const differing = structuredClone(body);
		differing.messages[4]!.content = protectedResult.replace('"revision":2', '"revision":3');
		expect(applyEvaluationContextBudget(differing, gateway.preview!).observation.duplicates).toBe(0);
		const ambiguous = structuredClone(body);
		ambiguous.messages[3]!.tool_calls![0]!.id = "earlier";
		ambiguous.messages[4]!.tool_call_id = "earlier";
		expect(applyEvaluationContextBudget(ambiguous, gateway.preview!).observation.duplicates).toBe(0);
	});

	it.each(["verified", "unverified", "later-user", "parallel", "no-pytest", "still-denied"])(
		"offers only approved pytest after a current successful edit when the projection fits (%s)",
		async (scenario) => {
			const gateway = await gatewayFor("http://127.0.0.1:1", {
				...baseLimits,
				maxTotalTokens: scenario === "still-denied" ? 4_500 : 6_000,
			});
			const messages = [
				{ role: "system", content: "Keep the original task and evidence." },
				{
					role: "assistant",
					tool_calls: [
						{ id: "edit-1", function: { name: "edit", arguments: "{}" } },
						...(scenario === "parallel" ? [{ id: "edit-2", function: { name: "edit", arguments: "{}" } }] : []),
					],
				},
				{ role: "tool", tool_call_id: "edit-1", content: "An edit result with its original evidence." },
				...(scenario === "later-user" ? [{ role: "user", content: "Wait for approval" }] : []),
			];
			const pytest = { type: "function", function: { name: "run_tests", parameters: {} } };
			const tools = [
				{ type: "function", function: { name: "edit", description: "x".repeat(3_000), parameters: {} } },
				...(scenario === "no-pytest" ? [] : [pytest]),
			];
			const body = { model: "deepseek-flash", stream: true, messages, tools };
			const { selected, observation } = applyEvaluationContextBudget(
				body,
				gateway.preview!,
				scenario === "unverified" ? undefined : "edit-1",
			);
			expect(observation.beforeDenial).toBe("GATEWAY_TOKEN_BUDGET");
			if (scenario === "verified") {
				expect(observation).toMatchObject({ mode: "test-only", afterDenial: null });
				expect(selected).toMatchObject({
					messages,
					tools: [pytest],
					tool_choice: { type: "function", function: { name: "run_tests" } },
				});
				expect(selected.messages).toEqual(messages);
				expect(body.tools).toEqual(tools);
			} else {
				expect(selected).toBe(body);
				expect(observation).toMatchObject({ mode: "full", afterDenial: "GATEWAY_TOKEN_BUDGET" });
			}
		},
	);

	it("keeps the paired edit and passing test when a full closeout does not fit", async () => {
		const gateway = await gatewayFor("http://127.0.0.1:1", { ...baseLimits, maxTotalTokens: 6_000 });
		const task = { role: "user", content: "Keep the approved constraints." };
		const pair = (id: string, name: string, result: string) => [
			{ role: "assistant", tool_calls: [{ id, function: { name, arguments: "{}" } }] },
			{ role: "tool", tool_call_id: id, content: result },
		];
		const edit = pair("write", "edit", "Scoped edit completed");
		const test = pair("verification", "run_tests", '{"status":"passed","exitCode":0,"passed":1,"failed":0}');
		const messages = [
			task,
			...pair("lookup", "enhanced_docs_read", "Authorized output. ".repeat(200)),
			...edit,
			...test,
		];
		const body = {
			model: "deepseek-flash",
			stream: true,
			messages,
			tools: [{ type: "function", function: { name: "run_tests" } }],
		};
		const selected = applyEvaluationContextBudget(body, gateway.preview!, undefined, {
			publicPassId: "verification",
		});
		expect(selected.observation).toMatchObject({ mode: "text-closeout", afterDenial: null });
		expect(selected.selected.messages).toEqual([task, ...edit, ...test]);
		expect(applyEvaluationContextBudget(body, gateway.preview!, undefined, { publicPassId: "older" }).selected).toBe(
			body,
		);
		const unpaired = {
			...body,
			messages: messages.filter((m) => !("tool_call_id" in m) || m.tool_call_id !== "lookup"),
		};
		expect(
			applyEvaluationContextBudget(unpaired, gateway.preview!, undefined, { publicPassId: "verification" }).selected,
		).toBe(unpaired);
	});

	it("reserves the approved pytest tool for a host-requested read-only verification", async () => {
		const gateway = await gatewayFor("http://127.0.0.1:1", baseLimits);
		const body = {
			model: "deepseek-flash",
			stream: true,
			messages: [{ role: "user", content: "Keep the workspace unchanged and verify the baseline." }],
			tools: [
				{ type: "function", function: { name: "edit" } },
				{ type: "function", function: { name: "run_tests" } },
			],
		};
		const result = applyEvaluationContextBudget(body, gateway.preview!, undefined, { verifyReadOnly: true });
		expect(result.observation).toMatchObject({ mode: "test-only", beforeDenial: null, afterDenial: null });
		expect(result.selected).toMatchObject({
			messages: body.messages,
			tools: [body.tools[1]],
			tool_choice: { type: "function", function: { name: "run_tests" } },
		});
	});

	it("uses the last two read-only turns for verification and a text response with the evidence", async () => {
		const gateway = await gatewayFor("http://127.0.0.1:1", baseLimits);
		const pair = (id: string, name: string, content: string) => [
			{ role: "assistant", tool_calls: [{ id, function: { name, arguments: "{}" } }] },
			{ role: "tool", tool_call_id: id, content },
		];
		const task = { role: "user", content: "Verify without editing and report gaps in the available evidence." };
		const reference = pair("reference", "enhanced_docs_read", "A current authorized source.");
		const discovery = pair("workspace", "read", "Workspace discovery.");
		const tests = { type: "function", function: { name: "run_tests" } };
		const body = {
			model: "deepseek-flash",
			stream: true,
			messages: [task, ...reference, ...discovery],
			tools: [tests, { type: "function", function: { name: "enhanced_docs_read" } }],
		};
		const result = applyEvaluationContextBudget(body, gateway.preview!, undefined, {
			readOnly: true, readOnlyRequestsRemaining: 2,
		});
		expect(result.observation.mode).toBe("test-only");
		expect(result.selected.messages).toEqual([task, ...reference]);
		expect(result.selected.tools).toEqual([tests]);
		const pass = pair("pass", "run_tests", '{"status":"passed","exitCode":0,"passed":1,"failed":0}');
		const after = { ...body, messages: [...body.messages, ...pass] };
		const closeout = applyEvaluationContextBudget(after, gateway.preview!, undefined, {
			readOnly: true, readOnlyRequestsRemaining: 1, publicPassId: "pass",
		});
		expect(closeout.observation.mode).toBe("text-closeout");
		expect(closeout.selected.messages).toEqual([task, ...reference, ...pass]);
		expect(closeout.selected.tools).toBeUndefined();
		const unverifiable = applyEvaluationContextBudget(after, gateway.preview!, undefined, {
			readOnly: true, readOnlyRequestsRemaining: 1,
		});
		expect(unverifiable.observation.mode).toBe("full");
	});

	it.each(["passed", "failed", "older-passed", "unpaired", "parallel"])(
		"only drops tool declarations after a current, paired, passing pytest result (%s)",
		async (scenario) => {
			const gateway = await gatewayFor("http://127.0.0.1:1", { ...baseLimits, maxTotalTokens: 6_000 });
			const testStatus = scenario === "failed" ? "failed" : "passed";
			const messages = [
				{ role: "system", content: "Keep the task evidence." },
				{
					role: "assistant",
					tool_calls: [
						{ id: "test", function: { name: "run_tests", arguments: "{}" } },
						...(scenario === "parallel" ? [{ id: "other", function: { name: "edit", arguments: "{}" } }] : []),
					],
				},
				{
					role: "tool",
					tool_call_id: scenario === "unpaired" ? "other" : "test",
					content: JSON.stringify({
						status: testStatus,
						exitCode: testStatus === "passed" ? 0 : 1,
						passed: testStatus === "passed" ? 1 : 0,
						failed: testStatus === "passed" ? 0 : 1,
					}),
				},
				...(scenario === "older-passed" ? [{ role: "user", content: "Start another operation" }] : []),
			];
			const body = {
				model: "deepseek-flash",
				stream: true,
				messages,
				tools: [{ type: "function", function: { name: "read", description: "x".repeat(3_000), parameters: {} } }],
			};
			const { selected, observation } = applyEvaluationContextBudget(body, gateway.preview!);
			expect(observation.beforeDenial).toBe("GATEWAY_TOKEN_BUDGET");
			if (scenario === "passed") {
				expect(observation).toMatchObject({ mode: "text-closeout", afterDenial: null });
				expect(selected).not.toHaveProperty("tools");
				expect((selected.messages as unknown[]).slice(1)).toEqual(messages.slice(1));
			} else {
				expect(observation).toMatchObject({ mode: "full", afterDenial: "GATEWAY_TOKEN_BUDGET" });
				expect(selected).toBe(body);
			}
		},
	);
});

async function gatewayFor(
	upstreamBaseUrl: string,
	limits: BudgetGatewayLimits,
	options: Pick<Parameters<typeof startBudgetGateway>[0], "fetch" | "guardedClientRetry"> = {},
): Promise<RunningBudgetGateway> {
	const gateway = await startBudgetGateway({
		runId: "budget-gateway-test",
		upstreamBaseUrl,
		upstreamApiKey: "upstream-key",
		clientToken: "client-token",
		adminToken: "admin-token",
		allowedModel: "deepseek-flash",
		limits,
		pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
		...options,
	});
	running.push(gateway);
	return gateway;
}

async function callGateway(
	url: string,
	token: string,
	extra: Record<string, unknown> = {},
	model = "deepseek-flash",
): Promise<Response> {
	return fetch(`${url}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "test" }], stream: true, ...extra }),
	});
}

async function mockUpstream(
	handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = chunks.length
				? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
				: {};
			await handler(request, response, body);
		})();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("mock listen failed");
	const result = { url: `http://127.0.0.1:${address.port}`, close: () => close(server) };
	running.push(result);
	return result;
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe("evaluation continuation and request attribution", () => {
	it("warns at one request without blocking batched pytest and blocks edits after spending the last slot", async () => {
		const upstream = await mockUpstream(async (_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n',
			);
		});
		const gateway = await startBudgetGateway({
			runId: "evaluation-continuation",
			upstreamBaseUrl: upstream.url,
			upstreamApiKey: "upstream",
			clientToken: "client",
			adminToken: "admin",
			allowedModel: "deepseek-flash",
			limits: { ...baseLimits, maxRequests: 1, minOutputTokensPerRequest: 128 },
			pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
		});
		running.push(gateway);
		const status = gateway.status();
		expect(assessEvaluationContinuation("edit", "deepseek-flash", status, gateway.preview!)).toMatchObject({
			blocked: false,
			denial: null,
			tight: true,
			remainingRequests: 1,
			recommendedRequests: 2,
		});
		expect(assessEvaluationContinuation("run_tests", "deepseek-flash", status, gateway.preview!)).toMatchObject({
			blocked: false,
			denial: null,
		});
		expect(gateway.status()).toEqual(status);
		const response = await callGateway(gateway.url, "client");
		expect(response.ok).toBe(true);
		await response.text();
		const exhausted = gateway.status();
		expect(assessEvaluationContinuation("edit", "deepseek-flash", exhausted, gateway.preview!)).toMatchObject({
			blocked: true,
			denial: "GATEWAY_REQUEST_LIMIT",
			remainingRequests: 0,
		});
		expect(assessEvaluationContinuation("run_tests", "deepseek-flash", exhausted, gateway.preview!)).toMatchObject({
			blocked: false,
			denial: "GATEWAY_REQUEST_LIMIT",
		});
		expect(gateway.status()).toEqual(exhausted);
	});

	it("keeps pytest available when no next request fits and leaves restoration blocked", () => {
		const status = { limits: baseLimits, requestsStarted: 2 };
		const preview: NonNullable<RunningBudgetGateway["preview"]> = () => ({
			denial: "GATEWAY_TOKEN_BUDGET",
			diagnostics: {
				candidateReservedTokens: 4400,
				remainingTokenHeadroom: 3000,
			} as ReturnType<NonNullable<RunningBudgetGateway["preview"]>>["diagnostics"],
		});
		expect(assessEvaluationContinuation("run_tests", "stub", status, preview)).toMatchObject({
			blocked: false,
			denial: "GATEWAY_TOKEN_BUDGET",
		});
		expect(assessEvaluationContinuation("restore", "stub", status, preview)).toMatchObject({
			blocked: true,
			denial: "GATEWAY_TOKEN_BUDGET",
		});
	});

	it("attributes serialized requests without storing text or double-counting custom context", () => {
		const messages = [
			{ role: "system", content: "System" },
			{ role: "user", content: "First task" },
			{
				role: "assistant",
				tool_calls: [
					{ id: "m", function: { name: "enhanced_memory_search" } },
					{ id: "k", function: { name: "enhanced_docs_search" } },
					{ id: "t", function: { name: "run_tests" } },
				],
			},
			{ role: "tool", tool_call_id: "m", content: "known fact" },
			{ role: "tool", tool_call_id: "k", content: "authorized doc" },
			{ role: "tool", tool_call_id: "t", content: "test output" },
			{ role: "user", content: [{ type: "text", text: "当前任务摘要" }] },
			{ role: "user", content: "Resume task" },
		];
		const tools = [{ type: "function", function: { name: "run_tests" } }];
		const output = measureEvaluationContext(
			{ messages, tools },
			(text) => text.endsWith("task"),
			new Set(["当前任务摘要"]),
		);
		const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
		expect(output.components).toEqual({
			system: bytes(messages[0]),
			historyUser: bytes(messages[1]),
			historyAssistant: bytes(messages[2]),
			memory: bytes(messages[3]),
			rag: bytes(messages[4]),
			historyToolResult: bytes(messages[5]),
			contextInjection: bytes(messages[6]),
			currentTask: bytes(messages[7]),
			toolSchema: bytes(tools),
		});
		expect(Object.values(output.components).reduce((sum, value) => sum + value, output.envelopeBytes)).toBe(
			output.bytes,
		);
		expect(JSON.stringify(output)).not.toContain("authorized doc");
	});
});

it("reserves the E17 global ceiling before opening a cell and never reuses unresolved credit", () => {
	expect(canReserveE17Cell(0, 0, 0.12, 0.03)).toBe(true);
	expect(canReserveE17Cell(0.09, 0, 0.12, 0.03)).toBe(true);
	expect(canReserveE17Cell(0.090001, 0, 0.12, 0.03)).toBe(false);
	expect(canReserveE17Cell(0, 0.03, 0.12, 0.03)).toBe(false);
	expect(canReserveE17Cell(Number.NaN, 0, 0.12, 0.03)).toBe(false);
});
