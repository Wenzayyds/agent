import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { assertRunId } from "./protocol.ts";

export interface SandboxConfig {
	enabled: boolean;
	trusted: boolean;
	runId: string;
	runRoot: string;
	workspace: string;
	workspaceDevice: number;
	workspaceInode: number;
	auditReportPath?: string;
	image: string;
	timeoutMs: number;
	maxRequestBytes: number;
	maxResponseBytes: number;
}

const DEFAULT_IMAGE = "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293";

export function loadSandboxConfig(
	env: NodeJS.ProcessEnv = process.env,
	cwd = process.cwd(),
	tempRootInput = tmpdir(),
): SandboxConfig {
	const enabled = env.PI_ENHANCED_SANDBOX_ENABLED === "1";
	if (!enabled) {
		return {
			enabled: false,
			trusted: false,
			runId: "disabled",
			runRoot: resolve(tmpdir()),
			workspace: resolve(cwd),
			workspaceDevice: 0,
			workspaceInode: 0,
			image: DEFAULT_IMAGE,
			timeoutMs: 10_000,
			maxRequestBytes: 1024 * 1024,
			maxResponseBytes: 2 * 1024 * 1024,
		};
	}

	const runId = required(env, "PI_ENHANCED_SANDBOX_RUN_ID");
	assertRunId(runId);
	const configuredRunRoot = required(env, "PI_ENHANCED_SANDBOX_RUN_ROOT");
	if (!isAbsolute(configuredRunRoot)) throw new Error("SANDBOX_RUN_ROOT_NOT_ABSOLUTE");
	const runRoot = realpathSync(configuredRunRoot);
	const tempRoot = realpathSync(tempRootInput);
	if (!samePath(runRoot, tempRoot)) throw new Error("SANDBOX_RUN_ROOT_TEMP_MISMATCH");
	const configuredWorkspace = required(env, "PI_ENHANCED_SANDBOX_WORKSPACE");
	if (!isAbsolute(configuredWorkspace)) throw new Error("SANDBOX_WORKSPACE_NOT_ABSOLUTE");
	const workspace = realpathSync(configuredWorkspace);
	const actualCwd = realpathSync(cwd);
	if (!samePath(workspace, actualCwd)) throw new Error("SANDBOX_WORKSPACE_CWD_MISMATCH");
	if (!strictlyInside(runRoot, workspace)) {
		throw new Error("SANDBOX_WORKSPACE_NOT_TEMPORARY");
	}
	const workspaceStat = lstatSync(workspace);
	if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink())
		throw new Error("SANDBOX_WORKSPACE_IDENTITY_INVALID");
	const auditReportPath = optionalAuditPath(env.PI_ENHANCED_SANDBOX_REPORT_PATH, runRoot, workspace);
	const image = env.PI_ENHANCED_SANDBOX_IMAGE ?? DEFAULT_IMAGE;
	if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("SANDBOX_IMAGE_NOT_PINNED");
	return {
		enabled: true,
		trusted: env.PI_ENHANCED_SANDBOX_TRUSTED === "1",
		runId,
		runRoot,
		workspace,
		workspaceDevice: workspaceStat.dev,
		workspaceInode: workspaceStat.ino,
		...(auditReportPath ? { auditReportPath } : {}),
		image,
		timeoutMs: positiveInt(env.PI_ENHANCED_SANDBOX_TIMEOUT_MS, 10_000, 1_000, 60_000),
		maxRequestBytes: positiveInt(env.PI_ENHANCED_SANDBOX_MAX_REQUEST_BYTES, 1024 * 1024, 1024, 2 * 1024 * 1024),
		maxResponseBytes: positiveInt(env.PI_ENHANCED_SANDBOX_MAX_RESPONSE_BYTES, 2 * 1024 * 1024, 1024, 4 * 1024 * 1024),
	};
}

export function assertSandboxWorkspaceIdentity(config: SandboxConfig): void {
	let current: string;
	try {
		current = realpathSync(config.workspace);
		const stat = lstatSync(config.workspace);
		if (
			!samePath(current, config.workspace) ||
			!strictlyInside(config.runRoot, current) ||
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.dev !== config.workspaceDevice ||
			stat.ino !== config.workspaceInode
		) {
			throw new Error("SANDBOX_WORKSPACE_IDENTITY_CHANGED");
		}
	} catch (error) {
		if (error instanceof Error && error.message === "SANDBOX_WORKSPACE_IDENTITY_CHANGED") throw error;
		throw new Error("SANDBOX_WORKSPACE_IDENTITY_CHANGED");
	}
}

function optionalAuditPath(value: string | undefined, runRoot: string, workspace: string): string | undefined {
	if (!value?.trim()) return undefined;
	if (!isAbsolute(value)) throw new Error("SANDBOX_REPORT_PATH_NOT_ABSOLUTE");
	const reportPath = resolve(value);
	const parent = realpathSync(dirname(reportPath));
	if (!samePath(parent, runRoot) || strictlyInside(workspace, reportPath) || samePath(workspace, reportPath)) {
		throw new Error("SANDBOX_REPORT_PATH_INVALID");
	}
	return reportPath;
}

function strictlyInside(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}

function samePath(left: string, right: string): boolean {
	return relative(left, right) === "" && relative(right, left) === "";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`SANDBOX_MISSING_${name}`);
	return value;
}

function positiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error("SANDBOX_INVALID_LIMIT");
	return parsed;
}
