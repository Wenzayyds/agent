import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
	MaintenanceProposal,
	MemoryCategory,
	MemoryKind,
	MemoryLifecycle,
	MemoryRecord,
	MemoryRelation,
	MemoryRelationType,
	MemorySearchStatus,
	MemorySource,
	MemorySourceType,
	MemoryStatus,
	MemoryVerification,
	ProjectScope,
} from "./contracts.ts";
import { MemoryError } from "./errors.ts";

const SCHEMA_VERSION = 2;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_LITERAL_SCAN_ROWS = 500;
const MAX_SNAPSHOT_ROWS = 2_001;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;

interface MemoryRow {
	id: string;
	project_id: string;
	kind: MemoryKind;
	content: string;
	status: MemoryStatus;
	content_hash: string;
	revision: number;
	content_revision: number;
	created_at: number;
	updated_at: number;
}

interface SourceRow {
	source_type: MemorySourceType;
	source_ref: string;
	source_commit: string;
	observed_at: number;
}

interface VerificationRow {
	id: string;
	verification_type: MemoryVerification["type"];
	evidence_ref: string;
	evidence_version: string;
	verified_content_revision: number;
	verified_at: number;
}

interface MetadataRow {
	category: MemoryCategory;
	subject_key: string | null;
	tags_json: string;
	importance: 0 | 1 | 2 | 3;
	valid_from: number | null;
	valid_until: number | null;
	lifecycle: MemoryLifecycle;
	last_used_at: number | null;
	use_count: number;
}

interface ProposalRow {
	id: string;
	project_id: string;
	action: MaintenanceProposal["action"];
	source_ids_json: string;
	expected_revisions_json: string;
	proposed_content: string | null;
	proposed_category: MemoryCategory | null;
	justification: string;
	evidence_refs_json: string;
	status: MaintenanceProposal["status"];
	created_at: number;
	reviewed_at: number | null;
	applied_at: number | null;
}

export interface StoredCandidateInput {
	id?: string;
	kind: MemoryKind;
	content: string;
	normalizedContent: string;
	contentHash: string;
	source: MemorySource;
	now: number;
	metadata?: {
		category: MemoryCategory;
		subjectKey?: string;
		tags: readonly string[];
		importance: 0 | 1 | 2 | 3;
		validFrom?: number;
		validUntil?: number;
	};
}

export interface ProviderSearchQuery {
	text: string;
	limit?: number;
	kinds?: MemoryKind[];
	statuses?: MemoryStatus[];
	sourceTypes?: MemorySourceType[];
	categories?: MemoryCategory[];
	lifecycles?: MemoryLifecycle[];
	includeExpired?: boolean;
}

export interface LocalMemoryProviderOptions {
	ftsMode?: "auto" | "unavailable-for-test";
}

export class LocalMemoryProvider {
	readonly projectId: string;
	readonly searchStatus: MemorySearchStatus;
	readonly databasePath: string;
	readonly databaseLimitBytes: number;
	private readonly database: DatabaseSync;
	private closed = false;

	constructor(scope: ProjectScope, options: LocalMemoryProviderOptions = {}) {
		this.projectId = scope.projectId;
		this.databasePath = scope.databasePath;
		this.database = new DatabaseSync(scope.databasePath, {
			enableForeignKeyConstraints: true,
			timeout: 1_500,
		});
		try {
			this.database.exec("PRAGMA journal_mode=WAL");
			this.database.exec("PRAGMA synchronous=NORMAL");
			this.database.exec("PRAGMA foreign_keys=ON");
			this.databaseLimitBytes = configureDatabaseSizeLimit(this.database);
			runCoreMigrations(this.database);
			this.searchStatus = initializeSearchIndex(this.database, options.ftsMode ?? "auto");
		} catch (error) {
			this.database.close();
			throw storageError("Failed to initialize memory database", error);
		}
	}

	async saveCandidate(input: StoredCandidateInput): Promise<MemoryRecord> {
		this.assertOpen();
		this.storageOperation(() =>
			this.transaction(() => {
				this.assertNotForgotten(input.kind, input.contentHash);
				const existing = this.database
					.prepare("SELECT id, content_hash FROM memories WHERE project_id=? AND kind=? AND content_hash=?")
					.get(this.projectId, input.kind, input.contentHash) as { id: string; content_hash: string } | undefined;
				const id = existing?.id ?? input.id ?? randomUUID();
				if (!existing) {
					this.database
						.prepare(
							"INSERT INTO memories (id, project_id, kind, content, normalized_content, status, content_hash, revision, content_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'candidate', ?, 1, 1, ?, ?)",
						)
						.run(
							id,
							this.projectId,
							input.kind,
							input.content,
							input.normalizedContent,
							input.contentHash,
							input.now,
							input.now,
						);
					this.database.prepare("INSERT INTO memory_usage_stats (memory_id, use_count) VALUES (?, 0)").run(id);
					this.database
						.prepare(
							"INSERT INTO memory_metadata (memory_id, category, subject_key, tags_json, importance, valid_from, valid_until, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
						)
						.run(
							id,
							input.metadata?.category ?? "other",
							input.metadata?.subjectKey ?? null,
							JSON.stringify(input.metadata?.tags ?? []),
							input.metadata?.importance ?? 1,
							input.metadata?.validFrom ?? null,
							input.metadata?.validUntil ?? null,
							input.now,
							input.now,
						);
				}
				const sourceResult = this.database
					.prepare(
						"INSERT OR IGNORE INTO memory_sources (memory_id, source_type, source_ref, source_commit, observed_at) SELECT id, ?, ?, ?, ? FROM memories WHERE id=? AND project_id=? AND content_hash=?",
					)
					.run(
						input.source.type,
						input.source.ref,
						input.source.commit ?? "",
						input.source.observedAt,
						id,
						this.projectId,
						input.contentHash,
					);
				if (!existing && Number(sourceResult.changes) !== 1) {
					throw new MemoryError(
						"MEMORY_REVISION_CONFLICT",
						"Memory content changed before its source was attached",
					);
				}
				return id;
			}),
		);
		const record = await this.getByUniqueKey(input.kind, input.contentHash);
		if (!record) throw new MemoryError("MEMORY_STORAGE_ERROR", "Saved memory could not be read back");
		return record;
	}

