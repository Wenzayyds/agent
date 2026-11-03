import { createHash } from "node:crypto";
import {
	CONTROLLED_LIMITS,
	type ControlledCell,
	LONG_REPORT_TASK,
	MEMORY_RULE,
	TASK_STEPS,
} from "./controlled-cases.ts";

export const BATCH_L_PROFILE = "batch-l-v1";
export const BATCH_L_LIMITS = Object.freeze({ ...CONTROLLED_LIMITS, maxTokens: 80_000 });
export const BATCH_L_MODULE_TOOLS = ["enhanced_memory_search", "enhanced_task_get"];
export function batchLPrompt(cell: ControlledCell): string {
	const common =
		"工作目录就是项目根目录，请只在当前工作区内操作，不访问父目录。保留公开 API，不修改测试或参考资料。只读服务可能未启用，参考资料始终可通过文件工具读取。";
	if (cell.module === "memory")
		return `${common}\n按项目约定修复 key.js 的 normalizeKey。相同约定见 reference.md，也可使用 enhanced_memory_search 查询 normalizeKey。`;
	if (cell.module === "task")
		return `${common}\n修复 formatter.js 与 index.js 的导出关系，保留 formatName 的大写行为。相同步骤计划见 task-plan.json，也可用 enhanced_task_get 查询 taskId=current。`;
	return `${common}\n${LONG_REPORT_TASK.prompt}`;
}
export function batchLReferences(cell: ControlledCell): Record<string, string> {
	if (cell.module === "memory") return { "reference.md": `${MEMORY_RULE}\n` };
	if (cell.module === "task")
		return {
			"task-plan.json": JSON.stringify({ taskId: "current", goal: batchLPrompt(cell), steps: TASK_STEPS }, null, 2),
		};
	return {};
}
export function digest(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : JSON.stringify(value))
		.digest("hex");
}
export function batchLGroup(cell: ControlledCell): string {
	return `${cell.module}_${cell.treatment ? "on" : "off"}`;
}
