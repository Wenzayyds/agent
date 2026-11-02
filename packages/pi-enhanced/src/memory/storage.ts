import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectScope } from "./contracts.ts";
import { MemoryError } from "./errors.ts";
import { LocalMemoryProvider, type LocalMemoryProviderOptions } from "./provider.ts";

interface ProjectManifest {
	schemaVersion: 1;
	projectId: string;
	rootPath: string;
}

export async function openLocalMemoryProvider(
	scope: ProjectScope,
	options?: LocalMemoryProviderOptions,
): Promise<LocalMemoryProvider> {
	ensureProjectStorage(scope);
	return new LocalMemoryProvider(scope, options);
}

export function ensureProjectStorage(scope: ProjectScope): void {
	mkdirSync(scope.dataDir, { recursive: true });
	if (existsSync(scope.manifestPath)) {
		let manifest: ProjectManifest;
		try {
			manifest = JSON.parse(readFileSync(scope.manifestPath, "utf8")) as ProjectManifest;
		} catch (error) {
			throw new MemoryError("MEMORY_STORAGE_ERROR", "Project memory manifest is invalid", { cause: error });
		}
		if (
			manifest.schemaVersion !== 1 ||
			manifest.projectId !== scope.projectId ||
			manifest.rootPath !== scope.rootPath
		) {
			throw new MemoryError("MEMORY_STORAGE_ERROR", "Project memory manifest does not match the current workspace");
		}
		return;
	}
	const manifest: ProjectManifest = { schemaVersion: 1, projectId: scope.projectId, rootPath: scope.rootPath };
	const temporary = join(scope.dataDir, `.${basename(scope.manifestPath)}.${process.pid}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	renameSync(temporary, scope.manifestPath);
}
