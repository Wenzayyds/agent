import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sandboxUser } from "./broker.ts";
import {
	assertSandboxContainerOwner,
	assertSandboxWorkspaceIdentity,
	SANDBOX_CONTAINER_OWNER_LABEL,
	type SandboxConfig,
} from "./config.ts";

/** Host-only configuration: exact files, never globs or model-supplied paths. */
export interface PytestConfig {
	image: string;
	files: string[];
	tests: string[];
	timeoutMs?: number;
	candidateImport?: "pytest" | "requests";
}
export const MAX_PYTEST_TARGETS = 16;

export interface PytestResult {
	status: "passed" | "skipped" | "failed" | "timeout" | "execution_error" | "sandbox_error" | "unsupported";
	targets: string[];
	exitCode: number | null;
	passed: number | null;
	failed: number | null;
	output: string;
	truncated: boolean;
}

function allowedPath(path: string, candidateImport?: PytestConfig["candidateImport"]): boolean {
	// Exactly one public Requests source path. All snapshot identity checks still apply.
	if (candidateImport === "requests" && path === "requests/auth.py") return true;
	return (
		path.length <= 180 &&
		path
			.split("/")
			.every(
				(part) =>
					/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(part) &&
					!/(?:secret|credential|auth|grant|token|password|id_rsa|id_ed25519|private|experiment|history|evaluation|database)/iu.test(
						part,
					) &&
					!/(?:^|\.)(?:env|pem|key|db|sqlite|sqlite3)$/iu.test(part),
			)
	);
}

function checkedFile(root: string, path: string, candidateImport?: PytestConfig["candidateImport"]): string {
	if (!allowedPath(path, candidateImport)) throw new Error("PYTEST_PATH_DENIED");
	let current = root;
	for (const part of path.split("/")) {
		current = join(current, part);
		if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== resolve(current))
			throw new Error("PYTEST_LINK_DENIED");
	}
	return current;
}

function boundedRead(fd: number): Buffer {
	const buffer = Buffer.alloc(1024 * 1024 + 1);
	let length = 0;
	while (length < buffer.length) {
		const count = readSync(fd, buffer, length, buffer.length - length, length);
		if (!count) break;
		length += count;
	}
	if (length > 1024 * 1024) throw new Error("PYTEST_COPY_LIMIT");
	return buffer.subarray(0, length);
}

export function pytestFileVersions(
	config: SandboxConfig,
	policy: Pick<PytestConfig, "files" | "candidateImport">,
	destination?: string,
): Map<string, string> {
	assertSandboxWorkspaceIdentity(config);
	const versions = new Map<string, string>();
	let total = 0;
	for (const path of policy.files) {
		const source = checkedFile(config.workspace, path, policy.candidateImport);
		const identity = lstatSync(source);
		if (!identity.isFile()) throw new Error("PYTEST_FILE_DENIED");
		const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		try {
			const before = fstatSync(fd);
			if (
				!before.isFile() ||
				before.nlink !== 1 ||
				before.size > 1024 * 1024 ||
				before.dev !== identity.dev ||
				before.ino !== identity.ino
			)
				throw new Error("PYTEST_FILE_DENIED");
			const bytes = boundedRead(fd);
			if (!bytes.equals(boundedRead(fd))) throw new Error("PYTEST_SOURCE_CHANGED");
			const after = lstatSync(checkedFile(config.workspace, path, policy.candidateImport));
			if (
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs ||
				before.size !== bytes.length ||
				after.nlink !== 1
			)
				throw new Error("PYTEST_SOURCE_CHANGED");
			total += bytes.length;
			if (total > 8 * 1024 * 1024) throw new Error("PYTEST_COPY_LIMIT");
			versions.set(path, createHash("sha256").update(bytes).digest("hex"));
			if (destination) {
				const target = join(destination, path);
				mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
				writeFileSync(target, bytes, { flag: "wx", mode: 0o444 });
			}
		} finally {
			closeSync(fd);
		}
	}
	assertSandboxWorkspaceIdentity(config);
	return versions;
}

const pytestArgs =
	"['-c', '/dev/null', '-p', 'no:cacheprovider', '--basetemp=/tmp/pytest', '--tb=short', '-r', 'fE', '-q', *sys.argv[1:]]";
