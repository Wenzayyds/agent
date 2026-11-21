import type { Task } from "./agent-evaluation.ts";
import { independentTasks } from "./independent-evaluation-tasks.ts";

type Fixture = { task: Task; origin: "E15" | "MA-3-holdout"; provisional?: Task["edits"]; correction?: Task["edits"] };
const e15Ids = ["page-buckets", "meter-adapter", "cache-retention", "record-revision"] as const;
const span = "def evaluate(start, end):\n    return end - start\n";
const prefix = "def evaluate(costs, limit):\n    return costs[:limit]\n";
const prefixLoop = [
	"    accepted = []",
	"    total = 0",
	"    for cost in costs:",
	"        if total + cost <= limit:",
	"            accepted.append(cost)",
	"            total += cost",
	"    return accepted",
].join("\n");
const contract = (primary: string, regression: string) =>
	`from app import evaluate\n\ndef test_contract():\n    assert ${primary}\n\ndef test_regression():\n    assert ${regression}\n`;
const appEdit = (oldText: string, newText: string): Task["edits"][number] => ({ path: "app.py", oldText, newText });

export const ma3Fixtures: readonly Fixture[] = [
	...e15Ids.map((id): Fixture => ({ task: independentTasks.find((entry) => entry.id === id)!, origin: "E15" })),
	{
		origin: "MA-3-holdout",
		task: {
			id: "inclusive-span", category: "闭区间与反向边界",
			request: "Return how many integers lie between start and end, including both endpoints. Return zero when end precedes start.",
			files: { "app.py": span },
			publicCheck: "evaluate(2, 4) == 3 and evaluate(5, 2) == 0",
			edits: [appEdit("return end - start", "return max(0, end - start + 1)")],
			hidden: contract("evaluate(-4, -1) == 4 and evaluate(7, 3) == 0", "evaluate(2, 2) == 1 and evaluate(-3, 2) == 6"),
		},
		provisional: [appEdit("return end - start", "return end - start + 1")],
		correction: [appEdit("return end - start + 1", "return max(0, end - start + 1)")],
	},
	{
		origin: "MA-3-holdout",
		task: {
			id: "prefix-budget", category: "顺序累积与停止条件",
			request: "Return the longest prefix of the supplied nonnegative costs that fits in the budget. Stop at the first unaffordable item, even if a later item fits. Preserve input order and do not mutate it.",
			files: { "app.py": prefix },
			publicCheck: "evaluate([2, 8, 1], 5) == [2]",
			edits: [appEdit("    return costs[:limit]", prefixLoop.replace(
				"        if total + cost <= limit:\n            accepted.append(cost)\n            total += cost",
				"        if total + cost > limit:\n            break\n        accepted.append(cost)\n        total += cost",
			))],
			hidden: contract("evaluate([0, 3, 0, 2, 9, 0], 5) == [0, 3, 0, 2]",
				"evaluate([], 10) == [] and evaluate([0, 0, 1], 0) == [0, 0] and evaluate([4, 4, 1], 5) == [4]"),
		},
		provisional: [appEdit("    return costs[:limit]", prefixLoop)],
		correction: [appEdit(
			"        if total + cost <= limit:\n            accepted.append(cost)\n            total += cost",
			"        if total + cost > limit:\n            break\n        accepted.append(cost)\n        total += cost",
		)],
	},
];

export const ma3Modes = ["S0", "S1", "S2"] as const;
export type Ma3Mode = (typeof ma3Modes)[number];

// Use all six permutations once. Each arm occupies each position twice.
const permutations: readonly (readonly Ma3Mode[])[] = [
	["S0", "S1", "S2"], ["S1", "S2", "S0"], ["S2", "S0", "S1"],
	["S0", "S2", "S1"], ["S2", "S1", "S0"], ["S1", "S0", "S2"],
];
export const ma3Order = ma3Fixtures.flatMap(({ task }, i) =>
	permutations[i]!.map((mode) => ({ id: task.id, mode })),
);
