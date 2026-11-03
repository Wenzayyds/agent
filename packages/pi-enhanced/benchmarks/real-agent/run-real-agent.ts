import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { LocalMemoryProvider } from "../../src/memory/provider.ts";
import { ensureProjectStorage } from "../../src/memory/storage.ts";
import { DockerSandboxBroker } from "../../src/sandbox/broker.ts";
import { loadSandboxConfig } from "../../src/sandbox/config.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import { startBudgetGateway, type BudgetGatewayStatus } from "./budget-gateway.ts";
import { budgetExceeded, buildEvaluationPlan, classifyExecution, executionOutcome, preflightView, redactEvaluationText, summarizeUsage } from "./evaluation-policy.ts";
import { gatewayEvidence, gatewayModelsConfig, isolatedAgentEnvironment } from "./gateway-integration.ts";
import { controlledCell, CONTROLLED_LIMITS, LONG_REPORT_TASK, longReport, MEMORY_RULE, MEMORY_TASK_PROMPT, TASK_STEPS } from "./controlled-cases.ts";

interface Task { id: string; category: string; prompt: string }
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const manifest = JSON.parse(readFileSync(join(here, "task-manifest.json"), "utf8")) as { tasks: Task[] };
const execute = process.argv.includes("--execute");
const localStubUrl = argument("--local-stub-url");
const cell = controlledCell(argument("--controlled-cell"));
const readonlyModuleTools = cell ? cell.treatment && cell.module !== "context" : process.argv.includes("--readonly-module-tools");
const taskId = cell?.taskId ?? argument("--task-id");
const selectedTasks = (taskId ? [...manifest.tasks, LONG_REPORT_TASK].filter((task) => task.id === taskId) : manifest.tasks).map((task) => cell?.module === "memory" ? { ...task, prompt: MEMORY_TASK_PROMPT } : task);
if (selectedTasks.length === 0) throw new Error("EVAL_UNKNOWN_TASK");
const input = {
	runId: argument("--run-id"), provider: argument("--provider"), model: argument("--model"), apiKeyEnv: argument("--api-key-env"),
	maxTotalCostUsd: argument("--max-total-cost-usd"), maxTasks: argument("--max-tasks"), maxTokensPerTask: argument("--max-tokens-per-task"),
	maxCallsPerTask: argument("--max-calls-per-task"), timeoutMs: argument("--timeout-ms"), concurrency: argument("--concurrency"),
	budgetEnforcement: argument("--budget-enforcement"), outputDir: argument("--output-dir"),
	sandboxImage: argument("--sandbox-image"),
};
if (process.argv.includes("--preflight")) {
	const repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
	process.stdout.write(`${JSON.stringify({ repositoryCommit, ...preflightView(input, manifest.tasks.length) }, null, 2)}\n`);
	process.exit(0);
}
if (localStubUrl) {
	if (!execute || process.env.PI_ENHANCED_LOCAL_STUB_EVAL !== "1" || !isLoopbackUrl(localStubUrl)) {
		throw new Error("EVAL_GATE_LOCAL_STUB_UNAUTHORIZED");
	}
}
if (execute && !localStubUrl) {
	const projectEnv = join(repositoryRoot, ".env");
	if (existsSync(projectEnv)) loadEnvFile(projectEnv);
}
const plan = execute ? buildEvaluationPlan(input, process.env) : undefined;
if (cell && plan && (plan.maxTasks !== 1 || plan.maxCallsPerTask > CONTROLLED_LIMITS.maxRequests || plan.maxTokensPerTask > CONTROLLED_LIMITS.maxTokens || plan.maxTotalCostUsd > CONTROLLED_LIMITS.maxCostUsd || plan.timeoutMs > CONTROLLED_LIMITS.timeoutMs)) throw new Error("EVAL_CONTROLLED_LIMIT_EXCEEDED");
const provider = plan?.provider; const model = plan?.model; const apiKeyEnv = plan?.apiKeyEnv;
const variant = cell?.variant ?? argument("--variant") ?? "baseline";
const condition = cell ? cell.id === "m_memory" ? "memory_seeded" : "cold" : argument("--condition") ?? "cold";
if (condition !== "cold" && condition !== "memory_seeded") throw new Error(`Unknown condition: ${condition}`);
const variants: Record<string, { memory: boolean; context: boolean; task: boolean }> = {
	baseline: { memory: false, context: false, task: false },
	"memory-only": { memory: true, context: false, task: false },
	"context-only": { memory: false, context: true, task: false },
	"task-only": { memory: false, context: false, task: true },
	"memory-context": { memory: true, context: true, task: false },
	full: { memory: true, context: true, task: true },
};
if (!variants[variant]) throw new Error(`Unknown ablation variant: ${variant}`);

