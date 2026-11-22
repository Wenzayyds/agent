import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createKnowledgeExtension } from "../../src/knowledge/extension.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import { isKnowledgeTool, KNOWLEDGE_READ, KNOWLEDGE_SEARCH, knowledgeResultReferences } from "../../src/knowledge/tools.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import type { SandboxConfig } from "../../src/sandbox/config.ts";
import { createSandboxExtension } from "../../src/sandbox/extension.ts";
import { createPytestExecutor } from "../../src/sandbox/pytest.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { startBudgetGateway } from "../real-agent/budget-gateway.ts";
import { CONTROLLED_IMAGE } from "../real-agent/controlled-cases.ts";

const modelId = "deepseek-flash";
const reference = "protocol.md";
const source = "implementation.py";
const verifier = "test_contract.py";
const initial = '    return ""';
const cases = [
	{
		id: "exact-field",
		title: "Client header configuration",
		document: "The client header used for the release protocol is exactly `X-Quill-Trace`. The case and spelling are part of the protocol.",
		query: "client header",
		code: `def header_name():\n${initial}\n`,
		edit: '    return "X-Quill-Trace"',
		test: "from implementation import header_name\n\ndef test_header():\n    assert header_name() == 'X-Quill-Trace'\n",
		prompt: "修复 implementation.py 里的 header_name()，按项目发布协议返回精确的请求字段名。",
	},
	{
		id: "multilingual-diagnosis",
		title: "Retry failure policy 重试故障",
		document: "故障定位：连续失败达到 4 次或更高时进入 `cooldown`。失败次数小于 4 时返回 `retry`。The boundary includes exactly four failures.",
		query: "重试故障",
		code: `def retry_action(failures):\n${initial}\n`,
		edit: '    return "cooldown" if failures >= 4 else "retry"',
		test: "from implementation import retry_action\n\ndef test_boundary():\n    assert retry_action(3) == 'retry'\n    assert retry_action(4) == 'cooldown'\n    assert retry_action(5) == 'cooldown'\n",
		prompt: "修复 implementation.py 里的 retry_action(failures)。按故障手册实现重试与冷却的边界行为。",
	},
] as const;

const limits = {
	maxRequests: 16, maxTotalTokens: 64_000, maxTotalCostUsd: 0.03, maxConcurrency: 1,
	requestTimeoutMs: 25_000, maxOutputTokensPerRequest: 768, maxRequestBytes: 18_000,
};
const pricing = { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 };
const prompt = (task: (typeof cases)[number]) =>
	`${task.prompt} 参考资料是项目内的 protocol.md。可以用相对路径读取，也可以使用当前可用的文档检索工具。仅修改 implementation.py。完成后说明改动并引用参考资料，不要声称执行了测试。`;

const [mode, output] = process.argv.slice(2);
if (!output || !["--preflight", "--stub", "--real"].includes(mode) || process.argv.length !== 4)
	throw new Error("Usage: flash-comparison.ts --preflight|--stub|--real <new-output.json>");
if (mode === "--real" && !process.env.DEEPSEEK_API_KEY?.trim()) {
	writeFileSync(output, JSON.stringify({ status: "blocked_missing_credential", model: modelId, requests: 0 }), { flag: "wx" });
	throw new Error("DEEPSEEK_API_KEY is unavailable");
}
const plan = {
	model: modelId, reasoning: "off", limits, peakPricing: pricing, upstream: "https://api.deepseek.com",
	cases: cases.map((task) => ({
		id: task.id,
		inputSha256: createHash("sha256").update(JSON.stringify([prompt(task), task.code, task.title, task.document, task.test])).digest("hex"),
	})),
	cells: ["exact-field-off", "exact-field-on", "multilingual-diagnosis-on", "multilingual-diagnosis-off"],
};
if (mode === "--preflight") {
	writeFileSync(output, JSON.stringify({
		status: "preflight", plan, credentialConfigured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()), upstreamRequests: 0,
	}, null, 2), { flag: "wx" });
} else {
	await run(mode === "--stub", resolve(output));
}

