import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerSandboxBroker } from "../../src/sandbox/broker.ts";
import { loadSandboxConfig } from "../../src/sandbox/config.ts";
import { type BudgetGatewayStatus, startBudgetGateway } from "./budget-gateway.ts";
import { verifyPatchInDocker } from "./docker-verifier.ts";
import { EvaluationTelemetry } from "./evaluation-telemetry.ts";
import { gatewayEvidence, gatewayModelsConfig, isolatedAgentEnvironment } from "./gateway-integration.ts";
import type { PreparedAgent, RunnerContext } from "./runner-preparation.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** Owns gateway/container/process lifetimes; no fixture generation or result interpretation. */
export async function executeAgent(context: RunnerContext, prepared: PreparedAgent) {
	const {
		task,
		root,
		packageRoot,
		repositoryRoot,
		runOutput,
		plan,
		cell,
		batchL,
		switches,
		readonlyModuleTools,
		telemetryEnabled,
		localStubUrl,
		authorization,
		offlinePolicy,
		observedCost,
	} = context;
	const { cwd, agentDir, seededTaskId, moduleTools, prompt } = prepared;
	const { provider, model, apiKeyEnv } = plan;
	const gatewayToken = randomUUID().replaceAll("-", "");
	const adminToken = randomUUID().replaceAll("-", "");
	const sandboxAuditPath = join(root, `${task.id}-sandbox-audit.json`);
	const contextReportPath = join(root, `${task.id}-context-audit.json`);
	const childEnvironment = isolatedAgentEnvironment(process.env, {
		providerApiKeyEnv: apiKeyEnv!,
		gatewayToken,
		agentDir,
		tempDir: root,
		evaluation: {
			PI_ENHANCED_EVAL_RUN_ID: plan!.runId,
			...(telemetryEnabled ? { PI_ENHANCED_EVALUATION_TELEMETRY: "1" } : {}),
			PI_ENHANCED_MAX_TOKENS_PER_TASK: String(plan!.maxTokensPerTask),
			PI_ENHANCED_MAX_CALLS_PER_TASK: String(plan!.maxCallsPerTask),
			PI_ENHANCED_MAX_TOTAL_COST_USD: String(plan!.maxTotalCostUsd),
			PI_ENHANCED_SANDBOX_ENABLED: "1",
			PI_ENHANCED_SANDBOX_TRUSTED: "1",
			PI_ENHANCED_SANDBOX_RUN_ID: `${plan!.runId.slice(0, 50)}-${task.id}`,
			PI_ENHANCED_SANDBOX_WORKSPACE: cwd,
			PI_ENHANCED_SANDBOX_IMAGE: plan!.sandboxImage,
			PI_ENHANCED_SANDBOX_REPORT_PATH: sandboxAuditPath,
			PI_ENHANCED_SANDBOX_READONLY_MODULE_TOOLS: readonlyModuleTools ? "1" : "0",
			PI_ENHANCED_CONTEXT_REPORT_PATH: contextReportPath,
			...(batchL
				? {
						PI_ENHANCED_BATCH_L_MEMORY: switches.memory ? "1" : "0",
						PI_ENHANCED_BATCH_L_TASK: switches.task ? "1" : "0",
						PI_ENHANCED_BATCH_L_TASK_ID: seededTaskId ?? "",
					}
				: {}),
		},
	});
	const verifierScope = preflightSandbox(childEnvironment, cwd, root);
	let telemetry: EvaluationTelemetry | undefined;
	if (telemetryEnabled) {
		const directory = join(runOutput!, task.id);
		mkdirSync(directory, { recursive: true });
		telemetry = new EvaluationTelemetry(
			plan!.runId,
			join(directory, "evaluation-telemetry.json"),
			cwd,
			verifierScope.runId,
		);
	}
	const gateway = await startBudgetGateway({
		...(telemetry ? { telemetry } : {}),
		runId: plan!.runId,
		upstreamBaseUrl: localStubUrl ?? "https://api.deepseek.com",
		upstreamApiKey: process.env[apiKeyEnv!]!,
		clientToken: gatewayToken,
		adminToken,
		allowedModel: model!,
		limits: {
			maxRequests: plan!.maxCallsPerTask,
			maxTotalTokens: plan!.maxTokensPerTask,
			maxTotalCostUsd: Math.max(0.01, plan!.maxTotalCostUsd - observedCost),
			maxConcurrency: 1,
			requestTimeoutMs: Math.min(plan!.timeoutMs, 120_000),
			maxOutputTokensPerRequest: Math.min(2_048, plan!.maxTokensPerTask),
			maxRequestBytes: 2 * 1024 * 1024,
		},
		pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
	});
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(gatewayModelsConfig(gateway.url)));
	if (cell) childEnvironment.PI_ENHANCED_CONTROLLED_GATEWAY_URL = gateway.url;
	const cli = join(repositoryRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
	const extensionArgs = [
		"--extension",
		join(packageRoot, "extensions", "mcp-policy.ts"),
		"--extension",
		join(packageRoot, "extensions", "sandbox.ts"),
	];
	if (cell)
		extensionArgs.push(
			"--extension",
			join(
				here,
				authorization
					? "batch-l-controlled-stop.ts"
					: offlinePolicy
						? "offline-controlled-stop.ts"
						: "controlled-stop.ts",
			),
		);
	if (switches.memory) extensionArgs.push("--extension", join(packageRoot, "extensions", "memory.ts"));
	if (switches.context) extensionArgs.push("--extension", join(here, "context-probe.ts"));
	if (batchL) extensionArgs.push("--extension", join(here, "batch-l-tools.ts"));
	else if (switches.task) extensionArgs.push("--extension", join(packageRoot, "extensions", "task-manager.ts"));
	const started = performance.now();
	let gatewayStatus: BudgetGatewayStatus;
	let child: Awaited<ReturnType<typeof runAgentProcess>>;
	try {
		child = await runAgentProcess(
			process.execPath,
			[
				cli,
				"--mode",
				"json",
				"--print",
				"--provider",
				provider!,
				"--model",
				model!,
				...(batchL ? ["--thinking", "off"] : []),
				"--tools",
				["read", "grep", "find", "ls", "write", "edit", ...moduleTools].join(","),
				...extensionArgs,
				"--no-session",
				"--no-mcp",
				"--no-skills",
				"--no-context-files",
				prompt,
			],
			{
				cwd,
				timeoutMs: plan!.timeoutMs,
				...(telemetry
					? {
							onEvent: (event: unknown) => telemetry!.event(event),
							onEventError: () => telemetry!.error("event_stream_incomplete"),
						}
					: {}),
				env: childEnvironment,
				...(cell
					? {
							stopOnBoundaryFailure: () => {
								const status = gateway.status();
								return status.state !== "ready" || status.requestsRejected > 0;
							},
						}
					: {}),
			},
		);
	} finally {
		gatewayStatus = gateway.status();
		if (cell) {
			const evidenceDir = join(runOutput!, task.id);
			mkdirSync(evidenceDir, { recursive: true });
			writeFileSync(
				join(evidenceDir, "gateway-final.json"),
				JSON.stringify(gatewayEvidence(gatewayStatus), null, 2),
			);
		}
		await gateway.close();
		if (cell) {
			const prefix = `pi-enhanced-tools-${plan!.runId.slice(0, 50)}-${task.id}-`;
			const ids = execFileSync("docker", ["ps", "-a", "--filter", `name=^/${prefix}`, "--format", "{{.ID}}"], {
				encoding: "utf8",
				timeout: 10_000,
				windowsHide: true,
			})
				.trim()
				.split(/\s+/u)
				.filter(Boolean);
			for (const id of ids) {
				if (!/^[a-f0-9]{12,64}$/u.test(id)) {
					// biome-ignore lint/correctness/noUnsafeFinally: Invalid Docker identities must fail closed during cleanup too.
					throw new Error("EVAL_SANDBOX_CLEANUP_ID_INVALID");
				}
				execFileSync("docker", ["rm", "-f", id], { timeout: 10_000, windowsHide: true, stdio: "ignore" });
			}
		}
	}
	const verification = await verifyPatchInDocker(task.id, verifierScope);
	return { child, gatewayStatus, verification, telemetry, sandboxAuditPath, contextReportPath, started };
}
export type AgentExecution = Awaited<ReturnType<typeof executeAgent>>;
function preflightSandbox(environment: NodeJS.ProcessEnv, cwd: string, runRoot: string) {
	const scope = loadSandboxConfig(environment, cwd, runRoot);
	const broker = new DockerSandboxBroker({ ...scope, auditReportPath: undefined });
	try {
		broker.start();
		return scope;
	} finally {
		broker.stop();
	}
}
async function runAgentProcess(
	file: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs: number;
		stopOnBoundaryFailure?: () => boolean;
		onEvent?: (value: unknown) => void;
		onEventError?: () => void;
	},
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolveProcess) => {
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let size = 0;
		let timedOut = false;
		let eventBuffer = "";
		const decoder = new TextDecoder();
		const collect = (target: Buffer[], chunk: Buffer) => {
			size += chunk.length;
			if (size <= 4 * 1024 * 1024) target.push(chunk);
			else child.kill();
		};
		child.stdout.on("data", (chunk: Buffer) => {
			collect(stdout, chunk);
			if (options.onEvent) {
				eventBuffer += decoder.decode(chunk, { stream: true });
				if (eventBuffer.length > 1024 * 1024) {
					options.onEventError?.();
					eventBuffer = "";
				}
				const lines = eventBuffer.split(/\r?\n/u);
				eventBuffer = lines.pop() ?? "";
				for (const line of lines) {
					try {
						options.onEvent(JSON.parse(line));
					} catch {
						options.onEventError?.();
					}
				}
			}
		});
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		const boundaryTimer = options.stopOnBoundaryFailure
			? setInterval(() => {
					if (options.stopOnBoundaryFailure?.()) child.kill();
				}, 25)
			: undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, options.timeoutMs);
		child.once("close", (status) => {
			clearTimeout(timer);
			clearInterval(boundaryTimer);
			resolveProcess({
				status,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
			});
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			clearInterval(boundaryTimer);
			stderr.push(Buffer.from(error.message));
			resolveProcess({
				status: null,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
			});
		});
	});
}