const setup = `import sys, pytest
sys.dont_write_bytecode = True
sys.path.insert(0, '/workspace')`;
// Keep one bounded counter per requested target. A pass in another file cannot certify a skipped step.
function observedProgram(marker: string, targetCount: number, candidateImport: PytestConfig["candidateImport"]): string {
	const prelude = candidateImport === "pytest" ? pytestSourceProgram : candidateImport === "requests" ? requestsSourceProgram : "";
	return prelude + setup + `
targets = sys.argv[-${targetCount}:]
class Calls:
    passed = 0
    counts = [0] * len(targets)
    def pytest_runtest_logreport(self, report):
        if report.when == 'call' and report.passed:
            self.passed += 1
            for i, target in enumerate(targets):
                if report.nodeid == target or report.nodeid.startswith((target + '::', target + '[')):
                    self.counts[i] += 1
calls = Calls()
code = pytest.main(${pytestArgs}, plugins=[calls])
print('${marker}' + ','.join(map(str, [calls.passed] + calls.counts)), flush=True)
raise SystemExit(code)`;
}

const pytestSourceProgram =
	`import os, pathlib, sys
sys.path.insert(0, "/workspace/src")
os.environ["PYTHONPATH"] = "/workspace/src"
import _pytest
if not pathlib.Path("/workspace/src/_pytest/_version.py").is_file():
    # Public Git snapshots omit setuptools-generated version metadata.
    import types
    metadata = types.ModuleType("_pytest._version")
    metadata.version = metadata.__version__ = _pytest.__version__
    sys.modules[metadata.__name__] = metadata
    _pytest._version = metadata
import pytest
for module in (pytest, _pytest):
    assert str(pathlib.Path(module.__file__).resolve()).startswith("/workspace/src/"), module.__file__
    print("Candidate module:", module.__file__)
`;
const requestsSourceProgram =
	`import pathlib, sys
sys.path.insert(0, "/workspace")
import requests
assert str(pathlib.Path(requests.__file__).resolve()).startswith("/workspace/requests/"), requests.__file__
print("Candidate module:", requests.__file__)
`;

function pytestTargetFile(target: string): string | undefined {
	if (target.length > 240) return undefined;
	const [file, ...nodes] = target.split("::");
	return nodes.length <= 2 && nodes.every((node) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(node)) ? file : undefined;
}

export function isPytestConfig(input: unknown, allowCandidateImport = false): input is PytestConfig {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const { image, timeoutMs: configuredTimeout, files, tests, candidateImport } = input as Partial<PytestConfig>;
	const timeoutMs = configuredTimeout ?? 30_000;
	return (
		typeof image === "string" &&
		/^sha256:[a-f0-9]{64}$/u.test(image) &&
		Number.isInteger(timeoutMs) &&
		timeoutMs >= 100 &&
		timeoutMs <= 30_000 &&
		Array.isArray(files) &&
		files.length >= 1 &&
		files.length <= 128 &&
		new Set(files).size === files.length &&
		files.every((file) => typeof file === "string" && allowedPath(file, candidateImport)) &&
		(candidateImport === undefined ||
			(allowCandidateImport &&
				((candidateImport === "pytest" &&
					files.includes("src/_pytest/__init__.py") &&
					(files.includes("src/pytest.py") || files.includes("src/pytest/__init__.py"))) ||
					(candidateImport === "requests" && files.includes("requests/__init__.py"))))) &&
		Array.isArray(tests) &&
		tests.length >= 1 &&
		tests.length <= MAX_PYTEST_TARGETS &&
		tests.every((test) => typeof test === "string" && files.includes(pytestTargetFile(test) ?? ""))
	);
}

export interface PytestEvidence {
	passesByTarget?: ReadonlyMap<string, number>;
	status: PytestResult["status"];
	targets: readonly string[];
	files: ReadonlyMap<string, string>;
	canRunAgain: boolean;
}

