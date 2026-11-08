import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicPrivateJson } from "../../src/sandbox/audit.ts";
import { DockerSandboxBroker } from "../../src/sandbox/broker.ts";
import { assertSandboxWorkspaceIdentity, loadSandboxConfig } from "../../src/sandbox/config.ts";
import { TASK_PAIR_CONFIGURATION, TASK_PAIR_PROFILE } from "./batch-l-profile.ts";
import { type BudgetGatewayStatus, startBudgetGateway } from "./budget-gateway.ts";
import { verifyPatchInDocker } from "./docker-verifier.ts";
import { digest } from "./evaluation-identity.ts";
import { EvaluationTelemetry } from "./evaluation-telemetry.ts";
import { gatewayEvidence, gatewayModelsConfig, isolatedAgentEnvironment } from "./gateway-integration.ts";
import type { PreparedAgent, RunnerContext } from "./runner-preparation.ts";
import { SWE_TASK_PROFILE } from "./swe-profile.ts";
import { readTaskPairInput } from "./task-pair-authorization.ts";

const here = dirname(fileURLToPath(import.meta.url));
export function stubPidHandshakeEnabled(flag: string | undefined, localStubUrl: string | undefined, swe: boolean, stubEval: string | undefined): boolean {
	if (flag !== "1") return false;
	if (!localStubUrl || !swe || stubEval !== "1") throw new Error("SWE_STUB_PID_HANDSHAKE_FORBIDDEN");
	return true;
}

