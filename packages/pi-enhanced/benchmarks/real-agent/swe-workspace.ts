import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { digestBytes as sha } from "./evaluation-identity.ts";
import { runSweGit as git } from "./swe-git.ts";
import { type PublicIssue, publicInstance, readSweManifest } from "./swe-instance.ts";

export type SweTask = { issue: PublicIssue; mirror: string };

export function safeBasePath(path: string): boolean {
	return !path
		.split("/")
		.some(
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				[".git", ".pi", "node_modules"].includes(part.toLowerCase()) ||
				/[. ]$/u.test(part) ||
				/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
		);
}

export function loadSweTask(id: string, mirror: string): SweTask {
	const selection = readSweManifest().instances.find((row) => row.instance_id === id && row.role === "candidate");
	if (!selection) throw new Error("SWE_CANDIDATE_NOT_SELECTED");
	const issue = publicInstance(selection, selection);
	if (sha(issue.problem_statement) !== selection.problem_sha256) throw new Error("SWE_ISSUE_HASH_MISMATCH");
	return { issue, mirror: realpathSync(mirror) };
}

/** Copy only the selected base from an operator-provided public local mirror, with no hooks or submodules. */
export function prepareSweWorkspace(task: SweTask, cwd: string): string {
	const origin = git(task.mirror, ["config", "--get", "remote.origin.url"]).trim();
	if (origin !== `https://github.com/${task.issue.repo}.git` && origin !== `https://github.com/${task.issue.repo}`)
		throw new Error("SWE_MIRROR_ORIGIN_MISMATCH");
	const base = task.issue.base_commit;
	if (git(task.mirror, ["rev-parse", `${base}^{commit}`]).trim() !== base) throw new Error("SWE_BASE_MISMATCH");
	const tree = git(task.mirror, ["ls-tree", "-rlz", base]).split("\0").filter(Boolean);
	let bytes = 0;
	for (const entry of tree) {
		const match = /^(100644|100755) blob [a-f0-9]+ +([0-9]+)\t([A-Za-z0-9_./+@ -]+)$/u.exec(entry);
		if (!match || !safeBasePath(match[3]!)) throw new Error("SWE_UNSUPPORTED_BASE_TREE");
		bytes += Number(match[2]);
	}
	if (!tree.length || tree.length > 50_000 || bytes > 128 * 1024 * 1024) throw new Error("SWE_BASE_TOO_LARGE");
	// Fetch only the base tree (one commit, no tags) into an independent repository.
	mkdirSync(cwd);
	git(cwd, ["init", "--quiet", `--separate-git-dir=${join(dirname(cwd), "swe-git")}`]);
	git(cwd, ["fetch", "--quiet", "--no-tags", "--depth=1", pathToFileURL(task.mirror).href, base]);
	git(cwd, ["checkout", "--quiet", "--detach", base]);
	if (git(cwd, ["rev-parse", "HEAD"]).trim() !== base || git(cwd, ["status", "--porcelain", "-z"]))
		throw new Error("SWE_WORKSPACE_NOT_PRISTINE");
	return git(cwd, ["rev-parse", "HEAD^{tree}"]).trim();
}
