import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("./swebench-verified.json", import.meta.url));
export const SWE_EVALUATION_PROTOCOL = "swebench_verified_source_restricted_v1";
export const SWE_SOURCE_INSTRUCTIONS =
	"本次采用受限源码评测协议：允许读取工作区中的测试文件，但禁止修改、创建或删除测试文件。只能修改已有且被 Git 跟踪的 .py/.js/.ts/.rst/.md 源码文件；禁止新增文件、删除、重命名、权限变更及修改凭据或仓库元数据。不提供 Shell 或 Agent 内测试执行能力；完成最小源码修复后结束，由独立官方 Harness 判分。所有模式使用相同限制，没有按答案位置设置文件白名单。";
export function swePrompt(issue: string): string {
	return `${issue}\n\n${SWE_SOURCE_INSTRUCTIONS}`;
}

interface Identity {
	instance_id: string;
	repo: string;
	base_commit: string;
}
export interface PublicIssue extends Identity {
	problem_statement: string;
}
interface Selection extends Identity {
	role: "gold" | "candidate";
	problem_sha256: string;
}

export function readSweManifest() {
	return JSON.parse(readFileSync(manifestPath, "utf8")) as {
		parquetSha256: string;
		instances: Array<Selection & { problem_statement?: string }>;
	};
}

export function publicInstance(value: unknown, expected: Identity): PublicIssue {
	if (!value || typeof value !== "object") throw new Error("SWE_ROW_INVALID");
	const { instance_id, repo, base_commit, problem_statement } = value as PublicIssue;
	if (
		typeof repo !== "string" ||
		!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/u.test(repo) ||
		typeof instance_id !== "string" ||
		!new RegExp(`^${repo.replace("/", "__").replaceAll(".", "\\.")}-[0-9]+$`, "u").test(instance_id) ||
		typeof base_commit !== "string" ||
		!/^[a-f0-9]{40}$/u.test(base_commit) ||
		instance_id !== expected.instance_id ||
		repo !== expected.repo ||
		base_commit !== expected.base_commit ||
		typeof problem_statement !== "string" ||
		!problem_statement.trim() ||
		problem_statement.length > 32_000 ||
		problem_statement.includes("\0")
	)
		throw new Error("SWE_ROW_IDENTITY_OR_ISSUE_INVALID");
	return { instance_id, repo, base_commit, problem_statement };
}
