import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup, restoreSqliteBackup } from "../../src/data-management/backup.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { openLocalMemoryProvider } from "../../src/memory/storage.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("project SQLite backup and offline restore", () => {
	it("backs up and restores Memory and Task databases with scope and integrity checks", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-enhanced-backup-")); roots.push(root);
		const project = join(root, "project"); const agentDir = join(root, "agent"); mkdirSync(project);
		const scope = createProjectScope({ cwd: project, agentDir });
		const memory = await openLocalMemoryProvider(scope);
		await memory.saveCandidate({ kind: "fact", content: "backup marker", normalizedContent: "backup marker", contentHash: "a".repeat(64), source: { type: "user", ref: "backup-test", observedAt: Date.now() }, now: Date.now() });
		const memoryBackup = join(root, "memory.backup.sqlite3");
		await createSqliteBackup({ kind: "memory", projectId: scope.projectId, sourcePath: scope.databasePath, destinationPath: memoryBackup });
		memory.close();
		const memoryRestore = restoreSqliteBackup({ backupPath: memoryBackup, destinationPath: scope.databasePath, expectedKind: "memory", expectedProjectId: scope.projectId });
		expect(memoryRestore.restored).toBe(true);
		expect(memoryRestore.preRestoreBackupPath).toBeTruthy();
		const reopenedMemory = await openLocalMemoryProvider(scope);
		expect((await reopenedMemory.search({ text: "backup marker" })).map((record) => record.content)).toContain("backup marker");
		reopenedMemory.close();
		expect(existsSync(`${memoryBackup}.manifest.json`)).toBe(true);

		const taskScope = createTaskStorageScope(scope, agentDir); const tasks = new TaskService(new TaskProvider(taskScope), 10);
		const created = tasks.create("backup task", [{ title: "inspect", expectedOutcome: "saved" }], "session", null);
		const taskBackup = join(root, "task.backup.sqlite3");
		await createSqliteBackup({ kind: "task", projectId: scope.projectId, sourcePath: taskScope.databasePath, destinationPath: taskBackup });
		tasks.close();
		const restoredTask = join(root, "restored-task.sqlite3");
		restoreSqliteBackup({ backupPath: taskBackup, destinationPath: restoredTask, expectedKind: "task", expectedProjectId: scope.projectId });
		const reopened = new TaskProvider({ ...taskScope, databasePath: restoredTask });
		expect(reopened.get(created.task.taskId)?.task.goal).toBe("backup task"); reopened.close();
	});
});
