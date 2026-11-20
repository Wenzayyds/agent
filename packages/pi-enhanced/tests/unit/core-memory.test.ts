import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_MEMORY_NAMES, type CoreMemoryName, type ProjectScope } from "../../src/memory/contracts.ts";
import { CoreMemoryStore } from "../../src/memory/core-memory.ts";
import { MemoryError } from "../../src/memory/errors.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-enhanced-core-memory-"));
	tempDirs.push(path);
	return path;
}

function setup(): { scope: ProjectScope; store: CoreMemoryStore } {
	const root = tempDir();
	const project = join(root, "project");
	mkdirSync(project);
	const scope = createProjectScope({ cwd: project, agentDir: join(root, "agent") });
	return { scope, store: new CoreMemoryStore(scope) };
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P2-4 CoreMemoryStore", () => {
	it("supports explicit CRUD for exactly three fixed Markdown documents", () => {
		const { scope, store } = setup();
		for (const [index, name] of CORE_MEMORY_NAMES.entries()) {
			const created = store.create(name, `# ${name}\n`);
			expect(created.document).toMatchObject({
				projectId: scope.projectId,
				name,
				relativePath: `.pi-enhanced/memory/${name}.md`,
				content: `# ${name}\n`,
			});
			expect(created.visibilityWarning !== undefined).toBe(index === 0);
			expect(store.get(name)?.contentHash).toBe(createHash("sha256").update(`# ${name}\n`).digest("hex"));
			const updated = store.update(name, `# ${name}\nupdated\n`);
			expect(updated.document.content).toContain("updated");
			expect(updated.visibilityWarning).toBeUndefined();
		}

		for (const name of CORE_MEMORY_NAMES) {
			store.delete(name);
			expect(store.get(name)).toBeNull();
		}
	});

	it("rejects unsupported names, duplicate create, missing update, large content, and credentials", () => {
		const { scope, store } = setup();
		expect(() => store.get("../AGENTS" as CoreMemoryName)).toThrowError(
			expect.objectContaining({ code: "MEMORY_VALIDATION_ERROR" }),
		);
		expect(existsSync(join(scope.rootPath, ".pi-enhanced"))).toBe(false);
		store.create("project", "safe");
		expect(() => store.create("project", "again")).toThrowError(
			expect.objectContaining({ code: "MEMORY_CONTENT_CONFLICT" }),
		);
		expect(() => store.update("architecture", "missing")).toThrowError(
			expect.objectContaining({ code: "MEMORY_NOT_FOUND" }),
		);
		expect(() => store.create("architecture", "界".repeat(30_000))).toThrowError(
			expect.objectContaining({ code: "MEMORY_VALIDATION_ERROR" }),
		);
		expect(() => store.create("architecture", "token=sk-abcdefghijklmnopqrstuvwxyz123456")).toThrowError(
			expect.objectContaining({ code: "MEMORY_VALIDATION_ERROR" }),
		);
		writeFileSync(join(scope.rootPath, ".pi-enhanced", "memory", "project.md"), Uint8Array.from([0xff]));
		expect(() => store.get("project")).toThrowError(
			expect.objectContaining({ code: "MEMORY_VALIDATION_ERROR" }),
		);
	});

	it("rejects a junction or symbolic-link directory that escapes the project", () => {
		const { scope, store } = setup();
		const outside = join(tempDir(), "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(scope.rootPath, ".pi-enhanced"), "junction");
		expect(() => store.create("project", "must not escape")).toThrowError(
			expect.objectContaining({ code: "MEMORY_VALIDATION_ERROR" }),
		);
		expect(existsSync(join(outside, "memory", "project.md"))).toBe(false);
	});

	it("keeps the old document when atomic replacement fails and removes the temporary file", () => {
		const { scope, store } = setup();
		store.create("project", "old content");
		const failing = new CoreMemoryStore(scope, {
			create: linkSync,
			replace: () => {
				throw new Error("injected replace failure");
			},
		});
		expect(() => failing.update("project", "new content")).toThrowError(
			expect.objectContaining({ code: "MEMORY_STORAGE_ERROR" }),
		);
		expect(store.get("project")?.content).toBe("old content");
		const entries = readdirSync(join(scope.rootPath, ".pi-enhanced", "memory")).sort();
		expect(entries).toEqual(["project.md"]);
	});

	it("never modifies AGENTS.md content, hash, or timestamp", () => {
		const { scope, store } = setup();
		const agentsPath = join(scope.rootPath, "AGENTS.md");
		writeFileSync(agentsPath, "# Rules\nDo not change this file.\n");
		const beforeContent = readFileSync(agentsPath);
		const beforeHash = createHash("sha256").update(beforeContent).digest("hex");
		const beforeMtime = statSync(agentsPath).mtimeMs;

		store.create("decisions", "# Decision\nKeep Core separate from instructions.\n");
		store.update("decisions", "# Decision\nCore remains data.\n");
		store.delete("decisions");

		const afterContent = readFileSync(agentsPath);
		expect(afterContent.equals(beforeContent)).toBe(true);
		expect(createHash("sha256").update(afterContent).digest("hex")).toBe(beforeHash);
		expect(statSync(agentsPath).mtimeMs).toBe(beforeMtime);
	});
});
