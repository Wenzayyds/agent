import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import type { DocumentAccessPolicy } from "../../src/knowledge/contracts.ts";

export function createKnowledgeTestRoot(prefix: string): string {
	// Host imports require a canonical directory. Windows TEMP may contain an 8.3 alias.
	return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

export async function setDocumentAccess(
	session: AgentSession,
	filename: string,
	path: string,
	corpus: string,
	policy: DocumentAccessPolicy,
) {
	const external = policy === "allow-external" ? "--allow-external " : "";
	await session.prompt(`/enhanced-docs add --corpus=${corpus} ${external}${JSON.stringify([path])}`);
	expectIndexedDocument(filename, path, corpus, policy);
}

export function expectIndexedDocument(filename: string, path: string, corpus: string, policy: DocumentAccessPolicy) {
	// Command failures are reported through the UI. Confirm the policy of the active revision on disk.
	const db = new DatabaseSync(filename, { readOnly: true });
	try {
		const document = db
			.prepare("SELECT policy FROM documents WHERE corpus=? AND source=? AND deleted=0 AND active IS NOT NULL")
			.get(corpus, basename(path));
		expect(document).toEqual({ policy });
	} finally {
		db.close();
	}
}
