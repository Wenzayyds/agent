import { readFileSync } from "node:fs";
import { getEnhancedConfigPaths } from "../shared/config.ts";
import type { RetrievalMode } from "./service.ts";

export type KnowledgeState = "disabled" | "blocked" | "enabled" | "invalid-config";
type KnowledgeConfig = { state: KnowledgeState; mode: RetrievalMode; qdrantEndpoint: string; rerank?: boolean };

export function loadKnowledgeConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): KnowledgeConfig {
	const paths = getEnhancedConfigPaths(options);
	const config: KnowledgeConfig = { state: "disabled", mode: "lexical", qdrantEndpoint: "http://127.0.0.1:6333" };
	let enabled = false;
	for (const path of [paths.global, paths.project]) {
		if (!path) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isRecord(parsed)) throw new TypeError();
			if (parsed.modules === undefined) continue;
			if (!isRecord(parsed.modules)) throw new TypeError();
			const module = parsed.modules.knowledge;
			if (module === undefined) continue;
			if (
				!isRecord(module) ||
				typeof module.enabled !== "boolean" ||
				Object.keys(module).some((key) => !["enabled", "mode", "qdrantEndpoint", "rerank"].includes(key))
			)
				throw new TypeError();
			enabled = module.enabled;
			if (module.rerank !== undefined) {
				if (typeof module.rerank !== "boolean") throw new TypeError();
				config.rerank = module.rerank;
			}
			if (module.mode !== undefined) {
				if (module.mode !== "lexical" && module.mode !== "semantic" && module.mode !== "hybrid")
					throw new TypeError();
				config.mode = module.mode;
			}
			if (module.qdrantEndpoint !== undefined) {
				if (typeof module.qdrantEndpoint !== "string") throw new TypeError();
				const endpoint = new URL(module.qdrantEndpoint);
				if (
					endpoint.protocol !== "http:" ||
					!["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
					endpoint.username ||
					endpoint.password ||
					endpoint.pathname !== "/" ||
					endpoint.search ||
					endpoint.hash
				) {
					throw new TypeError();
				}
				config.qdrantEndpoint = endpoint.origin;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ...config, state: "invalid-config" };
		}
	}
	return { ...config, state: enabled ? (options.projectTrusted ? "enabled" : "blocked") : "disabled" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