function inside(parent: string, target: string): boolean {
	const rel = relative(parent, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function linuxStartTicks(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const ticks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
	if (!ticks || !/^\d+$/u.test(ticks)) throw new Error("SWE_STUB_PID_HANDSHAKE_IDENTITY_INVALID");
	return ticks;
}

function writePidHandshake(path: string, value: unknown): void {
	const payload = `${JSON.stringify(value)}\n`;
	if (process.platform !== "linux") {
		writeFileSync(path, payload, { flag: "wx", mode: 0o600 });
		return;
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, payload, { flag: "wx", mode: 0o600 });
	try {
		linkSync(temporary, path); // Exclusive and visible only after the full payload is written.
	} finally {
		rmSync(temporary, { force: true });
	}
}
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
	const pidHandshake = stubPidHandshakeEnabled(
		process.env.PI_ENHANCED_SWE_STUB_PID_HANDSHAKE,
		localStubUrl,
		Boolean(task.swebench),
		process.env.PI_ENHANCED_LOCAL_STUB_EVAL,
	);
	const handshakeNonce = process.env.PI_ENHANCED_SWE_STUB_PID_NONCE;
	if (pidHandshake && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(handshakeNonce ?? ""))
		throw new Error("SWE_STUB_PID_HANDSHAKE_NONCE_INVALID");
	const controlled = Boolean(cell || task.swebench);
	const { provider, model, apiKeyEnv } = plan;
	const taskPair = context.comparisonProfile === TASK_PAIR_PROFILE;
	if (
		(taskPair || context.comparisonProfile === SWE_TASK_PROFILE) &&
		!localStubUrl &&
		(!context.taskPairAuthorization || !context.taskPairExpected)
	)
		throw new Error("TASK_PAIR_REAL_AUTHORIZATION_REQUIRED");
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
			PI_ENHANCED_SANDBOX_READONLY_MODULE_TOOLS: readonlyModuleTools || (task.swebench && switches.task) ? "1" : "0",
			...(task.swebench && context.taskMode === "v2" ? { PI_ENHANCED_SANDBOX_TASK_PLAN_TOOL: "1" } : {}),
			PI_ENHANCED_CONTEXT_REPORT_PATH: contextReportPath,
			...(task.swebench ? { PI_ENHANCED_SWE_INPUT_AUDIT_ONLY: "1" } : {}),
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
	if (taskPair) {
		const initialVerification = await verifyPatchInDocker(task.id, verifierScope);
		const directory = join(runOutput, task.id);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "initial-verification.json"), JSON.stringify(initialVerification, null, 2));
		if (initialVerification.status !== "verification_failed" || initialVerification.cleanup !== "removed")
			throw new Error("SANDBOX_TASK_PAIR_INITIAL_VERIFICATION_UNEXPECTED");
	}
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
	let handshakePath: string | undefined;
	if (pidHandshake) {
		const output = realpathSync(runOutput);
		const workspace = realpathSync(cwd);
		const temporary = realpathSync(tmpdir());
		const evidenceDir = join(runOutput, task.id);
		if (
			!inside(temporary, output) ||
			inside(workspace, output) ||
			inside(output, workspace) ||
			lstatSync(runOutput).isSymbolicLink() ||
			lstatSync(evidenceDir).isSymbolicLink() ||
			realpathSync(evidenceDir) !== join(output, task.id)
		)
			throw new Error("SWE_STUB_PID_HANDSHAKE_PATH_INVALID");
		handshakePath = join(evidenceDir, "agent-spawn-pid.json");
	}
	let forwarded = 0;
	let admissionDenied = false;
	const gatedFetch: typeof fetch = (input, init) => {
		const evidencePath = join(runOutput, task.id, "input-admission.json");
		try {
			if (context.taskPairAuthorization && Date.parse(context.taskPairAuthorization.expiresAt) <= Date.now())
				throw new Error("TASK_PAIR_INPUT_AUTHORIZATION_EXPIRED");
			if (forwarded === 0) {
				const audit = JSON.parse(readFileSync(join(root, "batch-l-input-audit.json"), "utf8"));
				if (
					typeof init?.body !== "string" ||
					audit.userPromptSha256 !== digest(prompt) ||
					audit.model !== model ||
					audit.provider !== provider ||
					audit.thinking !== TASK_PAIR_CONFIGURATION.thinking
				)
					throw new Error("TASK_PAIR_INPUT_AUDIT_INVALID");
				const wire = JSON.parse(init.body);
				if (wire.model !== model || wire.max_tokens !== TASK_PAIR_CONFIGURATION.maxOutputTokens)
					throw new Error("TASK_PAIR_INPUT_WIRE_INVALID");
				// Only the system message may contain the ephemeral project root. Keep user text and tools exact.
				for (const message of wire.messages) {
					if (message.role === "system")
						message.content = JSON.parse(
							JSON.stringify(message.content)
								.replaceAll(JSON.stringify(cwd).slice(1, -1), "[PROJECT_ROOT]")
								.replaceAll(cwd.replaceAll("\\", "/"), "[PROJECT_ROOT]"),
						);
				}
				const observed = readTaskPairInput({
					fixtureSha256: prepared.inputFixtureHash,
					fixtureCommit: prepared.repositoryCommit,
					userPromptSha256: audit.userPromptSha256,
					systemPromptSha256: audit.canonicalSystemPromptSha256,
					toolSchemaSha256: audit.toolSchemaSha256,
					firstRequestSha256: digest(wire),
				});
				if (context.taskPairExpected && !isDeepStrictEqual(observed, context.taskPairExpected))
					throw new Error("TASK_PAIR_INPUT_FINGERPRINT_MISMATCH");
				atomicPrivateJson(evidencePath, {
					status: context.taskPairExpected ? "matched" : "stub_capture",
					runId: plan.runId,
					input: observed,
				});
			}
		} catch (error) {
			admissionDenied = true;
			atomicPrivateJson(evidencePath, {
				status: "denied",
				runId: plan.runId,
				upstreamForwarded: false,
				previouslyForwarded: forwarded,
				reason:
					error instanceof Error && error.message.startsWith("TASK_PAIR_INPUT_")
						? error.message
						: "TASK_PAIR_INPUT_EVIDENCE_INVALID",
			});
			throw new Error("TASK_PAIR_INPUT_ADMISSION_FAILED");
		}
		forwarded++;
		return globalThis.fetch(input, init);
	};
	const gateway = await startBudgetGateway({
		// The gateway has reserved a request at this point. A local veto is recorded only in input-admission.json.
		get telemetry() {
			return admissionDenied ? undefined : telemetry;
		},
		...(taskPair || task.swebench ? { fetch: gatedFetch } : {}),
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
	if (controlled) childEnvironment.PI_ENHANCED_CONTROLLED_GATEWAY_URL = gateway.url;
	const cli = join(repositoryRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
	const extensionArgs = [
		"--extension",
		join(packageRoot, "extensions", "mcp-policy.ts"),
		"--extension",
		join(packageRoot, "extensions", "sandbox.ts"),
	];
	if (controlled)
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
	if (task.swebench) extensionArgs.push("--extension", join(here, "batch-l-tools.ts"));
	const started = performance.now();
	let gatewayStatus: BudgetGatewayStatus;
	let child: Awaited<ReturnType<typeof runAgentProcess>>;
	let handshakeError: Error | undefined;
	let containersRemoved = false;
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
				...(batchL || task.swebench ? ["--thinking", "off"] : []),
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
				...(handshakePath
					? {
							onSpawn: (pid: number | undefined) => {
								try {
									if (!pid) throw new Error("SWE_STUB_PID_HANDSHAKE_CHILD_MISSING");
									writePidHandshake(
										handshakePath,
										{ runId: plan.runId, runnerPid: process.pid, agentPid: pid, nonce: handshakeNonce, startTicks: process.platform === "linux" ? linuxStartTicks(pid) : null, runnerStartTicks: process.platform === "linux" ? linuxStartTicks(process.pid) : null },
									);
								} catch (error) {
									handshakeError = error instanceof Error ? error : new Error(String(error));
									throw handshakeError;
								}
							},
						}
					: {}),
				...(telemetry
					? {
							onEvent: (event: unknown) => telemetry!.event(event),
							onEventError: () => telemetry!.error("event_stream_incomplete"),
						}
					: {}),
				env: childEnvironment,
				...(controlled
					? {
							stopOnBoundaryFailure: () => {
								const status = gateway.status();
								return status.state !== "ready" || status.requestsRejected > 0;
							},
						}
					: {}),
			},
		);
		if (handshakeError) throw handshakeError;
	} finally {
		gatewayStatus = gateway.status();
		if (controlled && !admissionDenied) {
			const evidenceDir = join(runOutput!, task.id);
			mkdirSync(evidenceDir, { recursive: true });
			writeFileSync(
				join(evidenceDir, "gateway-final.json"),
				JSON.stringify(gatewayEvidence(gatewayStatus), null, 2),
			);
		}
		await gateway.close();
		if (controlled) {
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
			containersRemoved =
				execFileSync("docker", ["ps", "-a", "--filter", `name=^/${prefix}`, "--format", "{{.ID}}"], {
					encoding: "utf8",
					timeout: 10_000,
					windowsHide: true,
				}).trim() === "";
		}
	}
	if (admissionDenied) throw new Error("TASK_PAIR_INPUT_ADMISSION_FAILED");
	if ((taskPair || task.swebench) && forwarded === 0) throw new Error("TASK_PAIR_INPUT_NO_REQUEST");
	let childAbsent = false;
	if (child.pid) {
		try {
			process.kill(child.pid, 0);
		} catch (error) {
			childAbsent = (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	}
	let workspaceIdentityValid = false;
	try {
		assertSandboxWorkspaceIdentity(verifierScope);
		workspaceIdentityValid = true;
	} catch {}
	const hostLifecycle = {
		childClosed: child.closed,
		childAbsent,
		containersRemoved,
		workspaceIdentityValid,
		gatewayClosed: true,
		gatewayActiveRequests: gatewayStatus.activeRequests,
		reservedTokens: gatewayStatus.reservedTokens,
		reservedCostUsd: gatewayStatus.reservedCostUsd,
	};
	const verification = task.swebench ? null : await verifyPatchInDocker(task.id, verifierScope);
	return {
		child,
		hostLifecycle,
		gatewayStatus,
		verification,
		telemetry,
		sandboxAuditPath,
		contextReportPath,
		started,
		workspaceScope: verifierScope,
	};
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
		onSpawn?: (pid: number | undefined) => void;
	},
): Promise<{
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	pid?: number;
	closed: boolean;
}> {
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
			// A SIGSTOPped Linux child cannot handle SIGTERM until it resumes.
			if (process.platform === "linux") child.kill("SIGCONT");
			child.kill();
		}, options.timeoutMs);
		child.once("close", (status) => {
			clearTimeout(timer);
			clearInterval(boundaryTimer);
			resolveProcess({
				status,
				pid: child.pid,
				closed: true,
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
				pid: child.pid,
				closed: false,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
			});
		});
		if (options.onSpawn) {
			try {
				options.onSpawn(child.pid);
			} catch {
				child.kill();
			}
		}
	});
}
