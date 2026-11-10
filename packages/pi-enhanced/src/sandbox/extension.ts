import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DockerSandboxBroker } from "./broker.ts";
import { loadSandboxConfig, type SandboxConfig } from "./config.ts";
import { SANDBOX_ALLOWED_TOOLS } from "./protocol.ts";
import { type PytestConfig, registerPytestTool } from "./pytest.ts";
import { registerSandboxTools } from "./tools.ts";

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

export function createSandboxExtension(
	configSource: SandboxConfig | ((cwd: string) => SandboxConfig) = (cwd) => loadSandboxConfig(process.env, cwd),
	onBroker?: (broker: DockerSandboxBroker) => void,
	pytestPolicy: PytestConfig | undefined = process.env.PI_ENHANCED_PYTEST_ENABLED === "1"
		? (JSON.parse(process.env.PI_ENHANCED_PYTEST_CONFIG_JSON ?? "null") ?? undefined)
		: undefined,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		let broker: DockerSandboxBroker | undefined;
		let config: SandboxConfig | undefined;
		pi.on("tool_call", (event) => {
			if (
				broker &&
				!sandboxToolAllowed(event.toolName, config?.readonlyModuleTools, config?.taskPlanTool, !!pytestPolicy)
			) {
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
			if (pytestPolicy) {
				const activeConfig = config;
				registerPytestTool(pi, config, pytestPolicy, () => !!broker && config === activeConfig);
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
