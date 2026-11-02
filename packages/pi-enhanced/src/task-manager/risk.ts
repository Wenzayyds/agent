import type { RiskClass } from "./contracts.ts";

const READ_ONLY = new Set(["read", "grep", "find", "ls", "enhanced_memory_search", "enhanced_task_get"]);
const MUTATING = new Set(["write", "edit"]);

export function classifyToolRisk(toolName: string, args?: unknown): RiskClass {
	const name = toolName.toLocaleLowerCase("en-US");
	if (READ_ONLY.has(name)) return "read_only";
	if (MUTATING.has(name)) return "mutating";
	if (/push|deploy|publish|payment|create[_-]pr|merge[_-]pr/iu.test(name)) return "external_side_effect";
	if (name === "bash" || name === "powershell") {
		const text = JSON.stringify(args ?? {}).toLocaleLowerCase("en-US");
		if (
			/\b(git\s+push|deploy|publish|curl\s+.*-[xd]|invoke-restmethod|remove-item|rm\s|del\s|drop\s+table)\b/iu.test(
				text,
			)
		)
			return "external_side_effect";
		if (/\b(git\s+(commit|reset|checkout)|npm\s+(install|publish)|write|move-item|copy-item)\b/iu.test(text))
			return "mutating";
		return "unknown";
	}
	return "unknown";
}
