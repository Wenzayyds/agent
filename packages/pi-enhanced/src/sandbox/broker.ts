import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { AUDIT_MAX_RECORDS, SandboxAuditJournal } from "./audit.ts";
import { assertSandboxWorkspaceIdentity, type SandboxConfig } from "./config.ts";
import {
	assertRequestId,
	SANDBOX_PROTOCOL_VERSION,
	type SandboxRequest,
	type SandboxResponse,
	type SandboxToolName,
	sanitizeSandboxError,
	validateSandboxResponse,
} from "./protocol.ts";
import { SANDBOX_WORKER_SOURCE } from "./worker-source.ts";

// Bind mounts retain host ownership on Linux. Never run the container as root.
export function sandboxUser(): string {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	return uid && gid ? `${uid}:${gid}` : "1000:1000";
}

export interface SandboxAuditRecord {
	runId?: string;
	startedAt?: number;
	endedAt?: number;
	requestId: string;
	toolName: SandboxToolName;
	operation: string;
	status: "ok" | "error";
	containerId: string;
	image: string;
	durationMs: number;
	errorCode?: string;
}

export interface SandboxContainerEvidence {
	containerId: string;
	image: string;
	network: string;
	readOnlyRoot: boolean;
	user: string;
	mounts: Array<{ destination: string; readWrite: boolean }>;
}

export class DockerSandboxBroker {
	private readonly config: SandboxConfig;
	private containerId: string | undefined;
	private stopped = false;
	private requestIds = new Set<string>();
	private audit: SandboxAuditRecord[] = [];
	private evidence: SandboxContainerEvidence | undefined;
	private journal: SandboxAuditJournal | undefined;

	constructor(config: SandboxConfig) {
		this.config = config;
		if (config.auditReportPath) this.journal = new SandboxAuditJournal(config.auditReportPath, config);
	}

