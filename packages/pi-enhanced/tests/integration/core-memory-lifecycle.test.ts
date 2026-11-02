import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryError } from "../../src/memory/errors.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { startMemoryRuntime } from "../../src/memory/runtime.ts";
import { MemoryService, openMemoryService } from "../../src/memory/service.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-core-lifecycle-"));
	tempDirs.push(path);
	return path;
}

function workspace() {
	const root = tempDir();
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(project);
	return { project, agentDir };
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P2-4 Core Memory lifecycle", () => {
	it.each([
		{ enabled: false, projectTrusted: true, expected: "disabled" },
		{ enabled: true, projectTrusted: false, expected: "blocked" },
	] as const)("does no Memory file I/O in $expected state", async (input) => {
		const { project, agentDir } = workspace();
		const runtime = await startMemoryRuntime({
			...input,
			cwd: project,
			agentDir,
			openBackend: openMemoryService,
		});
		expect(runtime.state).toBe(input.expected);
		expect(existsSync(join(project, ".pi-enhanced"))).toBe(false);
		expect(existsSync(join(agentDir, "pi-enhanced"))).toBe(false);
	});

	it("does not create Core files until explicit use and survives repeated runtime open/close", async () => {
		const { project, agentDir } = workspace();
		const first = await startMemoryRuntime({
			enabled: true,
			projectTrusted: true,
			cwd: project,
			agentDir,
			openBackend: openMemoryService,
		});
		expect(first.state).toBe("ready");
		expect(existsSync(join(project, ".pi-enhanced"))).toBe(false);
		expect(first.backend).toBeInstanceOf(MemoryService);
		const firstService = first.backend as MemoryService;
		firstService.createCore("architecture", "# Architecture\nTypeScript owns authoritative state.\n");
		await first.close();
		await first.close();
		await expect(firstService.get("unused")).rejects.toMatchObject<MemoryError>({ code: "MEMORY_RUNTIME_CLOSED" });

		const second = await startMemoryRuntime({
			enabled: true,
			projectTrusted: true,
			cwd: project,
			agentDir,
			openBackend: openMemoryService,
		});
		const secondService = second.backend as MemoryService;
		expect(secondService.getCore("architecture")?.content).toContain("authoritative state");
		await second.close();
	});
});
