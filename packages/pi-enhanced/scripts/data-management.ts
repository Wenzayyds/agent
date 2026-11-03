import { createSqliteBackup, restoreSqliteBackup, type DataStoreKind } from "../src/data-management/backup.ts";

const [operation, kindValue, projectId, source, destination, confirmation] = process.argv.slice(2);
if ((operation !== "backup" && operation !== "restore") || (kindValue !== "memory" && kindValue !== "task") || !projectId || !source || !destination) {
	throw new Error("Usage: npm run data -- <backup|restore> <memory|task> <projectId> <source> <destination> [confirmProjectId]");
}
const kind = kindValue as DataStoreKind;
if (operation === "backup") {
	const result = await createSqliteBackup({ kind, projectId, sourcePath: source, destinationPath: destination });
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
	if (confirmation !== projectId) throw new Error("Restore requires the projectId repeated as the final confirmation argument");
	const result = restoreSqliteBackup({ backupPath: source, destinationPath: destination, expectedKind: kind, expectedProjectId: projectId });
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
