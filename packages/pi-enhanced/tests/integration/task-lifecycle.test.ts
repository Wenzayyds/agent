import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { createTaskManagerExtension } from "../../src/task-manager/extension.ts";
import { digestToolInput } from "../../src/task-manager/runtime.ts";

const roots: string[] = []; const harnesses: Harness[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), "pi-enhanced-task-lifecycle-")); roots.push(path); return path; }
function config(agentDir: string, enabled = true, modelPlanTool = false): void { mkdirSync(agentDir, { recursive: true }); writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify({ modules: { "task-manager": { enabled, modelPlanTool, contextSummary: false, maximumTasks: 50, maximumSteps: 20, maximumEvents: 1000 } } })); }
afterEach(async () => { for (const harness of harnesses.splice(0)) { await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); harness.cleanup(); } for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("P4 Task Extension lifecycle", () => {
	it.each([{ enabled: false, trusted: true }, { enabled: true, trusted: false }])("does not create storage or expose task tools when enabled=$enabled trusted=$trusted", async ({ enabled, trusted }) => {
		const agentDir = join(temp(), "agent"); config(agentDir, enabled); const harness = await createHarness({ extensionFactories: [createTaskManagerExtension({ agentDir })] }); harnesses.push(harness); harness.settingsManager.setProjectTrusted(trusted); await harness.session.bindExtensions({ mode: "print", uiContext: createTestUiContext() });
		expect(existsSync(join(agentDir, "pi-enhanced", "tasks"))).toBe(false); expect(harness.session.extensionRunner.getCommand("enhanced-task-create")).toBeUndefined();
	});

	it("creates, persists, observes an explicitly bound tool, checkpoints, and recovers without replay", async () => {
		const agentDir = join(temp(), "agent"); config(agentDir, true); const notifications: string[] = []; const harness = await createHarness({ extensionFactories: [createTaskManagerExtension({ agentDir })] }); harnesses.push(harness); harness.settingsManager.setProjectTrusted(true); await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ notify: (message) => notifications.push(message), confirm: async () => true }) });
		const commandContext = harness.session.extensionRunner.createCommandContext(); const interactive = Object.create(commandContext) as ExtensionCommandContext; Object.defineProperty(interactive, "hasUI", { value: true }); Object.defineProperty(interactive, "ui", { value: createTestUiContext({ notify: (message) => notifications.push(message), confirm: async () => true }) });
		const invoke = async (name: string, args: string) => { const command = harness.session.extensionRunner.getCommand(name); if (!command) throw new Error(`missing ${name}`); await command.handler(args, interactive); };
		const commandArgs = { command: "npm test" };
		await invoke("enhanced-task-create", JSON.stringify({ goal: "run fixture", steps: [{ stepId: "test", title: "run tests", expectedOutcome: "exit code zero", validation: { kind: "command_exit", toolName: "bash", inputDigest: digestToolInput(commandArgs), expectedExitCode: 0 } }] })); const created = JSON.parse(notifications.at(-1)!) as { task: { taskId: string; revision: number }; steps: { stepId: string; revision: number }[] };
		await invoke("enhanced-task-approve", `${created.task.taskId} ${created.task.revision}`); const approved = JSON.parse(notifications.at(-1)!) as { task: { revision: number } };
		await invoke("enhanced-task-step", `${created.task.taskId} test bind`); await invoke("enhanced-task-step", `${created.task.taskId} test start 1`); let state = JSON.parse(notifications.at(-1)!) as { steps: { revision: number }[] };
		await harness.session.extensionRunner.emit({ type: "tool_execution_start", toolCallId: "call-test", toolName: "bash", args: commandArgs });
		await harness.session.extensionRunner.emit({ type: "tool_execution_end", toolCallId: "call-test", toolName: "bash", result: { details: { exitCode: 0, testCount: 3 } }, isError: false, durationMs: 5 });
		await harness.session.extensionRunner.emit({ type: "tool_execution_end", toolCallId: "call-test", toolName: "bash", result: { details: { exitCode: 0, testCount: 3 } }, isError: false, durationMs: 5 });
		await invoke("enhanced-task-step", `${created.task.taskId} test verify ${state.steps[0]!.revision}`); state = JSON.parse(notifications.at(-1)!) as { steps: { revision: number }[] };
		await invoke("enhanced-task-step", `${created.task.taskId} test complete ${state.steps[0]!.revision}`); await invoke("enhanced-task-checkpoint", created.task.taskId); await invoke("enhanced-task-recover", created.task.taskId);
		const preflight = JSON.parse(notifications.at(-1)!) as { automaticReplayAllowed: boolean; completedStepIds: string[] }; expect(preflight.automaticReplayAllowed).toBe(false); expect(preflight.completedStepIds).toEqual(["test"]); expect(approved.task.revision).toBeGreaterThan(created.task.revision);
		expect(existsSync(join(agentDir, "pi-enhanced", "tasks"))).toBe(true);
		await harness.session.extensionRunner.emit({ type: "agent_settled", aborted: false }); await invoke("enhanced-task-inspect", created.task.taskId); expect(notifications.at(-1)).toContain('"status": "running"'); expect((JSON.parse(notifications.at(-1)!) as { evidence: unknown[] }).evidence).toHaveLength(1);
	});
});
