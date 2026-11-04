import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOfflineDenialPolicy, ordinaryReadonlyOutside } from "../../benchmarks/real-agent/offline-denial-policy.ts";
import { classifyTermination } from "../../benchmarks/real-agent/result-classification.ts";
import { AUDIT_MAX_RECORDS, readSandboxAuditSnapshot, SandboxAuditJournal } from "../../src/sandbox/audit.ts";
import { assertSandboxWorkspaceIdentity } from "../../src/sandbox/config.ts";
import { createSandboxFixture } from "../fixtures/runner-support.ts";

const roots: string[] = [];
function fixture() {
	const { root, workspace, config } = createSandboxFixture("pi-batch-j-unit-");
	roots.push(root);
	const path = join(root, "audit.json");
	return { root, workspace, path, config: { ...config, auditReportPath: path } };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Batch J trusted policy and durable audit", () => {
	it("is disabled by default and rejects real-provider, project and malformed configuration", () => {
		const { root } = fixture();
		const path = join(root, "user-policy.json");
		writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode: "recover_readonly_denials", maxDenials: 2 }));
		expect(loadOfflineDenialPolicy(undefined, undefined, resolve("."))).toBeUndefined();
		expect(() => loadOfflineDenialPolicy(path, undefined, resolve("."))).toThrow("UNTRUSTED");
		expect(() => loadOfflineDenialPolicy(path, "http://127.0.0.1:1", root)).toThrow("PROJECT_FILE");
		expect(loadOfflineDenialPolicy(path, "http://127.0.0.1:1", resolve("."))?.maxDenials).toBe(2);
		writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode: "recover_readonly_denials", maxDenials: 99 }));
		expect(() => loadOfflineDenialPolicy(path, "http://127.0.0.1:1", resolve("."))).toThrow("INVALID");
	});
	it("distinguishes lexical parent traversal from symlink escape, metadata and invalid paths", () => {
		const { root, workspace } = fixture();
		symlinkSync(root, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
		expect(ordinaryReadonlyOutside(workspace, "..")).toBe(true);
		for (const input of ["escape", "escape/../..", ".git", "../missing", root, "C:\\Windows", null])
			expect(ordinaryReadonlyOutside(workspace, input)).toBe(false);
	});
	it("persists intent, then completion, and marks only an explicit shutdown complete", () => {
		const { path, config } = fixture();
		const journal = new SandboxAuditJournal(path, config);
		const pending = {
			runId: config.runId,
			requestId: "req1",
			toolName: "read",
			operation: "read_file",
			containerId: "abc",
			startedAt: Date.now(),
		};
		journal.begin(pending);
		expect(readSandboxAuditSnapshot(path)).toMatchObject({
			complete: false,
			missingOperationResults: ["req1"],
			unseenEventsPossible: true,
		});
		journal.end({
			...pending,
			toolName: "read",
			status: "ok",
			image: config.image,
			durationMs: 1,
			endedAt: Date.now(),
		});
		expect(readSandboxAuditSnapshot(path)).toMatchObject({ complete: false, missingOperationResults: [] });
		journal.complete();
		expect(readSandboxAuditSnapshot(path)).toMatchObject({ complete: true, recoveryState: "normal_shutdown" });
		expect(readFileSync(path, "utf8")).not.toContain(config.workspace);
	});
	it("detects altered and truncated snapshots without repairing or inventing evidence", () => {
		const { path, config } = fixture();
		new SandboxAuditJournal(path, config);
		const before = readFileSync(path, "utf8");
		writeFileSync(path, before.replace('"running"', '"completed"'));
		expect(() => readSandboxAuditSnapshot(path)).toThrow("INTEGRITY");
		writeFileSync(path, before.slice(0, -5));
		expect(() => readSandboxAuditSnapshot(path)).toThrow();
	});
	it("fails closed on journal write errors and cannot subsequently declare a complete audit", () => {
		const { path, config } = fixture();
		const journal = new SandboxAuditJournal(path, config);
		renameSync(path, `${path}.previous`);
		mkdirSync(path);
		expect(() =>
			journal.begin({
				runId: config.runId,
				requestId: "not-dispatched",
				toolName: "read",
				operation: "read_file",
				containerId: "abc",
				startedAt: Date.now(),
			}),
		).toThrow("SANDBOX_AUDIT_WRITE_FAILED");
		expect(() => journal.complete()).toThrow("SANDBOX_AUDIT_INCOMPLETE");
		expect(readSandboxAuditSnapshot(`${path}.previous`)).toMatchObject({
			complete: false,
			audit: [],
			unseenEventsPossible: true,
		});
	});
	it("rejects even checksummed inconsistent sequences and unfinished completion", () => {
		const { path, config } = fixture();
		new SandboxAuditJournal(path, config);
		const { sha256: _checksum, ...body } = JSON.parse(readFileSync(path, "utf8"));
		body.state = "completed";
		body.pending = [{ runId: config.runId, requestId: "missing" }];
		writeFileSync(
			path,
			JSON.stringify({ ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") }),
		);
		expect(() => readSandboxAuditSnapshot(path)).toThrow("SEQUENCE");
	});
	it("refuses audit files inside the model workspace and existing authoritative files", () => {
		const { workspace, path, config } = fixture();
		expect(() => new SandboxAuditJournal(join(workspace, "audit.json"), config)).toThrow("PATH");
		new SandboxAuditJournal(path, config);
		expect(() => new SandboxAuditJournal(path, config)).toThrow("PATH");
	});
	it("caps pending and completed records before dispatching further operations", () => {
		const { path, config } = fixture();
		const journal = new SandboxAuditJournal(path, config);
		for (let i = 0; i < AUDIT_MAX_RECORDS; i++)
			journal.begin({
				runId: config.runId,
				requestId: `req${i}`,
				toolName: "ls",
				operation: "list_dir",
				containerId: "abc",
				startedAt: Date.now(),
			});
		expect(() =>
			journal.begin({
				runId: config.runId,
				requestId: "over",
				toolName: "ls",
				operation: "list_dir",
				containerId: "abc",
				startedAt: Date.now(),
			}),
		).toThrow("LIMIT");
		expect(readSandboxAuditSnapshot(path)).toMatchObject({ state: "limit_reached", complete: false });
	});
	it("does not treat a replacement workspace as the original binding", () => {
		const { workspace, config } = fixture();
		renameSync(workspace, `${workspace}-old`);
		mkdirSync(workspace);
		expect(() => assertSandboxWorkspaceIdentity(config)).toThrow("IDENTITY_CHANGED");
	});
	it.each([
		["GATEWAY_ISOLATION_STOP", "isolation_boundary_stop"],
		["GATEWAY_TOKEN_BUDGET", "gateway_budget_stop"],
		["GATEWAY_USAGE_MISSING", "gateway_budget_stop"],
		["GATEWAY_UPSTREAM_HTTP_503", "gateway_provider_error"],
	])("classifies %s without rewriting legacy runStatus", (lastError, expected) => {
		expect(
			classifyTermination({
				events: [],
				lastError,
				gatewayState: "failed_closed",
				rejected: 0,
				runStatus: "gateway_error",
				verifierPassed: false,
			}),
		).toBe(expected);
	});
	it("keeps normal agent completion separate from failed verification", () => {
		expect(
			classifyTermination({
				events: [],
				lastError: null,
				gatewayState: "ready",
				rejected: 0,
				runStatus: "completed",
				verifierPassed: true,
				auditComplete: false,
			}),
		).toBe("sandbox_runtime_error");
		expect(
			classifyTermination({
				events: [],
				lastError: null,
				gatewayState: "ready",
				rejected: 0,
				runStatus: "completed",
				verifierPassed: false,
			}),
		).toBe("verification_failed");
	});
});
