import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createHarness, createTestUiContext, getMessageText, getToolResult } from "../../../coding-agent/test/suite/harness.ts";
import { createContextExtension } from "../../src/context/extension.ts";
import { createKnowledgeExtension } from "../../src/knowledge/extension.ts";
import { KNOWLEDGE_READ, KNOWLEDGE_SEARCH } from "../../src/knowledge/tools.ts";
import { createMemoryExtension } from "../../src/memory/extension.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { openMemoryService } from "../../src/memory/service.ts";
import { createSandboxExtension, sandboxToolAllowed } from "../../src/sandbox/extension.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import type { TaskSnapshot } from "../../src/task-manager/contracts.ts";
import { createTaskManagerExtension } from "../../src/task-manager/extension.ts";
import { sandboxConfigForTesting } from "../fixtures/runner-support.ts";

const image = process.env.PI_TEST_PYTEST_IMAGE;
const testFile = "test_calc.py";
const fileSource = "def inc(n):\n    return n\n";
const suiteSource = "from calc import inc\n\ndef test_inc():\n    assert inc(4) == 5\n";
const prior = "The calculator previously failed its increment check.";
const contract = "The calculator contract requires inc(n) to return n + 1.";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

it("requires a separate trusted Sandbox opt-in for the two Knowledge reads", () => {
	for (const name of [KNOWLEDGE_READ, KNOWLEDGE_SEARCH]) {
		expect(sandboxToolAllowed(name, true, true, true)).toBe(false);
		expect(sandboxToolAllowed(name, true, true, true, true)).toBe(true);
	}
	expect(sandboxToolAllowed("enhanced_docs_add", true, true, true, true)).toBe(false);
});