	start(): SandboxContainerEvidence {
		if (this.stopped) throw new Error("SANDBOX_RUNTIME_CLOSED");
		if (!this.config.enabled || !this.config.trusted) throw new Error("SANDBOX_NOT_AUTHORIZED");
		assertSandboxWorkspaceIdentity(this.config);
		if (this.containerId && this.evidence) return this.evidence;
		const name = `pi-enhanced-tools-${this.config.runId}-${randomUUID().slice(0, 8)}`;
		try {
			const id = execFileSync(
				"docker",
				[
					"create",
					"--name",
					name,
					"--network",
					"none",
					"--read-only",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--pids-limit",
					"64",
					"--memory",
					"192m",
					"--cpus",
					"0.5",
					"--user",
					sandboxUser(),
					"--tmpfs",
					"/tmp:rw,noexec,nosuid,size=32m",
					"--mount",
					`type=bind,src=${this.config.workspace},dst=/workspace`,
					this.config.image,
					"node",
					"-e",
					"setInterval(() => {}, 2147483647)",
				],
				{ encoding: "utf8", timeout: this.config.timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
			).trim();
			this.containerId = id;
			execFileSync("docker", ["start", id], {
				encoding: "utf8",
				timeout: this.config.timeoutMs,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const inspected = JSON.parse(
				execFileSync("docker", ["inspect", id, "--format", "{{json .}}"], {
					encoding: "utf8",
					timeout: this.config.timeoutMs,
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				}),
			) as {
				Image: string;
				Config: { User: string };
				HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean };
				Mounts: Array<{ Source: string; Destination: string; RW: boolean }>;
			};
			const workspaceMount = inspected.Mounts.filter((mount) => mount.Destination === "/workspace");
			if (
				inspected.Image !== this.config.image ||
				inspected.HostConfig.NetworkMode !== "none" ||
				!inspected.HostConfig.ReadonlyRootfs ||
				inspected.HostConfig.Privileged ||
				inspected.Config.User !== sandboxUser() ||
				workspaceMount.length !== 1 ||
				!workspaceMount[0]?.RW ||
				inspected.Mounts.some((mount) => mount.Destination !== "/workspace")
			) {
				throw new Error("SANDBOX_CONTAINER_POLICY_MISMATCH");
			}
			this.evidence = {
				containerId: id,
				image: inspected.Image,
				network: inspected.HostConfig.NetworkMode,
				readOnlyRoot: inspected.HostConfig.ReadonlyRootfs,
				user: inspected.Config.User,
				mounts: inspected.Mounts.map((mount) => ({
					destination: mount.Destination,
					readWrite: mount.RW,
				})),
			};
			this.journal?.setEvidence(this.evidence);
			return this.evidence;
		} catch (error) {
			this.stop();
			throw sanitizeSandboxError(error);
		}
	}

	async request(
		toolName: SandboxToolName,
		operation: string,
		args: Record<string, unknown>,
		options: { requestId?: string; signal?: AbortSignal } = {},
	): Promise<unknown> {
		assertSandboxWorkspaceIdentity(this.config);
		const containerId = this.start().containerId;
		const requestId = options.requestId ?? randomUUID();
		assertRequestId(requestId);
		if (this.requestIds.has(requestId)) throw new Error("SANDBOX_DUPLICATE_REQUEST");
		if (this.requestIds.size >= AUDIT_MAX_RECORDS) throw new Error("SANDBOX_AUDIT_LIMIT");
		this.requestIds.add(requestId);
		const request: SandboxRequest = {
			protocolVersion: SANDBOX_PROTOCOL_VERSION,
			runId: this.config.runId,
			requestId,
			toolName,
			operation,
			args,
			deadlineMs: Date.now() + this.config.timeoutMs,
		};
		const encoded = JSON.stringify(request);
		if (Buffer.byteLength(encoded, "utf8") > this.config.maxRequestBytes) {
			throw new Error("SANDBOX_REQUEST_TOO_LARGE");
		}
		const started = performance.now();
		const startedAt = Date.now();
		if (this.audit.length >= AUDIT_MAX_RECORDS) throw new Error("SANDBOX_AUDIT_LIMIT");
		// No operation starts until its intent is durable. No paths or file contents enter the journal.
		if (!/^[a-z_]{1,40}$/u.test(operation)) throw new Error("SANDBOX_OPERATION_INVALID");
		this.journal?.begin({
			runId: this.config.runId,
			requestId: auditRequestId(requestId),
			toolName,
			operation,
			containerId,
			startedAt,
		});
		let response: SandboxResponse;
		try {
			response = await this.executeWorker(containerId, encoded, options.signal);
			if (response.status === "error") throw new Error(response.errorCode ?? "SANDBOX_WORKER_REJECTED");
		} catch (error) {
			const sanitized = sanitizeSandboxError(error);
			this.record({
				runId: this.config.runId,
				startedAt,
				endedAt: Date.now(),
				requestId,
				toolName,
				operation,
				status: "error",
				containerId,
				image: this.config.image,
				durationMs: Number((performance.now() - started).toFixed(3)),
				errorCode: sanitized.message,
			});
			throw sanitized;
		}
		// A failed journal write must not be caught and recorded a second time as a worker error.
		this.record({
			runId: this.config.runId,
			startedAt,
			endedAt: Date.now(),
			requestId,
			toolName,
			operation,
			status: "ok",
			containerId,
			image: this.config.image,
			durationMs: Number((performance.now() - started).toFixed(3)),
		});
		return response.result;
	}

	toRelative(absolutePath: string): string {
		if (!isAbsolute(absolutePath)) throw new Error("SANDBOX_EXPECTED_ABSOLUTE_PATH");
		const candidate = relative(this.config.workspace, absolutePath).replaceAll("\\", "/");
		if (candidate.startsWith("../") || candidate === ".." || isAbsolute(candidate)) {
			throw new Error("SANDBOX_PATH_ESCAPE");
		}
		return candidate || ".";
	}

	getAuditRecords(): readonly SandboxAuditRecord[] {
		return this.audit;
	}

	getEvidence(): SandboxContainerEvidence | undefined {
		return this.evidence;
	}

	completeAudit(): void {
		this.journal?.complete();
	}
	private record(value: SandboxAuditRecord): void {
		this.journal?.end({ ...value, requestId: auditRequestId(value.requestId) });
		this.audit.push(value);
	}

	stop(): void {
		if (this.stopped && !this.containerId) return;
		this.stopped = true;
		const id = this.containerId;
		this.containerId = undefined;
		if (!id) return;
		try {
			execFileSync("docker", ["rm", "-f", id], {
				stdio: "ignore",
				timeout: this.config.timeoutMs,
				windowsHide: true,
			});
		} catch {}
	}

	private executeWorker(containerId: string, input: string, signal?: AbortSignal): Promise<SandboxResponse> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("SANDBOX_ABORTED"));
				return;
			}
			const child = spawn("docker", ["exec", "-i", containerId, "node", "-e", SANDBOX_WORKER_SOURCE], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			const stdout: Buffer[] = [];
			let stdoutBytes = 0;
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				callback();
			};
			const killContainer = (): void => {
				try {
					execFileSync("docker", ["rm", "-f", containerId], {
						stdio: "ignore",
						timeout: 5_000,
						windowsHide: true,
					});
				} catch {}
				this.containerId = undefined;
				child.kill();
			};
			const onAbort = (): void => {
				killContainer();
				finish(() => reject(new Error("SANDBOX_ABORTED")));
			};
			const timer = setTimeout(() => {
				killContainer();
				finish(() => reject(new Error("SANDBOX_TIMEOUT")));
			}, this.config.timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > this.config.maxResponseBytes) {
					killContainer();
					finish(() => reject(new Error("SANDBOX_RESPONSE_TOO_LARGE")));
					return;
				}
				stdout.push(chunk);
			});
			child.on("error", () => finish(() => reject(new Error("SANDBOX_DOCKER_UNAVAILABLE"))));
			child.on("close", () => {
				finish(() => {
					try {
						const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
						resolve(
							validateSandboxResponse(
								parsed,
								JSON.parse(input) as Pick<SandboxRequest, "runId" | "requestId" | "toolName">,
								this.config.maxResponseBytes,
							),
						);
					} catch {
						reject(new Error("SANDBOX_INVALID_RESPONSE"));
					}
				});
			});
			child.stdin.end(input);
		});
	}
}

function auditRequestId(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