	async get(id: string): Promise<MemoryRecord | null> {
		this.assertOpen();
		return this.storageOperation(() => {
			const row = this.database
				.prepare("SELECT * FROM memories WHERE id=? AND project_id=?")
				.get(id, this.projectId) as MemoryRow | undefined;
			return row ? this.hydrate(row) : null;
		});
	}

	async search(query: ProviderSearchQuery): Promise<MemoryRecord[]> {
		this.assertOpen();
		const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
		const text = query.text.trim();
		return this.storageOperation(() => {
			if (!text) return this.selectLiteral("", query, limit);

			const records = new Map<string, MemoryRecord>();
			if (this.searchStatus === "fts-ready") {
				for (const record of this.selectFts(text, query, limit)) records.set(record.id, record);
			}
			if (this.searchStatus === "degraded" || /[^\u0000-\u007f]/u.test(text) || records.size < limit) {
				for (const record of this.selectLiteral(text, query, limit)) records.set(record.id, record);
			}
			return [...records.values()].slice(0, limit);
		});
	}

	async listVerified(limit: number): Promise<MemoryRecord[]> {
		this.assertOpen();
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_ROWS) {
			throw new MemoryError("MEMORY_VALIDATION_ERROR", "Verified snapshot limit is invalid");
		}
		return this.storageOperation(() => {
			const rows = this.database
				.prepare(
					"SELECT m.* FROM memories m JOIN memory_metadata md ON md.memory_id=m.id WHERE m.project_id=? AND m.status='verified' AND md.lifecycle='active' AND (md.valid_until IS NULL OR md.valid_until > ?) ORDER BY m.updated_at DESC, m.id LIMIT ?",
				)
				.all(this.projectId, Date.now(), limit) as unknown as MemoryRow[];
			return rows.map((row) => this.hydrate(row));
		});
	}

	async list(options: Omit<ProviderSearchQuery, "text"> & { limit?: number } = {}): Promise<MemoryRecord[]> {
		this.assertOpen();
		const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LITERAL_SCAN_ROWS));
		return this.storageOperation(() => this.selectLiteral("", { text: "", includeExpired: true, ...options }, limit));
	}

	async setMetadata(options: {
		id: string;
		expectedRevision: number;
		category?: MemoryCategory;
		subjectKey?: string | null;
		tags?: readonly string[];
		importance?: 0 | 1 | 2 | 3;
		validFrom?: number | null;
		validUntil?: number | null;
		lifecycle?: MemoryLifecycle;
		now: number;
	}): Promise<MemoryRecord> {
		this.assertOpen();
		this.storageOperation(() =>
			this.transaction(() => {
				const current = this.database
					.prepare(
						"SELECT m.revision, md.* FROM memories m JOIN memory_metadata md ON md.memory_id=m.id WHERE m.id=? AND m.project_id=?",
					)
					.get(options.id, this.projectId) as (MetadataRow & { revision: number }) | undefined;
				if (!current) this.throwMissingOrRevision(options.id);
				if (current.revision !== options.expectedRevision) this.throwMissingOrRevision(options.id);
				this.database
					.prepare(
						"UPDATE memory_metadata SET category=?, subject_key=?, tags_json=?, importance=?, valid_from=?, valid_until=?, lifecycle=?, updated_at=? WHERE memory_id=?",
					)
					.run(
						options.category ?? current.category,
						options.subjectKey === undefined ? current.subject_key : options.subjectKey,
						options.tags === undefined ? current.tags_json : JSON.stringify(options.tags),
						options.importance ?? current.importance,
						options.validFrom === undefined ? current.valid_from : options.validFrom,
						options.validUntil === undefined ? current.valid_until : options.validUntil,
						options.lifecycle ?? current.lifecycle,
						options.now,
						options.id,
					);
				const update = this.database
					.prepare(
						"UPDATE memories SET revision=revision+1, updated_at=? WHERE id=? AND project_id=? AND revision=?",
					)
					.run(options.now, options.id, this.projectId, options.expectedRevision);
				if (Number(update.changes) !== 1) this.throwMissingOrRevision(options.id);
				this.writeAudit(options.id, null, "metadata_changed", current, options, options.now);
			}),
		);
		return this.require(options.id);
	}

	async recordUsage(id: string, now: number): Promise<void> {
		this.assertOpen();
		this.storageOperation(() => {
			const result = this.database
				.prepare(
					"UPDATE memory_usage_stats SET last_used_at=?, use_count=use_count+1 WHERE memory_id IN (SELECT id FROM memories WHERE id=? AND project_id=?)",
				)
				.run(now, id, this.projectId);
			if (Number(result.changes) !== 1) this.throwMissingOrRevision(id);
		});
	}

	async updateContent(options: {
		id: string;
		content: string;
		normalizedContent: string;
		contentHash: string;
		expectedRevision: number;
		now: number;
	}): Promise<MemoryRecord> {
		this.assertOpen();
		try {
			const result = this.database
				.prepare(
					"UPDATE memories SET content=?, normalized_content=?, content_hash=?, status='candidate', revision=revision+1, content_revision=content_revision+1, updated_at=? WHERE id=? AND project_id=? AND revision=?",
				)
				.run(
					options.content,
					options.normalizedContent,
					options.contentHash,
					options.now,
					options.id,
					this.projectId,
					options.expectedRevision,
				);
			if (Number(result.changes) !== 1) this.throwMissingOrRevision(options.id);
		} catch (error) {
			if (isUniqueConstraint(error)) {
				throw new MemoryError("MEMORY_CONTENT_CONFLICT", "Another memory already has the updated content", {
					cause: error,
				});
			}
			throw normalizeStorageError(error);
		}
		return this.require(options.id);
	}

	async setStatus(options: {
		id: string;
		status: MemoryStatus;
		verification?: Omit<MemoryVerification, "verifiedContentRevision">;
		expectedRevision: number;
		now: number;
		reflection?: readonly { evidenceRef: string; previousSha256: string; observedSha256: string }[];
	}): Promise<MemoryRecord> {
		this.assertOpen();
		this.storageOperation(() =>
			this.transaction(() => {
				const current = this.database
					.prepare("SELECT content_revision FROM memories WHERE id=? AND project_id=? AND revision=?")
					.get(options.id, this.projectId, options.expectedRevision) as { content_revision: number } | undefined;
				if (!current) this.throwMissingOrRevision(options.id);
				const result = this.database
					.prepare(
						"UPDATE memories SET status=?, revision=revision+1, updated_at=? WHERE id=? AND project_id=? AND revision=?",
					)
					.run(options.status, options.now, options.id, this.projectId, options.expectedRevision);
				if (Number(result.changes) !== 1) this.throwMissingOrRevision(options.id);
				if (options.reflection)
					this.writeAudit(
						options.id,
						null,
						"file_evidence_changed",
						{ revision: options.expectedRevision },
						options.reflection,
						options.now,
					);
				if (options.verification) {
					this.database
						.prepare(
							"INSERT INTO memory_verifications (id, memory_id, verification_type, evidence_ref, evidence_version, verified_content_revision, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						)
						.run(
							options.verification.id,
							options.id,
							options.verification.type,
							options.verification.evidenceRef,
							options.verification.evidenceVersion,
							current.content_revision,
							options.verification.verifiedAt,
						);
				}
			}),
		);
		return this.require(options.id);
	}

	async delete(id: string, expectedRevision: number): Promise<void> {
		this.assertOpen();
		this.storageOperation(() =>
			this.transaction(() => {
				const current = this.database
					.prepare("SELECT id, revision, kind, content_hash, status FROM memories WHERE id=? AND project_id=?")
					.get(id, this.projectId) as
					| { id: string; revision: number; kind: MemoryKind; content_hash: string; status: string }
					| undefined;
				if (!current || current.revision !== expectedRevision) this.throwMissingOrRevision(id);
				this.writeAudit(id, null, "deleted", current, null, Date.now());
				const result = this.database
					.prepare("DELETE FROM memories WHERE id=? AND project_id=? AND revision=?")
					.run(id, this.projectId, expectedRevision);
				if (Number(result.changes) !== 1) this.throwMissingOrRevision(id);
			}),
		);
	}

	async replaceDraftProposals(proposals: readonly MaintenanceProposal[]): Promise<void> {
		this.assertOpen();
		this.storageOperation(() =>
			this.transaction(() => {
				this.database
					.prepare("DELETE FROM memory_maintenance_proposals WHERE project_id=? AND status='draft'")
					.run(this.projectId);
				const insert = this.database.prepare(
					"INSERT INTO memory_maintenance_proposals (id, project_id, action, source_ids_json, expected_revisions_json, proposed_content, proposed_category, justification, evidence_refs_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)",
				);
				for (const proposal of proposals) {
					if (proposal.projectId !== this.projectId || proposal.status !== "draft") {
						throw new MemoryError("MEMORY_VALIDATION_ERROR", "Maintenance proposal scope or status is invalid");
					}
					if (proposal.sourceIds.length === 0 || proposal.sourceIds.length !== proposal.expectedRevisions.length) {
						throw new MemoryError("MEMORY_VALIDATION_ERROR", "Maintenance proposal sources are invalid");
					}
					insert.run(
						proposal.id,
						this.projectId,
						proposal.action,
						JSON.stringify(proposal.sourceIds),
						JSON.stringify(proposal.expectedRevisions),
						proposal.proposedContent ?? null,
						proposal.proposedCategory ?? null,
						proposal.justification,
						JSON.stringify(proposal.evidenceRefs),
						proposal.createdAt,
					);
				}
			}),
		);
	}

	async getProposal(id: string): Promise<MaintenanceProposal | null> {
		this.assertOpen();
		return this.storageOperation(() => {
			const row = this.database
				.prepare("SELECT * FROM memory_maintenance_proposals WHERE id=? AND project_id=?")
				.get(id, this.projectId) as ProposalRow | undefined;
			return row ? hydrateProposal(row) : null;
		});
	}

	async listRelations(id: string): Promise<MemoryRelation[]> {
		this.assertOpen();
		return this.storageOperation(() => {
			const rows = this.database
				.prepare(
					"SELECT source_memory_id, target_memory_id, relation, created_at FROM memory_relations WHERE project_id=? AND (source_memory_id=? OR target_memory_id=?) ORDER BY created_at, source_memory_id, target_memory_id",
				)
				.all(this.projectId, id, id) as unknown as Array<{
				source_memory_id: string;
				target_memory_id: string;
				relation: MemoryRelationType;
				created_at: number;
			}>;
			return rows.map((row) => ({
				sourceMemoryId: row.source_memory_id,
				targetMemoryId: row.target_memory_id,
				relation: row.relation,
				createdAt: row.created_at,
			}));
		});
	}

	async applyProposal(id: string, now: number): Promise<MaintenanceProposal> {
		this.assertOpen();
		this.storageOperation(() =>
			this.transaction(() => {
				const row = this.database
					.prepare("SELECT * FROM memory_maintenance_proposals WHERE id=? AND project_id=?")
					.get(id, this.projectId) as ProposalRow | undefined;
				if (!row) throw new MemoryError("MEMORY_NOT_FOUND", "Maintenance proposal does not exist");
				if (row.status !== "draft" && row.status !== "reviewed") {
					throw new MemoryError("MEMORY_VALIDATION_ERROR", "Maintenance proposal is no longer applicable");
				}
				const proposal = hydrateProposal(row);
				if (proposal.action === "delete") {
					throw new MemoryError("MEMORY_VALIDATION_ERROR", "Batch delete proposals cannot be applied");
				}
				const records = proposal.sourceIds.map((sourceId, index) => {
					const record = this.database
						.prepare("SELECT * FROM memories WHERE id=? AND project_id=? AND revision=?")
						.get(sourceId, this.projectId, proposal.expectedRevisions[index]) as MemoryRow | undefined;
					if (!record) this.throwMissingOrRevision(sourceId);
					return record;
				});
				if (proposal.action === "archive") {
					if (records.length !== 1)
						throw new MemoryError("MEMORY_VALIDATION_ERROR", "Archive requires one source");
					this.applyLifecycle(records[0], "archived", now);
				} else if (proposal.action === "mark_stale") {
					for (const record of records) this.applyStatus(record, "stale", now);
				} else if (proposal.action === "retag") {
					if (!proposal.proposedCategory)
						throw new MemoryError("MEMORY_VALIDATION_ERROR", "Retag category is missing");
					for (const record of records) this.applyCategory(record, proposal.proposedCategory, now);
				} else if (proposal.action === "compress" || proposal.action === "merge") {
					if (!proposal.proposedContent || records.length < 2)
						throw new MemoryError("MEMORY_VALIDATION_ERROR", "Consolidation proposal is incomplete");
					const normalized = proposal.proposedContent.normalize("NFKC").replace(/\s+/gu, " ").trim();
					const hash = createContentHash(normalized);
					this.assertNotForgotten("experience", hash);
					const targetId = randomUUID();
					this.database
						.prepare(
							"INSERT INTO memories (id, project_id, kind, content, normalized_content, status, content_hash, revision, content_revision, created_at, updated_at) VALUES (?, ?, 'experience', ?, ?, 'candidate', ?, 1, 1, ?, ?)",
						)
						.run(targetId, this.projectId, proposal.proposedContent, normalized, hash, now, now);
					this.database
						.prepare(
							"INSERT INTO memory_metadata (memory_id, category, tags_json, importance, lifecycle, created_at, updated_at) VALUES (?, ?, '[]', 1, 'active', ?, ?)",
						)
						.run(targetId, proposal.proposedCategory ?? "procedure", now, now);
					this.database
						.prepare("INSERT INTO memory_usage_stats (memory_id, use_count) VALUES (?, 0)")
						.run(targetId);
					this.database
						.prepare(
							"INSERT INTO memory_sources (memory_id, source_type, source_ref, source_commit, observed_at) VALUES (?, 'session', ?, '', ?)",
						)
						.run(targetId, `maintenance:${proposal.id}`, now);
					const relation = this.database.prepare(
						"INSERT INTO memory_relations (project_id, source_memory_id, target_memory_id, relation, created_at) VALUES (?, ?, ?, 'derived_from', ?)",
					);
					for (const source of records) relation.run(this.projectId, targetId, source.id, now);
					this.writeAudit(
						targetId,
						proposal.id,
						"candidate_created",
						null,
						{ sourceIds: proposal.sourceIds },
						now,
					);
				}
				this.database
					.prepare(
						"UPDATE memory_maintenance_proposals SET status='applied', reviewed_at=COALESCE(reviewed_at, ?), applied_at=? WHERE id=? AND project_id=?",
					)
					.run(now, now, id, this.projectId);
				this.writeAudit(null, id, "proposal_applied", row, null, now);
			}),
		);
		const applied = await this.getProposal(id);
		if (!applied) throw new MemoryError("MEMORY_STORAGE_ERROR", "Applied proposal could not be read back");
		return applied;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.database.close();
	}

	private applyLifecycle(record: MemoryRow, lifecycle: MemoryLifecycle, now: number): void {
		this.database
			.prepare("UPDATE memory_metadata SET lifecycle=?, updated_at=? WHERE memory_id=?")
			.run(lifecycle, now, record.id);
		this.database
			.prepare("UPDATE memories SET revision=revision+1, updated_at=? WHERE id=? AND project_id=? AND revision=?")
			.run(now, record.id, this.projectId, record.revision);
		this.writeAudit(record.id, null, lifecycle === "archived" ? "archived" : "restored", record, { lifecycle }, now);
	}

	private applyStatus(record: MemoryRow, status: MemoryStatus, now: number): void {
		this.database
			.prepare(
				"UPDATE memories SET status=?, revision=revision+1, updated_at=? WHERE id=? AND project_id=? AND revision=?",
			)
			.run(status, now, record.id, this.projectId, record.revision);
		this.writeAudit(record.id, null, "status_changed", record, { status }, now);
	}

	private applyCategory(record: MemoryRow, category: MemoryCategory, now: number): void {
		this.database
			.prepare("UPDATE memory_metadata SET category=?, updated_at=? WHERE memory_id=?")
			.run(category, now, record.id);
		this.database
			.prepare("UPDATE memories SET revision=revision+1, updated_at=? WHERE id=? AND project_id=? AND revision=?")
			.run(now, record.id, this.projectId, record.revision);
		this.writeAudit(record.id, null, "retagged", record, { category }, now);
	}

	private assertNotForgotten(kind: MemoryKind, hash: string): void {
		const deleted = this.database
			.prepare(
				`SELECT 1 FROM memory_governance_audit WHERE project_id=? AND action='deleted'
			 AND json_extract(before_json, '$.content_hash')=?
			 AND (json_extract(before_json, '$.kind')=? OR json_extract(before_json, '$.kind') IS NULL) LIMIT 1`,
			)
			.get(this.projectId, hash, kind);
		if (deleted) throw new MemoryError("MEMORY_VALIDATION_ERROR", "This exact memory was explicitly forgotten");
	}

	private writeAudit(
		memoryId: string | null,
		proposalId: string | null,
		action: string,
		before: unknown,
		after: unknown,
		now: number,
	): void {
		this.database
			.prepare(
				"INSERT INTO memory_governance_audit (id, project_id, memory_id, proposal_id, action, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(randomUUID(), this.projectId, memoryId, proposalId, action, safeJson(before), safeJson(after), now);
	}

	private async getByUniqueKey(kind: MemoryKind, contentHash: string): Promise<MemoryRecord | null> {
		const row = this.database
			.prepare("SELECT * FROM memories WHERE project_id=? AND kind=? AND content_hash=?")
			.get(this.projectId, kind, contentHash) as MemoryRow | undefined;
		return row ? this.hydrate(row) : null;
	}

	private async require(id: string): Promise<MemoryRecord> {
		const record = await this.get(id);
		if (!record) throw new MemoryError("MEMORY_NOT_FOUND", "Memory does not exist in the current project");
		return record;
	}

	private hydrate(row: MemoryRow): MemoryRecord {
		const metadata = this.database
			.prepare(
				"SELECT md.*, COALESCE(us.last_used_at, NULL) AS last_used_at, COALESCE(us.use_count, 0) AS use_count FROM memory_metadata md LEFT JOIN memory_usage_stats us ON us.memory_id=md.memory_id WHERE md.memory_id=?",
			)
			.get(row.id) as MetadataRow | undefined;
		if (!metadata) throw new MemoryError("MEMORY_STORAGE_ERROR", "Memory metadata is missing");
		const sources = this.database
			.prepare(
				"SELECT source_type, source_ref, source_commit, observed_at FROM memory_sources WHERE memory_id=? ORDER BY observed_at, source_type, source_ref",
			)
			.all(row.id) as unknown as SourceRow[];
		const verifications = this.database
			.prepare(
				"SELECT id, verification_type, evidence_ref, evidence_version, verified_content_revision, verified_at FROM memory_verifications WHERE memory_id=? ORDER BY verified_at, id",
			)
			.all(row.id) as unknown as VerificationRow[];
		return {
			id: row.id,
			projectId: row.project_id,
			kind: row.kind,
			content: row.content,
			status: row.status,
			category: metadata.category,
			...(metadata.subject_key ? { subjectKey: metadata.subject_key } : {}),
			tags: parseStringArray(metadata.tags_json),
			importance: metadata.importance,
			...(metadata.valid_from === null ? {} : { validFrom: metadata.valid_from }),
			...(metadata.valid_until === null ? {} : { validUntil: metadata.valid_until }),
			lifecycle: metadata.lifecycle,
			...(metadata.last_used_at === null ? {} : { lastUsedAt: metadata.last_used_at }),
			useCount: metadata.use_count,
			contentHash: row.content_hash,
			revision: row.revision,
			contentRevision: row.content_revision,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			sources: sources.map((source) => ({
				type: source.source_type,
				ref: source.source_ref,
				...(source.source_commit ? { commit: source.source_commit } : {}),
				observedAt: source.observed_at,
			})),
			verifications: verifications.map((verification) => ({
				id: verification.id,
				type: verification.verification_type,
				evidenceRef: verification.evidence_ref,
				evidenceVersion: verification.evidence_version,
				verifiedContentRevision: verification.verified_content_revision,
				verifiedAt: verification.verified_at,
			})),
		};
	}

	private selectFts(text: string, query: ProviderSearchQuery, limit: number): MemoryRecord[] {
		const fts = text
			.split(/\s+/u)
			.filter(Boolean)
			.map((token) => `"${token.replaceAll('"', '""')}"`)
			.join(" AND ");
		if (!fts) return [];
		const { clauses, parameters } = buildFilters(this.projectId, query);
		const rows = this.database
			.prepare(
				`SELECT m.* FROM memory_fts JOIN memories m ON m.rowid=memory_fts.rowid JOIN memory_metadata md ON md.memory_id=m.id WHERE memory_fts MATCH ? AND ${clauses.join(" AND ")} ORDER BY bm25(memory_fts), m.updated_at DESC LIMIT ?`,
			)
			.all(fts, ...parameters, limit) as unknown as MemoryRow[];
		return rows.map((row) => this.hydrate(row));
	}

	private selectLiteral(text: string, query: ProviderSearchQuery, limit: number): MemoryRecord[] {
		const { clauses, parameters } = buildFilters(this.projectId, query);
		if (text) {
			clauses.push("instr(lower(m.normalized_content), lower(?)) > 0");
			parameters.push(text.normalize("NFKC"));
		}
		const rows = this.database
			.prepare(
				`SELECT m.* FROM (SELECT * FROM memories WHERE project_id=? ORDER BY updated_at DESC LIMIT ?) m JOIN memory_metadata md ON md.memory_id=m.id WHERE ${clauses.join(" AND ")} ORDER BY m.updated_at DESC LIMIT ?`,
			)
			.all(this.projectId, MAX_LITERAL_SCAN_ROWS, ...parameters, limit) as unknown as MemoryRow[];
		return rows.map((row) => this.hydrate(row));
	}

	private transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.database.isTransaction) this.database.exec("ROLLBACK");
			throw error;
		}
	}

	private throwMissingOrRevision(id: string): never {
		const exists = this.database
			.prepare("SELECT 1 AS present FROM memories WHERE id=? AND project_id=?")
			.get(id, this.projectId);
		if (!exists) throw new MemoryError("MEMORY_NOT_FOUND", "Memory does not exist in the current project");
		throw new MemoryError("MEMORY_REVISION_CONFLICT", "Memory changed since it was read");
	}

	private assertOpen(): void {
		if (this.closed) throw new MemoryError("MEMORY_RUNTIME_CLOSED", "Memory runtime is closed");
	}

	private storageOperation<T>(operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			throw normalizeStorageError(error);
		}
	}
}

