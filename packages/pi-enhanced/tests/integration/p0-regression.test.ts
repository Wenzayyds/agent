import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../../../coding-agent/src/core/extensions/loader.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("P0 package regression", () => {
	// Keep the historical test identity stable; Batch G adds the fifth optional sandbox entry.
	it("keeps four independent root entries without built-in command conflicts", async () => {
		const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
			pi: { extensions: string[] };
		};
		const paths = manifest.pi.extensions.map((path) => resolve(packageDir, path));
		const result = await discoverAndLoadExtensions(paths, packageDir, packageDir);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(5);
		expect(result.extensions.every((extension) => extension.tools.size === 0)).toBe(true);
		const commands = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
		expect(commands.sort()).toEqual([
			"enhanced-context-inspect",
			"enhanced-context-status",
			"enhanced-mcp-policy-status",
			"enhanced-memory-status",
			"enhanced-task-manager-status",
		]);
		expect(commands).not.toEqual(expect.arrayContaining(["mcp", "codemode", "tool_search"]));
	}, 15_000);
});
