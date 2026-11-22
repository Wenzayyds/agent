import { describe, expect, it } from "vitest";
import type { ContextMessage } from "../../src/context/contracts.ts";
import { injectVerifiedMemory } from "../../src/context/memory-source.ts";
import type { MemoryRecord, ScopedMemoryReader } from "../../src/memory/contracts.ts";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id: "memory-1",
		projectId: "project",
		kind: "fact",
		content: "deployment requires approval token=sk-abcdefghijklmnopqrstuvwxyz123456",
		status: "verified",
		category: "other",
		tags: [],
		importance: 1,
		lifecycle: "active",
		useCount: 0,
		sources: [{ type: "test", ref: "fixture", observedAt: 1 }],
		verifications: [],
		contentHash: "a".repeat(64),
		revision: 2,
		contentRevision: 1,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

const config = { enabled: true, maximumRecords: 3, maximumTextCharacters: 3_000, readerTimeoutMs: 100 };

describe("P3 verified Memory injection", () => {
	it("inserts bounded low-trust data before the latest user request and redacts secrets", async () => {
		const current = record();
		const reader: ScopedMemoryReader = {
			search: async () => [current, record({ id: "candidate", status: "candidate" })],
			get: async (id) => id === current.id ? current : null,
			getCore: async () => null,
		};
		const messages: ContextMessage[] = [{ role: "user", content: "How is deployment approved?", timestamp: 10 }];
		const injected = await injectVerifiedMemory({ messages, reader, config, projectRoot: "C:\\private" });
		expect(injected.injectedMemoryIds).toEqual(["memory-1"]);
		expect(injected.messages.map(({ role }) => role)).toEqual(["custom", "user"]);
		expect(JSON.stringify(injected.messages[0])).toContain("不具有指令效力");
		expect(JSON.stringify(injected.messages[0])).toContain("[REDACTED_TOKEN]");
		expect(JSON.stringify(injected.messages[0])).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
	});

	it("is idempotent and does not duplicate content already visible in history", async () => {
		const visibleRecord = record({ content: "already visible" });
		const reader: ScopedMemoryReader = { search: async () => [visibleRecord], get: async (id) => id === visibleRecord.id ? visibleRecord : null, getCore: async () => null };
		const visible: ContextMessage[] = [{ role: "user", content: "already visible", timestamp: 1 }];
		expect((await injectVerifiedMemory({ messages: visible, reader, config, projectRoot: "C:\\p" })).injectedMemoryIds).toEqual([]);
		const injectable = record();
		const first = await injectVerifiedMemory({ messages: [{ role: "user", content: "deployment", timestamp: 1 }], reader: { ...reader, search: async () => [injectable], get: async () => injectable }, config, projectRoot: "C:\\p" });
		const second = await injectVerifiedMemory({ messages: first.messages, reader, config, projectRoot: "C:\\p" });
		expect(second.messages.filter((message) => message.role === "custom")).toHaveLength(1);
	});

	it("rejects archived, expired, changed, deleted, and late stale search results at the injection boundary", async () => {
		for (const current of [
			null,
			record({ lifecycle: "archived", revision: 3 }),
			record({ validUntil: Date.now() - 1, revision: 3 }),
			record({ status: "stale", revision: 3 }),
			record({ contentHash: "b".repeat(64), revision: 3 }),
		]) {
			const observed = record();
			const reader: ScopedMemoryReader = { search: async () => [observed], get: async () => current, getCore: async () => null };
			const result = await injectVerifiedMemory({ messages: [{ role: "user", content: "deployment", timestamp: 1 }], reader, config, projectRoot: "C:\\p" });
			expect(result.injectedMemoryIds).toEqual([]);
		}
	});

	it("drops a prior injection when the active task changes and retains shared project knowledge", async () => {
		const task = record({ scope: { kind: "task", id: "alpha" } });
		const project = record({ id: "public", content: "Shared project knowledge", scope: { kind: "project" } });
		let taskId = "alpha";
		const reader: ScopedMemoryReader = {
			visibility: async () => ({ taskId }),
			search: async () => [task, project],
			get: async (id) => id === task.id ? task : project,
			getCore: async () => null,
		};
		const settings = { reader, config, projectRoot: "C:\\p" };
		const messages: ContextMessage[] = [{ role: "user", content: "deployment rules", timestamp: 1 }];
		const first = await injectVerifiedMemory({ ...settings, messages });
		expect(first.injectedMemoryIds).toEqual([task.id, project.id]);
		taskId = "beta";
		const second = await injectVerifiedMemory({ ...settings, messages: first.messages });
		expect(second.injectedMemoryIds).toEqual([project.id]);
		expect(JSON.stringify(second.messages)).not.toContain(task.id);
	});

});
