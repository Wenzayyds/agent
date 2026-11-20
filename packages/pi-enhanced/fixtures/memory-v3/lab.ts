import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { PythonMemoryWorkerClient } from "../../src/memory/python-worker-client.ts";

const pythonRoot = fileURLToPath(new URL("../../python/memory-intelligence/src/", import.meta.url));
const composePath = fileURLToPath(new URL("compose.yaml", import.meta.url));

export function dockerWorker(image: string, name = `pi-memory-v3-worker-${randomUUID()}`, modelCache?: string): PythonMemoryWorkerClient {
	const environment = Object.fromEntries(
		["PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "DOCKER_CONFIG"]
			.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []),
	);
	return new PythonMemoryWorkerClient({
		command: "docker",
		args: [
			"run", "--rm", "--interactive", "--network", "none", "--name", name,
			"--mount", `type=bind,source=${pythonRoot},target=/memory,readonly`,
			"--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
			...(modelCache ? ["--env", "PI_ENHANCED_MEMORY_MODEL_CACHE=" + modelCache] : []),
			"--workdir", "/memory", image, "python", "-m", "memory_intelligence.worker",
		],
		startupTimeoutMs: 20_000, requestTimeoutMs: 30_000, environment,
	});
}


const ports = new Map<string, number>();

export async function reserveLoopbackPort(project: string): Promise<void> {
	const port = await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => {
				if (error || !address || typeof address === "string") reject(error ?? new Error("Invalid loopback address"));
				else resolve(address.port);
			});
		});
	});
	ports.set(project, port);
}

export function compose(project: string, ...args: string[]): string {
	return execFileSync("docker", ["compose", "--project-name", project, "-f", composePath, ...args], {
		encoding: "utf-8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_MEMORY_V3_QDRANT_PORT: String(ports.get(project) ?? 6333) },
	}).trim();
}
