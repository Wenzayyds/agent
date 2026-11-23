import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PythonMemoryWorkerClient } from "../shared/embedding/python-worker-client.ts";
import type { KnowledgeReranker } from "./service.ts";

export const RERANKER_REVISION = "1427fd652930e4ba29e8149678df786c240d8825";
const program = fileURLToPath(new URL("../../python/knowledge-reranker/worker.py", import.meta.url));
const dockerHost = process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
const localDocker = ["--host", dockerHost] as const;

/** Host-provisioned weights. The worker only sees its program, weights, and input frames. */
export function createLocalKnowledgeReranker(): KnowledgeReranker {
	let client: PythonMemoryWorkerClient | undefined;
	let name: string | undefined;
	const environment = Object.fromEntries(
		["PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE"].flatMap((key) =>
			process.env[key] ? [[key, process.env[key]!]] : [],
		),
	);
	const close = async (): Promise<void> => {
		const current = client;
		const container = name;
		client = undefined;
		name = undefined;
		if (!current || !container) return;
		await current.close().finally(
			() =>
				new Promise<void>((resolve) => {
					execFile(
						"docker",
						[...localDocker, "rm", "-f", container],
						{ env: environment, windowsHide: true, timeout: 2_000 },
						() => resolve(),
					);
				}),
		);
	};
	return {
		async rank(query, passages) {
			try {
				if (!client) {
					const cache = process.env.PI_KNOWLEDGE_RERANK_MODEL_DIR;
					if (!cache) throw new Error("Missing local reranker weights");
					const model = realpathSync.native(cache);
					if (!statSync(model).isDirectory() || model.includes(",") || program.includes(","))
						throw new Error("Invalid reranker mount");
					name = `pi-knowledge-rerank-${randomUUID()}`;
					client = new PythonMemoryWorkerClient({
						command: "docker",
						cwd: process.cwd(),
						environment,
						startupTimeoutMs: 12_000,
						requestTimeoutMs: 1_500,
						args: [
							...localDocker,
							"run",
							"--rm",
							"-i",
							"--pull=never",
							"--network=none",
							"--name",
							name,
							"--read-only",
							"--cpus=2",
							"--memory=1536m",
							"--pids-limit=96",
							"--cap-drop=ALL",
							"--security-opt=no-new-privileges",
							"--tmpfs",
							"/tmp:rw,noexec,nosuid,nodev,size=32m",
							"--mount",
							`type=bind,source=${model},target=/models,readonly`,
							"--mount",
							`type=bind,source=${program},target=/rerank.py,readonly`,
							"--env",
							"HF_HUB_OFFLINE=1",
							"--env",
							"TRANSFORMERS_OFFLINE=1",
							"--env",
							"TOKENIZERS_PARALLELISM=false",
							"--env",
							"PYTHONDONTWRITEBYTECODE=1",
							process.env.PI_MEMORY_V3_E5_IMAGE ?? "pi-memory-v3-e5:local",
							"python",
							"/rerank.py",
						],
					});
				}
				const response = await client.request("rerank_pairs", { query, passages });
				if (!Array.isArray(response.scores)) throw new Error("Invalid reranker scores");
				return response.scores;
			} catch (error) {
				await close();
				throw error;
			}
		},
		close,
	};
}
