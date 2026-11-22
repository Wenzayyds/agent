import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { E5EmbeddingProvider } from "../../src/shared/embedding/e5.ts";
import { PythonMemoryWorkerClient } from "../../src/shared/embedding/python-worker-client.ts";

const qdrantImage = "qdrant/qdrant:v1.15.5@sha256:0fb8897412abc81d1c0430a899b9a81eb8328aa634e7242d1bc804c1fe8fe863";
const e5Root = fileURLToPath(new URL("../../python/memory-intelligence/src/", import.meta.url));

export async function startVectorLab() {
	const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
	const qdrant = `pi-knowledge-qdrant-${suffix}`;
	const e5 = `pi-knowledge-e5-${suffix}`;
	const e5Image = process.env.PI_MEMORY_V3_E5_IMAGE ?? "pi-memory-v3-e5:local";
	const environment = Object.fromEntries(
		["PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "DOCKER_CONFIG"]
			.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []),
	);
	const worker = new PythonMemoryWorkerClient({
		command: "docker", environment, startupTimeoutMs: 20_000, requestTimeoutMs: 30_000,
		args: [
			"run", "--rm", "-i", "--pull=never", "--network=none", "--name", e5,
			"--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
			"--cpus=2", "--memory=1200m", "--pids-limit=96", "--cap-drop=ALL", "--security-opt=no-new-privileges",
			"--mount", `type=bind,source=${e5Root},target=/memory,readonly`,
			"--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
			"--workdir", "/memory", e5Image, "python", "-m", "memory_intelligence.worker",
		],
	});
	const remove = () => {
		for (const container of [qdrant, e5]) {
			if (docker("ps", "-a", "--filter", `name=${container}`, "--format", "{{.Names}}").split(/\r?\n/u).includes(container)) {
				docker("rm", "-f", "-v", container);
			}
		}
	};
	try {
		const port = await reservePort();
		docker("run", "-d", "--pull=never", "--name", qdrant, "--publish", `127.0.0.1:${port}:6333`, qdrantImage);
		const address = docker("port", qdrant, "6333/tcp");
		if (!/^127\.0\.0\.1:\d+$/u.test(address)) throw new Error("Expected local Qdrant port");
		const endpoint = `http://${address}`;
		await waitForQdrant(endpoint);
		return {
			endpoint, embedding: new E5EmbeddingProvider(() => worker), collection: `knowledge_${suffix}`,
			stopQdrant: () => docker("stop", qdrant),
			async restartQdrant() {
				docker("start", qdrant);
				await waitForQdrant(endpoint);
			},
			workerNetwork: () => docker("inspect", "--format", "{{.HostConfig.NetworkMode}}", e5),
			vectorBytes: () => ({
				apparent: Number(docker("exec", qdrant, "du", "-sb", "/qdrant/storage").split(/\s/u)[0]),
				allocated: Number(docker("exec", qdrant, "du", "-s", "-B1", "/qdrant/storage").split(/\s/u)[0]),
			}),
			memory: () => docker("stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}}", qdrant, e5),
			async close() {
				try {
					await worker.close();
				} finally {
					remove();
				}
			},
		};
	} catch (error) {
		await worker.close().finally(remove);
		throw error;
	}
}

function docker(...args: string[]): string {
	return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore","pipe","pipe"] }).trim();
}

async function waitForQdrant(endpoint: string): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const response = await fetch(`${endpoint}/readyz`, { signal: AbortSignal.timeout(1_000), redirect: "error" }).catch(() => undefined);
		if (response?.ok) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Local Qdrant did not become ready");
}

function reservePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => {
				if (error || !address || typeof address === "string") reject(error ?? new Error("Missing loopback address"));
				else resolve(address.port);
			});
		});
	});
}
