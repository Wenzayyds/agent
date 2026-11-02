import { describe, expect, it } from "vitest";
import type { ContextMessage } from "../../src/context/contracts.ts";
import { injectActiveTask } from "../../src/context/task-source.ts";
import type { ScopedTaskReader, ScopedTaskSummary } from "../../src/task-manager/contracts.ts";

const config = { enabled: true, maximumTextCharacters: 2_000, readerTimeoutMs: 100 };
const messages: ContextMessage[] = [{ role: "user", content: "continue", timestamp: 10 }];

function summary(overrides: Partial<ScopedTaskSummary> = {}): ScopedTaskSummary {
	return {
		taskId: "task-1",
		projectId: "project-1",
		sessionId: "session-1",
		branchLeafId: "leaf-1",
		goal: "repair the fixture token=sk-abcdefghijklmnopqrstuvwxyz123456",
		status: "running",
		revision: 3,
		planRevision: 2,
		reconciliationCount: 0,
		observedAt: 1,
		steps: [{ stepId: "step-1", title: "run tests", status: "running", expectedOutcome: "tests pass", dependsOn: [] }],
		...overrides,
	};
}

function reader(first: ScopedTaskSummary | null, current: ScopedTaskSummary | null): ScopedTaskReader {
	return { getActive: async () => first, get: async () => current };
}

describe("P3 active Task injection", () => {
	it("injects a bounded redacted low-trust summary before the latest user", async () => {
		const value = summary();
		const result = await injectActiveTask({
			messages,
			reader: reader(value, value),
			config,
			projectRoot: "C:\\private",
			sessionId: "session-1",
			branchLeafId: "leaf-1",
		});
		expect(result.injectedTaskId).toBe("task-1");
		expect(result.messages.map(({ role }) => role)).toEqual(["custom", "user"]);
		expect(JSON.stringify(result.messages[0])).toContain("低信任状态摘要");
		expect(JSON.stringify(result.messages[0])).toContain("[REDACTED_TOKEN]");
	});

	it("rejects a stale async snapshot, wrong binding, terminal state, and duplicate injection", async () => {
		for (const [observed, current] of [
			[summary(), summary({ revision: 4 })],
			[summary(), summary({ sessionId: "other" })],
			[summary(), summary({ branchLeafId: "other" })],
			[summary(), summary({ status: "completed" })],
		] as const) {
			const result = await injectActiveTask({ messages, reader: reader(observed, current), config, projectRoot: "C:\\p", sessionId: "session-1", branchLeafId: "leaf-1" });
			expect(result.injectedTaskId).toBeUndefined();
			expect(result.messages).toEqual(messages);
		}
		const first = await injectActiveTask({ messages, reader: reader(summary(), summary()), config, projectRoot: "C:\\p", sessionId: "session-1", branchLeafId: "leaf-1" });
		const second = await injectActiveTask({ messages: first.messages, reader: reader(summary(), summary()), config, projectRoot: "C:\\p", sessionId: "session-1", branchLeafId: "leaf-1" });
		expect(second.messages.filter(({ role }) => role === "custom")).toHaveLength(1);
	});
});
