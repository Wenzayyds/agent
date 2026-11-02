import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectScope } from "./contracts.ts";

const PROJECT_ID_PREFIX = "pi-enhanced-memory:v1\0";

export interface ProjectScopeOptions {
	cwd: string;
	agentDir: string;
	platform?: NodeJS.Platform;
	realpath?: (path: string) => string;
}

export function createProjectScope(options: ProjectScopeOptions): ProjectScope {
	const rootPath = (options.realpath ?? realpathSync.native)(resolve(options.cwd));
	const identityKey =
		(options.platform ?? process.platform) === "win32" ? rootPath.toLocaleLowerCase("en-US") : rootPath;
	const projectId = createHash("sha256").update(PROJECT_ID_PREFIX).update(identityKey).digest("hex");
	const dataDir = join(options.agentDir, "pi-enhanced", "memory", "projects", projectId);
	return {
		projectId,
		rootPath,
		identityKey,
		dataDir,
		manifestPath: join(dataDir, "project.json"),
		databasePath: join(dataDir, "memory.sqlite3"),
	};
}
