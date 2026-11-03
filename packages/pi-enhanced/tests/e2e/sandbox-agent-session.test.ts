import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHarness, getToolResult, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import type { DockerSandboxBroker } from "../../src/sandbox/broker.ts";
import { createSandboxExtension, sandboxConfigForTesting } from "../../src/sandbox/extension.ts";

const image = "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293";
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const dockerAvailable =
	spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 }).status === 0;
const harnesses: Harness[] = [];
const brokers: DockerSandboxBroker[] = [];
const externalRoots: string[] = [];
const integrationEvidence: Record<string, unknown> = {
	schemaVersion: 1,
	status: "running",
	image,
	modelCalls: 0,
	modelCostUsd: 0,
	checks: {},
};

afterAll(() => {
	const output = process.env.PI_ENHANCED_SANDBOX_REPORT_PATH;
	if (!output) return;
	integrationEvidence.status = "passed";
	integrationEvidence.generatedAt = new Date().toISOString();
	integrationEvidence.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
	writeFileSync(output, `${JSON.stringify(integrationEvidence, null, 2)}\n`);
});

afterEach(() => {
	for (const broker of brokers.splice(0)) broker.stop();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of externalRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable)("real AgentSession Docker file tools", () => {
	it(
		"dispatches all six overridden Pi tools through the restricted container",
		async () => {
			const extension = createSandboxExtension(
				(cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "agent-session-six-tools" }),
				(broker) => brokers.push(broker),
			);
			const harness = await createHarness({
				allowedToolNames: ["read", "grep", "find", "ls", "write", "edit"],
				extensionFactories: [extension],
			});
			harnesses.push(harness);
			mkdirSync(join(harness.tempDir, "中文 目录"));
			writeFileSync(join(harness.tempDir, "中文 目录", "fixture.txt"), "alpha\r\nbeta\r\n", "utf8");
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "中文 目录/fixture.txt", limit: 1 })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("grep", { pattern: "beta", path: "中文 目录" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("find", { pattern: "*.txt", path: "中文 目录" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("ls", { path: "中文 目录" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("write", { path: "中文 目录/new file.txt", content: "before\n" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("edit", { path: "中文 目录/new file.txt", edits: [{ oldText: "before", newText: "after" }] })], { stopReason: "toolUse" }),
				fauxAssistantMessage([
					fauxToolCall("read", { path: "中文 目录/fixture.txt" }),
					fauxToolCall("read", { path: "中文 目录/new file.txt" }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("exercise isolated tools");

			const readResults = harness.session.messages.filter(
				(message) => message.role === "toolResult" && message.toolName === "read",
			);
			expect(
				readResults.some((message) =>
					message.content.some((content) => content.type === "text" && content.text.includes("alpha")),
				),
			).toBe(true);
			expect(getToolResult(harness, "grep").content[0]).toMatchObject({ type: "text", text: expect.stringContaining("beta") });
			expect(getToolResult(harness, "find").content[0]).toMatchObject({ type: "text", text: expect.stringContaining("fixture.txt") });
			expect(getToolResult(harness, "ls").content[0]).toMatchObject({ type: "text", text: expect.stringContaining("fixture.txt") });
			expect(getToolResult(harness, "edit").details).toMatchObject({ patch: expect.stringContaining("+after") });
			expect(readFileSync(join(harness.tempDir, "中文 目录", "new file.txt"), "utf8")).toBe("after\n");

			const broker = brokers[0]!;
			const successfulTools = new Set(broker.getAuditRecords().filter((record) => record.status === "ok").map((record) => record.toolName));
			expect(successfulTools).toEqual(new Set(["read", "grep", "find", "ls", "write", "edit"]));
			expect(broker.getEvidence()).toMatchObject({
				image,
				network: "none",
				readOnlyRoot: true,
				user: `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
				mounts: [{ destination: "/workspace", readWrite: true }],
			});
			expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(8);
			await expect(
				broker.request("read", "read_file", { path: "中文 目录/fixture.txt" }, { requestId: "duplicate-check" }),
			).resolves.toBeDefined();
			await expect(
				broker.request("read", "read_file", { path: "中文 目录/fixture.txt" }, { requestId: "duplicate-check" }),
			).rejects.toThrow("SANDBOX_DUPLICATE_REQUEST");
			await expect(
				broker.request(
					"write",
					"write_file",
					{ path: "oversized.txt", content: "x".repeat(1024 * 1024) },
					{ requestId: "oversized-request" },
				),
			).rejects.toThrow("SANDBOX_REQUEST_TOO_LARGE");
			const aborted = new AbortController();
			aborted.abort();
			await expect(
				broker.request("read", "read_file", { path: "中文 目录/fixture.txt" }, { requestId: "aborted-check", signal: aborted.signal }),
			).rejects.toThrow("SANDBOX_ABORTED");
			const isolation = JSON.parse(
				execFileSync(
					"docker",
					[
						"exec",
						broker.getEvidence()!.containerId,
						"node",
						"-e",
						"const fs=require('fs');(async()=>{let rootWrite=false,network=false,host=false;try{fs.writeFileSync('/blocked','x');rootWrite=true}catch{}try{await fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1000)});network=true}catch{}host=fs.existsSync('/host-sentinel');process.stdout.write(JSON.stringify({rootWrite,network,host}))})()",
					],
					{ encoding: "utf8", timeout: 5_000 },
				),
			) as { rootWrite: boolean; network: boolean; host: boolean };
			expect(isolation).toEqual({ rootWrite: false, network: false, host: false });
			integrationEvidence.integratedContainer = {
				containerId: broker.getEvidence()!.containerId,
				image: broker.getEvidence()!.image,
				network: broker.getEvidence()!.network,
				readOnlyRoot: broker.getEvidence()!.readOnlyRoot,
				user: broker.getEvidence()!.user,
				mounts: broker.getEvidence()!.mounts,
			};
			integrationEvidence.toolCoverage = [...successfulTools].sort();
			integrationEvidence.auditRecords = broker.getAuditRecords().length;
			integrationEvidence.outputSha256 = sha256(join(harness.tempDir, "中文 目录", "new file.txt"));
			integrationEvidence.isolation = isolation;
			integrationEvidence.duplicateRequestFailClosed = true;
			integrationEvidence.oversizedRequestFailClosed = true;
			integrationEvidence.preAbortedRequestFailClosed = true;
			const activeRead = harness.session.agent.state.tools.find((tool) => tool.name === "read");
			expect(activeRead).toBeDefined();
			const inFlightAbort = new AbortController();
			const pendingRead = activeRead!.execute(
				"in-flight-abort",
				{ path: "中文 目录/fixture.txt" },
				inFlightAbort.signal,
			);
			setTimeout(() => inFlightAbort.abort(), 0);
			await expect(pendingRead).rejects.toThrow("SANDBOX_ABORTED");
			integrationEvidence.inFlightAbortFailClosed = true;
		},
		120_000,
	);

	it(
		"rejects path escape and container failure without a host fallback",
		async () => {
			const extension = createSandboxExtension(
				(cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "agent-session-negative" }),
				(broker) => brokers.push(broker),
			);
			const harness = await createHarness({
				allowedToolNames: ["read", "write"],
				extensionFactories: [extension],
			});
			harnesses.push(harness);
			const sentinel = join(harness.tempDir, "sentinel.txt");
			writeFileSync(sentinel, "unchanged", "utf8");
			writeFileSync(join(harness.tempDir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
			writeFileSync(join(harness.tempDir, "too-large.txt"), "x".repeat(1024 * 1024 + 1), "utf8");
			const outside = mkdtempSync(join(tmpdir(), "pi-sandbox-outside-"));
			externalRoots.push(outside);
			writeFileSync(join(outside, "secret.txt"), "fake-secret-must-not-leak", "utf8");
			symlinkSync(outside, join(harness.tempDir, "escape-link"), process.platform === "win32" ? "junction" : "dir");
			const before = sha256(sentinel);
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "../outside.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: "\\\\server\\share\\secret" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: ".git/config" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: ".pi/config.json" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: ".ssh/id_ed25519" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: ".aws/credentials" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: "escape-link/secret.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: "binary.bin" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: "too-large.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("escape rejected"),
			]);
			await harness.session.prompt("try escape");
			const rejectedReads = harness.session.messages.filter(
				(message) => message.role === "toolResult" && message.toolName === "read",
			);
			expect(rejectedReads).toHaveLength(10);
			expect(rejectedReads.every((message) => message.isError)).toBe(true);
			expect(JSON.stringify(rejectedReads)).not.toContain("fake-secret-must-not-leak");

			const broker = brokers[0]!;
			const containerId = broker.getEvidence()!.containerId;
			execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore", timeout: 10_000 });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: "sentinel.txt", content: "changed" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("container failure rejected"),
			]);
			await harness.session.prompt("try after worker failure");
			expect(getToolResult(harness, "write").isError).toBe(true);
			expect(sha256(sentinel)).toBe(before);
			expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
			integrationEvidence.hostSentinel = { beforeSha256: before, afterSha256: sha256(sentinel), unchanged: true };
			integrationEvidence.pathRejections = [
				"parent",
				"windows-drive",
				"unc",
				"git-metadata",
				"pi-metadata",
				"ssh-metadata",
				"aws-metadata",
				"junction",
				"binary",
				"oversized-file",
			];
			integrationEvidence.containerFailureFailClosed = true;
		},
		90_000,
	);

	it(
		"runs an earlier tool_call guard before the worker and blocks unknown tools",
		async () => {
			const extension = createSandboxExtension(
				(cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "agent-session-guard" }),
				(broker) => brokers.push(broker),
			);
			const harness = await createHarness({
				initialActiveToolNames: ["write", "bash"],
				extensionFactories: [
					(pi) => pi.on("tool_call", (event) => event.toolName === "write" ? { block: true, reason: "guard denied" } : undefined),
					extension,
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: "blocked.txt", content: "no" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo no" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("guard order");
			expect(harness.session.messages.filter((message) => message.role === "toolResult").every((message) => message.isError)).toBe(true);
			expect(brokers[0]!.getAuditRecords()).toHaveLength(0);
			integrationEvidence.guardBlockedBeforeWorker = true;
		},
		60_000,
	);

	it("fails closed when the pinned image is unavailable", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read"] });
		harnesses.push(harness);
		const broker = new (await import("../../src/sandbox/broker.ts")).DockerSandboxBroker(
			sandboxConfigForTesting({
				workspace: harness.tempDir,
				runId: "missing-image",
				image: `sha256:${"0".repeat(64)}`,
			}),
		);
		brokers.push(broker);
		expect(() => broker.start()).toThrow("SANDBOX_EXECUTION_FAILED");
		expect(broker.getAuditRecords()).toHaveLength(0);
		integrationEvidence.missingImageFailClosed = true;
	});

	it(
		"loads the installed sandbox extension and executes read through AgentSession",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-sandbox-installed-"));
			externalRoots.push(root);
			const pack = spawnSync(
				process.execPath,
				[npmCli, "pack", "--json", "--pack-destination", root, "./packages/pi-enhanced"],
				{ cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
			);
			expect(pack.status, pack.stderr).toBe(0);
			const tarball = join(root, (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]!.filename);
			const installRoot = join(root, "installed");
			const install = spawnSync(
				process.execPath,
				[npmCli, "install", "--prefix", installRoot, "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=peer", tarball],
				{ cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
			);
			expect(install.status, install.stderr).toBe(0);
			const peerScope = join(installRoot, "node_modules", "@earendil-works");
			mkdirSync(peerScope, { recursive: true });
			for (const [name, source] of [["pi-coding-agent", "coding-agent"], ["pi-ai", "ai"], ["pi-agent-core", "agent"]] as const) {
				symlinkSync(join(repositoryRoot, "packages", source), join(peerScope, name), "junction");
			}
			const installed = join(installRoot, "node_modules", "@wz-agent", "pi-enhanced");
			const entryModule = await import(pathToFileURL(join(installed, "extensions", "sandbox.ts")).href) as {
				default: (pi: Parameters<ReturnType<typeof createSandboxExtension>>[0]) => void;
			};
			expect(typeof entryModule.default).toBe("function");
			const installedModule = await import(pathToFileURL(join(installed, "src", "sandbox", "extension.ts")).href) as {
				createSandboxExtension: typeof createSandboxExtension;
			};
			const installedExtension = installedModule.createSandboxExtension(
				(cwd) => sandboxConfigForTesting({ workspace: cwd, runId: "installed-extension-e2e" }),
				(broker) => brokers.push(broker),
			);
			const harness = await createHarness({
				allowedToolNames: ["read"],
				extensionFactories: [installedExtension],
			});
			harnesses.push(harness);
			writeFileSync(join(harness.tempDir, "installed.txt"), "installed-extension-container-read", "utf8");
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "installed.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("installed sandbox read");
			expect(getToolResult(harness, "read").content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("installed-extension-container-read"),
			});
			integrationEvidence.installedPackageAgentSession = true;
		},
		120_000,
	);
});

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
