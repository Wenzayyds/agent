import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { registerAdaptiveRouter } from "../ccr/adaptive.ts";
import { DockerSandboxBroker } from "./broker.ts";
import { loadSandboxConfig, type SandboxConfig } from "./config.ts";
import { SANDBOX_ALLOWED_TOOLS, SANDBOX_RESTORE_CHECK, type SandboxToolName } from "./protocol.ts";
import { isPytestConfig, pytestFileVersions } from "./pytest.ts";
import { registerPytestTool, registerSandboxTools } from "./tools.ts";

export function sandboxToolAllowed(
	toolName: string,
	readonlyModuleTools = false,
	taskPlanTool = false,
	pytest = false,
): boolean {
	return (
		(SANDBOX_ALLOWED_TOOLS as readonly string[]).includes(toolName) ||
		(readonlyModuleTools && ["enhanced_memory_search", "enhanced_task_get"].includes(toolName)) ||
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
): (pi: ExtensionAPI) => void {
	return (pi) => {
		let broker: DockerSandboxBroker | undefined;
		let config: SandboxConfig | undefined;
		let runTestsActive = false;
		const policy = isPytestConfig(pytestPolicy) ? pytestPolicy : undefined;
		const observe = adaptive && policy ? registerAdaptiveRouter(pi, () => {
			if (!runTestsActive || !broker || !config?.trusted) return undefined;
			try { return pytestFileVersions(config, policy); } catch { return undefined; }
		}, () => policy.tests, (file) => {
			try { return config && broker?.toRelative(resolve(config.workspace, file)); } catch { return undefined; }
		}) : undefined;
		pi.events.on(SANDBOX_RESTORE_CHECK, (deny) => {
			if ((broker || adaptive) && typeof deny === "function") deny();
		});
		pi.on("tool_call", (event) => {
			if (adaptive && (!broker || !runTestsActive || !config?.trusted))
				return { block: true, reason: "CCR auto requires a trusted Sandbox and pytest policy" };
			if (
				broker &&
				!sandboxToolAllowed(event.toolName, config?.readonlyModuleTools, config?.taskPlanTool, runTestsActive)
			) {
				return { block: true, reason: "Sandbox pilot only permits isolated file tools" };
			}
		});
		pi.on("session_start", (_event, ctx) => {
			runTestsActive = false;
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
				registerPytestTool(pi, config, policy, isActive, observe);
				runTestsActive = true;
				if (adaptive) pi.setActiveTools([...SANDBOX_ALLOWED_TOOLS, "run_tests"]);
			} else if (pytestPolicy !== undefined) {
				ctx.ui.notify("Invalid pytest configuration. run_tests is disabled.", "warning");
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
			broker?.stop();
			broker?.completeAudit();
			broker = undefined;
			config = undefined;
		});
	};
}
