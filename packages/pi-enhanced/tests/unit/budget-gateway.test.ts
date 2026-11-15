import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BudgetGatewayLimits,
	type RunningBudgetGateway,
	startBudgetGateway,
} from "../../benchmarks/real-agent/budget-gateway.ts";
import { finalizeAgentExecution } from "../../benchmarks/real-agent/runner-cleanup.ts";

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
			expect(body).toMatchObject({ model: "deepseek-v4-pro", max_tokens: 2048, stream_options: { include_usage: true } });
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\ndata: [DONE]\n\n');
		});
		const limits = { ...baseLimits, maxRequests: 20, maxTotalTokens: 200_000, maxTotalCostUsd: 0.4, maxOutputTokensPerRequest: 2048, maxRequestBytes: 300_000 };
		const proGateway = async (overrides: Partial<BudgetGatewayLimits> = {}, upstreamBaseUrl = upstream.url) => {
			const gateway = await startBudgetGateway({
				runId: "swe-pro-off-test", upstreamBaseUrl, upstreamApiKey: "upstream-key",
				clientToken: "client-token", adminToken: "admin-token", allowedModel: "deepseek-v4-pro",
				limits: { ...limits, ...overrides }, pricing: { inputUsdPerMillion: 1.32, outputUsdPerMillion: 3.96 },
			});
			running.push(gateway);
			return gateway;
		};
		const gateway = await proGateway();
		expect((await callGateway(gateway.url, "client-token", { max_tokens: 9999 }, "deepseek-flash")).status).toBe(400);
		expect((await callGateway(gateway.url, "client-token", { max_tokens: 9999 }, "deepseek-v4-pro")).status).toBe(200);
		expect(forwarded).toBe(1);
		expect(gateway.status()).toMatchObject({ requestsStarted: 1, requestsCompleted: 1, actualTotalTokens: 110, state: "ready" });
		expect(gateway.status().actualCostUsd).toBeCloseTo(0.0001716, 9);
		const tokenLimited = await proGateway();
		expect((await callGateway(tokenLimited.url, "client-token", { messages: [{ role: "user", content: "a".repeat(200_000) }] }, "deepseek-v4-pro")).status).toBe(429);
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
				formulaVersion: "utf8_bytes_plus4096_v1",
				requestBodyBytes: Buffer.byteLength(
					JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "test" }], stream: true }),
				),
				inputTokenUpperBound:
					Buffer.byteLength(
						JSON.stringify({
							model: "deepseek-flash",
							messages: [{ role: "user", content: "test" }],
							stream: true,
						}),
					) + 4096,
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
});

async function gatewayFor(upstreamBaseUrl: string, limits: BudgetGatewayLimits): Promise<RunningBudgetGateway> {
	const gateway = await startBudgetGateway({
		runId: "budget-gateway-test",
		upstreamBaseUrl,
		upstreamApiKey: "upstream-key",
		clientToken: "client-token",
		adminToken: "admin-token",
		allowedModel: "deepseek-flash",
		limits,
		pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
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