/** One instance per session; limits are consumed even when a call fails. */
export function createPytestExecutor(config: SandboxConfig, input: PytestConfig, namespacePackages = false) {
	if (!config.enabled || !config.trusted || !isPytestConfig(input, namespacePackages))
		throw new Error("PYTEST_CONFIG_DENIED");
	const policy = structuredClone(input);
	const timeoutMs = policy.timeoutMs ?? 30_000;
	let calls = 0;
	let elapsed = 0;
	let busy = false;
	return async (
		targets: string[],
		signal?: AbortSignal,
		observe?: (evidence: PytestEvidence, result: PytestResult) => void,
	): Promise<PytestResult> => {
		const result: PytestResult = {
			status: "sandbox_error",
			targets: [],
			exitCode: null,
			passed: null,
			failed: null,
			output: "",
			truncated: false,
		};
		if (busy || calls >= 3 || elapsed >= 90_000) return { ...result, output: "Test execution limit reached." };
		if (
			!Array.isArray(targets) ||
			targets.length < 1 ||
			targets.length > MAX_PYTEST_TARGETS ||
			!targets.every((target) => {
				const file = typeof target === "string" ? pytestTargetFile(target) : undefined;
				return file !== undefined && (policy.tests.includes(file) || policy.tests.includes(target));
			})
		)
			return {
				...result,
				status: "unsupported",
				output: "Only host-approved test files or functions are supported.",
			};
		result.targets = [...targets];
		calls++;
		busy = true;
		const started = performance.now();
		let files: ReadonlyMap<string, string> | undefined;
		const marker = `pi-pytest-${randomUUID()}:`;
		let completedPasses: number | undefined;
		let passesByTarget: Map<string, number> | undefined;
		let root: string | undefined;
		let id: string | undefined;
		const docker = (args: string[]) =>
			execFileSync("docker", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			}).trim();
		const remove = () => {
			if (id) {
				docker(["rm", "-f", id]);
				id = undefined;
			}
		};
		try {
			if (signal?.aborted) throw new Error("PYTEST_CANCELLED");
			root = mkdtempSync(join(realpathSync(tmpdir()), "pi-pytest-"));
			const copy = join(root, "workspace");
			mkdirSync(copy, { mode: 0o755 });
			files = pytestFileVersions(config, policy, copy);
			result.status = "execution_error";
			// Image IDs are immutable; no tag resolution or implicit pulls at execution time.
			if (docker(["image", "inspect", policy.image, "--format", "{{.Id}}"]) !== policy.image)
				throw new Error("PYTEST_IMAGE_MISMATCH");
			const owner = config.containerOwner;
			if (owner !== undefined) assertSandboxContainerOwner(owner);
			id = docker([
				"create",
				"--name",
				`pi-pytest-${randomUUID()}`,
				"--pull",
				"never",
				...(owner === undefined ? [] : ["--label", SANDBOX_CONTAINER_OWNER_LABEL + "=" + owner]),
				"--log-driver",
				"none",
				"--network",
				"none",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--pids-limit",
				"32",
				"--memory",
				"128m",
				"--memory-swap",
				"128m",
				"--cpus",
				"0.5",
				"--user",
				sandboxUser(),
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,nodev,size=16m",
				"--mount",
				`type=bind,src=${copy},dst=/workspace,readonly`,
				"--workdir",
				"/workspace",
				"--env",
				"PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
				"--env",
				"PYTHONDONTWRITEBYTECODE=1",
				"--entrypoint",
				"python",
				policy.image,
				"-I",
				"-B",
				"-c",
				observedProgram(marker, result.targets.length, policy.candidateImport),
				"--rootdir=/workspace",
				...(policy.candidateImport === "pytest"
					? ["-p", "pytester"]
					: namespacePackages
						? ["--import-mode=importlib", "-o", "consider_namespace_packages=true"]
						: []),
				...targets,
			]);
			if (!/^[a-f0-9]{64}$/u.test(id)) {
				id = undefined;
				throw new Error("PYTEST_CONTAINER_INVALID");
			}
			const info = JSON.parse(docker(["inspect", id]))[0];
			if (
				info.Image !== policy.image ||
				(owner !== undefined && info.Config.Labels?.[SANDBOX_CONTAINER_OWNER_LABEL] !== owner) ||
				info.Config.User !== sandboxUser() ||
				info.HostConfig.NetworkMode !== "none" ||
				!info.HostConfig.ReadonlyRootfs ||
				info.HostConfig.Privileged ||
				info.Mounts.length !== 1 ||
				info.Mounts[0].RW ||
				info.Mounts[0].Destination !== "/workspace" ||
				realpathSync(info.Mounts[0].Source) !== copy
			) {
				result.status = "sandbox_error";
				throw new Error("PYTEST_ISOLATION_MISMATCH");
			}
			let tail = Buffer.alloc(0);
			let stdoutTail = Buffer.alloc(0);
			let count = 0;
			let stopped = false;
			let cleanupFailed = false;
			result.exitCode = await new Promise<number | null>((done) => {
				const child = spawn("docker", ["start", "-a", id!], {
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				const stop = () => {
					stopped = true;
					try {
						remove();
					} catch {
						cleanupFailed = true;
					}
					child.kill();
				};
				const timer = setTimeout(stop, Math.min(timeoutMs, 90_000 - elapsed));
				const collect = (chunk: Buffer) => {
					count += chunk.length;
					tail = Buffer.concat([tail, chunk]).subarray(-6400);
				};
				child.stdout.on("data", (chunk: Buffer) => {
					// stderr may be delivered after the final stdout marker.
					stdoutTail = Buffer.concat([stdoutTail, chunk]).subarray(-512);
					collect(chunk);
				});
				child.stderr.on("data", collect);
				signal?.addEventListener("abort", stop, { once: true });
				if (signal?.aborted) stop();
				child.once("error", () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", stop);
					done(null);
				});
				child.once("close", (code) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", stop);
					done(code);
				});
			});
			const report = new RegExp(marker + `(\\d{1,9}(?:,\\d{1,9}){${result.targets.length}})\\r?\\n$`).exec(stdoutTail.toString("utf8"));
			if (report) {
				const counts = report[1]!.split(",").map(Number);
				completedPasses = counts[0];
				passesByTarget = new Map(result.targets.map((target, i) => [target, counts[i + 1]!]));
				const bytes = Buffer.byteLength(report[0]);
				const start = tail.lastIndexOf(report[0]);
				if (start >= 0) tail = Buffer.concat([tail.subarray(0, start), tail.subarray(start + bytes)]);
				count -= bytes;
			}
			result.output = tail.subarray(-6000).toString("utf8");
			result.truncated = count > 6000;
			if (stopped) {
				result.status = cleanupFailed ? "sandbox_error" : signal?.aborted ? "execution_error" : "timeout";
			} else {
				const state = JSON.parse(docker(["inspect", id!, "--format", "{{json .State}}"]));
				if (state.Status !== "exited" || state.OOMKilled || state.Error || state.ExitCode !== result.exitCode)
					throw new Error("PYTEST_EXECUTION_FAILED");
				if (result.exitCode === 0 && completedPasses !== undefined) {
					result.status = completedPasses > 0 ? "passed" : "skipped";
				} else if (result.exitCode === 1) {
					result.status = "failed";
				} else if (result.exitCode === 2 || result.exitCode === 5) {
					result.status = "unsupported";
				}
				// Diagnostics are untrusted pytest output, not security or authorization evidence.
				result.passed = completedPasses ?? null;
				result.failed = Number(result.output.match(/(\d+) failed/u)?.[1] ?? 0);
			}
		} catch {
			result.output = "Test environment unavailable or approved file/isolation checks failed.";
		} finally {
			try {
				remove();
			} catch {
				result.status = "sandbox_error";
				result.output = "Container cleanup failed.";
			}
			if (root) {
				try {
					rmSync(root, { recursive: true, force: true });
				} catch {
					result.status = "sandbox_error";
					result.output = "Snapshot cleanup failed.";
				}
			}
			elapsed += performance.now() - started;
			busy = false;
		}
		if (files)
			observe?.(
				{
					passesByTarget,
					status: result.status,
					targets: result.targets,
					files,
					canRunAgain: calls < 3 && elapsed < 90_000,
				},
				result,
			);
		while (Buffer.byteLength(JSON.stringify(result)) > 8192) {
			result.output = result.output.slice(Math.max(1, Math.ceil(result.output.length / 8)));
			result.truncated = true;
		}
		return result;
	};
}
