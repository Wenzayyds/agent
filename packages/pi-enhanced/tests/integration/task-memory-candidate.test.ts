import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerMemoryCandidateWriterBroker,
	requestMemoryCandidateWrite,
} from "../../src/memory/candidate-writer.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { openMemoryService, type MemoryService } from "../../src/memory/service.ts";

const roots: string[] = [];
const services: MemoryService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Task to Memory candidate bridge", () => {
	it("accepts only the bound session and project, is idempotent, and never creates verified Memory", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-task-memory-"));
		roots.push(root);
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(project);
		const scope = createProjectScope({ cwd: project, agentDir });
		const service = await openMemoryService(scope);
		services.push(service);
		const events = createEventBus();
		const off = registerMemoryCandidateWriterBroker(events, { service, scope, sessionId: "session-1" });
		const context = { cwd: project, sessionManager: { getSessionId: () => "session-1" } } as never;
		const first = await requestMemoryCandidateWrite(events, context, { taskId: "task-1", content: "A reviewed task experience" });
		const second = await requestMemoryCandidateWrite(events, context, { taskId: "task-1", content: "A reviewed task experience" });
		expect(second).toEqual(first);
		const record = await service.get(first.id);
		expect(record?.status).toBe("candidate");
		expect(record?.sources).toEqual([expect.objectContaining({ type: "user", ref: "task:task-1" })]);
		expect(await service.search({ text: "reviewed task", statuses: ["verified"] })).toEqual([]);
		await expect(
			requestMemoryCandidateWrite(events, { cwd: project, sessionManager: { getSessionId: () => "other" } } as never, { taskId: "task-1", content: "wrong session" }, 50),
		).rejects.toMatchObject({ code: "MEMORY_RUNTIME_UNAVAILABLE" });
		off();
	});
});
