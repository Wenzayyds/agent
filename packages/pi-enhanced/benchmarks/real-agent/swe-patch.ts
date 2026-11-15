import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { digestBytes as sha } from "./evaluation-identity.ts";
import { runSweGit as git } from "./swe-git.ts";
import type { SweTask } from "./swe-workspace.ts";

export function safePatchPath(path: string): boolean {
	return (
		/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:py|js|ts|rst|md)$/u.test(path) &&
		!path
			.split("/")
			.some((part) =>
				/^(?:tests?(?:\.[^.]+)?|__tests?__|specs?|__specs?__|tests?_.*|spec_.*|conftest\.py|.*(?:_test|\.test|\.spec)\.[^.]+|secrets?|credentials?)$/iu.test(
					part,
				),
			)
	);
}

export function sweWritePathAllowed(cwd: string, input: unknown): boolean {
	if (typeof input !== "string") return false;
	const path = relative(resolve(cwd), resolve(cwd, input)).replaceAll("\\", "/");
	if (!safePatchPath(path)) return false;
	return git(cwd, ["ls-files", "-z", "--", path]).split("\0").filter(Boolean).includes(path);
}

export function exportSwePrediction(
	task: SweTask,
	cwd: string,
	output: string,
	model: string,
	diagnosticOutput?: string,
) {
	const parent = realpathSync(dirname(output));
	const rel = relative(realpathSync(cwd), parent);
	if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("SWE_OUTPUT_IN_WORKSPACE");
	if (diagnosticOutput && realpathSync(dirname(diagnosticOutput)) !== parent)
		throw new Error("SWE_DIAGNOSTIC_OUTPUT_INVALID");
	const diagnostic: {
		status: string;
		error: string | null;
		candidatePatchSha256: string | null;
		candidatePatchBytes: number | null;
		paths: Array<{ path: string | null; pathSha256: string }> | null;
		pathsTruncated: boolean;
		contentSaved: false;
	} = {
		status: "rejected",
		error: null,
		candidatePatchSha256: null,
		candidatePatchBytes: null,
		paths: null,
		pathsTruncated: false,
		contentSaved: false,
	};
	try {
		if (
			git(cwd, ["rev-parse", "HEAD"]).trim() !== task.issue.base_commit ||
			git(cwd, ["diff", "--cached", "--name-only"]) ||
			git(cwd, ["ls-files", "--others", "-z"])
		)
			throw new Error("SWE_WORKSPACE_DRIFT_OR_UNTRACKED_FILES");
		const changed = git(cwd, ["diff", "--name-only", "-z", "HEAD", "--"]).split("\0").filter(Boolean);
		diagnostic.paths = changed.slice(0, 64).map((path) => ({
			path:
				path.length <= 256 &&
				/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:py|js|ts|rst|md)$/u.test(path) &&
				!/secret|credential|password|token|api.?key/iu.test(path)
					? path
					: null,
			pathSha256: sha(path),
		}));
		diagnostic.pathsTruncated = changed.length > 64;
		const patch = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--"]);
		diagnostic.candidatePatchSha256 = sha(patch);
		diagnostic.candidatePatchBytes = Buffer.byteLength(patch);
		if (!changed.length) {
			diagnostic.error = "empty_patch";
			return { status: "agent_failed", reason: "empty_patch" } as const;
		}
		for (const path of changed) {
			const target = join(cwd, path);
			if (!safePatchPath(path) || !lstatSync(target).isFile() || realpathSync(target) !== target)
				throw new Error("SWE_PATCH_PATH_DENIED");
		}
		const raw = git(cwd, ["diff", "--raw", "--no-renames", "HEAD", "--"]);
		if (
			raw
				.split(/\r?\n/u)
				.filter(Boolean)
				.some((line) => !/^:(100644|100755) \1 [a-f0-9]+ [a-f0-9]+ M\t/u.test(line))
		)
			throw new Error("SWE_PATCH_MODE_DENIED");
		if (
			Buffer.byteLength(patch) > 256 * 1024 ||
			/(?:^Binary files |^GIT binary patch|-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}\b|\bAKIA[A-Z0-9]{16}\b|(?:api[_-]?key|password|secret|token)\s*[:=]\s*['"][^'"]{16,}['"])/imu.test(
				patch,
			)
		)
			throw new Error("SWE_PATCH_UNSAFE");
		git(cwd, ["apply", "--cached", "--check", "--whitespace=nowarn", "-"], patch);
		writeFileSync(
			output,
			`${JSON.stringify({ instance_id: task.issue.instance_id, model_name_or_path: model, model_patch: patch })}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		diagnostic.status = "exported";
		return {
			status: "not_run",
			reason: "official_harness_not_run",
			patchSha256: sha(patch),
			changedFiles: changed,
		} as const;
	} catch (error) {
		diagnostic.error =
			error instanceof Error && /^SWE_[A-Z_]+$/u.test(error.message) ? error.message : "SWE_PATCH_EXPORT_FAILED";
		throw error;
	} finally {
		if (diagnosticOutput)
			writeFileSync(diagnosticOutput, `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	}
}
