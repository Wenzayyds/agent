import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startBudgetGateway, type BudgetGatewayLimits, type RunningBudgetGateway } from "../../benchmarks/real-agent/budget-gateway.ts";

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
	it("forces the provider request through loopback, clamps output, and accounts usage", async () => {
		let seenAuthorization = "";
		let seenBody: Record<string, unknown> = {};
		const upstream = await mockUpstream(async (request, response, body) => {
			seenAuthorization = request.headers.authorization ?? "";
			seenBody = body;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\ndata: [DONE]\n\n');
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
		});
		const costLimited = await gatewayFor(upstream.url, { ...baseLimits, maxTotalCostUsd: 0.000001 });
		expect((await callGateway(costLimited.url, "client-token")).status).toBe(429);
		expect(costLimited.status().denials[0]?.code).toBe("GATEWAY_COST_BUDGET");
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
		expect(status.committedTokenUpperBound).toBeGreaterThan(0);
		expect(status.committedCostUpperBoundUsd).toBeGreaterThan(0);
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
	handler: (
		request: import("node:http").IncomingMessage,
		response: import("node:http").ServerResponse,
		body: Record<string, unknown>,
	) => Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
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
