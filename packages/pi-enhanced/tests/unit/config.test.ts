import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpPolicyConfig } from "../../src/mcp-policy/config.ts";
import { evaluatePolicy } from "../../src/mcp-policy/policy.ts";
import { ENHANCED_CONFIG_FILE, loadEnhancedConfig } from "../../src/shared/config.ts";
import { ENHANCED_MODULE_NAMES } from "../../src/shared/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-policy-"));
	tempDirs.push(path);
	return path;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P0 shared configuration regression", () => {
	it("keeps all four modules disabled by default and independently switchable", () => {
		for (const enabled of ENHANCED_MODULE_NAMES) {
			const root = tempDir();
			const agentDir = join(root, "agent");
			writeJson(join(agentDir, ENHANCED_CONFIG_FILE), { modules: { [enabled]: { enabled: true } } });
			const loaded = loadEnhancedConfig({ agentDir, cwd: root, projectTrusted: false });
			for (const name of ENHANCED_MODULE_NAMES) {
				expect(loaded.config.modules[name].enabled).toBe(name === enabled);
			}
		}
	});
});

describe("layered MCP policy configuration", () => {
	it("does not let a trusted project disable user policy or override an explicit user deny", () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectFile = join(root, "project", ".pi", ENHANCED_CONFIG_FILE);
		writeJson(join(agentDir, ENHANCED_CONFIG_FILE), {
			modules: {
				"mcp-policy": {
					enabled: true,
					rules: [{ id: "user-deny", server: "fixture", tool: "write_file", action: "deny" }],
				},
			},
		});
		writeJson(projectFile, {
			modules: {
				"mcp-policy": {
					enabled: false,
					rules: [{ id: "project-allow", server: "fixture", tool: "write_file", action: "allow" }],
				},
			},
		});

		const loaded = loadMcpPolicyConfig({ agentDir, cwd: join(root, "project"), projectTrusted: true });
		expect(loaded.config.enabled).toBe(true);
		expect(
			evaluatePolicy(
				{
					server: "fixture",
					tool: "write_file",
					fullToolName: "mcp__fixture__write_file",
					arguments: {},
				},
				loaded.config.rules,
				loaded.config.defaultAction,
			),
		).toMatchObject({ action: "deny", ruleId: "user-deny" });
	});

	it("ignores project policy until the project is trusted", () => {
		const root = tempDir();
		const project = join(root, "project");
		writeJson(join(project, ".pi", ENHANCED_CONFIG_FILE), {
			modules: { "mcp-policy": { enabled: true, defaultAction: "deny" } },
		});
		const loaded = loadMcpPolicyConfig({ agentDir: join(root, "agent"), cwd: project, projectTrusted: false });
		expect(loaded.config.enabled).toBe(false);
		expect(loaded.sources).toEqual([]);
	});

	it("fails closed for invalid policy, duplicate ids, and unsafe default allow", () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		writeJson(join(agentDir, ENHANCED_CONFIG_FILE), {
			modules: {
				"mcp-policy": {
					enabled: true,
					defaultAction: "allow",
					rules: [
						{ id: "same", action: "allow", tool: "read_symbol" },
						{ id: "same", action: "deny", tool: "write_file" },
					],
				},
			},
		});
		const loaded = loadMcpPolicyConfig({ agentDir, cwd: root, projectTrusted: false });
		expect(loaded.failClosed).toBe(true);
		expect(loaded.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("defaultAction must be ask or deny"),
				expect.stringContaining('duplicate mcp-policy rule id "same"'),
			]),
		);
	});
});