export function runCoreMigrations(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS storage_metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS memories (
				rowid INTEGER PRIMARY KEY,
				id TEXT NOT NULL UNIQUE,
				project_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('fact', 'decision', 'experience')),
				content TEXT NOT NULL,
				normalized_content TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('candidate', 'verified', 'stale', 'rejected')),
				content_hash TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
				content_revision INTEGER NOT NULL DEFAULT 1 CHECK(content_revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(project_id, kind, content_hash)
			);
			CREATE TABLE IF NOT EXISTS memory_sources (
				memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
				source_type TEXT NOT NULL CHECK(source_type IN ('user', 'file', 'session', 'test', 'git')),
				source_ref TEXT NOT NULL,
				source_commit TEXT NOT NULL DEFAULT '',
				observed_at INTEGER NOT NULL,
				PRIMARY KEY (memory_id, source_type, source_ref, source_commit)
			);
			CREATE TABLE IF NOT EXISTS memory_verifications (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
				verification_type TEXT NOT NULL CHECK(verification_type IN ('user_confirmed', 'file_observed', 'test_passed', 'git_observed')),
				evidence_ref TEXT NOT NULL,
				evidence_version TEXT NOT NULL,
				verified_content_revision INTEGER NOT NULL CHECK(verified_content_revision > 0),
				verified_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS memories_scope_status ON memories(project_id, status, kind, updated_at DESC);
			CREATE INDEX IF NOT EXISTS memory_verifications_memory_revision ON memory_verifications(memory_id, verified_content_revision, verified_at DESC);
			CREATE INDEX IF NOT EXISTS memory_sources_type ON memory_sources(source_type, memory_id);
		`);
		const versions = database
			.prepare("SELECT version FROM schema_migrations ORDER BY version")
			.all() as unknown as Array<{
			version: number;
		}>;
		if (versions.some(({ version }) => version > SCHEMA_VERSION)) {
			throw new Error(`Memory schema ${versions.at(-1)?.version} is newer than supported version ${SCHEMA_VERSION}`);
		}
		if (!versions.some(({ version }) => version === 1)) {
			database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(Date.now());
		}
		if (!versions.some(({ version }) => version === 2)) {
			database.exec(`
				CREATE TABLE memory_metadata (
					memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
					category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('architecture','dependency','environment','convention','bug_fix','procedure','test_insight','preference','temporary','other')),
					subject_key TEXT,
					tags_json TEXT NOT NULL DEFAULT '[]',
					importance INTEGER NOT NULL DEFAULT 1 CHECK(importance BETWEEN 0 AND 3),
					valid_from INTEGER,
					valid_until INTEGER,
					lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','archived')),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					CHECK(valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until)
				);
				CREATE TABLE memory_usage_stats (
					memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
					last_used_at INTEGER,
					use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0)
				);
				CREATE TABLE memory_relations (
					project_id TEXT NOT NULL,
					source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
					target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
					relation TEXT NOT NULL CHECK(relation IN ('derived_from','supersedes','related_to')),
					created_at INTEGER NOT NULL,
					PRIMARY KEY (source_memory_id, target_memory_id, relation),
					CHECK(source_memory_id <> target_memory_id)
				);
				CREATE TABLE memory_maintenance_proposals (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					action TEXT NOT NULL CHECK(action IN ('keep','retag','merge','compress','archive','mark_stale','delete')),
					source_ids_json TEXT NOT NULL,
					expected_revisions_json TEXT NOT NULL,
					proposed_content TEXT,
					proposed_category TEXT,
					justification TEXT NOT NULL,
					evidence_refs_json TEXT NOT NULL DEFAULT '[]',
					status TEXT NOT NULL CHECK(status IN ('draft','reviewed','applied','rejected')),
					created_at INTEGER NOT NULL,
					reviewed_at INTEGER,
					applied_at INTEGER
				);
				CREATE TABLE memory_governance_audit (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					memory_id TEXT,
					proposal_id TEXT,
					action TEXT NOT NULL,
					before_json TEXT NOT NULL,
					after_json TEXT NOT NULL,
					created_at INTEGER NOT NULL
				);
				CREATE INDEX memory_metadata_category_lifecycle ON memory_metadata(category, lifecycle, subject_key);
				CREATE INDEX memory_relations_project ON memory_relations(project_id, relation, source_memory_id);
				CREATE INDEX memory_proposals_project_status ON memory_maintenance_proposals(project_id, status, created_at DESC);
				CREATE INDEX memory_governance_audit_project ON memory_governance_audit(project_id, created_at DESC);
				INSERT INTO memory_metadata (memory_id, category, tags_json, importance, lifecycle, created_at, updated_at)
					SELECT id, 'other', '[]', 1, 'active', created_at, updated_at FROM memories;
				INSERT INTO memory_usage_stats (memory_id, use_count) SELECT id, 0 FROM memories;
			`);
			database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(Date.now());
		}
		database.exec("COMMIT");
	} catch (error) {
		if (database.isTransaction) database.exec("ROLLBACK");
		throw error;
	}
}

export function rollbackMemoryGovernanceMigration(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		const present = database.prepare("SELECT 1 AS present FROM schema_migrations WHERE version=2").get();
		if (!present) throw new Error("Memory governance schema v2 is not installed");
		database.exec(`
			DROP TABLE memory_governance_audit;
			DROP TABLE memory_maintenance_proposals;
			DROP TABLE memory_relations;
			DROP TABLE memory_usage_stats;
			DROP TABLE memory_metadata;
			DELETE FROM schema_migrations WHERE version=2;
		`);
		database.exec("COMMIT");
	} catch (error) {
		if (database.isTransaction) database.exec("ROLLBACK");
		throw error;
	}
}

function configureDatabaseSizeLimit(database: DatabaseSync): number {
	const pageSize = (database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
	const pageCount = (database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
	if (pageSize * pageCount > MAX_DATABASE_BYTES) {
		throw new MemoryError("MEMORY_STORAGE_ERROR", "Memory database exceeds the configured size limit");
	}
	const maxPages = Math.floor(MAX_DATABASE_BYTES / pageSize);
	database.exec(`PRAGMA max_page_count=${maxPages}`);
	const configured = (database.prepare("PRAGMA max_page_count").get() as { max_page_count: number }).max_page_count;
	if (configured > maxPages)
		throw new MemoryError("MEMORY_STORAGE_ERROR", "Memory database size limit could not be applied");
	return pageSize * configured;
}

function initializeSearchIndex(database: DatabaseSync, mode: "auto" | "unavailable-for-test"): MemorySearchStatus {
	if (mode === "unavailable-for-test") {
		setMetadata(database, "search_index_state", "degraded");
		return "degraded";
	}
	try {
		database.exec("BEGIN IMMEDIATE");
		database.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='memories', content_rowid='rowid');
			CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
				INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
				INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
			END;
			CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories BEGIN
				INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
				INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
		`);
		const memoryCount = database.prepare("SELECT count(*) AS count FROM memories").get() as { count: number };
		const indexCount = database.prepare("SELECT count(*) AS count FROM memory_fts").get() as { count: number };
		if (memoryCount.count !== indexCount.count) throw new Error("FTS5 index count does not match memories");
		database.exec("COMMIT");
		setMetadata(database, "search_index_state", "fts-ready");
		return "fts-ready";
	} catch (error) {
		if (database.isTransaction) database.exec("ROLLBACK");
		if (isFtsUnavailable(error)) {
			setMetadata(database, "search_index_state", "degraded");
			return "degraded";
		}
		throw error;
	}
}

