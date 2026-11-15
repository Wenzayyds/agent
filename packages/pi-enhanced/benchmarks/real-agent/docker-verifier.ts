import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { sandboxUser } from "../../src/sandbox/broker.ts";
import { assertSandboxContainerOwner, assertSandboxWorkspaceIdentity, SANDBOX_CONTAINER_OWNER_LABEL, type SandboxConfig } from "../../src/sandbox/config.ts";
import { LONG_REPORT_TASK, longReport } from "./controlled-cases.ts";

export interface VerificationResult {
	mode: "docker-readonly";
	status: "passed" | "verification_failed" | "runtime_error" | "timeout" | "protocol_error";
	passed: boolean;
	errorCode?: string;
	exitCode: number | null;
	containerExitCode?: number;
	durationMs: number;
	outputBytes: number;
	cleanup: "not_needed" | "removed" | "failed";
	evidence: {
		containerId: string;
		image: string;
		network: string;
		readOnlyRoot: boolean;
		user: string;
		mounts: Array<{ destination: string; readWrite: boolean }>;
	} | null;
}

const CONFIG_CHECKS = [
	{ input: "{}", expected: 5000 },
	{ input: "{timeoutMs:7}", expected: 7 },
];
const configObservations = CONFIG_CHECKS.map(({ input }) => `config.loadConfig(${input}).timeoutMs`);

const TASKS: Record<string, { program: string; expected: unknown }> = {
	"single-file-off-by-one": { program: "const m=await import('./math.js');return [m.sumTo(3)];", expected: [6] },
	"cross-file-export": {
		program: "const m=await import('./index.js');return [m.formatName('pi')];",
		expected: ["PI"],
	},
	"config-default": {
		program: `const config = await import('./config.js');return [${configObservations.join(",")}];`,
		expected: CONFIG_CHECKS.map(({ expected }) => expected),
	},
	"long-output-localization": {
		program: "const m=await import('./validate.js');return [m.validateItems([...Array(20).fill(1),-1])];",
		expected: [false],
	},
	"memory-guided-regression": {
		program: "const m=await import('./key.js');const x='  PI ';return [m.normalizeKey(x),x];",
		expected: ["pi", "  PI "],
	},
	[LONG_REPORT_TASK.id]: {
		program:
			"const fs=await import('node:fs');const crypto=await import('node:crypto');const report=crypto.createHash('sha256').update(fs.readFileSync('diagnostics.txt')).digest('hex');const m=await import('./validate.js');return [m.validateItems([...Array(20).fill(1),-1]),report];",
		expected: [false, createHash("sha256").update(longReport()).digest("hex")],
	},
};

