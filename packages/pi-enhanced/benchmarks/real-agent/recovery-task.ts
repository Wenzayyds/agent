import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTaskManagerExtension } from "../../src/task-manager/extension.ts";

/** The Runner supplies this binding through its private, scoped child environment. */
export default function recoveryTask(pi: ExtensionAPI): void {
	const taskId = process.env.PI_ENHANCED_V3_TASK_ID;
	const phase = process.env.PI_ENHANCED_V3_RECOVERY_PHASE;
	if (!taskId || (phase !== "pause" && phase !== "resume")) throw new Error("EVAL_V3_RECOVERY_BINDING_REQUIRED");
	const tools = (process.env.PI_ENHANCED_V3_MODULE_TOOLS ?? "").split(",").filter((tool) =>
		tool === "enhanced_memory_search" || tool === "enhanced_task_get");
	createTaskManagerExtension({ initialBinding: { taskId, stepId: phase === "pause" ? "reproduce" : "repair" } })(pi);
	const settledWrites = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		if (phase === "resume") {
			for (const entry of ctx.sessionManager.getBranch())
				if (entry.type === "message" && entry.message.role === "toolResult" &&
					(entry.message.toolName === "edit" || entry.message.toolName === "write"))
					settledWrites.add(entry.message.toolCallId);
		}
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...tools])]);
	});
	pi.on("tool_call", (event) => {
		if ((event.toolName === "edit" || event.toolName === "write") && settledWrites.has(event.toolCallId))
			return { block: true, reason: "This tool call already has a durable write result in the recovered session." };
	});
}
