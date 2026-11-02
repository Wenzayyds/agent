import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { createMemoryExtension } from "../../src/memory/extension.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-memory-lifecycle-"));
	tempDirs.push(path);
	return path;
}

function enableMemory(agentDir: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, ENHANCED_CONFIG_FILE),
		`${JSON.stringify({ modules: { memory: { enabled: true } } }, null, 2)}\n`,
	);
}

async function setup(options: { enabled: boolean; trusted: boolean }) {
	const agentDir = join(tempDir(), "agent");
	if (options.enabled) enableMemory(agentDir);
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [createMemoryExtension({ agentDir })],
	});
	harnesses.push(harness);
	harness.settingsManager.setProjectTrusted(options.trusted);
	return { harness, agentDir };
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P2-1/P2-2 Memory Extension lifecycle", () => {
	it.each([
		{ enabled: false, trusted: true },
		{ enabled: true, trusted: false },
	])("does not create a Memory data directory when enabled=$enabled trusted=$trusted", async (options) => {
		const { harness, agentDir } = await setup(options);
		await harness.session.bindExtensions({ mode: "print", uiContext: createTestUiContext() });
		expect(existsSync(join(agentDir, "pi-enhanced", "memory"))).toBe(false);
	});

	it("opens trusted storage, survives reload, and closes repeatedly", async () => {
		const agentDir = join(tempDir(), "agent");
		enableMemory(agentDir);
		const active = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [createMemoryExtension({ agentDir })],
		});
		harnesses.push(active);
		await active.session.bindExtensions({ mode: "print", uiContext: createTestUiContext() });
		expect(existsSync(join(agentDir, "pi-enhanced", "memory", "projects"))).toBe(true);
		await active.session.reload();
		await expect(active.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })).resolves.toBeUndefined();
		await expect(active.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })).resolves.toBeUndefined();
	});
});
