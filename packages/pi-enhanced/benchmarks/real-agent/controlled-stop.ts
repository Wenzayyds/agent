import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NativeToolAuditRecord } from "../../src/mcp-policy/native-tool-guard.ts";
import { atomicPrivateJson, readSandboxAuditSnapshot } from "../../src/sandbox/audit.ts";
import { assertSandboxWorkspaceIdentity, loadSandboxConfig } from "../../src/sandbox/config.ts";
import { type OfflineDenialPolicy, ordinaryReadonlyOutside } from "./offline-denial-policy.ts";

export interface SafetyEvent {
	requestId: string;
	toolName: string;
	classification: "tool_denied_recoverable" | "isolation_boundary_stop" | "sandbox_runtime_error";
	reasonCode: string;
	at: number;
}

/** Awaited by Pi before the next model turn; this capability can only close the gateway. */
export default function controlledStop(pi: ExtensionAPI): void {
	installControlledStop(pi);
}

export function installControlledStop(pi: ExtensionAPI, policy?: OfflineDenialPolicy): void {
	const url = process.env.PI_ENHANCED_CONTROLLED_GATEWAY_URL;
	const token = process.env.PI_ENHANCED_GATEWAY_TOKEN;
	if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(url) || !token) throw new Error("CONTROLLED_STOP_CHANNEL_INVALID");
	const config = loadSandboxConfig(process.env, process.cwd());
	const events: SafetyEvent[] = [];
	let deniedCount = 0;
	const denied = new Map<string, { record: NativeToolAuditRecord; path: unknown }>();
	pi.events.on("pi-enhanced:native-denied", (data) => {
		const value = data as { record: NativeToolAuditRecord; path: unknown };
		if (denied.size >= 16) return; // Unmatched guard errors still stop below.
		if (value.record?.decision === "denied") denied.set(value.record.toolCallId, value);
	});
	pi.on("tool_execution_end", async (event) => {
		const refusal = denied.get(event.toolCallId);
		denied.delete(event.toolCallId);
		if (!event.isError) return;
		// Unknown/unauthorized tools are fatal too; no reliance on model-controlled output text.
		const text = JSON.stringify(event.result);
		const knownTool = [
			"read",
			"grep",
			"find",
			"ls",
			"write",
			"edit",
			...(config.readonlyModuleTools ? ["enhanced_memory_search", "enhanced_task_get"] : []),
		].includes(event.toolName);
		if (
			!refusal &&
			knownTool &&
			!/SANDBOX_|Native tool guard blocked|Sandbox pilot only permits|not found/iu.test(text)
		)
			return;
		let recoverable = false;
		let identityChanged = false;
		let containerUnavailable = false;
		if (refusal) {
			deniedCount++;
			try {
				assertSandboxWorkspaceIdentity(config);
			} catch {
				identityChanged = true;
			}
			recoverable = Boolean(
				!identityChanged &&
					policy &&
					deniedCount <= policy.maxDenials &&
					["read", "grep", "find", "ls"].includes(event.toolName) &&
					refusal.record.toolName === event.toolName &&
					refusal.record.risk === "read_only" &&
					refusal.record.reasonCode === "path-outside-workspace" &&
					ordinaryReadonlyOutside(config.workspace, refusal.path),
			);
		}
		if (recoverable) {
			try {
				const snapshot = readSandboxAuditSnapshot(config.auditReportPath!);
				const evidence = snapshot.evidence as { containerId: string };
				if (!/^[a-f0-9]{64}$/u.test(evidence.containerId)) throw new Error("SANDBOX_CONTAINER_ID_INVALID");
				const inspected = JSON.parse(
					execFileSync("docker", ["inspect", evidence.containerId], {
						encoding: "utf8",
						timeout: 2_000,
						windowsHide: true,
						stdio: ["ignore", "pipe", "pipe"],
					}),
				)[0] as {
					State: { Running: boolean };
					Image: string;
					HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean };
				};
				if (
					!inspected.State.Running ||
					inspected.Image !== config.image ||
					inspected.HostConfig.NetworkMode !== "none" ||
					!inspected.HostConfig.ReadonlyRootfs ||
					inspected.HostConfig.Privileged
				)
					throw new Error("SANDBOX_CONTAINER_POLICY_MISMATCH");
			} catch {
				recoverable = false;
				containerUnavailable = true;
			}
		}
		if (!refusal && !knownTool) deniedCount++;
		const boundaryError =
			identityChanged ||
			/SANDBOX_(?:WORKSPACE_IDENTITY|PATH_ESCAPE|CONTAINER_POLICY_MISMATCH|RUN_ID_MISMATCH|REQUEST_ID_MISMATCH|TOOL_NAME_MISMATCH|PROTOCOL_MISMATCH)/u.test(
				text,
			);
		const classification = recoverable
			? "tool_denied_recoverable"
			: containerUnavailable
				? "sandbox_runtime_error"
				: refusal || boundaryError || !/SANDBOX_/u.test(text)
					? "isolation_boundary_stop"
					: "sandbox_runtime_error";
		const reasonCode = containerUnavailable
			? "SANDBOX_CONTAINER_UNAVAILABLE"
			: identityChanged
				? "SANDBOX_WORKSPACE_IDENTITY_CHANGED"
				: refusal
					? deniedCount > (policy?.maxDenials ?? Number.POSITIVE_INFINITY)
						? "readonly-denial-limit"
						: refusal.record.reasonCode
					: (text.match(/(?:SANDBOX|SWE_WRITE)_[A-Z_]+/u)?.[0] ?? "unauthorized-tool");
		if (events.length < 16)
			events.push({
				requestId: createHash("sha256").update(event.toolCallId).digest("hex"),
				toolName: knownTool ? event.toolName : "[unknown]",
				classification,
				reasonCode,
				at: Date.now(),
			});
		try {
			atomicPrivateJson(join(config.runRoot, "tool-safety.json"), {
				schemaVersion: 1,
				runId: config.runId,
				policy: policy?.mode ?? "strict",
				deniedCount,
				recoverableDenials: events.filter((entry) => entry.classification === "tool_denied_recoverable").length,
				fatalEvents: events.filter((entry) => entry.classification !== "tool_denied_recoverable").length,
				events,
			});
		} catch {
			process.exit(74);
		}
		if (recoverable) return;
		try {
			const response = await fetch(`${url}/__budget/stop-isolation`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(2_000),
			});
			if (!response.ok) process.exit(74);
		} catch {
			process.exit(74);
		}
	});
}
