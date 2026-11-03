import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerSandboxBroker } from "../../src/sandbox/broker.ts";
import { sandboxToolAllowed } from "../../src/sandbox/extension.ts";
import { assertSandboxWorkspaceIdentity, loadSandboxConfig } from "../../src/sandbox/config.ts";
import {
	SANDBOX_PROTOCOL_VERSION,
	assertRequestId,
	assertRunId,
	validateSandboxResponse,
} from "../../src/sandbox/protocol.ts";

describe("Docker sandbox protocol", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	it("is disabled by default without registering an implicit trusted workspace", () => {
		const config = loadSandboxConfig({}, process.cwd());
		expect(config).toMatchObject({ enabled: false, trusted: false, runId: "disabled" });
	});
	it("allows only explicitly enabled read-only module tools alongside Docker file tools", () => {
		for (const name of ["enhanced_memory_search", "enhanced_task_get"]) {
			expect(sandboxToolAllowed(name)).toBe(false);
			expect(sandboxToolAllowed(name, true)).toBe(true);
		}
		for (const name of ["bash", "mcp", "enhanced_task_propose_plan", "enhanced_memory_write", "unknown"]) {
			expect(sandboxToolAllowed(name, true)).toBe(false);
		}
		expect(sandboxToolAllowed("edit", true)).toBe(true);
	});

	it("requires bounded identifiers and a pinned image", () => {
		expect(() => assertRunId("run/escape")).toThrow("SANDBOX_INVALID_RUN_ID");
		expect(() => assertRequestId("bad id")).toThrow("SANDBOX_INVALID_REQUEST_ID");
		expect(() =>
			loadSandboxConfig(
				{
					PI_ENHANCED_SANDBOX_ENABLED: "1",
					PI_ENHANCED_SANDBOX_TRUSTED: "1",
					PI_ENHANCED_SANDBOX_RUN_ID: "test",
					PI_ENHANCED_SANDBOX_RUN_ROOT: tmpdir(),
					PI_ENHANCED_SANDBOX_WORKSPACE: process.cwd(),
					PI_ENHANCED_SANDBOX_IMAGE: "node:latest",
				},
				process.cwd(),
			),
		).toThrow("SANDBOX_WORKSPACE_NOT_TEMPORARY");
	});

	it("reproduces the H3 sibling-temp rejection and accepts only the runner root handoff", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-identity-"));
		roots.push(root);
		const workspace = join(root, "中文 fixture");
		const oldChildTemp = join(root, "temp");
		mkdirSync(workspace);
		mkdirSync(oldChildTemp);
		const base = {
			PI_ENHANCED_SANDBOX_ENABLED: "1",
			PI_ENHANCED_SANDBOX_TRUSTED: "1",
			PI_ENHANCED_SANDBOX_RUN_ID: "identity-test",
			PI_ENHANCED_SANDBOX_WORKSPACE: workspace,
			PI_ENHANCED_SANDBOX_IMAGE: "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293",
		};
		expect(() =>
			loadSandboxConfig({ ...base, PI_ENHANCED_SANDBOX_RUN_ROOT: oldChildTemp }, workspace, oldChildTemp),
		).toThrow("SANDBOX_WORKSPACE_NOT_TEMPORARY");
		const config = loadSandboxConfig({ ...base, PI_ENHANCED_SANDBOX_RUN_ROOT: root }, workspace, root);
		expect(config).toMatchObject({ runRoot: root, workspace });
		if (process.platform === "win32") {
			const alternateRoot = `${root[0]!.toLowerCase()}${root.slice(1)}`;
			const alternateWorkspace = `${workspace[0]!.toLowerCase()}${workspace.slice(1)}`;
			const alternateConfig = loadSandboxConfig({
				...base,
				PI_ENHANCED_SANDBOX_RUN_ROOT: alternateRoot,
				PI_ENHANCED_SANDBOX_WORKSPACE: alternateWorkspace,
			}, alternateWorkspace, alternateRoot);
			expect(alternateConfig.runRoot.toLowerCase()).toBe(root.toLowerCase());
			expect(alternateConfig.workspace.toLowerCase()).toBe(workspace.toLowerCase());
		}
		renameSync(workspace, `${workspace}-old`);
		mkdirSync(workspace);
		expect(() => assertSandboxWorkspaceIdentity(config)).toThrow("SANDBOX_WORKSPACE_IDENTITY_CHANGED");
	});

	it("rejects a mismatched run root and an ordinary project outside the controlled root", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-controlled-"));
		const other = mkdtempSync(join(tmpdir(), "pi-enhanced-ordinary-"));
		roots.push(root, other);
		const workspace = join(root, "fixture");
		mkdirSync(workspace);
		const env = {
			PI_ENHANCED_SANDBOX_ENABLED: "1",
			PI_ENHANCED_SANDBOX_TRUSTED: "1",
			PI_ENHANCED_SANDBOX_RUN_ID: "identity-negative",
			PI_ENHANCED_SANDBOX_RUN_ROOT: root,
			PI_ENHANCED_SANDBOX_WORKSPACE: workspace,
		};
		expect(() => loadSandboxConfig(env, workspace, other)).toThrow("SANDBOX_RUN_ROOT_TEMP_MISMATCH");
		expect(() => loadSandboxConfig({ ...env, PI_ENHANCED_SANDBOX_WORKSPACE: other }, other, root)).toThrow(
			"SANDBOX_WORKSPACE_NOT_TEMPORARY",
		);
	});

	it("rejects stale, cross-run, cross-tool, and oversized worker responses", () => {
		const expected = { runId: "run", requestId: "request", toolName: "read" as const };
		const base = {
			protocolVersion: SANDBOX_PROTOCOL_VERSION,
			runId: "run",
			requestId: "request",
			toolName: "read",
			status: "ok",
			result: {},
		};
		expect(validateSandboxResponse(base, expected, 1024)).toMatchObject({ status: "ok" });
		expect(() => validateSandboxResponse({ ...base, runId: "old" }, expected, 1024)).toThrow(
			"SANDBOX_RUN_ID_MISMATCH",
		);
		expect(() => validateSandboxResponse({ ...base, requestId: "late" }, expected, 1024)).toThrow(
			"SANDBOX_REQUEST_ID_MISMATCH",
		);
		expect(() => validateSandboxResponse({ ...base, toolName: "write" }, expected, 1024)).toThrow(
			"SANDBOX_TOOL_NAME_MISMATCH",
		);
		expect(() => validateSandboxResponse({ ...base, result: "x".repeat(2048) }, expected, 1024)).toThrow(
			"SANDBOX_RESPONSE_TOO_LARGE",
		);
	});

	it("does not accept a workspace path that merely shares a textual prefix", () => {
		const stat = lstatSync(process.cwd());
		const broker = new DockerSandboxBroker({
			enabled: true,
			trusted: true,
			runId: "path-test",
			runRoot: join(process.cwd(), ".."),
			workspace: process.cwd(),
			workspaceDevice: stat.dev,
			workspaceInode: stat.ino,
			image: "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293",
			timeoutMs: 10_000,
			maxRequestBytes: 1024,
			maxResponseBytes: 1024,
		});
		expect(() => broker.toRelative(join(process.cwd(), "..", "not-the-workspace"))).toThrow(
			"SANDBOX_PATH_ESCAPE",
		);
		if (process.platform === "win32") {
			expect(() => broker.toRelative("C:\\Windows\\System32\\drivers\\etc\\hosts")).toThrow(
				"SANDBOX_PATH_ESCAPE",
			);
			expect(() => broker.toRelative("\\\\server\\share\\secret")).toThrow("SANDBOX_PATH_ESCAPE");
		}
	});
});