/** Only fixed observations execute in Docker. Expected values and the pass decision remain on the host. */
export async function verifyPatchInDocker(
	taskId: string,
	config: SandboxConfig,
	limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<VerificationResult> {
	return await runDockerCheck(taskId, config, limits);
}

export async function runApprovedTestInDocker(
	taskId: "single-file-off-by-one" | "config-default",
	config: SandboxConfig,
	signal?: AbortSignal,
) {
	const output = { stdout: "", stderr: "" };
	const result = await runDockerCheck(taskId, config, { maxOutputBytes: 2_048 }, { output, signal });
	return { ...output, result };
}

async function runDockerCheck(
	taskId: string,
	config: SandboxConfig,
	limits: { timeoutMs?: number; maxOutputBytes?: number },
	feedback?: { output: { stdout: string; stderr: string }; signal?: AbortSignal },
): Promise<VerificationResult> {
	const started = performance.now();
	const result: VerificationResult = {
		mode: "docker-readonly",
		status: "runtime_error",
		passed: false,
		exitCode: null,
		durationMs: 0,
		outputBytes: 0,
		cleanup: "not_needed",
		evidence: null,
	};
	let id: string | undefined;
	let removed = false;
	const remove = (): void => {
		if (!id || removed) return;
		execFileSync("docker", ["rm", "-f", id], { stdio: "ignore", timeout: 10_000, windowsHide: true });
		removed = true;
	};
	try {
		const task = Object.hasOwn(TASKS, taskId) ? TASKS[taskId] : undefined;
		if (!task) throw new Error("VERIFIER_UNKNOWN_TASK");
		if (!config.enabled || !config.trusted || !/^sha256:[a-f0-9]{64}$/u.test(config.image))
			throw new Error("VERIFIER_NOT_AUTHORIZED");
		assertSandboxWorkspaceIdentity(config);
		const timeoutMs = limits.timeoutMs ?? 5_000;
		const maxOutputBytes = limits.maxOutputBytes ?? 16_384;
		if (
			!Number.isInteger(timeoutMs) ||
			timeoutMs < 100 ||
			timeoutMs > 10_000 ||
			!Number.isInteger(maxOutputBytes) ||
			maxOutputBytes < 128 ||
			maxOutputBytes > 16_384
		)
			throw new Error("VERIFIER_LIMIT_INVALID");
		if (feedback?.signal?.aborted) throw new Error("VERIFIER_CANCELLED");
		if (feedback) {
			if (!config.containerOwner) throw new Error("VERIFIER_NOT_AUTHORIZED");
			assertSandboxContainerOwner(config.containerOwner);
		}
		const configFeedback = feedback && taskId === "config-default" ? feedback : undefined;
		const source = configFeedback
			? `const emit = process.stdout.write.bind(process.stdout);
const encode = JSON.stringify;
const isFinite = Number.isFinite;
const observe = (check) => {
	try {
		const value = check();
		return isFinite(value) ? value : null;
	} catch {
		return null;
	}
};
const config = await import("./config.js");
const actual = [${configObservations.map((expression) => `observe(() => ${expression})`).join(",")}];
emit(encode({ protocolVersion: 1, actual }));
process.exitCode = ${CONFIG_CHECKS.map(({ expected }, index) => `actual[${index}] === ${expected}`).join(" && ")} ? 0 : 1;`
			: feedback
				? `import { strictEqual } from "node:assert/strict";
const passed = console.log.bind(console);
const failed = console.error.bind(console);
try {
	const { sumTo } = await import("./math.js");
	strictEqual(sumTo(3), 6);
	passed("PASS");
} catch (error) {
	const diagnostic = error instanceof Error ? error.name + ": " + error.message.trim() : String(error);
	failed("sumTo(3): " + diagnostic);
	process.exitCode = 1;
}`
				: `const emit=process.stdout.write.bind(process.stdout);const encode=JSON.stringify;const actual=await(async()=>{${task.program}})();emit(encode({protocolVersion:1,actual}));`;
		id = execFileSync(
			"docker",
			[
				"create",
				"--name",
				`pi-enhanced-verify-${randomUUID()}`,
				...(feedback ? ["--label", SANDBOX_CONTAINER_OWNER_LABEL + "=" + config.containerOwner, "--log-driver", "none"] : []),
				"--pull",
				"never",
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
				"--cpus",
				"0.5",
				"--user",
				sandboxUser(),
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,size=16m",
				"--mount",
				`type=bind,src=${config.workspace},dst=/workspace,readonly`,
				"--workdir",
				"/workspace",
				"--entrypoint",
				"node",
				config.image,
				"--input-type=module",
				"--eval",
				source,
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true },
		).trim();
		if (!/^[a-f0-9]{64}$/u.test(id)) {
			id = undefined;
			throw new Error("VERIFIER_CONTAINER_ID_INVALID");
		}
		const inspected = JSON.parse(
			execFileSync("docker", ["inspect", id], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				windowsHide: true,
			}),
		)[0] as {
			Image: string;
			Config: { User: string };
			HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean };
			Mounts: Array<{ Source: string; Destination: string; RW: boolean }>;
		};
		if (
			inspected.Image !== config.image ||
			inspected.Config.User !== sandboxUser() ||
			inspected.HostConfig.NetworkMode !== "none" ||
			!inspected.HostConfig.ReadonlyRootfs ||
			inspected.HostConfig.Privileged ||
			inspected.Mounts.length !== 1 ||
			inspected.Mounts[0]!.Destination !== "/workspace" ||
			inspected.Mounts[0]!.RW ||
			realpathSync(inspected.Mounts[0]!.Source) !== config.workspace
		)
			throw new Error("VERIFIER_CONTAINER_POLICY_MISMATCH");
		result.evidence = {
			containerId: id,
			image: inspected.Image,
			network: inspected.HostConfig.NetworkMode,
			readOnlyRoot: inspected.HostConfig.ReadonlyRootfs,
			user: inspected.Config.User,
			mounts: inspected.Mounts.map((m) => ({ destination: m.Destination, readWrite: m.RW })),
		};
		const containerId = id;
		const execution = await new Promise<{ code: number | null; stdout: string; failure?: string }>((done) => {
			const child = spawn("docker", ["start", "-a", containerId], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const chunks: Buffer[] = [];
			const errors: Buffer[] = [];
			let settled = false;
			const finish = (code: number | null, failure?: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				feedback?.signal?.removeEventListener("abort", cancel);
				const stdout = Buffer.concat(chunks).toString("utf8");
				if (feedback) {
				Object.assign(feedback.output, {
					stdout: configFeedback ? "" : stdout,
					stderr: Buffer.concat(errors).toString("utf8"),
				});
			}
				done({ code, stdout, failure });
			};
			const abort = (failure: string): void => {
				try {
					remove();
				} catch {}
				child.kill();
				finish(null, failure);
			};
			const cancel = () => abort("VERIFIER_CANCELLED");
			const timer = setTimeout(() => abort("VERIFIER_TIMEOUT"), timeoutMs);
			const collect = (chunk: Buffer, stdout: boolean): void => {
				if (settled) return;
				result.outputBytes += chunk.length;
				if (result.outputBytes > maxOutputBytes) {
					abort("VERIFIER_OUTPUT_LIMIT");
					return;
				}
				if (stdout) chunks.push(chunk);
				else if (feedback) errors.push(chunk);
			};
			child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
			child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
			child.once("error", () => finish(null, "VERIFIER_DOCKER_UNAVAILABLE"));
			child.once("close", (code) => finish(code));
			feedback?.signal?.addEventListener("abort", cancel, { once: true });
			if (feedback?.signal?.aborted) cancel();
		});
		result.exitCode = execution.code;
		assertSandboxWorkspaceIdentity(config);
		if (execution.failure) {
			result.status = execution.failure === "VERIFIER_TIMEOUT" ? "timeout" : "runtime_error";
			result.errorCode = execution.failure;
		} else {
			const state = JSON.parse(
				execFileSync("docker", ["inspect", id, "--format", "{{json .State}}"], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 10_000,
					windowsHide: true,
				}),
			) as { Status: string; ExitCode: number; OOMKilled: boolean; Error: string; StartedAt: string };
			if (state.Status !== "exited" || state.OOMKilled || state.Error || state.StartedAt.startsWith("0001-"))
				throw new Error("VERIFIER_CONTAINER_EXECUTION_FAILED");
			result.containerExitCode = state.ExitCode;
			const configCheckFailed = configFeedback && execution.code === 1 && state.ExitCode === 1;
			if ((execution.code !== 0 || state.ExitCode !== 0) && !configCheckFailed) {
				result.status = state.ExitCode === 1 ? "verification_failed" : "runtime_error";
				result.errorCode = "VERIFIER_PROGRAM_FAILED";
				return result;
			}
			try {
				if (feedback && !configFeedback) {
					result.status = "passed";
					result.passed = true;
					return result;
				}
				const value = JSON.parse(execution.stdout) as { protocolVersion?: unknown; actual?: unknown };
				if (
					!value ||
					value.protocolVersion !== 1 ||
					Object.keys(value).sort().join(",") !== "actual,protocolVersion"
				)
					throw new Error("invalid protocol");
				const passed = isDeepStrictEqual(value.actual, task.expected);
				if (configFeedback) {
					const actual = value.actual;
					if (
						!Array.isArray(actual) ||
						actual.length !== CONFIG_CHECKS.length ||
						!actual.every((item: unknown) => item === null || Number.isFinite(item)) ||
						state.ExitCode !== (passed ? 0 : 1)
					) {
						throw new Error("invalid config checks");
					}
					const stdout: string[] = [];
					const stderr: string[] = [];
					for (const [index, { input, expected }] of CONFIG_CHECKS.entries()) {
						const observed: number | null = actual[index];
						const label = `loadConfig(${input}).timeoutMs`;
						if (observed === expected) stdout.push(`PASS ${label}: ${observed}`);
						else stderr.push(`FAIL ${label}: expected ${expected}, got ${observed ?? "no numeric result"}`);
					}
					Object.assign(configFeedback.output, { stdout: stdout.join("\n"), stderr: stderr.join("\n") });
				}
				result.passed = passed;
				result.status = passed ? "passed" : "verification_failed";
			} catch {
				result.status = "protocol_error";
				result.errorCode = "VERIFIER_INVALID_RESPONSE";
			}
		}
	} catch (error) {
		result.errorCode =
			error instanceof Error
				? (error.message.match(/(?:VERIFIER|SANDBOX)_[A-Z_]+/u)?.[0] ?? "VERIFIER_DOCKER_UNAVAILABLE")
				: "VERIFIER_RUNTIME_ERROR";
	} finally {
		try {
			remove();
			result.cleanup = id ? "removed" : "not_needed";
		} catch {
			result.cleanup = "failed";
			result.status = "runtime_error";
			result.passed = false;
			result.errorCode = "VERIFIER_CLEANUP_FAILED";
		}
		result.durationMs = Number((performance.now() - started).toFixed(3));
	}
	return result;
}
