import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadEnhancedConfig } from "./config.ts";
import type { EnhancedModuleName, EnhancedModuleState } from "./types.ts";

const COMMANDS: Record<EnhancedModuleName, string> = {
	"mcp-policy": "enhanced-mcp-policy-status",
	memory: "enhanced-memory-status",
	context: "enhanced-context-status",
	"task-manager": "enhanced-task-manager-status",
};

function stateFor(name: EnhancedModuleName, ctx: ExtensionContext): EnhancedModuleState {
	const loaded = loadEnhancedConfig({
		agentDir: getAgentDir(),
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});
	return {
		name,
		enabled: loaded.config.modules[name].enabled,
		sources: loaded.sources,
		errors: loaded.errors,
	};
}

function formatState(state: EnhancedModuleState): string {
	const source = state.sources.length > 0 ? state.sources.join(", ") : "defaults";
	const errors = state.errors.length > 0 ? `\nConfiguration errors:\n${state.errors.join("\n")}` : "";
	return `pi-enhanced ${state.name}: ${state.enabled ? "enabled" : "disabled"}\nConfiguration: ${source}${errors}`;
}

/** Register one independent P0 module entry. Business hooks are added in that module's later phase. */
export function registerModuleExtension(pi: ExtensionAPI, name: EnhancedModuleName): void {
	let state: EnhancedModuleState | undefined;

	pi.on("session_start", (_event, ctx) => {
		state = stateFor(name, ctx);
	});

	pi.on("session_shutdown", () => {
		state = undefined;
	});

	pi.registerCommand(COMMANDS[name], {
		description: `Show whether the pi-enhanced ${name} module is enabled`,
		handler: async (_args, ctx) => {
			const current = state ?? stateFor(name, ctx);
			ctx.ui.notify(formatState(current), current.errors.length > 0 ? "warning" : "info");
		},
	});
}
