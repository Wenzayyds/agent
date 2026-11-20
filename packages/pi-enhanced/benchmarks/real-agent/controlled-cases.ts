export const CONTROLLED_IMAGE = "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293";
export const CONTROLLED_LIMITS = Object.freeze({ maxRequests: 8, maxTokens: 40_000, maxCostUsd: 0.03, timeoutMs: 180_000, maxRuns: 6, maxBatchCostUsd: 0.18 });
export const MEMORY_RULE = "项目约定：normalizeKey 去掉首尾空白后转成小写，不修改输入字符串，保留公开导出。";
export const MEMORY_TASK_PROMPT = "按照当前项目的 normalizeKey 约定修复 key.js，保留公开导出，不修改测试。先查阅已提供的项目参考资料。";
export const TASK_STEPS = [
	{ title: "检查 formatter.js 和 index.js 的导出关系", expectedOutcome: "定位公开导出缺失，不改变 formatName 的大写行为" },
	{ title: "最小修复模块导出", expectedOutcome: "index.js 可导入 formatName，formatName('pi') 返回 'PI'，不修改测试", dependsOn: [] },
];
export const CONTROLLED_CELLS = [
	{ id: "m_inline", taskId: "memory-guided-regression", variant: "baseline", module: "memory", treatment: false },
	{ id: "m_memory", taskId: "memory-guided-regression", variant: "memory-only", module: "memory", treatment: true },
	{ id: "c_off", taskId: "controlled-long-report", variant: "baseline", module: "context", treatment: false },
	{ id: "c_on", taskId: "controlled-long-report", variant: "context-only", module: "context", treatment: true },
	{ id: "t_inline", taskId: "cross-file-export", variant: "baseline", module: "task", treatment: false },
	{ id: "t_task", taskId: "cross-file-export", variant: "task-only", module: "task", treatment: true },
] as const;
export type ControlledCell = typeof CONTROLLED_CELLS[number];
export function controlledCell(id: string | undefined): ControlledCell | undefined {
	if (!id) return undefined;
	const cell = CONTROLLED_CELLS.find((cell) => cell.id === id);
	if (!cell) throw new Error("EVAL_UNKNOWN_CONTROLLED_CELL");
	return cell;
}
export const LONG_REPORT_TASK = { id: "controlled-long-report", category: "controlled_context", prompt: "先使用 read 完整读取 diagnostics.txt，再依据报告定位并最小修复 validateItems。任意位置存在负数应返回 false，否则返回 true；不修改报告或测试。" };
export function longReport(): string {
	const head = "DIAGNOSTIC TARGET: validate.js / validateItems. Bug: only first ten values are checked. Inspect the implementation.\n";
	const tail = "\nEND EVIDENCE: inspect validate.js; a negative value beyond position 10 must be rejected.\n";
	return head + "noise: unrelated diagnostic padding 0123456789\n".repeat(300).slice(0, 12_000 - head.length - tail.length) + tail;
}