function containerImage(name: string): string {
	const id = execFileSync("docker", ["image", "inspect", name, "--format", "{{.Id}}"], {
		encoding: "utf8", timeout: 10_000, windowsHide: true,
	}).trim();
	if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new Error("Unpinned local image");
	return id;
}

function stubSse(delta: Record<string, unknown>, usageId: number) {
	const request = {
		id: `chatcmpl-stub-${usageId}`, created: 1, model: modelId, object: "chat.completion.chunk",
	};
	const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
	const text = frame({ ...request, choices: [{ index: 0, delta, finish_reason: null }] }) +
		frame({ ...request, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] }) +
		frame({ ...request, choices: [], usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 } }) +
		"data: [DONE]\n\n";
	return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

async function run(stub: boolean, outputPath: string) {
	writeFileSync(outputPath, JSON.stringify({ status: "started", stub, plan }), { flag: "wx" });
	const docker = { tools: containerImage(CONTROLLED_IMAGE), pytest: containerImage("pi-enhanced-pytest:local") };
	const root = mkdtempSync(join(tmpdir(), "pi-ka-"));
	const clientToken = randomUUID();
	const adminToken = randomUUID();
	let stubTurn: (request: RequestInit | undefined) => Response = () => { throw new Error("No active Stub cell"); };
	const gateway = await startBudgetGateway({
		runId: `knowledge-${randomUUID()}`, allowedModel: modelId, limits, pricing, clientToken, adminToken,
		upstreamBaseUrl: "https://api.deepseek.com", upstreamApiKey: stub ? "mock-key" : process.env.DEEPSEEK_API_KEY!.trim(),
		fetch: stub ? async (_input, init) => stubTurn(init) : (input, init) => fetch(input, { ...init, redirect: "error" }),
	});
	const results: Array<Record<string, unknown>> = [];
	let completed = false;
	try {
		for (const [index, task] of cases.entries()) {
			for (const enabled of index === 0 ? [false, true] : [true, false]) {
				const id = `${task.id}-${enabled ? "on" : "off"}`;
				const cwd = join(root, `p${results.length}`);
				const agentDir = join(root, `a${results.length}`);
				mkdirSync(cwd);
				mkdirSync(agentDir);
				writeFileSync(join(cwd, source), task.code);
				writeFileSync(join(cwd, reference), `# ${task.title}\n\n${task.document}\n`);
				writeFileSync(join(cwd, verifier), task.test);
				writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({ modules: {
					knowledge: { enabled, mode: "lexical" },
				} }));
				let indexedId: string | undefined;
				if (enabled) {
					const { projectId } = createProjectScope({ cwd, agentDir });
					const knowledge = new KnowledgeService({
						projectId, filename: join(agentDir, "pi-enhanced", "knowledge", "projects", projectId, "knowledge.sqlite3"), mode: "lexical",
					});
					try { indexedId = (await knowledge.add(cwd, reference, "default", "allow-external")).documentId; }
					finally { await knowledge.close(); }
				}
				const workspace = lstatSync(cwd);
				const sandbox: SandboxConfig = {
					enabled: true, trusted: true, runId: `flash-${randomUUID()}`, runRoot: dirname(cwd), workspace: cwd,
					workspaceDevice: workspace.dev, workspaceInode: workspace.ino, image: docker.tools,
					containerOwner: randomUUID(), auditReportPath: join(root, `${id}.json`),
					readonlyKnowledgeTools: enabled, timeoutMs: 10_000, maxRequestBytes: 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024,
				};
				const settingsManager = SettingsManager.inMemory({
					compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
				});
				settingsManager.setProjectTrusted(true);
				const resourceLoader = new DefaultResourceLoader({
					cwd, agentDir, settingsManager, noExtensions: true,
					extensionFactories: [
						createKnowledgeExtension({ agentDir }),
						createSandboxExtension(sandbox, undefined, undefined, false, undefined, undefined, {
							reads: [source, reference], edits: [source],
						}),
					],
				});
				await resourceLoader.reload();
				const modelRuntime = await ModelRuntime.create({
					authPath: join(agentDir, "unused-auth.json"), modelsPath: null,
					modelsStorePath: join(agentDir, "catalog"), allowModelNetwork: false, refreshOnCreate: false,
				});
				await modelRuntime.setRuntimeApiKey("deepseek", clientToken);
				const model = { ...getModel("deepseek", modelId), baseUrl: gateway.url, maxTokens: limits.maxOutputTokensPerRequest };
				const { session } = await createAgentSession({
					cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model, thinkingLevel: "off",
					sessionManager: SessionManager.inMemory(cwd), tools: ["read", "edit", ...(enabled ? [KNOWLEDGE_SEARCH, KNOWLEDGE_READ] : [])],
				});
				let turn = 0;
				stubTurn = (request) => {
					const wire = JSON.parse(String(request?.body)) as { messages: unknown[]; thinking?: { type: string } };
					if (wire.thinking?.type !== "disabled") throw new Error("Unexpected reasoning mode");
					const sequence = ++turn;
					if (sequence > 1 && !JSON.stringify(wire.messages).includes(task.document))
						throw new Error("Reference evidence did not reach the Stub");
					const replies = [
						enabled ? { name: KNOWLEDGE_SEARCH, arguments: { query: task.query } } : { name: "read", arguments: { path: reference } },
						{ name: "edit", arguments: { path: source, edits: [{ oldText: initial, newText: task.edit }] } },
					];
					const reply = replies[sequence - 1];
					return stubSse(reply ? { tool_calls: [{ index: 0, id: `call-${sequence}`, type: "function",
						function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }] }
						: { content: "已按 protocol.md 修复。" }, sequence);
				};
				const started = performance.now();
				const before = gateway.status();
				try {
					await session.bindExtensions({});
					await session.prompt(prompt(task));
					const agentElapsedMs = performance.now() - started;
					const responses = session.messages.filter((message) => message.role === "assistant");
					const last = responses.at(-1);
					const tools = session.messages.flatMap((message) =>
						message.role === "toolResult" ? [{ tool: message.toolName, error: message.isError }] : []);
					const sourceRead = session.messages.some((message) => {
						if (message.role !== "toolResult" || message.isError) return false;
						if (message.toolName === "read") return JSON.stringify(message.content).includes(task.document);
						return indexedId !== undefined && isKnowledgeTool(message.toolName) && knowledgeResultReferences({ ...message, toolName: message.toolName })?.some((item) => item.disclosure?.documentId === indexedId);
					});
					const verify = createPytestExecutor(sandbox, { image: docker.pytest, files: [source, verifier], tests: [verifier] });
					const test = await verify([verifier]);
					const status = gateway.status();
					results.push({
						id, tools, stopReason: last?.stopReason, providerError: last?.errorMessage,
						verification: test, citationCorrect: sourceRead && (session.getLastAssistantText()?.includes(reference) ?? false),
						modelAnswer: session.getLastAssistantText(), agentElapsedMs, elapsedMs: performance.now() - started,
						requests: status.requestsStarted - before.requestsStarted,
						inputTokens: status.actualInputTokens - before.actualInputTokens,
						outputTokens: status.actualOutputTokens - before.actualOutputTokens,
						peakCostUpperEstimateUsd: status.actualCostUsd - before.actualCostUsd,
					});
					if (last?.stopReason === "error" || status.state !== "ready") throw new Error("Model request failed or gateway stopped");
					if (stub && (test.status !== "passed" || tools.some(({ error }) => error) ||
						!tools.some(({ tool }) => tool === (enabled ? KNOWLEDGE_SEARCH : "read"))))
						throw new Error("Stub comparison cell failed");
				} finally {
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
					session.dispose();
				}
			}
		}
		completed = true;
	} finally {
		await gateway.close();
		writeFileSync(outputPath, JSON.stringify({
			status: completed ? "complete" : "stopped", stub, plan, docker, results, gateway: gateway.finalStatus?.(),
		}, null, 2));
		rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
	}
}
