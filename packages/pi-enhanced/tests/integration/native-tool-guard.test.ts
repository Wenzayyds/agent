import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../../../coding-agent/src/extensions/codemode/index.ts";
import {
	createHarness,
	createTestUiContext,
	getToolResult,
	type Harness,
} from "../../../coding-agent/test/suite/harness.ts";
import mcpPolicyExtension from "../../extensions/mcp-policy.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";

const roots: string[] = [];
const harnesses: Harness[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-native-guard-"));
	roots.push(root);
	return root;
}

function configure(agentDir: string, workspaceMutationAction: "ask" | "allow" = "ask"): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, ENHANCED_CONFIG_FILE),
		JSON.stringify({
			modules: {
				"mcp-policy": {
					enabled: false,
					defaultAction: "ask",
					rules: [],
					nativeToolGuard: {
						enabled: true,
						approvalTimeoutMs: 1_000,
						maxRecent: 20,
						protectProjectMetadata: true,
						workspaceMutationAction,
					},
				},
			},
		}),
	);
}

async function setup(options: { trusted: boolean; confirm?: () => Promise<boolean>; codemode?: boolean; workspaceMutationAction?: "ask" | "allow" }) {
	const root = temporaryRoot();
	const agentDir = join(root, "agent");
	configure(agentDir, options.workspaceMutationAction);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const harness = await createHarness({
		extensionFactories: [mcpPolicyExtension, ...(options.codemode ? [createCodemodeExtension()] : [])],
		initialActiveToolNames: options.codemode
			? ["read", "write", "edit", "codemode"]
			: ["read", "write", "edit", process.platform === "win32" ? "powershell" : "bash"],
	});
	harnesses.push(harness);
	harness.settingsManager.setProjectTrusted(options.trusted);
	await harness.session.bindExtensions({
		mode: options.confirm ? "tui" : "print",
		uiContext: createTestUiContext(options.confirm ? { confirm: options.confirm } : {}),
	});
	return { harness, root: harness.tempDir };
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("native tool guard pre-execution boundary", () => {
	it("blocks untrusted writes before the file tool creates anything", async () => {
		const { harness, root } = await setup({ trusted: false, confirm: async () => true });
		const target = join(root, "untrusted.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "must not exist" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write outside trust");
		expect(getToolResult(harness, "write").isError).toBe(true);
		expect(existsSync(target)).toBe(false);
	});

	it("fails closed for Shell without a dialog-capable UI", async () => {
		const { harness, root } = await setup({ trusted: true });
		const toolName = process.platform === "win32" ? "powershell" : "bash";
		const target = join(root, "shell-must-not-exist.txt");
		const command = process.platform === "win32" ? `Set-Content -LiteralPath '${target}' unsafe` : `printf unsafe > '${target}'`;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(toolName, { command })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run shell");
		expect(getToolResult(harness, toolName).isError).toBe(true);
		expect(existsSync(target)).toBe(false);
	});

	it("blocks absolute, traversal, protected, and junction-escaped writes even when approval would succeed", async () => {
		const { harness, root } = await setup({ trusted: true, confirm: async () => true });
		const outside = temporaryRoot();
		const junction = join(root, "linked-outside");
		symlinkSync(outside, junction, "junction");
		const cases = [
			join(outside, "absolute.txt"),
			join("..", "traversal.txt"),
			join(".git", "config"),
			join(junction, "junction.txt"),
		];
		for (const [index, path] of cases.entries()) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path, content: "unsafe" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt(`blocked case ${index}`);
			expect(getToolResult(harness, "write").isError).toBe(true);
		}
		expect(existsSync(join(outside, "absolute.txt"))).toBe(false);
		expect(existsSync(join(outside, "junction.txt"))).toBe(false);
	});

	it("allows an explicitly approved workspace write and intercepts nested codemode writes", async () => {
		const decisions = [true, false];
		const { harness, root } = await setup({ trusted: true, confirm: async () => decisions.shift() ?? false, codemode: true });
		const allowed = join(root, "allowed.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: allowed, content: "approved" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("approved write");
		expect(existsSync(allowed)).toBe(true);

		const nested = join(root, "nested-blocked.txt").replaceAll("\\", "/");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("codemode", { code: `return await tools.write({ path: ${JSON.stringify(nested)}, content: "blocked" });` })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("nested write");
		expect(existsSync(nested)).toBe(false);
	});

	it("allows only canonical workspace write/edit in explicit user evaluation mode while Shell stays closed", async () => {
		const { harness, root } = await setup({ trusted: true, workspaceMutationAction: "allow" });
		const target = join(root, "evaluation-write.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "bounded" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("bounded evaluation write");
		expect(existsSync(target)).toBe(true);
		const toolName = process.platform === "win32" ? "powershell" : "bash";
		const shellTarget = join(root, "evaluation-shell.txt");
		const command = process.platform === "win32" ? `Set-Content -LiteralPath '${shellTarget}' unsafe` : `printf unsafe > '${shellTarget}'`;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(toolName, { command })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("shell remains closed");
		expect(existsSync(shellTarget)).toBe(false);
	});
});
