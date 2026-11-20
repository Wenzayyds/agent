import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export type DataStoreKind = "memory" | "task";

export interface BackupManifest {
	schemaVersion: 1;
	kind: DataStoreKind;
	projectId: string;
	databaseSchemaVersion: number;
	createdAt: string;
	databaseFile: string;
	databaseBytes: number;
	sha256: string;
}

export async function createSqliteBackup(input: {
	kind: DataStoreKind;
	projectId: string;
	sourcePath: string;
	destinationPath: string;
}): Promise<BackupManifest> {
	if (!existsSync(input.sourcePath)) throw new Error("Source SQLite database does not exist");
	if (existsSync(input.destinationPath)) throw new Error("Backup destination already exists");
	const source = new DatabaseSync(input.sourcePath, { readOnly: true });
	try {
		assertIntegrity(source);
		await backup(source, input.destinationPath);
	} finally {
		source.close();
	}
	const copied = new DatabaseSync(input.destinationPath, { readOnly: true });
	let databaseSchemaVersion: number;
	try {
		assertIntegrity(copied);
		databaseSchemaVersion = schemaVersion(copied);
	} finally {
		copied.close();
	}
	const manifest: BackupManifest = {
		schemaVersion: 1,
		kind: input.kind,
		projectId: input.projectId,
		databaseSchemaVersion,
		createdAt: new Date().toISOString(),
		databaseFile: basename(input.destinationPath),
		databaseBytes: statSync(input.destinationPath).size,
		sha256: digestFile(input.destinationPath),
	};
	writeFileSync(`${input.destinationPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	return manifest;
}

export function restoreSqliteBackup(input: {
	backupPath: string;
	destinationPath: string;
	expectedKind: DataStoreKind;
	expectedProjectId: string;
}): { restored: true; preRestoreBackupPath?: string } {
	const manifest = readManifest(input.backupPath);
	if (manifest.kind !== input.expectedKind || manifest.projectId !== input.expectedProjectId)
		throw new Error("Backup scope does not match the requested data store");
	if (manifest.sha256 !== digestFile(input.backupPath)) throw new Error("Backup digest does not match its manifest");
	for (const suffix of ["-wal", "-shm"])
		if (existsSync(`${input.destinationPath}${suffix}`))
			throw new Error("Restore requires the data store to be offline with no WAL/SHM files");
	const candidate = new DatabaseSync(input.backupPath, { readOnly: true });
	try {
		assertIntegrity(candidate);
		if (schemaVersion(candidate) !== manifest.databaseSchemaVersion) throw new Error("Backup schema version changed");
	} finally {
		candidate.close();
	}
	let preRestoreBackupPath: string | undefined;
	if (existsSync(input.destinationPath)) {
		preRestoreBackupPath = join(
			dirname(input.destinationPath),
			`${basename(input.destinationPath)}.pre-restore-${Date.now()}`,
		);
	}
	const temporary = join(
		dirname(input.destinationPath),
		`.${basename(input.destinationPath)}.${process.pid}.${randomUUID()}.restore`,
	);
	try {
		copyFileSync(input.backupPath, temporary);
		if (preRestoreBackupPath) renameSync(input.destinationPath, preRestoreBackupPath);
		renameSync(temporary, input.destinationPath);
	} catch (error) {
		if (preRestoreBackupPath && !existsSync(input.destinationPath) && existsSync(preRestoreBackupPath))
			renameSync(preRestoreBackupPath, input.destinationPath);
		throw error;
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
	return { restored: true, ...(preRestoreBackupPath ? { preRestoreBackupPath } : {}) };
}

function readManifest(backupPath: string): BackupManifest {
	const value = JSON.parse(readFileSync(`${backupPath}.manifest.json`, "utf8")) as BackupManifest;
	if (value.schemaVersion !== 1 || !["memory", "task"].includes(value.kind) || !value.projectId || !value.sha256)
		throw new Error("Backup manifest is invalid");
	return value;
}
function schemaVersion(database: DatabaseSync): number {
	const row = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as {
		version: number | null;
	};
	if (!Number.isSafeInteger(row.version) || (row.version ?? 0) < 1)
		throw new Error("SQLite schema version is invalid");
	return row.version!;
}
function assertIntegrity(database: DatabaseSync): void {
	const rows = database.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
	if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
}
function digestFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
