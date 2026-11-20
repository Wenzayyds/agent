import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { startMemoryRuntime } from "../../src/memory/runtime.ts";

describe("P2-1 project scope", () => {
	it("uses the canonical absolute workspace path and separates same-named directories", () => {
		const first = createProjectScope({ cwd: "C:/work/one/app", agentDir: "C:/agent", realpath: resolve, platform: "win32" });
		const second = createProjectScope({ cwd: "C:/work/two/app", agentDir: "C:/agent", realpath: resolve, platform: "win32" });
		expect(first.projectId).not.toBe(second.projectId);
		expect(first.databasePath).not.toBe(second.databasePath);
	});

	it("normalizes Windows path case for identity without changing the displayed canonical path", () => {
		const upper = createProjectScope({ cwd: "C:/Work/App", agentDir: "C:/agent", realpath: (path) => path, platform: "win32" });
		const lower = createProjectScope({ cwd: "c:/work/app", agentDir: "C:/agent", realpath: (path) => path, platform: "win32" });
		expect(upper.projectId).toBe(lower.projectId);
		expect(upper.rootPath).not.toBe(lower.rootPath);
	});

	it("keeps repository root and subdirectory as separate workspace scopes", () => {
		const root = createProjectScope({ cwd: "/repo", agentDir: "/agent", realpath: resolve, platform: "linux" });
		const child = createProjectScope({ cwd: "/repo/packages/app", agentDir: "/agent", realpath: resolve, platform: "linux" });
		expect(root.projectId).not.toBe(child.projectId);
	});
});

describe("P2-1 lifecycle gate", () => {
	it.each([
		{ enabled: false, projectTrusted: true, state: "disabled" },
		{ enabled: true, projectTrusted: false, state: "blocked" },
	] as const)("returns $state without resolving a scope or opening storage", async (input) => {
		const createScope = vi.fn();
		const openBackend = vi.fn();
		const runtime = await startMemoryRuntime({
			...input,
			cwd: "unused",
			agentDir: "unused",
			createScope,
			openBackend,
		});
		expect(runtime.state).toBe(input.state);
		expect(createScope).not.toHaveBeenCalled();
		expect(openBackend).not.toHaveBeenCalled();
	});

	it("closes an enabled trusted backend exactly once", async () => {
		const close = vi.fn(async () => {});
		const scope = createProjectScope({ cwd: "/project", agentDir: "/agent", realpath: resolve, platform: "linux" });
		const runtime = await startMemoryRuntime({
			enabled: true,
			projectTrusted: true,
			cwd: scope.rootPath,
			agentDir: "/agent",
			createScope: () => scope,
			openBackend: async () => ({ close }),
		});
		expect(runtime.state).toBe("ready");
		await runtime.close();
		await runtime.close();
		expect(close).toHaveBeenCalledTimes(1);
	});
});
