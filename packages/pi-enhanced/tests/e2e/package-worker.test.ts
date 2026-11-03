import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const pythonCommand = process.platform === "win32" ? "py" : "python3";
const pythonPrefix = process.platform === "win32" ? ["-3"] : [];
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const pythonAvailable =
	spawnSync(pythonCommand, [...pythonPrefix, "-c", "import numpy"], { encoding: "utf8" }).status === 0;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P2 release package", () => {
	it.skipIf(!pythonAvailable)(
		"packs, installs, and starts the bundled worker from a path containing spaces",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi enhanced package "));
			roots.push(root);
			const pack = spawnSync(
				process.execPath,
				[npmCli, "pack", "--json", "--pack-destination", root, "./packages/pi-enhanced"],
				{ cwd: repositoryRoot, encoding: "utf8" },
			);
			expect(pack.status, pack.stderr).toBe(0);
			const metadata = JSON.parse(pack.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
			const tarball = join(root, metadata[0].filename);
			const paths = metadata[0].files.map(({ path }) => path.replaceAll("\\", "/"));
			expect(paths).toContain("python/memory-intelligence/src/memory_intelligence/worker.py");
			expect(paths).toEqual(expect.arrayContaining(["extensions/task-manager.ts", "src/task-manager/provider.ts", "src/task-manager/service.ts", "src/task-manager/recovery.ts"]));
			expect(paths.some((path) => /(^|\/)(tests|__pycache__|\.venv|models|indexes)(\/|$)/.test(path))).toBe(false);

			const installRoot = join(root, "installed project");
			const install = spawnSync(
				process.execPath,
				[
					npmCli,
					"install",
					"--prefix",
					installRoot,
					"--package-lock=false",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--omit=peer",
					tarball,
				],
				{ cwd: repositoryRoot, encoding: "utf8" },
			);
			expect(install.status, install.stderr).toBe(0);
			const installed = join(installRoot, "node_modules", "@wz-agent", "pi-enhanced");
			const workerCwd = join(installed, "python", "memory-intelligence", "src");
			expect(existsSync(join(workerCwd, "memory_intelligence", "worker.py"))).toBe(true);

			const requests = [
				{ requestId: "health", op: "health", payload: {} },
				{ requestId: "sync", op: "sync_snapshot", payload: { projectId: "installed", records: [] } },
				{ requestId: "search", op: "search_vectors", payload: { projectId: "installed", query: "release", topK: 3 } },
				{ requestId: "shutdown", op: "shutdown", payload: {} },
			];
			const run = spawnSync(pythonCommand, [...pythonPrefix, "-m", "memory_intelligence.worker"], {
				cwd: workerCwd,
				input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
				encoding: "utf8",
				timeout: 10_000,
				env: {
					PATH: process.env.PATH ?? "",
					SystemRoot: process.env.SystemRoot ?? "",
					PYTHONIOENCODING: "utf-8",
					PYTHONUNBUFFERED: "1",
				},
			});
			expect(run.status, run.stderr).toBe(0);
			const responses = run.stdout
				.trim()
				.split(/\r?\n/u)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(responses).toHaveLength(4);
			expect(responses[0]).toMatchObject({ requestId: "health", ok: true, result: { status: "ready" } });
			expect(responses[2]).toMatchObject({ requestId: "search", ok: true, result: { candidates: [] } });
			expect(JSON.stringify(responses)).not.toContain("content");
			expect(readFileSync(join(installed, "package.json"), "utf8")).toContain("@wz-agent/pi-enhanced");
			expect(readdirSync(installed)).not.toContain("tests");
			const peerScope = join(installRoot, "node_modules", "@earendil-works"); mkdirSync(peerScope, { recursive: true });
			for (const [name, source] of [["pi-coding-agent", "coding-agent"], ["pi-ai", "ai"], ["pi-agent-core", "agent"]] as const) symlinkSync(join(repositoryRoot, "packages", source), join(peerScope, name), "junction");
			for (const name of ["mcp-policy", "memory", "context", "task-manager", "sandbox"]) {
				const extensionModule = await import(pathToFileURL(join(installed, "extensions", `${name}.ts`)).href);
				expect(typeof extensionModule.default).toBe("function");
			}
		},
		30_000,
	);
});
