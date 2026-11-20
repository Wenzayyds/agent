import {
	CONTROLLED_CELLS,
	CONTROLLED_IMAGE,
	CONTROLLED_LIMITS,
	type ControlledCell,
	LONG_REPORT_TASK,
	MEMORY_RULE,
	TASK_STEPS,
} from "./controlled-cases.ts";

export const BATCH_L_PROFILE = "batch-l-v1";
export const BATCH_L_LIMITS = Object.freeze({ ...CONTROLLED_LIMITS, maxTokens: 80_000 });
export const TASK_PAIR_PROFILE = "task-pair-v1";
export const TASK_PAIR_CELLS = [CONTROLLED_CELLS[4], CONTROLLED_CELLS[5]] as const;
export const TASK_PAIR_LIMITS = Object.freeze({
	...BATCH_L_LIMITS,
	maxRequests: 12,
	maxRuns: TASK_PAIR_CELLS.length,
	maxBatchCostUsd: 0.06,
});
export const TASK_PAIR_INSTRUCTIONS =
	"当前仅提供 read、grep、find、ls、write、edit 六项文件工具及两个只读模块查询工具；不能通过 Shell 执行测试脚本。请完成满足要求的最小修复，必要时可重新读取文件确认。独立隐藏验证器会在 Agent 正常退出后由 Runner 执行，不要创建无法执行的临时测试脚本，也不要把未执行的测试说成已执行。完成修改后简短说明结果并结束。";
export const BATCH_L_MODULE_TOOLS = ["enhanced_memory_search", "enhanced_task_get"];
export const TASK_PAIR_CONFIGURATION = Object.freeze({
	profile: TASK_PAIR_PROFILE,
	cells: TASK_PAIR_CELLS.map(({ id, taskId, variant }) => ({ id, taskId, variant })),
	provider: "deepseek",
	model: "deepseek-flash",
	thinking: "off",
	memory: false,
	context: false,
	telemetry: true,
	recovery: "strict",
	concurrency: 1,
	retries: 0,
	maxOutputTokens: 2048,
	image: CONTROLLED_IMAGE,
	limits: TASK_PAIR_LIMITS,
});
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
export function batchLGroup(cell: ControlledCell): string {
	return `${cell.module}_${cell.treatment ? "on" : "off"}`;
}
