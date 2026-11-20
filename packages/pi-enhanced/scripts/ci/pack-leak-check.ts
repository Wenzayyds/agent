import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const npmCli = process.env.npm_execpath ?? "npm";
const raw = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], { cwd: packageRoot, encoding: "utf8", timeout: 30_000 });
const report = JSON.parse(raw) as Array<{ entryCount: number; size: number; files: Array<{ path: string }> }>;
const paths = report[0]?.files.map(({ path }) => path.replaceAll("\\", "/")) ?? [];
const forbidden = paths.filter((path) => /(^|\/)(tests?|__pycache__|\.venv|models?|indexes?)(\/|$)|\.sqlite3(?:-|$)|session.*\.jsonl$|credential|secret|\.log$|\.pyc$/iu.test(path));
if (forbidden.length) throw new Error(`Pack contains forbidden paths: ${forbidden.join(", ")}`);
const secretPatterns = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
	/\bAKIA[A-Z0-9]{16}\b/u,
	/\bsk-[A-Za-z0-9]{20,}\b/u,
];
const contentLeaks = paths.filter((path) => {
	if (!/\.(?:c?js|mjs|ts|json|md|py|toml|ya?ml)$/iu.test(path)) return false;
	const content = readFileSync(join(packageRoot, path), "utf8");
	return secretPatterns.some((pattern) => pattern.test(content));
});
if (contentLeaks.length) throw new Error(`Pack contains secret-like content: ${contentLeaks.join(", ")}`);
for (const required of ["extensions/mcp-policy.ts", "extensions/memory.ts", "extensions/context.ts", "extensions/task-manager.ts", "extensions/sandbox.ts", "src/sandbox/broker.ts", "benchmarks/real-agent/run-real-agent.ts", "scripts/data-management.ts"])
	if (!paths.includes(required)) throw new Error(`Pack is missing ${required}`);
process.stdout.write(`${JSON.stringify({ status: "passed", entries: report[0]?.entryCount, bytes: report[0]?.size, forbidden: 0, contentLeaks: 0 })}\n`);
