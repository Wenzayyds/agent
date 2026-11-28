import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdaptiveRouter } from "../ccr/adaptive.ts";
import { isKnowledgeTool } from "../knowledge/tools.ts";
import { DockerSandboxBroker } from "./broker.ts";
import { loadSandboxConfig, type SandboxConfig } from "./config.ts";
import { SANDBOX_ALLOWED_TOOLS, SANDBOX_RESTORE_CHECK, type SandboxToolName } from "./protocol.ts";
import { isPytestConfig, MAX_PYTEST_TARGETS, pytestFileVersions } from "./pytest.ts";
import { registerTaskPytestSource } from "./task-evidence.ts";
import { registerPytestTool, registerSandboxTools } from "./tools.ts";

export function sandboxToolAllowed(
	toolName: string,
	readonlyModuleTools = false,
	taskPlanTool = false,
	pytest = false,
	readonlyKnowledgeTools = false,
): boolean {
	return (
		(SANDBOX_ALLOWED_TOOLS as readonly string[]).includes(toolName) ||
		(readonlyModuleTools && ["enhanced_memory_search", "enhanced_task_get"].includes(toolName)) ||
		(readonlyKnowledgeTools && isKnowledgeTool(toolName)) ||
		(taskPlanTool && toolName === "enhanced_task_plan_update") ||
		(pytest && toolName === "run_tests")
	);
}

function loadPytestPolicy(): unknown {
	if (process.env.PI_ENHANCED_PYTEST_ENABLED !== "1") return undefined;
	try {
		return JSON.parse(process.env.PI_ENHANCED_PYTEST_CONFIG_JSON ?? "null") ?? undefined;
	} catch {
		return false;
	}
}

export function createSandboxExtension(
	configSource: SandboxConfig | ((cwd: string) => SandboxConfig) = (cwd) => loadSandboxConfig(process.env, cwd),
	onBroker?: (broker: DockerSandboxBroker) => void,
	pytestPolicy: unknown = loadPytestPolicy(),
	adaptive = false,
	registerTests?: (pi: ExtensionAPI, config: SandboxConfig, isActive: () => boolean) => void,
	fileToolDescriptions?: Partial<Record<SandboxToolName, string>>,
	toolScope?: { reads: readonly string[]; edits: readonly string[]; readonlyMcpTool?: `mcp__${string}__${string}` },
): (pi: ExtensionAPI) => void {
	return (pi) => {
		let broker: DockerSandboxBroker | undefined;
		let config: SandboxConfig | undefined;
		let runTestsActive = false;
		let closeTaskEvidence: (() => void) | undefined;
		const policy = isPytestConfig(pytestPolicy) ? structuredClone(pytestPolicy) : undefined;
		const observe =
			adaptive && policy
				? registerAdaptiveRouter(
						pi,
						() => {
							if (!runTestsActive || !broker || !config?.trusted) return undefined;
							try {
								return pytestFileVersions(config, policy);
							} catch {
								return undefined;
							}
						},
						() => policy.tests,
						(file) => {
							try {
								return config && broker?.toRelative(resolve(config.workspace, file));
							} catch {
								return undefined;
							}
						},
					)
				: undefined;
		pi.events.on(SANDBOX_RESTORE_CHECK, (deny) => {
			if ((broker || adaptive) && typeof deny === "function") deny();
		});
		pi.on("tool_call", (event) => {
			if (toolScope) {
				const path = "path" in event.input ? event.input.path : undefined;
				const allowed =
					(event.toolName === "read" && typeof path === "string" && toolScope.reads.includes(path)) ||
					(event.toolName === "edit" && typeof path === "string" && toolScope.edits.includes(path)) ||
					event.toolName === toolScope.readonlyMcpTool ||
					(config?.readonlyKnowledgeTools && isKnowledgeTool(event.toolName));
				if (!broker || !config?.trusted || !allowed)
					return { block: true, reason: "Tool or path outside the configured Sandbox scope" };
				return;
			}
			if (adaptive && (!broker || !runTestsActive || !config?.trusted))
				return { block: true, reason: "CCR auto requires a trusted Sandbox and pytest policy" };
			if (
				broker &&
				!sandboxToolAllowed(
					event.toolName,
					config?.readonlyModuleTools,
					config?.taskPlanTool,
					runTestsActive,
					config?.trusted && config.readonlyKnowledgeTools,
				)
			) {
				return { block: true, reason: "Sandbox pilot only permits isolated file tools" };
			}
		});
		pi.on("session_start", (_event, ctx) => {
			runTestsActive = false;
			closeTaskEvidence?.();
			config = typeof configSource === "function" ? configSource(ctx.cwd) : configSource;
			if (!config.enabled) return;
			broker?.stop();
			broker = new DockerSandboxBroker(config);
			onBroker?.(broker);
			registerSandboxTools(pi, broker, config.workspace, fileToolDescriptions);
			broker.start();
			const activeConfig = config;
			const isActive = () => runTestsActive && !!broker && config === activeConfig;
			if (registerTests) {
				registerTests(pi, config, isActive);
				runTestsActive = true;
				pi.setActiveTools([...SANDBOX_ALLOWED_TOOLS, "run_tests"]);
			} else if (policy) {
				const evidence = registerTaskPytestSource(pi.events, config, policy, isActive);
				closeTaskEvidence = evidence.close;
				registerPytestTool(pi, config, policy, isActive, observe, evidence.begin);
				runTestsActive = true;
				if (adaptive) pi.setActiveTools([...SANDBOX_ALLOWED_TOOLS, "run_tests"]);
			} else if (pytestPolicy !== undefined) {
				const targets = typeof pytestPolicy === "object" && pytestPolicy && "tests" in pytestPolicy ? pytestPolicy.tests : undefined;
				const reason = Array.isArray(targets) && targets.length > MAX_PYTEST_TARGETS
					? `Configured ${targets.length} pytest targets, maximum ${MAX_PYTEST_TARGETS}.`
					: "Invalid pytest configuration.";
				ctx.ui.notify(`${reason} run_tests is disabled.`, "warning");
			}
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
			closeTaskEvidence?.();
			broker?.stop();
			broker?.completeAudit();
			broker = undefined;
			config = undefined;
		});
	};
}