function setMetadata(database: DatabaseSync, key: string, value: string): void {
	database
		.prepare(
			"INSERT INTO storage_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
		)
		.run(key, value);
}

function buildFilters(
	projectId: string,
	query: ProviderSearchQuery,
): { clauses: string[]; parameters: Array<string | number> } {
	const clauses = ["m.project_id=?"];
	const parameters: Array<string | number> = [projectId];
	addInFilter(clauses, parameters, "m.kind", query.kinds);
	addInFilter(clauses, parameters, "m.status", query.statuses);
	addInFilter(clauses, parameters, "md.category", query.categories);
	addInFilter(clauses, parameters, "md.lifecycle", query.lifecycles ?? ["active"]);
	if (!query.includeExpired) {
		clauses.push("(md.valid_until IS NULL OR md.valid_until > ?)");
		parameters.push(Date.now());
	}
	if (query.sourceTypes && query.sourceTypes.length > 0) {
		clauses.push(
			`EXISTS (SELECT 1 FROM memory_sources source_filter WHERE source_filter.memory_id=m.id AND source_filter.source_type IN (${query.sourceTypes.map(() => "?").join(",")}))`,
		);
		parameters.push(...query.sourceTypes);
	}
	return { clauses, parameters };
}

function hydrateProposal(row: ProposalRow): MaintenanceProposal {
	return {
		id: row.id,
		projectId: row.project_id,
		action: row.action,
		sourceIds: parseStringArray(row.source_ids_json),
		expectedRevisions: parseNumberArray(row.expected_revisions_json),
		...(row.proposed_content ? { proposedContent: row.proposed_content } : {}),
		...(row.proposed_category ? { proposedCategory: row.proposed_category } : {}),
		justification: row.justification,
		evidenceRefs: parseStringArray(row.evidence_refs_json),
		status: row.status,
		createdAt: row.created_at,
		...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
		...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
	};
}

