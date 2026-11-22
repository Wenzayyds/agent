import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { documentHash } from "./chunking.ts";
import type { DocumentAccessPolicy, DocumentChunk, KnowledgeDocument } from "./contracts.ts";
import { KnowledgeDocumentError } from "./contracts.ts";

export interface SourceRegistration {
	root: string;
	source: string;
	collection: string | null;
	model: string | null;
}

export interface DocumentRow {
	root: string;
	source: string;
	id: string;
	corpus: string;
	desired: number | null;
	active: number | null;
	latest: number;
	policy: DocumentAccessPolicy;
	deleted: number;
	error: string | null;
	retryAt: number;
	created: number;
	indexed: number | null;
}

export interface VersionRow {
	meta: string;
	warnings: string;
	model: string | null;
	collection: string | null;
}

export interface StoredChunk {
	chunk: DocumentChunk;
	document: KnowledgeDocument;
	source: string;
	score: number;
}

export interface SearchScope {
	corpusId?: string;
	documentId?: string;
	audience: "host" | "agent";
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS project_scope (only_row INTEGER PRIMARY KEY CHECK (only_row=1), project_id TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS documents (
		id TEXT PRIMARY KEY, corpus TEXT NOT NULL, root TEXT NOT NULL, source TEXT NOT NULL,
		policy TEXT NOT NULL, active INTEGER, desired INTEGER, latest INTEGER NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0, error TEXT, retryAt INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, indexed INTEGER
	);
	CREATE TABLE IF NOT EXISTS versions (
		id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL, model TEXT, collection TEXT,
		meta TEXT NOT NULL, warnings TEXT NOT NULL, PRIMARY KEY (id, version)
	);
	CREATE TABLE IF NOT EXISTS chunks (
		id TEXT PRIMARY KEY, document TEXT NOT NULL, version INTEGER NOT NULL, ordinal INTEGER NOT NULL,
		data TEXT NOT NULL, search_text TEXT NOT NULL, embedding_hash TEXT NOT NULL,
		FOREIGN KEY (document, version) REFERENCES versions(id, version) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS chunks_version ON chunks(document, version, ordinal);
	CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(terms, content='', tokenize = "unicode61 tokenchars '_'");
	CREATE TABLE IF NOT EXISTS embeddings (
		model TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (model, hash)
	);
	CREATE TABLE IF NOT EXISTS audit (
		seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL, document TEXT
	);
`;

interface ChunkRow {
	data: string;
	meta: string;
	source: string;
	score: number;
	active: number;
	created: number;
	indexed: number;
}

const VISIBILITY = `d.deleted = 0 AND d.active = c.version
	AND (? IS NULL OR d.corpus = ?) AND (? IS NULL OR d.id = ?)
	AND (? = 'host' OR (d.policy = 'allow-external' AND json_extract(v.meta, '$.accessPolicy') = 'allow-external'))`;
const COLUMNS = "c.data, v.meta, d.source, d.active, d.created, d.indexed";
const FROM_CHUNKS =
	"chunks c JOIN documents d ON d.id=c.document JOIN versions v ON v.id=c.document AND v.version=c.version";

export class DocumentStore {
	private readonly db: DatabaseSync;
	private readonly lock: DatabaseSync;

	constructor(filename: string, projectId: string) {
		mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(filename);
		try {
			this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500;");
			this.db.exec(SCHEMA);
			this.db.prepare("INSERT OR IGNORE INTO project_scope(only_row,project_id) VALUES(1,?)").run(projectId);
			if (this.db.prepare("SELECT project_id FROM project_scope").get()?.project_id !== projectId) {
				throw new KnowledgeDocumentError("invalid-parameter", "Knowledge database belongs to another project");
			}
			this.lock = new DatabaseSync(`${filename}.lock`);
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	async write<T>(run: () => Promise<T>): Promise<T> {
		// A separate SQLite lock lets readers use the last committed version during network writes.
		try {
			this.lock.exec("BEGIN IMMEDIATE");
		} catch (error) {
			if (error instanceof Error && /locked|transaction/iu.test(error.message)) {
				throw new KnowledgeDocumentError("index-busy", "Another Knowledge write is in progress");
			}
			throw error;
		}
		try {
			return await run();
		} finally {
			this.lock.exec("ROLLBACK");
		}
	}

	document(id: string): DocumentRow | undefined {
		return this.db.prepare("SELECT * FROM documents WHERE id=?").get(id) as unknown as DocumentRow | undefined;
	}

	documents(): DocumentRow[] {
		return this.db.prepare("SELECT * FROM documents WHERE deleted=0 ORDER BY id").all() as unknown as DocumentRow[];
	}

	version(id: string, version: number | null): VersionRow | undefined {
		return this.db
			.prepare("SELECT meta,warnings,model,collection FROM versions WHERE id=? AND version=?")
			.get(id, version) as unknown as VersionRow | undefined;
	}

	chunks(id: string, version: number): DocumentChunk[] {
		return this.db
			.prepare("SELECT data FROM chunks WHERE document=? AND version=? ORDER BY ordinal")
			.all(id, version)
			.map(({ data }) => JSON.parse(String(data)) as DocumentChunk);
	}

	stage(
		registration: SourceRegistration,
		meta: KnowledgeDocument,
		chunks: readonly DocumentChunk[],
		warnings: readonly string[],
	): void {
		const previous = this.document(meta.documentId);
		if (
			(!previous || previous.deleted) &&
			Number(this.db.prepare("SELECT count(*) AS n FROM documents WHERE deleted=0").get()?.n) >= 1_000
		) {
			throw new KnowledgeDocumentError("limit-exceeded", "Project Knowledge document limit reached");
		}
		if (Number(this.db.prepare("SELECT count(*) AS n FROM versions WHERE id=?").get(meta.documentId)?.n) >= 4) {
			throw new KnowledgeDocumentError("limit-exceeded", "Retry index cleanup before staging another version");
		}
		this.transaction(() => {
			this.db
				.prepare(`
				INSERT INTO documents(id,corpus,root,source,policy,desired,latest,created) VALUES(?,?,?,?,?,?,?,?)
				ON CONFLICT(id) DO UPDATE SET root=excluded.root,source=excluded.source,policy=excluded.policy,
					desired=excluded.desired,latest=excluded.latest,deleted=0,error=NULL,retryAt=0
			`)
				.run(
					meta.documentId,
					meta.corpusId,
					registration.root,
					registration.source,
					meta.accessPolicy,
					meta.version,
					meta.version,
					meta.createdAt,
				);
			this.db
				.prepare("INSERT INTO versions(id,version,model,collection,meta,warnings) VALUES(?,?,?,?,?,?)")
				.run(
					meta.documentId,
					meta.version,
					registration.model,
					registration.collection,
					JSON.stringify(meta),
					JSON.stringify(warnings),
				);
			const insert = this.db.prepare(`
				INSERT INTO chunks(id,document,version,ordinal,data,search_text,embedding_hash) VALUES(?,?,?,?,?,?,?)
			`);
			const insertFts = this.db.prepare("INSERT INTO chunk_fts(rowid,terms) VALUES(?,?)");
			for (const chunk of chunks) {
				const text = embeddingText(chunk);
				const { lastInsertRowid } = insert.run(
					chunk.chunkId,
					meta.documentId,
					meta.version,
					chunk.chunkIndex,
					JSON.stringify(chunk),
					text.toLowerCase().normalize("NFKC"),
					embeddingHash(chunk),
				);
				insertFts.run(lastInsertRowid, lexicalTerms(text).join(" "));
			}
		});
	}

	activate(id: string, version: number): void {
		this.db
			.prepare(
				"UPDATE documents SET active=desired, desired=NULL, error=NULL, retryAt=0, indexed=? WHERE id=? AND desired=? AND deleted=0",
			)
			.run(Date.now(), id, version);
	}

	restrict(id: string): void {
		this.db.prepare("UPDATE documents SET policy='local-only' WHERE id=?").run(id);
	}

	hide(id: string): void {
		this.db.prepare("UPDATE documents SET deleted=1, active=NULL, desired=NULL, error=NULL WHERE id=?").run(id);
	}

	markError(id: string, error: string): void {
		this.db.prepare("UPDATE documents SET error=?,retryAt=? WHERE id=?").run(error, Date.now() + 10_000, id);
	}

	retired(limit: number): { id: string; version: number; collection: string | null; model: string | null }[] {
		return this.db
			.prepare(`
			SELECT v.id,v.version,v.collection,v.model FROM versions v JOIN documents d ON d.id=v.id
			WHERE v.version IS NOT d.active AND v.version IS NOT d.desired ORDER BY v.id,v.version LIMIT ?
		`)
			.all(limit) as unknown as ReturnType<DocumentStore["retired"]>;
	}

	purge(id: string, version: number): void {
		this.transaction(() => {
			const old = this.db.prepare("SELECT rowid,data FROM chunks WHERE document=? AND version=?").all(id, version);
			for (const row of old) {
				const chunk = JSON.parse(String(row.data)) as DocumentChunk;
				this.db
					.prepare("INSERT INTO chunk_fts(chunk_fts,rowid,terms) VALUES('delete',?,?)")
					.run(row.rowid, lexicalTerms(embeddingText(chunk)).join(" "));
			}
			this.db.prepare("DELETE FROM versions WHERE id=? AND version=?").run(id, version);
			this.db
				.prepare(`DELETE FROM embeddings WHERE NOT EXISTS (
				SELECT 1 FROM chunks c JOIN versions v ON v.id=c.document AND v.version=c.version
				WHERE c.embedding_hash=embeddings.hash AND v.model=embeddings.model
			)`)
				.run();
		});
	}

	cached(model: string, hash: string): number[] | undefined {
		const result = this.db.prepare("SELECT vector FROM embeddings WHERE model=? AND hash=?").get(model, hash)?.vector;
		if (!(result instanceof Uint8Array)) return undefined;
		const buffer = Buffer.from(result);
		return Array.from({ length: buffer.length / 4 }, (_, index) => buffer.readFloatLE(index * 4));
	}

	cache(model: string, hash: string, vector: readonly number[]): void {
		const buffer = Buffer.alloc(vector.length * 4);
		for (const [index, value] of vector.entries()) buffer.writeFloatLE(value, index * 4);
		this.db.prepare("INSERT OR REPLACE INTO embeddings(model,hash,vector) VALUES(?,?,?)").run(model, hash, buffer);
	}

	lexical(query: string, scope: SearchScope, limit: number): StoredChunk[] {
		const terms = [...new Set(lexicalTerms(query))].slice(0, 32);
		if (!terms.length) return [];
		const match = terms.map((term) => `"${term}"`).join(" OR ");
		const rows = this.db
			.prepare(`
			SELECT ${COLUMNS}, -bm25(chunk_fts) AS score FROM chunk_fts
			JOIN ${FROM_CHUNKS.replace("chunks c", "chunks c ON c.rowid=chunk_fts.rowid")}
			WHERE chunk_fts MATCH ? AND ${VISIBILITY}
			ORDER BY (instr(c.search_text, ?) > 0) DESC, score DESC, d.corpus, d.source, c.ordinal, c.id LIMIT ?
		`)
			.all(match, ...scopeParams(scope), query.toLowerCase().normalize("NFKC"), limit) as unknown as ChunkRow[];
		return rows.map(hydrate);
	}

	chunk(chunkId: string, scope: SearchScope): StoredChunk | undefined {
		const row = this.db
			.prepare(`
			SELECT ${COLUMNS}, 0 AS score FROM ${FROM_CHUNKS} WHERE c.id=? AND ${VISIBILITY}
		`)
			.get(chunkId, ...scopeParams(scope)) as unknown as ChunkRow | undefined;
		return row && hydrate(row);
	}

	activeVersions(scope: SearchScope, model: string, collection: string): { id: string; version: number }[] {
		return this.db
			.prepare(`
			SELECT d.id,d.active AS version FROM documents d JOIN versions v ON d.id=v.id AND d.active=v.version
			WHERE d.deleted=0 AND v.model=? AND v.collection=?
			AND (? IS NULL OR d.corpus=?) AND (? IS NULL OR d.id=?)
			AND (? = 'host' OR (d.policy='allow-external' AND json_extract(v.meta, '$.accessPolicy')='allow-external'))
		`)
			.all(model, collection, ...scopeParams(scope)) as unknown as { id: string; version: number }[];
	}

	vectorPage(
		model: string,
		collection: string,
		cursor: string,
		limit: number,
	): {
		document: KnowledgeDocument;
		chunk: DocumentChunk;
	}[] {
		return this.db
			.prepare(`
			SELECT c.data,v.meta FROM ${FROM_CHUNKS}
			WHERE d.deleted=0 AND d.active=c.version AND v.model=? AND v.collection=? AND c.id>?
			ORDER BY c.id LIMIT ?
		`)
			.all(model, collection, cursor, limit)
			.map(({ data, meta }) => ({
				chunk: JSON.parse(String(data)),
				document: JSON.parse(String(meta)),
			}));
	}

	pointReference(
		chunkId: string,
	): { model: string | null; collection: string | null; meta: string; data: string } | undefined {
		return this.db
			.prepare(`
			SELECT v.model,v.collection,v.meta,c.data FROM ${FROM_CHUNKS}
			WHERE c.id=? AND d.deleted=0 AND (c.version=d.active OR c.version=d.desired)
		`)
			.get(chunkId) as ReturnType<DocumentStore["pointReference"]>;
	}

	audit(operation: string, outcome: string, document?: string): void {
		this.db
			.prepare("INSERT INTO audit(at,operation,outcome,document) VALUES(?,?,?,?)")
			.run(Date.now(), operation, outcome, document ?? null);
		this.db.exec("DELETE FROM audit WHERE seq <= (SELECT max(seq)-5000 FROM audit)");
	}

	status() {
		const row = this.db
			.prepare(`
			SELECT count(*) AS registered, coalesce(sum(active IS NOT NULL),0) AS active,
				coalesce(sum(desired IS NOT NULL),0) AS pending, coalesce(sum(error IS NOT NULL),0) AS errors,
				(SELECT count(*) FROM chunks) AS storedChunks,
				(SELECT count(*) FROM versions v JOIN documents d ON v.id=d.id
					WHERE v.version IS NOT d.active AND v.version IS NOT d.desired) AS retiredVersions
			FROM documents WHERE deleted=0
		`)
			.get();
		return {
			registered: Number(row?.registered),
			active: Number(row?.active),
			pending: Number(row?.pending),
			errors: Number(row?.errors),
			storedChunks: Number(row?.storedChunks),
			retiredVersions: Number(row?.retiredVersions),
		};
	}

	close(): void {
		this.lock.close();
		this.db.close();
	}

	transaction<T>(run: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = run();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

function hydrate(row: ChunkRow): StoredChunk {
	const meta = JSON.parse(row.meta) as KnowledgeDocument;
	return {
		chunk: JSON.parse(row.data) as DocumentChunk,
		document: {
			...meta,
			activeVersion: row.active,
			createdAt: row.created,
			indexedAt: row.indexed,
			status: "indexed",
		},
		source: row.source,
		score: row.score,
	};
}

function scopeParams(scope: SearchScope): [string | null, string | null, string | null, string | null, string] {
	return [
		scope.corpusId ?? null,
		scope.corpusId ?? null,
		scope.documentId ?? null,
		scope.documentId ?? null,
		scope.audience,
	];
}

function lexicalTerms(text: string): string[] {
	return (
		text
			.toLowerCase()
			.normalize("NFKC")
			.match(/\p{Script=Han}|[\p{L}\p{N}_]+/gu)
			?.flatMap((term) => term.split(/(\p{Script=Han})/u).filter(Boolean)) ?? []
	);
}

export function embeddingText(chunk: DocumentChunk): string {
	return [...chunk.headingPath.map((heading) => heading.replace(/\s+/gu, " ").trim()), chunk.content].join("\n");
}

export function embeddingHash(chunk: DocumentChunk): string {
	return documentHash(embeddingText(chunk));
}
