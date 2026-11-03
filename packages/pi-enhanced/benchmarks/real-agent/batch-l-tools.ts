import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setMemorySearchToolAvailability } from "../../src/memory/interaction.ts";
import { atomicPrivateJson } from "../../src/sandbox/audit.ts";
import { createTaskManagerExtension } from "../../src/task-manager/extension.ts";
import { BATCH_L_MODULE_TOOLS, digest } from "./batch-l-profile.ts";

/** Evaluation only: keep model-visible schemas identical while leaving disabled services closed. */
export default function batchLTools(pi: ExtensionAPI): void {
	const taskEnabled = process.env.PI_ENHANCED_BATCH_L_TASK === "1";
	const memoryEnabled = process.env.PI_ENHANCED_BATCH_L_MEMORY === "1";
	if (taskEnabled) {
		const register: ExtensionAPI["registerTool"] = (tool) => {
			if (tool.name !== "enhanced_task_get") return pi.registerTool(tool);
			return pi.registerTool({
				...tool,
				execute(id, input, signal, update, ctx) {
					const value = input as Record<string, unknown>;
					const actual =
						value.taskId === "current"
							? ({ ...value, taskId: process.env.PI_ENHANCED_BATCH_L_TASK_ID } as typeof input)
							: input;
					return tool.execute(id, actual, signal, update, ctx);
				},
			});
		};
		createTaskManagerExtension()(
			new Proxy(pi, {
				get(target, key) {
					return key === "registerTool" ? register : Reflect.get(target, key);
				},
			}),
		);
	}
	pi.on("session_start", () => {
		if (!memoryEnabled) setMemorySearchToolAvailability(pi, () => undefined, true);
		if (!taskEnabled)
			pi.registerTool({
				name: "enhanced_task_get",
				label: "Task state",
				description: "Read bounded state for one task in the current project",
				exposure: "direct",
				parameters: Type.Object(
					{ taskId: Type.String({ minLength: 1, maxLength: 100 }) },
					{ additionalProperties: false },
				),
				execute: async () => ({
					content: [
						{
							type: "text",
							text: "Task Manager is disabled for this experimental group; project reference files remain available.",
						},
					],
					details: { enabled: false },
					isError: true,
				}),
			});
		pi.setActiveTools(["read", "grep", "find", "ls", "write", "edit", ...BATCH_L_MODULE_TOOLS]);
	});
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
		atomicPrivateJson(join(process.env.PI_ENHANCED_SANDBOX_RUN_ROOT!, "batch-l-input-audit.json"), {
			userPromptSha256: digest("prompt" in event ? event.prompt : "[custom event]"),
			canonicalSystemPromptSha256: digest(system),
			toolSchemaSha256: digest(tools),
			tools: names,
			model: ctx.model?.id,
			provider: ctx.model?.provider,
			thinking: pi.getThinkingLevel(),
		});
	});
}