it.runIf(Boolean(image))("B4 Stub Model, persisted pause/resume, Knowledge, Memory and validated Docker pytest", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-b4-"));
	const project = join(root, "p");
	const agentDir = join(root, "a");
	mkdirSync(project);
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({
		modules: {
			"task-manager": { enabled: true, mode: "v1", contextSummary: true, modelPlanTool: false },
			memory: { enabled: true },
			knowledge: { enabled: true, mode: "lexical" },
			context: { enabled: true, mode: "select", taskInjection: { enabled: true },
				toolOutput: { enabled: true, offload: true, maximumTextCharacters: 600 } },
		},
	}));
	writeFileSync(join(project, "calc.py"), fileSource);
	writeFileSync(join(project, testFile), suiteSource);
	const document = join(root, "calculator.md");
	writeFileSync(document, `# Calculator contract\n\n${contract}\n`);
	const hosts: Awaited<ReturnType<typeof createHarness>>[] = [];
	const audits: string[] = [];
	const shutdown = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		hosts.splice(hosts.indexOf(harness), 1);
	};
	const open = async (sessionManager: SessionManager, phase: "before" | "after") => {
		const path = join(root, `sandbox-${phase}.json`);
		audits.push(path);
		const notes: string[] = [];
		const harness = await createHarness({
			cwd: project, sessionManager,
			extensionFactories: [
				createTaskManagerExtension({ agentDir }),
				createMemoryExtension({ agentDir }),
				createKnowledgeExtension({ agentDir }),
				createContextExtension({ agentDir }),
				createSandboxExtension((workspace) => sandboxConfigForTesting({
					workspace, runId: `b4-${randomUUID().slice(0, 12)}`, containerOwner: randomUUID(),
					auditReportPath: path, readonlyModuleTools: true, readonlyKnowledgeTools: true,
				}), undefined, { image, files: ["calc.py", testFile], tests: [testFile] }),
			],
		});
		hosts.push(harness);
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({
			notify: (text) => notes.push(text), confirm: async () => true,
		}) });
		const invoke = async <T>(command: string, args: string): Promise<T> => {
			const count = notes.length;
			await harness.session.prompt(`/${command} ${args}`);
			expect(notes.length).toBeGreaterThan(count);
			return JSON.parse(notes.at(-1)!) as T;
		};
		return { harness, invoke };
	};
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	const tools = (harness: Awaited<ReturnType<typeof createHarness>>) =>
		harness.eventsOfType("tool_execution_start").map(({ toolName }) => toolName);

	try {
		const memory = await openMemoryService(createProjectScope({ cwd: project, agentDir }));
		try {
			const source = "prior.txt";
			writeFileSync(join(project, source), prior);
			const candidate = await memory.saveCandidate({
				kind: "fact", type: "semantic", content: prior, source: { type: "file", ref: source },
			});
			await memory.verifyFileFact(candidate.id, { relativePath: source, exactExcerpt: prior }, candidate.revision);
		} finally {
			await memory.close();
		}

		const manager = SessionManager.create(project, join(root, "sessions"));
		const first = await open(manager, "before");
		const created = await first.invoke<TaskSnapshot>("enhanced-task-create", JSON.stringify({
			goal: "Implement the documented calculator contract",
			steps: [{ stepId: "repair", title: "Fix calc.py", expectedOutcome: "the approved pytest passes",
				validation: { kind: "pytest", target: testFile, expectedSha256: sha256(suiteSource) } }],
		}));
		const taskId = created.task.taskId;
		await first.invoke("enhanced-task-approve", `${taskId} ${created.task.revision}`);
		await first.invoke("enhanced-task-step", `${taskId} repair bind`);
		await first.invoke("enhanced-task-step", `${taskId} repair start 1`);
		await first.invoke("enhanced-docs", `add --allow-external ${JSON.stringify([document])}`);

		first.harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(`taskId=${taskId}`);
				expect(JSON.stringify(context.messages)).toContain("Implement the documented calculator contract");
				return call("enhanced_task_get", { taskId });
			},
			call("enhanced_memory_search", { query: "calculator previously failed" }),
			call("run_tests", { targets: [testFile] }),
			fauxAssistantMessage("The approved pytest found the broken increment."),
		]);
		await first.harness.session.prompt("Inspect the active task and prior failure, then run the approved pytest.");
		const taskResult = getToolResult(first.harness, "enhanced_task_get");
		expect(taskResult.isError, getMessageText(taskResult)).toBe(false);
		const memoryResult = getToolResult(first.harness, "enhanced_memory_search");
		expect(memoryResult.isError, getMessageText(memoryResult)).toBe(false);
		expect(getMessageText(memoryResult)).toContain(prior);
		const failed = getToolResult(first.harness, "run_tests");
		expect(JSON.parse(getMessageText(failed))).toMatchObject({ status: "failed", exitCode: 1 });
		const before = await first.invoke<TaskSnapshot>("enhanced-task-inspect", taskId);
		const paused = await first.invoke<TaskSnapshot>("enhanced-task-pause", `${taskId} ${before.task.revision}`);
		expect(paused.task.status).toBe("paused");
		expect(paused.lastCheckpoint?.sessionId).toBe(manager.getSessionId());
		const beforeTools = tools(first.harness);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Missing durable session");
		await shutdown(first.harness);

		const resumedManager = SessionManager.open(sessionFile, undefined, project);
		const second = await open(resumedManager, "after");
		const reopen = await second.invoke<TaskSnapshot>("enhanced-task-inspect", taskId);
		expect(reopen.task.status).toBe("paused");
		expect(reopen.lastCheckpoint?.checkpointId).toBe(paused.lastCheckpoint?.checkpointId);
		expect(tools(second.harness)).toEqual([]);
		const queued = await second.invoke<TaskSnapshot>("enhanced-task-resume", `${taskId} ${reopen.task.revision}`);
		expect(queued.task.status).toBe("queued");
		expect(tools(second.harness)).toEqual([]);
		expect(readFileSync(join(project, "calc.py"), "utf8")).toBe(fileSource);
		await second.invoke("enhanced-task-step", `${taskId} repair bind`);

		let citation: unknown;
		second.harness.setResponses([
			call(KNOWLEDGE_SEARCH, { query: "calculator contract" }),
			(context) => {
				const result = context.messages.findLast((item) => item.role === "toolResult" && item.toolName === KNOWLEDGE_SEARCH);
				expect(JSON.stringify(result)).toContain(contract);
				expect(JSON.stringify(result)).toContain("insufficient-evidence");
				if (result?.role !== "toolResult") throw new Error("Knowledge search result was not projected");
				const text = getMessageText(result);
				const parsed = JSON.parse(text.slice(text.indexOf("\n") + 1));
				citation = parsed.hits[0];
				expect(citation).toMatchObject({
					chunkId: expect.stringMatching(/^[0-9a-f]{64}$/u),
					documentId: expect.stringMatching(/^[0-9a-f]{64}$/u),
					documentVersion: 1,
					corpusId: "default",
					evidence: "candidate",
					source: { path: "calculator.md" },
				});
				return call("edit", { path: "calc.py", edits: [{ oldText: "return n", newText: "return n + 1" }] });
			},
			call("run_tests", { targets: [testFile] }),
			fauxAssistantMessage("The corrected implementation passed the approved pytest."),
		]);
		await second.harness.session.prompt("Read the reference, edit the calculator, and rerun the same approved pytest.");
		expect(tools(second.harness)).toEqual([KNOWLEDGE_SEARCH, "edit", "run_tests"]);
		expect(JSON.stringify(getToolResult(second.harness, KNOWLEDGE_SEARCH))).not.toContain(contract);
		expect(readFileSync(join(project, "calc.py"), "utf8")).toContain("return n + 1");
		const passed = getToolResult(second.harness, "run_tests");
		expect(JSON.parse(getMessageText(passed))).toMatchObject({ status: "passed", exitCode: 0, passed: 1 });
		const observed = await second.invoke<TaskSnapshot>("enhanced-task-inspect", taskId);
		const evidence = observed.evidence.filter(({ kind }) => kind === "sandbox_pytest");
		expect(evidence).toHaveLength(2);
		expect(evidence[0]).toMatchObject({ toolCallId: failed.toolCallId, pytest: { status: "failed", exitCode: 1 } });
		expect(evidence[1]).toMatchObject({ toolCallId: passed.toolCallId, confidenceClass: "validated",
			pytest: { target: testFile, completedPasses: 1, testHash: sha256(suiteSource) } });
		const verifying = await second.invoke<TaskSnapshot>("enhanced-task-step", `${taskId} repair verify ${observed.steps[0].revision}`);
		const complete = await second.invoke<TaskSnapshot>("enhanced-task-step", `${taskId} repair complete ${verifying.steps[0].revision}`);
		expect(complete.steps[0].status).toBe("completed");
		await shutdown(second.harness);

		const sandbox = audits.map((path) => JSON.parse(readFileSync(path, "utf8")));
		for (const audit of sandbox) expect(audit).toMatchObject({ state: "completed", pending: [] });
		expect(sandbox[1].audit).toContainEqual(expect.objectContaining({ toolName: "edit", status: "ok" }));
		const artifact = process.env.PI_V3_B4_EVIDENCE;
		if (artifact) writeFileSync(artifact, JSON.stringify({
			id: "B4-01", provider: "faux", sessionId: resumedManager.getSessionId(), taskId, checkpoint: reopen.lastCheckpoint,
			replayedToolsAtResume: 0, beforeTools, afterTools: [KNOWLEDGE_SEARCH, "edit", "run_tests"], citation, evidence, sandbox,
		}, null, 2));
	} finally {
		for (const host of [...hosts]) await shutdown(host);
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}, 120_000);