function parseStringArray(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
	} catch {}
	throw new MemoryError("MEMORY_STORAGE_ERROR", "Stored memory JSON is invalid");
}

function parseNumberArray(value: string): number[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.every((item) => Number.isSafeInteger(item) && item > 0)) return parsed;
	} catch {}
	throw new MemoryError("MEMORY_STORAGE_ERROR", "Stored proposal revisions are invalid");
}

function safeJson(value: unknown): string {
	return JSON.stringify(value ?? null, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function createContentHash(normalized: string): string {
	return createHash("sha256").update(normalized).digest("hex");
}

function addInFilter(
	clauses: string[],
	parameters: Array<string | number>,
	column: string,
	values: readonly string[] | undefined,
): void {
	if (!values || values.length === 0) return;
	clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
	parameters.push(...values);
}

function isFtsUnavailable(error: unknown): boolean {
	return error instanceof Error && /no such module:\s*fts5|fts5 is not available/iu.test(error.message);
}

function isUniqueConstraint(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/iu.test(error.message);
}

function storageError(message: string, error: unknown): MemoryError {
	return error instanceof MemoryError
		? error
		: new MemoryError(
				"MEMORY_STORAGE_ERROR",
				`${message}: ${error instanceof Error ? error.message : String(error)}`,
				{
					cause: error,
				},
			);
}

function normalizeStorageError(error: unknown): MemoryError {
	if (error instanceof MemoryError) return error;
	if (error instanceof Error && /database is locked|SQLITE_BUSY/iu.test(error.message)) {
		return new MemoryError("MEMORY_STORAGE_BUSY", "Memory database is busy", { cause: error });
	}
	return storageError("Memory storage operation failed", error);
}

export function readSearchState(database: DatabaseSync): string | undefined {
	return (
		database.prepare("SELECT value FROM storage_metadata WHERE key='search_index_state'").get() as
			| { value: string }
			| undefined
	)?.value;
}
