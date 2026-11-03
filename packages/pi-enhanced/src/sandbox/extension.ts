import { createHash } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DockerSandboxBroker } from "./broker.ts";
import { loadSandboxConfig, type SandboxConfig } from "./config.ts";
import { SANDBOX_ALLOWED_TOOLS } from "./protocol.ts";
import { registerSandboxTools } from "./tools.ts";

export function sandboxToolAllowed(toolName: string, readonlyModuleTools = false): boolean {
	return (
		(SANDBOX_ALLOWED_TOOLS as readonly string[]).includes(toolName) ||
		(readonlyModuleTools && ["enhanced_memory_search", "enhanced_task_get"].includes(toolName))
	);
}

export function createSandboxExtension(
	configSource: SandboxConfig | ((cwd: string) => SandboxConfig) = (cwd) => loadSandboxConfig(process.env, cwd),
	onBroker?: (broker: DockerSandboxBroker) => void,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		let broker: DockerSandboxBroker | undefined;
		let config: SandboxConfig | undefined;
		pi.on("tool_call", (event) => {
			if (broker && !sandboxToolAllowed(event.toolName, config?.readonlyModuleTools)) {
				return { block: true, reason: "Sandbox pilot only permits isolated file tools" };
			}
		});
		pi.on("session_start", (_event, ctx) => {
			config = typeof configSource === "function" ? configSource(ctx.cwd) : configSource;
			if (!config.enabled) return;
			broker?.stop();
			broker = new DockerSandboxBroker(config);
			onBroker?.(broker);
			registerSandboxTools(pi, broker, config.workspace);
			broker.start();
		});
		pi.on("session_before_switch", () => {
			broker?.stop();
			broker = undefined;
		});
		pi.on("session_before_fork", () => {
			broker?.stop();
			broker = undefined;
		});
		pi.on("session_shutdown", () => {
			if (broker && config?.auditReportPath) {
				writeFileSync(
					config.auditReportPath,
					`${JSON.stringify(
						{
							schemaVersion: 1,
							runId: config.runId,
							workspaceSha256: createHash("sha256").update(config.workspace).digest("hex"),
							evidence: broker.getEvidence(),
							audit: broker.getAuditRecords(),
						},
						null,
						2,
					)}\n`,
					{ flag: "wx" },
				);
			}
			broker?.stop();
			broker = undefined;
			config = undefined;
		});
	};
}

export function sandboxConfigForTesting(overrides: Partial<SandboxConfig>): SandboxConfig {
	const workspace = overrides.workspace ?? process.cwd();
	const stat = lstatSync(workspace);
	return {
		enabled: true,
		trusted: true,
		runId: "sandbox-test",
		runRoot: dirname(workspace),
		workspace,
		workspaceDevice: stat.dev,
		workspaceInode: stat.ino,
		image: "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293",
		timeoutMs: 10_000,
		maxRequestBytes: 1024 * 1024,
		maxResponseBytes: 2 * 1024 * 1024,
		...overrides,
	};
}
