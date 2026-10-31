import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodemodeExtension } from "../../../coding-agent/src/extensions/codemode/index.ts";
import { type McpExposure, type McpServerEntry } from "../../../coding-agent/src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../../coding-agent/src/extensions/mcp/index.ts";
import { createToolSearchExtension } from "../../../coding-agent/src/extensions/tool-search/index.ts";
import {
	createHarness,
	createTestUiContext,
	getMessageText,
	getToolResult,
	type Harness,
} from "../../../coding-agent/test/suite/harness.ts";
import mcpPolicyExtension from "../../extensions/mcp-policy.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = resolve(packageDir, "fixtures/mcp/policy-server.mjs");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const harnesses: Harness[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-mcp-policy-"));
	tempDirs.push(path);
	return path;
}

function writePolicy(agentDir: string, rules: unknown[], defaultAction: "ask" | "deny" = "ask"): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, ENHANCED_CONFIG_FILE),
		`${JSON.stringify(
			{
				modules: {
					"mcp-policy": {
						enabled: true,
						defaultAction,
						rules,
						audit: { enabled: true, maxRecent: 20 },
					},
				},
			},
			null,
			2,
		)}\n`,
	);
}

function calls(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { name: string }).name);
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

async function setup(exposure: McpExposure, rules: unknown[], uiConfirm?: () => Promise<boolean>) {
	const root = tempDir();
	const agentDir = join(root, "agent");
	const callLog = join(root, "calls.jsonl");
	writePolicy(agentDir, rules);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const entry: McpServerEntry = {
		name: "fixture",
		config: { command: process.execPath, args: [fixture, callLog], exposure, timeout: 5 },
		source: "test",
	};
	const notifications: string[] = [];
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			mcpPolicyExtension,
			createCodemodeExtension(),
			createToolSearchExtension(),
			createMcpExtension({
				loadConfig: () => ({ servers: [entry], errors: [] }),
				logPath: join(root, "mcp.log"),
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		mode: uiConfirm ? "tui" : "print",
		uiContext: createTestUiContext({
			notify: (message) => notifications.push(message),
			...(uiConfirm ? { confirm: uiConfirm } : {}),
		}),
	});
	await vi.waitFor(() => expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__fixture__read_symbol"));
	return { harness, callLog, notifications, root };
}

const allowReadDenyWrite = [
	{ id: "allow-read", server: "fixture", tool: "read_symbol", action: "allow" },
	{ id: "allow-refresh", server: "fixture", tool: "refresh_tools", action: "allow" },
	{ id: "deny-write", server: "fixture", tool: "write_file", action: "deny" },
];

describe("MCP policy with Pi native MCP paths", () => {
	it("allows direct reads and blocks a lying write tool before any side effect", async () => {
		const { harness, callLog, root } = await setup("direct", allowReadDenyWrite);
		const target = join(root, "must-not-exist.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__fixture__read_symbol", { name: "AgentSession" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("mcp__fixture__write_file", { path: target, content: "unsafe" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run direct tools");

		expect(getMessageText(getToolResult(harness, "mcp__fixture__read_symbol"))).toBe("symbol:AgentSession");
		expect(getToolResult(harness, "mcp__fixture__write_file").isError).toBe(true);
		expect(calls(callLog)).toEqual(["read_symbol"]);
		expect(existsSync(target)).toBe(false);
	});

	it("keeps policy enforcement after tool_search loads a deferred tool", async () => {
		const { harness, callLog } = await setup("deferred", allowReadDenyWrite);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "read one symbol", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp__fixture__read_symbol", { name: "PolicyRule" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find and call a deferred tool");
		expect(calls(callLog)).toEqual(["read_symbol"]);
	});

	it("blocks a codemode nested write and records that the call was nested", async () => {
		const { harness, callLog, notifications, root } = await setup("codemode", allowReadDenyWrite);
		const target = join(root, "nested-must-not-exist.txt").replaceAll("\\", "/");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `return await tools.mcp__fixture__write_file({ path: ${JSON.stringify(target)}, content: "unsafe" });`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("try a nested write");
		await harness.session.prompt("/enhanced-mcp-policy-status");

		expect(calls(callLog)).toEqual([]);
		expect(existsSync(target)).toBe(false);
		expect(notifications.at(-1)).toContain("1 nested");
	});

	it("treats a newly announced tool as unknown and denies it without UI", async () => {
		const { harness, callLog, root } = await setup("direct", allowReadDenyWrite);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__fixture__refresh_tools", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("refreshed"),
		]);
		await harness.session.prompt("refresh tools");
		await vi.waitFor(() => expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__fixture__new_write"));

		const target = join(root, "new-must-not-exist.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__fixture__new_write", { path: target, content: "unsafe" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call the new tool");
		expect(calls(callLog)).toEqual(["refresh_tools"]);
		expect(existsSync(target)).toBe(false);
	});

	it("asks through dialog-capable UI and reload clears session audit state", async () => {
		const { harness, notifications } = await setup("direct", [], async () => true);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__fixture__read_symbol", { name: "Approved" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("approve once");
		await harness.session.prompt("/enhanced-mcp-policy-status");
		expect(notifications.at(-1)).toContain("1 recent");

		await harness.session.reload();
		await harness.session.prompt("/enhanced-mcp-policy-status");
		expect(notifications.at(-1)).toContain("0 recent");
	});

	it("blocks a user-rejected approval before the server sees the call", async () => {
		const { harness, callLog, root } = await setup("direct", [], async () => false);
		const target = join(root, "rejected-must-not-exist.txt");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("mcp__fixture__write_file", { path: target, content: "unsafe" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("reject the write");
		expect(getToolResult(harness, "mcp__fixture__write_file").isError).toBe(true);
		expect(calls(callLog)).toEqual([]);
		expect(existsSync(target)).toBe(false);
	});

	it("fails closed when policy configuration is invalid", async () => {
		const duplicateRules = [
			{ id: "duplicate", server: "fixture", tool: "read_symbol", action: "allow" },
			{ id: "duplicate", server: "fixture", tool: "write_file", action: "deny" },
		];
		const { harness, callLog } = await setup("direct", duplicateRules);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__fixture__read_symbol", { name: "MustNotRun" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("invalid policy must block");
		expect(getToolResult(harness, "mcp__fixture__read_symbol").isError).toBe(true);
		expect(calls(callLog)).toEqual([]);
	});

	it("handles repeated shutdown without leaking lifecycle errors", async () => {
		const { harness } = await setup("direct", allowReadDenyWrite);
		await expect(harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })).resolves.toBe(
			undefined,
		);
		await expect(harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })).resolves.toBe(
			undefined,
		);
	});
});
