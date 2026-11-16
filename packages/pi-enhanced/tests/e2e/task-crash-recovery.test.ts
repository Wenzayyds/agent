import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import type { TaskManagerConfig } from "../../src/task-manager/config.ts";
import { recoveryPreflight } from "../../src/task-manager/recovery.ts";
import { TaskRuntime } from "../../src/task-manager/runtime.ts";
import { progressLedger } from "../../src/task-manager/v2.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("P4 real process interruption recovery", () => {
	it("reopens a killed child, detects the unknown write and workspace drift, and never replays it", async () => {
		for (const mode of ["v1", "v2"]) {
			const root = mkdtempSync(join(tmpdir(), "pi-task-crash-"));
			roots.push(root);
			const project = join(root, "project");
			const agentDir = join(root, "agent");
			mkdirSync(project);
			writeFileSync(join(project, "fixture.txt"), "original\n");
			execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: project });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: project });
			execFileSync("git", ["add", "fixture.txt"], { cwd: project });
			execFileSync("git", ["commit", "-m", "fixture"], { cwd: project, stdio: "ignore" });

			const fixture = resolve("packages/pi-enhanced/tests/fixtures/task-crash-child.ts");
			const child = spawn(process.execPath, ["--experimental-strip-types", fixture, project, agentDir, mode], {
				cwd: resolve("."),
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				windowsHide: true,
			});
			const taskId = await new Promise<string>((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error("crash fixture did not become ready")), 10_000);
				child.once("error", reject);
				child.on("message", (message) => {
					if (
						message &&
						typeof message === "object" &&
						"taskId" in message &&
						typeof message.taskId === "string"
					) {
						clearTimeout(timer);
						resolveReady(message.taskId);
					}
				});
			});
			child.kill();
			await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

			const config: TaskManagerConfig = {
				enabled: true,
				modelPlanTool: false,
				contextSummary: false,
				maximumTasks: 20,
				maximumSteps: 20,
				maximumEvents: 1_000,
				controlledFiles: [],
			};
			const scope = createProjectScope({ cwd: project, agentDir });
			const runtime = TaskRuntime.start({ config, trusted: true, scope, agentDir });
			if (!runtime.service) throw new Error(runtime.error ?? "runtime did not reopen");
			const snapshot = runtime.service.get(taskId)!;
			const attempt = runtime.service.provider
				.getAttempts(taskId)
				.find(({ attemptId }) => attemptId === "crashed-attempt");
			expect(attempt?.state).toBe("needs_reconciliation");
			expect(snapshot.steps.find(({ stepId }) => stepId === "checked")?.status).toBe("completed");
			expect(snapshot.steps.find(({ stepId }) => stepId === "mutate")?.status).toBe("needs_reconciliation");
			const preflight = recoveryPreflight(runtime.service.provider, taskId, "crash-session", "crash-leaf");
			expect(preflight.unknownStepIds).toEqual(["mutate"]);
			expect(preflight.verifyBeforeWriteStepIds).toEqual(["mutate"]);
			expect(preflight.safeContinueStepIds).toEqual([]);
			expect(preflight.automaticReplayAllowed).toBe(false);
			expect(preflight.driftReasons).toContain("git-worktree-changed");
			expect(readFileSync(join(project, "fixture.txt"), "utf8")).toBe("changed-once\n");
			if (mode === "v2") {
				expect(progressLedger(runtime.service, snapshot)).toMatchObject({
					state: "blocked",
					reason: "unknown_attempt",
					replans: 0,
				});
				expect(() =>
					runtime.service!.provider.mutateModelPlan(
						"model:crash-reply",
						"v2_create",
						{ session: "crash-session" },
						() => snapshot,
					),
				).toThrow("This assistant reply already changed a plan");
			}
			runtime.close();

			const second = TaskRuntime.start({ config, trusted: true, scope, agentDir });
			expect(
				second.service?.provider.getAttempts(taskId).find(({ attemptId }) => attemptId === "crashed-attempt")
					?.state,
			).toBe("needs_reconciliation");
			expect(readFileSync(join(project, "fixture.txt"), "utf8")).toBe("changed-once\n");
			second.close();
		}
	});
});
