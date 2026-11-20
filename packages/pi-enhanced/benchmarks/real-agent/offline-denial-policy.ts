import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface OfflineDenialPolicy {
	schemaVersion: 1;
	mode: "recover_readonly_denials";
	maxDenials: number;
}
/** Only an explicit host CLI argument selects this policy. Project config and env cannot select it. */
export function loadOfflineDenialPolicy(
	path: string | undefined,
	stub: string | undefined,
	repository: string,
): OfflineDenialPolicy | undefined {
	if (!path) return undefined;
	if (!stub || !isAbsolute(path) || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 1024)
		throw new Error("OFFLINE_DENIAL_POLICY_UNTRUSTED");
	const canonical = realpathSync(path);
	const rel = relative(realpathSync(repository), canonical);
	if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("OFFLINE_DENIAL_POLICY_PROJECT_FILE");
	const value = JSON.parse(readFileSync(canonical, "utf8")) as OfflineDenialPolicy;
	if (
		value.schemaVersion !== 1 ||
		value.mode !== "recover_readonly_denials" ||
		!Number.isInteger(value.maxDenials) ||
		value.maxDenials < 1 ||
		value.maxDenials > 3 ||
		Object.keys(value).some((k) => !["schemaVersion", "mode", "maxDenials"].includes(k))
	)
		throw new Error("OFFLINE_DENIAL_POLICY_INVALID");
	return value;
}

/** Conservative: lexical traversal outside AND canonical equality, no aliases/symlinks or missing paths. */
export function ordinaryReadonlyOutside(root: string, input: unknown): boolean {
	if (
		typeof input !== "string" ||
		input.length > 1024 ||
		input.includes("\0") ||
		isAbsolute(input) ||
		input.includes(":")
	)
		return false;
	try {
		const canonicalRoot = realpathSync(root);
		let cursor = canonicalRoot;
		for (const part of input.split(/[\\/]/u)) {
			cursor = resolve(cursor, part);
			if (lstatSync(cursor).isSymbolicLink()) return false;
		}
		const requested = resolve(canonicalRoot, input);
		const rel = relative(canonicalRoot, requested);
		return (
			(rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) &&
			relative(requested, realpathSync(requested)) === ""
		);
	} catch {
		return false;
	}
}
