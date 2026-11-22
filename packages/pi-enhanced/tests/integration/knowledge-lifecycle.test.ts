import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness, createTestUiContext } from "../../../coding-agent/test/suite/harness.ts";
import { createKnowledgeExtension } from "../../src/knowledge/extension.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";

it.each([
	{ trusted: true, global: undefined, project: undefined, state: "disabled" },
	{ trusted: true, global: true, project: undefined, state: "enabled" },
	{ trusted: true, global: true, project: false, state: "disabled" },
	{ trusted: false, global: true, project: false, state: "blocked" },
	{ trusted: true, global: "yes", project: undefined, state: "invalid-config" },
])("reports Knowledge as $state with trusted=$trusted", async ({ trusted, global, project, state }) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-knowledge-lifecycle-"));
	const agentDir = join(directory, "agent");
	const notifications: string[] = [];
	const harness = await createHarness({ extensionFactories: [createKnowledgeExtension({ agentDir })] });
	try {
		const writeConfig = (folder: string, enabled: unknown) => {
			if (enabled === undefined) return;
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, ENHANCED_CONFIG_FILE), JSON.stringify({ modules: { knowledge: { enabled } } }));
		};
		writeConfig(agentDir, global);
		writeConfig(join(harness.tempDir, CONFIG_DIR_NAME), project);
		harness.settingsManager.setProjectTrusted(trusted);
		await harness.session.bindExtensions({
			mode: "print",
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		await harness.session.prompt("/enhanced-docs status");
		if (state === "enabled") {
			expect(JSON.parse(notifications.at(-1)!)).toMatchObject({ mode: "lexical", registered: 0 });
			expect(harness.session.extensionRunner.getActiveTools()).toContain("enhanced_docs_search");
		} else {
			expect(notifications.at(-1)).toBe(`pi-enhanced knowledge: ${state}`);
			expect(harness.session.extensionRunner.getActiveTools()).not.toContain("enhanced_docs_search");
		}
		expect(existsSync(join(agentDir, "pi-enhanced"))).toBe(state === "enabled");
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await harness.session.prompt("/enhanced-docs status");
		expect(notifications.at(-1)).toBe("pi-enhanced knowledge: inactive");
	} finally {
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});