const runOutput = plan ? resolve(plan.outputDir, plan.runId) : undefined;
if (runOutput && existsSync(runOutput)) throw new Error("EVAL_GATE_RUN_ID_ALREADY_EXISTS");
if (runOutput) mkdirSync(runOutput, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "pi-enhanced-real-agent-"));
mkdirSync(join(root, "temp"));
const results: Array<Record<string, unknown>> = [];
try {
	let observedCost = 0;
	for (const task of selectedTasks.slice(0, plan?.maxTasks ?? selectedTasks.length)) {
		const cwd = join(root, task.id); mkdirSync(cwd);
		generate(task.id, cwd); initGit(cwd);
		const initialVerifierPassed = verify(task.id, cwd);
		if (initialVerifierPassed) throw new Error(`Fixture ${task.id} is not initially failing`);
		const repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		if (!execute) {
			results.push({ taskId: task.id, category: task.category, experimentClass: "real_model_coding_agent_task", status: "not_run", reason: "explicit-model-authorization-required", fixtureInitiallyFailed: true, repositoryCommit });
			continue;
		}
		const agentDir = join(root, `${task.id}-agent`); mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", ...(cell ? { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } } : {}) }));
		const switches = variants[variant]!;
		writeFileSync(join(agentDir, "pi-enhanced.json"), JSON.stringify({ modules: {
			"mcp-policy": { enabled: false, defaultAction: "ask", rules: [], nativeToolGuard: { enabled: true, workspaceMutationAction: "allow", protectProjectMetadata: true } },
			memory: { enabled: switches.memory },
			context: { enabled: switches.context, mode: "select", memoryInjection: { enabled: switches.memory }, taskInjection: { enabled: switches.task }, ...(cell?.module === "context" ? { toolOutput: { enabled: cell.treatment, maximumTextCharacters: 2_000 } } : {}) },
			"task-manager": { enabled: switches.task },
		} }));
		const memorySeed = condition === "memory_seeded" && switches.memory ? await seedMemory(cwd, agentDir, cell ? MEMORY_RULE : undefined) : null;
		let seededTaskId: string | undefined;
		if (readonlyModuleTools && switches.task) {
			const service = new TaskService(new TaskProvider(createTaskStorageScope(createProjectScope({ cwd, agentDir }), agentDir)), 20);
			try { seededTaskId = service.create(task.prompt, cell ? TASK_STEPS : [{ title: "阅读实现并定位缺陷", expectedOutcome: "说明缺陷来源" }, { title: "最小修改", expectedOutcome: "公开 API 保持一致，不修改测试", dependsOn: [] }], "controlled-pilot-setup", null).task.taskId; }
			finally { service.close(); }
		}
		const moduleTools = readonlyModuleTools ? [...(switches.memory ? ["enhanced_memory_search"] : []), ...(switches.task ? ["enhanced_task_get"] : [])] : [];
		const prompt = task.prompt + (cell?.id === "m_inline" ? `\n项目规则：${MEMORY_RULE}` : "") + (cell?.id === "t_inline" ? `\n步骤计划：${JSON.stringify({ goal: task.prompt, steps: TASK_STEPS })}` : "") + (moduleTools.includes("enhanced_memory_search") ? " 可使用只读项目记忆搜索查阅 normalizeKey 项目约定。" : "") + (seededTaskId ? ` 任务计划 ID 为 ${seededTaskId}，可先用 enhanced_task_get 查询。` : "");
		const gatewayToken = randomUUID().replaceAll("-", "");
		const adminToken = randomUUID().replaceAll("-", "");
		const sandboxAuditPath = join(root, `${task.id}-sandbox-audit.json`);
		const contextReportPath = join(root, `${task.id}-context-audit.json`);
		const childEnvironment = isolatedAgentEnvironment(process.env, {
			providerApiKeyEnv: apiKeyEnv!, gatewayToken, agentDir, tempDir: root,
			evaluation: {
				PI_ENHANCED_EVAL_RUN_ID: plan!.runId,
				PI_ENHANCED_MAX_TOKENS_PER_TASK: String(plan!.maxTokensPerTask),
				PI_ENHANCED_MAX_CALLS_PER_TASK: String(plan!.maxCallsPerTask),
				PI_ENHANCED_MAX_TOTAL_COST_USD: String(plan!.maxTotalCostUsd),
				PI_ENHANCED_SANDBOX_ENABLED: "1", PI_ENHANCED_SANDBOX_TRUSTED: "1",
				PI_ENHANCED_SANDBOX_RUN_ID: `${plan!.runId.slice(0, 50)}-${task.id}`,
				PI_ENHANCED_SANDBOX_WORKSPACE: cwd,
				PI_ENHANCED_SANDBOX_IMAGE: plan!.sandboxImage,
				PI_ENHANCED_SANDBOX_REPORT_PATH: sandboxAuditPath,
				PI_ENHANCED_SANDBOX_READONLY_MODULE_TOOLS: readonlyModuleTools ? "1" : "0",
				PI_ENHANCED_CONTEXT_REPORT_PATH: contextReportPath,
			},
		});
		preflightSandbox(childEnvironment, cwd, root);
		const gateway = await startBudgetGateway({
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
		const cli = join(repositoryRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
		const extensionArgs = [
			"--extension", join(packageRoot, "extensions", "mcp-policy.ts"),
			"--extension", join(packageRoot, "extensions", "sandbox.ts"),
		];
		if (switches.memory) extensionArgs.push("--extension", join(packageRoot, "extensions", "memory.ts"));
		if (switches.context) extensionArgs.push("--extension", join(here, "context-probe.ts"));
		if (switches.task) extensionArgs.push("--extension", join(packageRoot, "extensions", "task-manager.ts"));
		const started = performance.now();
		let gatewayStatus: BudgetGatewayStatus;
		let child: Awaited<ReturnType<typeof runAgentProcess>>;
		try {
			child = await runAgentProcess(
				process.execPath,
				[cli, "--mode", "json", "--print", "--provider", provider!, "--model", model!, "--tools", ["read", "grep", "find", "ls", "write", "edit", ...moduleTools].join(","), ...extensionArgs, "--no-session", "--no-mcp", "--no-skills", "--no-context-files", prompt],
				{
					cwd,
					timeoutMs: plan!.timeoutMs,
					env: childEnvironment,
					...(cell ? { stopOnBoundaryFailure: () => { const status = gateway.status(); return status.state !== "ready" || status.requestsRejected > 0; } } : {}),
				},
			);
			gatewayStatus = gateway.status();
		} finally {
			gatewayStatus = gateway.status();
			if (cell) {
				const evidenceDir = join(runOutput!, task.id); mkdirSync(evidenceDir, { recursive: true });
				writeFileSync(join(evidenceDir, "gateway-final.json"), JSON.stringify(gatewayEvidence(gatewayStatus), null, 2));
			}
			await gateway.close();
			if (cell) {
				const prefix = `pi-enhanced-tools-${plan!.runId.slice(0, 50)}-${task.id}-`;
				const ids = execFileSync("docker", ["ps", "-a", "--filter", `name=^/${prefix}`, "--format", "{{.ID}}"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim().split(/\s+/u).filter(Boolean);
				for (const id of ids) { if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error("EVAL_SANDBOX_CLEANUP_ID_INVALID"); execFileSync("docker", ["rm", "-f", id], { timeout: 10_000, windowsHide: true, stdio: "ignore" }); }
			}
		}
		const agentReportedUsage = summarizeUsage(child.stdout ?? "");
		const usage = {
			calls: gatewayStatus.requestsStarted,
			tokens: gatewayStatus.actualTotalTokens,
			costUsd: gatewayStatus.actualCostUsd,
		};
		observedCost += gatewayStatus.actualCostUsd;
		const verifierPassed = verify(task.id, cwd);
		const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff"], { cwd, encoding: "utf8" });
		const sandboxAudit = cell && !existsSync(sandboxAuditPath) ? { evidence: null, audit: [], error: "EVAL_SANDBOX_AUDIT_MISSING" } : readSandboxAudit(sandboxAuditPath);
		const contextAudit = existsSync(contextReportPath) ? JSON.parse(readFileSync(contextReportPath, "utf8")) as Record<string, unknown> : { state: switches.context ? "missing" : "disabled", diagnostics: [] };
		const overBudget = budgetExceeded(usage, observedCost, plan!) || gatewayStatus.requestsRejected > 0;
		const timedOut = child.timedOut;
		const status = classifyExecution({ overBudget, timedOut, exitCode: child.status, verifierPassed });
		const outcome = executionOutcome({ overBudget: budgetExceeded(usage, observedCost, plan!), budgetRejected: gatewayStatus.requestsRejected > 0, gatewayFailed: gatewayStatus.state === "failed_closed", timedOut, exitCode: child.status, verifierPassed });
		const taskOutput = join(runOutput!, task.id); mkdirSync(taskOutput, { recursive: true });
		writeFileSync(join(taskOutput, "patch.diff"), patch);
		writeFileSync(join(taskOutput, "agent.stderr.log"), redactEvaluationText(child.stderr ?? "", [process.env[apiKeyEnv!]!]));
		const record = { taskId: task.id, category: task.category, experimentClass: localStubUrl ? "simulated_provider_real_runner_task" : "real_model_coding_agent_task", repositoryCommit, status, verifierPassed, hiddenTestExitCode: verifierPassed ? 0 : 1, agentExitCode: child.status, timedOut, usage, agentReportedUsage, gateway: gatewayEvidence(gatewayStatus), sandboxAudit, costClass: localStubUrl ? "simulated" : "gateway_measured", patchSha256: createHash("sha256").update(patch).digest("hex"), durationMs: Number((performance.now() - started).toFixed(3)) };
		const moduleToolEvents = (child.stdout ?? "").split(/\r?\n/u).flatMap((line) => { try { const event = JSON.parse(line) as Record<string, unknown>; return event.type === "tool_execution_end" && moduleTools.includes(String(event.toolName)) ? [{ toolName: event.toolName, isError: event.isError, result: event.result }] : []; } catch { return []; } });
		const moduleToolCalls = (child.stdout ?? "").split(/\r?\n/u).flatMap((line) => { try { const event = JSON.parse(line) as Record<string, unknown>; return event.type === "tool_execution_start" && moduleTools.includes(String(event.toolName)) ? [{ toolCallId: event.toolCallId, toolName: event.toolName, args: JSON.parse(redactEvaluationText(JSON.stringify(event.args ?? {}), [process.env[apiKeyEnv!]!])) as Record<string, unknown> }] : []; } catch { return []; } });
		const fileToolCalls = (child.stdout ?? "").split(/\r?\n/u).flatMap((line) => { try { const event = JSON.parse(line) as Record<string, unknown>; return event.type === "tool_execution_start" ? [{ toolName: event.toolName, args: event.args }] : []; } catch { return []; } });
		const toolFailures = (child.stdout ?? "").split(/\r?\n/u).flatMap((line) => { try { const event = JSON.parse(line) as Record<string, unknown>; return event.type === "tool_execution_end" && event.isError ? [{ toolName: event.toolName, result: event.result }] : []; } catch { return []; } });
		const classifiedRecord = { ...record, ...outcome, ...(cell ? { controlledCell: cell.id, moduleSwitches: switches, referenceHash: createHash("sha256").update(cell.module === "memory" ? MEMORY_RULE : cell.module === "task" ? JSON.stringify(TASK_STEPS) : longReport()).digest("hex"), retriesEnabled: false, fileToolCalls, toolFailures } : {}), memorySeed, moduleTools, moduleToolCalls, moduleToolEvents, contextEnabled: switches.context, contextAudit, usageSource: "local_hard_gateway", agentReportedUsageSource: "stdout_final_assistant_messages_diagnostic_only" };
		writeFileSync(join(taskOutput, "result.json"), `${JSON.stringify(classifiedRecord, null, 2)}\n`); results.push(classifiedRecord);
		writeFileSync(join(taskOutput, "sandbox-audit.json"), `${JSON.stringify(sandboxAudit, null, 2)}\n`);
		writeFileSync(join(taskOutput, "context-audit.json"), `${JSON.stringify(contextAudit, null, 2)}\n`);
		if (overBudget) break;
	}
	const ran = results.filter((item) => item.status !== "not_run");
	const outcomeSummary = { patchPassed: ran.filter((item) => item.patchStatus === "passed").length, normallyCompleted: ran.filter((item) => item.runStatus === "completed").length, budgetStopped: ran.filter((item) => item.runStatus === "budget_stopped").length };
	const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), evaluationClass: localStubUrl ? "simulated_provider_real_runner_task" : "real_model_coding_agent_task", runId: plan?.runId ?? null, variant, condition, model: execute ? { provider, model } : null, authorization: localStubUrl ? "local_stub_only" : execute ? "explicit" : "absent", sandbox: plan ? { mode: "docker-file-tools", image: plan.sandboxImage, tools: ["read", "grep", "find", "ls", "write", "edit"], network: "none", failClosed: true } : null, limits: plan ? { maxTotalCostUsd: plan.maxTotalCostUsd, maxTasks: plan.maxTasks, maxTokensPerTask: plan.maxTokensPerTask, maxCallsPerTask: plan.maxCallsPerTask, timeoutMs: plan.timeoutMs, concurrency: plan.concurrency, budgetEnforcement: plan.budgetEnforcement } : null, summary: { total: results.length, run: ran.length, passed: ran.filter((item) => item.status === "passed").length, notRun: results.length - ran.length, observedCostUsd: execute ? observedCost : 0 }, results };
	Object.assign(report.summary, outcomeSummary);
	if (!localStubUrl) writeFileSync(join(packageRoot, "docs", "p5-real-model-results.json"), `${JSON.stringify(report, null, 2)}\n`);
	if (runOutput) writeFileSync(join(runOutput, "run.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	process.stdout.write(`${JSON.stringify(report.summary)}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function isLoopbackUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && Boolean(parsed.port) && parsed.pathname === "/";
	} catch {
		return false;
	}
}
function readSandboxAudit(path: string): Record<string, unknown> {
	if (!existsSync(path)) throw new Error("EVAL_SANDBOX_AUDIT_MISSING");
	const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	if (!value.evidence || !Array.isArray(value.audit)) throw new Error("EVAL_SANDBOX_AUDIT_INVALID");
	return value;
}
function preflightSandbox(environment: NodeJS.ProcessEnv, cwd: string, runRoot: string): void {
	const broker = new DockerSandboxBroker(loadSandboxConfig(environment, cwd, runRoot));
	try {
		broker.start();
	} finally {
		broker.stop();
	}
}
async function runAgentProcess(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stopOnBoundaryFailure?: () => boolean }): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolveProcess) => {
		const child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = []; const stderr: Buffer[] = []; let size = 0; let timedOut = false;
		const collect = (target: Buffer[], chunk: Buffer) => { size += chunk.length; if (size <= 4 * 1024 * 1024) target.push(chunk); else child.kill(); };
		let pending = "";
		child.stdout.on("data", (chunk: Buffer) => {
			collect(stdout, chunk);
			if (options.stopOnBoundaryFailure) {
				pending += chunk.toString(); const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? "";
				for (const line of lines) { try { const event = JSON.parse(line) as Record<string, unknown>; if (event.type === "tool_execution_end" && event.isError && /SANDBOX_|Native tool guard blocked/u.test(JSON.stringify(event.result))) child.kill(); } catch {} }
			}
		}); child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		const boundaryTimer = options.stopOnBoundaryFailure ? setInterval(() => { if (options.stopOnBoundaryFailure?.()) child.kill(); }, 25) : undefined;
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
		child.once("close", (status) => { clearTimeout(timer); clearInterval(boundaryTimer); resolveProcess({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut }); });
		child.once("error", (error) => { clearTimeout(timer); clearInterval(boundaryTimer); stderr.push(Buffer.from(error.message)); resolveProcess({ status: null, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut }); });
	});
}
async function seedMemory(cwd: string, agentDir: string, controlledContent?: string): Promise<{ id: string; probeQuery: string; verifiedHits: number }> {
	const scope = createProjectScope({ cwd, agentDir }); ensureProjectStorage(scope); const provider = new LocalMemoryProvider(scope);
	try {
		const content = controlledContent ?? "项目约定：normalizeKey 必须 trim 后转成小写且不改变输入；validateItems 必须检查整个数组，不能只检查前十项。修改前阅读实现，保留公开 API，不修改测试。";
		const normalizedContent = content.normalize("NFKC").replace(/\s+/gu, " ").trim();
		const candidate = await provider.saveCandidate({ kind: "experience", content, normalizedContent, contentHash: createHash("sha256").update(normalizedContent).digest("hex"), source: { type: "user", ref: "controlled-ablation-seed", observedAt: Date.now() }, now: Date.now() });
		await provider.setStatus({ id: candidate.id, status: "verified", verification: { id: randomUUID(), type: "test_passed", evidenceRef: "controlled-ablation-fixture", evidenceVersion: "v1", verifiedAt: Date.now() }, expectedRevision: candidate.revision, now: Date.now() });
		const probeQuery = "normalizeKey";
		const records = await provider.search({ text: probeQuery, statuses: ["verified"] });
		if (!records.some((record) => record.id === candidate.id)) throw new Error("EVAL_MEMORY_SEED_NOT_SEARCHABLE");
		if (controlledContent) {
			for (const distractor of ["无关约定：formatName 仅用于显示名称。", "候选信息：normalizeKey 应保留首尾空格（未确认，不可用于参考）。"]) {
				const normalized = distractor.normalize("NFKC");
				await provider.saveCandidate({ kind: "experience", content: distractor, normalizedContent: normalized, contentHash: createHash("sha256").update(normalized).digest("hex"), source: { type: "test", ref: "controlled-distractor", observedAt: Date.now() }, now: Date.now() });
			}
		}
		return { id: candidate.id, probeQuery, verifiedHits: records.length };
	} finally { provider.close(); }
}
function initGit(cwd: string): void {
	execFileSync("git", ["init"], { cwd, stdio: "ignore" }); execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd }); execFileSync("git", ["config", "user.name", "Fixture"], { cwd }); execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["commit", "-m", "failing fixture"], { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
}
function generate(id: string, cwd: string): void {
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: "module", private: true }));
	if (id === LONG_REPORT_TASK.id) { writeFileSync(join(cwd, "diagnostics.txt"), longReport()); writeFileSync(join(cwd, "validate.js"), "export const validateItems = items => items.slice(0, 10).every(value => value >= 0);\n"); return; }
	const files: Record<string, Record<string, string>> = {
		"single-file-off-by-one": { "math.js": "export const sumTo = n => n * (n - 1) / 2;\n" },
		"cross-file-export": { "formatter.js": "const formatName = value => value.toUpperCase();\n", "index.js": "export { formatName } from './formatter.js';\n" },
		"config-default": { "config.js": "export const loadConfig = input => ({ timeoutMs: input.timeoutMs || 1000 });\n" },
		"long-output-localization": { "validate.js": "export const validateItems = items => items.slice(0, 10).every(value => value >= 0);\n" },
		"memory-guided-regression": { "key.js": "export const normalizeKey = value => value.trim();\n" },
	};
	for (const [name, content] of Object.entries(files[id]!)) writeFileSync(join(cwd, name), content);
}
function verify(id: string, cwd: string): boolean {
	if (id === LONG_REPORT_TASK.id) { if (readFileSync(join(cwd, "diagnostics.txt"), "utf8") !== longReport()) return false; id = "long-output-localization"; }
	const programs: Record<string, string> = {
		"single-file-off-by-one": "import('./math.js').then(m=>{if(m.sumTo(3)!==6)process.exit(1)})",
		"cross-file-export": "import('./index.js').then(m=>{if(m.formatName('pi')!=='PI')process.exit(1)}).catch(()=>process.exit(1))",
		"config-default": "import('./config.js').then(m=>{if(m.loadConfig({}).timeoutMs!==5000||m.loadConfig({timeoutMs:7}).timeoutMs!==7)process.exit(1)})",
		"long-output-localization": "import('./validate.js').then(m=>{if(m.validateItems([...Array(20).fill(1),-1])!==false)process.exit(1)})",
		"memory-guided-regression": "import('./key.js').then(m=>{const x='  PI ';if(m.normalizeKey(x)!=='pi'||x!=='  PI ')process.exit(1)})",
	};
	return spawnSync(process.execPath, ["--input-type=module", "-e", programs[id]!], { cwd, stdio: "ignore", timeout: 5_000 }).status === 0;
}
