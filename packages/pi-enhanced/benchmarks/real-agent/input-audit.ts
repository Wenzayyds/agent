import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { atomicPrivateJson } from "../../src/sandbox/audit.ts";
import { digest } from "./evaluation-identity.ts";

// Keep the private file name stable for the existing Runner evidence readers.
export const INPUT_AUDIT_FILE = "batch-l-input-audit.json";

export function registerInputAudit(pi: ExtensionAPI, baseToolNames?: readonly string[]): void {
	pi.on("before_agent_start", (event, ctx) => {
		const names = pi.getActiveTools();
		const tools = names.map((name) => {
			const tool = pi.getAllTools().find((tool) => tool.name === name)!;
			return {
				name,
				description: tool.description,
				parameters: tool.parameters,
				promptGuidelines: tool.promptGuidelines,
			};
		});
		const system = event.systemPrompt
			.replaceAll(ctx.cwd, "[PROJECT_ROOT]")
			.replaceAll(ctx.cwd.replaceAll("\\", "/"), "[PROJECT_ROOT]");
		atomicPrivateJson(join(process.env.PI_ENHANCED_SANDBOX_RUN_ROOT!, INPUT_AUDIT_FILE), {
			userPromptSha256: digest("prompt" in event ? event.prompt : "[custom event]"),
			canonicalSystemPromptSha256: digest(system),
			toolSchemaSha256: digest(tools),
			...(baseToolNames
				? {
						baseToolSchemaSha256: digest(
							tools
								.filter((tool) => baseToolNames.includes(tool.name))
								.sort((left, right) => left.name.localeCompare(right.name)),
						),
					}
				: {}),
			tools: names,
			model: ctx.model?.id,
			provider: ctx.model?.provider,
			thinking: pi.getThinkingLevel(),
		});
	});
}
