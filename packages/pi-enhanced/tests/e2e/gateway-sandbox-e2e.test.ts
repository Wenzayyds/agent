import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBudgetGateway } from "../../benchmarks/real-agent/budget-gateway.ts";
import { gatewayModelsConfig, isolatedAgentEnvironment } from "../../benchmarks/real-agent/gateway-integration.ts";
import {
	close,
	dockerImageAvailable,
	type StubHandler,
	startStubProvider,
	textSse,
	toolCallSse,
} from "../fixtures/runner-support.ts";

const image = "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293";
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const cli = join(repositoryRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const dockerAvailable = dockerImageAvailable(image);
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.allSettled(closers.splice(0).map((close) => close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable || !existsSync(cli))("Batch H model gateway plus Docker tools", () => {
	it("routes every model turn through the budget gateway and every file operation through Docker", async () => {
		const providerBodies: Array<Record<string, unknown>> = [];
		const provider = await startProvider(async (body, response) => {
			providerBodies.push(body);
			const turn = providerBodies.length;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			if (turn === 1) {
				response.end(toolCallSse("write", { path: "fixed.txt", content: "fixed through docker\n" }, 120, 20));
			} else if (turn === 2) {
				response.end(toolCallSse("read", { path: "fixed.txt" }, 180, 20));
			} else {
				response.end(textSse("done", 220, 10));
			}
		});
		const clientToken = randomUUID().replaceAll("-", "");
		const gateway = await startBudgetGateway({
			runId: "batch-h-joint-e2e",
			upstreamBaseUrl: provider.url,
			upstreamApiKey: "mock-upstream-key",
			clientToken,
			adminToken: randomUUID().replaceAll("-", ""),
			allowedModel: "deepseek-flash",
			limits: {
				maxRequests: 4,
				maxTotalTokens: 200_000,
				maxTotalCostUsd: 0.1,
				maxConcurrency: 1,
				requestTimeoutMs: 30_000,
				maxOutputTokensPerRequest: 512,
				maxRequestBytes: 2 * 1024 * 1024,
			},
			pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
		});
		closers.push(() => gateway.close());

		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-h2-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const agentDir = join(root, "agent");
		const temp = join(root, "temp");
		mkdirSync(workspace);
		mkdirSync(agentDir);
		mkdirSync(temp);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(gatewayModelsConfig(gateway.url)));
		writeFileSync(
			join(agentDir, "pi-enhanced.json"),
			JSON.stringify({
				modules: {
					"mcp-policy": {
						enabled: false,
						defaultAction: "ask",
						rules: [],
						nativeToolGuard: { enabled: true, workspaceMutationAction: "allow", protectProjectMetadata: true },
					},
					memory: { enabled: false },
					context: { enabled: false },
					"task-manager": { enabled: false },
				},
			}),
		);

		const environment = isolatedAgentEnvironment(
			{ ...process.env, DEEPSEEK_API_KEY: "must-not-enter-child" },
			{
				providerApiKeyEnv: "DEEPSEEK_API_KEY",
				gatewayToken: clientToken,
				agentDir,
				tempDir: root,
				evaluation: {
					PI_ENHANCED_SANDBOX_ENABLED: "1",
					PI_ENHANCED_SANDBOX_TRUSTED: "1",
					PI_ENHANCED_SANDBOX_RUN_ID: "batch-h-joint-e2e",
					PI_ENHANCED_SANDBOX_WORKSPACE: workspace,
					PI_ENHANCED_SANDBOX_IMAGE: image,
				},
			},
		);
		const result = await run(cli, workspace, environment, [
			"--mode",
			"json",
			"--print",
			"--provider",
			"deepseek",
			"--model",
			"deepseek-flash",
			"--tools",
			"read,write",
			"--extension",
			join(repositoryRoot, "packages", "pi-enhanced", "extensions", "mcp-policy.ts"),
			"--extension",
			join(repositoryRoot, "packages", "pi-enhanced", "extensions", "sandbox.ts"),
			"--no-session",
			"--no-mcp",
			"--no-skills",
			"--no-context-files",
			"repair the fixture",
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).not.toContain("Extension error");
		expect(
			existsSync(join(workspace, "fixed.txt")),
			JSON.stringify({
				stderr: result.stderr.slice(-1_500),
				stdoutTail: result.stdout.slice(-2_000),
				providerTurns: providerBodies.length,
				gateway: gateway.status(),
			}),
		).toBe(true);
		expect(readFileSync(join(workspace, "fixed.txt"), "utf8")).toBe("fixed through docker\n");
		expect(providerBodies).toHaveLength(3);
		expect(JSON.stringify(providerBodies[1])).toContain("fixed through docker");
		expect(gateway.status()).toMatchObject({
			state: "ready",
			requestsStarted: 3,
			requestsCompleted: 3,
			actualInputTokens: 520,
			actualOutputTokens: 50,
			actualTotalTokens: 570,
		});
		expect(environment.DEEPSEEK_API_KEY).toBeUndefined();
	}, 120_000);
});

async function startProvider(handler: StubHandler) {
	const provider = await startStubProvider(handler);
	closers.push(() => close(provider.server));
	return provider;
}

async function run(
	file: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [file, ...args], {
			cwd,
			env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("close", (status) =>
			resolveRun({
				status,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		);
	});
}
