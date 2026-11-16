import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CORE_MEMORY_NAMES,
	type CoreMemoryDocument,
	type CoreMemoryName,
	type CoreMemoryWriteResult,
	type FileEvidenceInput,
	MAINTENANCE_ACTIONS,
	type MaintenanceProposal,
	MEMORY_CATEGORIES,
	MEMORY_KINDS,
	MEMORY_LIFECYCLES,
	MEMORY_SOURCE_TYPES,
	MEMORY_STATUSES,
	type MemoryCategory,
	type MemoryDoctorReport,
	type MemoryKind,
	type MemoryLifecycle,
	type MemoryRecord,
	type MemoryRelation,
	type MemoryStatus,
	memoryTaskId,
	type NewMemoryInput,
	type ProjectScope,
	type ScopedSearchQuery,
	type VerifiedMemorySnapshot,
} from "./contracts.ts";
import { CoreMemoryStore } from "./core-memory.ts";
import { MemoryError } from "./errors.ts";
import { type GovernancePlan, type MemoryGovernanceConfig, planMemoryGovernance } from "./governance.ts";
import type { LocalMemoryProvider } from "./provider.ts";
import { openLocalMemoryProvider } from "./storage.ts";

const MAX_CONTENT_LENGTH = 8_000;
const MAX_QUERY_LENGTH = 500;
const MAX_SOURCE_REF_LENGTH = 1_000;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_VERIFIED_SNAPSHOT_RECORDS = 2_000;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 64;
const MAX_SUBJECT_KEY_LENGTH = 200;

const SECRET_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
	/\bghp_[A-Za-z0-9]{30,}\b/u,
	/\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
	/\bsk-[A-Za-z0-9_-]{20,}\b/u,
	/\b(?:api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{12,}/iu,
];

export type MemoryReviewAction = "reject" | "mark_stale" | "restore_candidate";

export class MemoryService {
	readonly scope: ProjectScope;
	readonly searchStatus: LocalMemoryProvider["searchStatus"];
	private readonly provider: LocalMemoryProvider;
	private readonly coreMemory: CoreMemoryStore;
	private closed = false;

	constructor(scope: ProjectScope, provider: LocalMemoryProvider) {
		this.scope = scope;
		this.provider = provider;
		this.coreMemory = new CoreMemoryStore(scope);
		this.searchStatus = provider.searchStatus;
	}

	async saveCandidate(input: NewMemoryInput): Promise<MemoryRecord> {
		this.assertOpen();
		if (!MEMORY_KINDS.includes(input.kind)) throw validationError("Unsupported memory kind");
		if (!MEMORY_SOURCE_TYPES.includes(input.source.type)) throw validationError("Unsupported memory source type");
		const content = validateContent(input.content);
		const sourceRef = validateText(input.source.ref, "Source reference", MAX_SOURCE_REF_LENGTH);
		const now = Date.now();
		const metadata = validateMetadata(input.metadata);
		return this.provider.saveCandidate({
			kind: input.kind,
			content,
			normalizedContent: normalizeMemoryText(content),
			contentHash: hashNormalizedContent(content, memoryTaskId([{ ref: sourceRef }])),
			source: {
				type: input.source.type,
				ref: sourceRef,
				...(input.source.commit ? { commit: validateText(input.source.commit, "Source commit", 200) } : {}),
				observedAt: now,
			},
			now,
			metadata,
		});
	}

	async search(query: ScopedSearchQuery): Promise<MemoryRecord[]> {
		this.assertOpen();
		const text = validateText(query.text, "Search query", MAX_QUERY_LENGTH);
		const statuses = query.statuses ?? ["verified"];
		if (statuses.length === 0) throw validationError("At least one memory status is required");
		if (statuses.some((status) => !MEMORY_STATUSES.includes(status)))
			throw validationError("Unsupported memory status");
		if (query.kinds?.some((kind) => !MEMORY_KINDS.includes(kind))) throw validationError("Unsupported memory kind");
		if (query.sourceTypes?.some((source) => !MEMORY_SOURCE_TYPES.includes(source))) {
			throw validationError("Unsupported memory source type");
		}
		if (query.categories?.some((category) => !MEMORY_CATEGORIES.includes(category))) {
			throw validationError("Unsupported memory category");
		}
		if (query.lifecycles?.some((lifecycle) => !MEMORY_LIFECYCLES.includes(lifecycle))) {
			throw validationError("Unsupported memory lifecycle");
		}
		if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
			throw validationError("Search limit must be a positive integer");
		}
		return this.provider.search({
			text,
			limit: Math.max(1, Math.min(query.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)),
			statuses,
			...(query.kinds ? { kinds: query.kinds } : {}),
			...(query.sourceTypes ? { sourceTypes: query.sourceTypes } : {}),
			...(query.categories ? { categories: query.categories } : {}),
			...(query.lifecycles ? { lifecycles: query.lifecycles } : {}),
		});
	}

	async list(
		options: {
			limit?: number;
			kinds?: MemoryKind[];
			statuses?: MemoryStatus[];
			categories?: MemoryCategory[];
			lifecycles?: MemoryLifecycle[];
		} = {},
	): Promise<MemoryRecord[]> {
		this.assertOpen();
		if (
			options.limit !== undefined &&
			(!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50)
		)
			throw validationError("List limit is invalid");
		return this.provider.list({ ...options, limit: options.limit ?? 20 });
	}

	async get(id: string): Promise<MemoryRecord | null> {
		this.assertOpen();
		return this.provider.get(validateId(id));
	}

	async listVerifiedSnapshot(limit = MAX_VERIFIED_SNAPSHOT_RECORDS): Promise<VerifiedMemorySnapshot> {
		this.assertOpen();
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_VERIFIED_SNAPSHOT_RECORDS) {
			throw validationError("Verified snapshot limit is invalid");
		}
		const records = await this.provider.listVerified(limit + 1);
		return { records: records.slice(0, limit), truncated: records.length > limit };
	}

	getCore(name: CoreMemoryName): CoreMemoryDocument | null {
		this.assertOpen();
		return this.coreMemory.get(name);
	}

	createCore(name: CoreMemoryName, content: string): CoreMemoryWriteResult {
		this.assertOpen();
		return this.coreMemory.create(name, content);
	}

	updateCore(name: CoreMemoryName, content: string): CoreMemoryWriteResult {
		this.assertOpen();
		return this.coreMemory.update(name, content);
	}

	deleteCore(name: CoreMemoryName): void {
		this.assertOpen();
		this.coreMemory.delete(name);
	}

	async updateContent(id: string, content: string, expectedRevision: number): Promise<MemoryRecord> {
		this.assertOpen();
		const memoryId = validateId(id);
		validateRevision(expectedRevision);
		const current = await this.require(memoryId);
		if (current.revision !== expectedRevision) throw revisionConflict();
		const validated = validateContent(content);
		const normalized = normalizeMemoryText(validated);
		if (normalized === normalizeMemoryText(current.content)) return current;
		return this.provider.updateContent({
			id: memoryId,
			content: validated,
			normalizedContent: normalized,
			contentHash: hashNormalizedContent(validated, memoryTaskId(current.sources)),
			expectedRevision,
			now: Date.now(),
		});
	}

	async confirmByUser(id: string, expectedRevision: number, ctx: ExtensionCommandContext): Promise<MemoryRecord> {
		this.assertOpen();
		if (!ctx.hasUI) throw validationError("Interactive user confirmation is unavailable");
		const memoryId = validateId(id);
		validateRevision(expectedRevision);
		const current = await this.require(memoryId);
		if (current.revision !== expectedRevision) throw revisionConflict();
		if (current.status !== "candidate" && current.status !== "stale") {
			throw validationError(`Cannot confirm a ${current.status} memory`);
		}
		let confirmed: boolean;
		try {
			confirmed = await ctx.ui.confirm(
				"确认项目记忆",
				`类型：${current.kind}\n内容：${current.content.slice(0, 500)}\n\n确认这条内容可标记为 verified？`,
			);
		} catch {
			throw validationError("User confirmation failed");
		}
		if (!confirmed) throw validationError("User did not confirm the memory");
		return this.provider.setStatus({
			id: memoryId,
			status: "verified",
			verification: {
				id: randomUUID(),
				type: "user_confirmed",
				evidenceRef: `session:${ctx.sessionManager.getSessionId()}`,
				evidenceVersion: current.contentHash,
				verifiedAt: Date.now(),
			},
			expectedRevision,
			now: Date.now(),
		});
	}

	async verifyFileFact(id: string, evidence: FileEvidenceInput, expectedRevision: number): Promise<MemoryRecord> {
		this.assertOpen();
		const memoryId = validateId(id);
		validateRevision(expectedRevision);
		const current = await this.require(memoryId);
		if (current.revision !== expectedRevision) throw revisionConflict();
		if (current.status !== "candidate" && current.status !== "stale") {
			throw validationError(`Cannot verify a ${current.status} memory`);
		}
		const relativePath = validateText(evidence.relativePath, "Evidence path", MAX_SOURCE_REF_LENGTH);
		const { pathFromRoot, fileContent } = this.readEvidenceFile(relativePath);
		const excerpt = validateText(evidence.exactExcerpt, "Evidence excerpt", MAX_CONTENT_LENGTH);
		if (!fileContent.includes(excerpt) || normalizeMemoryText(excerpt) !== normalizeMemoryText(current.content)) {
			throw validationError("File evidence does not contain the exact memory content");
		}
		const fileHash = createHash("sha256").update(fileContent).digest("hex");
		if (evidence.expectedFileHash && evidence.expectedFileHash !== fileHash) {
			throw validationError("File evidence changed before verification");
		}
		return this.provider.setStatus({
			id: memoryId,
			status: "verified",
			verification: {
				id: randomUUID(),
				type: "file_observed",
				evidenceRef: pathFromRoot.replaceAll("\\", "/"),
				evidenceVersion: fileHash,
				verifiedAt: Date.now(),
			},
			expectedRevision,
			now: Date.now(),
		});
	}

	async reflectFileEvidence(id: string, expectedRevision: number): Promise<MemoryRecord> {
		this.assertOpen();
		validateRevision(expectedRevision);
		const record = await this.require(validateId(id));
		if (record.revision !== expectedRevision) throw revisionConflict();
		const proof = record.verifications.filter((item) => item.verifiedContentRevision === record.contentRevision);
		const files = proof.filter((item) => item.type === "file_observed");
		if (record.status !== "verified" || !files.length || files.length !== proof.length)
			throw validationError("Reflection requires current file-only verification evidence");
		const changed: { evidenceRef: string; previousSha256: string; observedSha256: string }[] = [];
		const checked = new Set<string>();
		for (const item of [...files].sort((left, right) => right.verifiedAt - left.verifiedAt)) {
			if (checked.has(item.evidenceRef)) continue;
			checked.add(item.evidenceRef);
			const { fileContent: text } = this.readEvidenceFile(item.evidenceRef);
			const observedSha256 = createHash("sha256").update(text).digest("hex");
			if (
				observedSha256 === item.evidenceVersion ||
				normalizeMemoryText(text).includes(normalizeMemoryText(record.content))
			)
				return record;
			changed.push({ evidenceRef: item.evidenceRef, previousSha256: item.evidenceVersion, observedSha256 });
		}
		return this.provider.setStatus({
			id: record.id,
			status: "stale",
			expectedRevision,
			now: Date.now(),
			reflection: changed,
		});
	}

	private readEvidenceFile(relativePath: string): { pathFromRoot: string; fileContent: string } {
		if (isAbsolute(relativePath)) throw validationError("Evidence path must be relative to the current project");
		try {
			const target = realpathSync.native(resolve(this.scope.rootPath, relativePath));
			const pathFromRoot = relative(this.scope.rootPath, target);
			if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot))
				throw validationError("Evidence path is outside the current project");
			const info = statSync(target);
			if (!info.isFile() || info.size > 1024 * 1024)
				throw validationError("Evidence must be a project file of at most 1 MiB");
			return { pathFromRoot, fileContent: readFileSync(target, "utf8") };
		} catch (error) {
			if (error instanceof MemoryError) throw error;
			throw validationError("File evidence could not be read");
		}
	}

	async review(id: string, action: MemoryReviewAction, expectedRevision: number): Promise<MemoryRecord> {
		this.assertOpen();
		const memoryId = validateId(id);
		validateRevision(expectedRevision);
		const current = await this.require(memoryId);
		if (current.revision !== expectedRevision) throw revisionConflict();
		const target = reviewTarget(current.status, action);
		return this.provider.setStatus({ id: memoryId, status: target, expectedRevision, now: Date.now() });
	}

	async delete(id: string, expectedRevision: number): Promise<void> {
		this.assertOpen();
		validateRevision(expectedRevision);
		await this.provider.delete(validateId(id), expectedRevision);
	}

	async updateMetadata(
		id: string,
		expectedRevision: number,
		patch: {
			category?: MemoryCategory;
			subjectKey?: string | null;
			tags?: readonly string[];
			importance?: 0 | 1 | 2 | 3;
			validFrom?: number | null;
			validUntil?: number | null;
		},
	): Promise<MemoryRecord> {
		this.assertOpen();
		validateRevision(expectedRevision);
		const validated = validateMetadataPatch(patch);
		return this.provider.setMetadata({ id: validateId(id), expectedRevision, ...validated, now: Date.now() });
	}

	async archive(id: string, expectedRevision: number): Promise<MemoryRecord> {
		return this.setLifecycle(id, expectedRevision, "archived");
	}

	async restore(id: string, expectedRevision: number): Promise<MemoryRecord> {
		return this.setLifecycle(id, expectedRevision, "active");
	}

	async recordUsage(id: string): Promise<void> {
		this.assertOpen();
		await this.provider.recordUsage(validateId(id), Date.now());
	}

	async inspect(id: string): Promise<{ record: MemoryRecord; relations: readonly MemoryRelation[] }> {
		this.assertOpen();
		const memoryId = validateId(id);
		return { record: await this.require(memoryId), relations: await this.provider.listRelations(memoryId) };
	}

	async doctor(config: MemoryGovernanceConfig): Promise<MemoryDoctorReport> {
		return (await this.planMaintenance(config, false)).report;
	}

	async planMaintenance(config: MemoryGovernanceConfig, persistDrafts = true): Promise<GovernancePlan> {
		this.assertOpen();
		const records = await this.provider.list({
			limit: config.maximumScanRecords,
			statuses: [...MEMORY_STATUSES],
			lifecycles: [...MEMORY_LIFECYCLES],
		});
		const coreBytes = Object.fromEntries(
			CORE_MEMORY_NAMES.map((name) => [name, Buffer.byteLength(this.coreMemory.get(name)?.content ?? "", "utf8")]),
		) as Record<CoreMemoryName, number>;
		const plan = planMemoryGovernance({ projectId: this.scope.projectId, records, coreBytes, config });
		if (persistDrafts) await this.provider.replaceDraftProposals(plan.proposals);
		return plan;
	}

	async getMaintenanceProposal(id: string): Promise<MaintenanceProposal | null> {
		this.assertOpen();
		return this.provider.getProposal(validateId(id));
	}

	async applyMaintenanceProposal(id: string): Promise<MaintenanceProposal> {
		this.assertOpen();
		const proposal = await this.provider.getProposal(validateId(id));
		if (!proposal) throw new MemoryError("MEMORY_NOT_FOUND", "Maintenance proposal does not exist");
		if (!MAINTENANCE_ACTIONS.includes(proposal.action)) throw validationError("Unsupported maintenance action");
		if (proposal.proposedContent !== undefined) validateContent(proposal.proposedContent);
		if (proposal.proposedCategory !== undefined && !MEMORY_CATEGORIES.includes(proposal.proposedCategory))
			throw validationError("Unsupported proposal category");
		return this.provider.applyProposal(proposal.id, Date.now());
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.provider.close();
	}

	private async require(id: string): Promise<MemoryRecord> {
		const record = await this.provider.get(id);
		if (!record) throw new MemoryError("MEMORY_NOT_FOUND", "Memory does not exist in the current project");
		return record;
	}

	private async setLifecycle(id: string, expectedRevision: number, lifecycle: MemoryLifecycle): Promise<MemoryRecord> {
		this.assertOpen();
		validateRevision(expectedRevision);
		const memoryId = validateId(id);
		const current = await this.require(memoryId);
		if (current.revision !== expectedRevision) throw revisionConflict();
		if (current.lifecycle === lifecycle) return current;
		return this.provider.setMetadata({ id: memoryId, expectedRevision, lifecycle, now: Date.now() });
	}

	private assertOpen(): void {
		if (this.closed) throw new MemoryError("MEMORY_RUNTIME_CLOSED", "Memory runtime is closed");
	}
}

export async function openMemoryService(scope: ProjectScope): Promise<MemoryService> {
	return new MemoryService(scope, await openLocalMemoryProvider(scope));
}

export function normalizeMemoryText(content: string): string {
	return content.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function hashNormalizedContent(content: string, taskId?: string): string {
	const normalized = normalizeMemoryText(content);
	return createHash("sha256")
		.update(taskId ? JSON.stringify([taskId, normalized]) : normalized)
		.digest("hex");
}

function validateContent(content: string): string {
	const value = validateText(content, "Memory content", MAX_CONTENT_LENGTH);
	if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
		throw validationError("Memory content appears to contain a credential or private key");
	}
	return value;
}

function validateText(value: string, label: string, maximum: number): string {
	if (typeof value !== "string") throw validationError(`${label} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw validationError(`${label} must not be empty`);
	if (trimmed.length > maximum) throw validationError(`${label} is too long`);
	if (trimmed.includes("\0")) throw validationError(`${label} contains an invalid null character`);
	return trimmed;
}

function validateId(id: string): string {
	return validateText(id, "Memory id", 200);
}

function validateRevision(revision: number): void {
	if (!Number.isSafeInteger(revision) || revision < 1)
		throw validationError("Expected revision must be a positive integer");
}

function validateMetadata(metadata: NewMemoryInput["metadata"]): NonNullable<NewMemoryInput["metadata"]> & {
	category: MemoryCategory;
	tags: readonly string[];
	importance: 0 | 1 | 2 | 3;
} {
	const patch = validateMetadataPatch(metadata ?? {});
	return {
		category: patch.category ?? "other",
		tags: patch.tags ?? [],
		importance: patch.importance ?? 1,
		...(patch.subjectKey ? { subjectKey: patch.subjectKey } : {}),
		...(patch.validFrom === undefined || patch.validFrom === null ? {} : { validFrom: patch.validFrom }),
		...(patch.validUntil === undefined || patch.validUntil === null ? {} : { validUntil: patch.validUntil }),
	};
}

function validateMetadataPatch<
	T extends {
		category?: MemoryCategory;
		subjectKey?: string | null;
		tags?: readonly string[];
		importance?: 0 | 1 | 2 | 3;
		validFrom?: number | null;
		validUntil?: number | null;
	},
>(patch: T): T {
	if (patch.category !== undefined && !MEMORY_CATEGORIES.includes(patch.category))
		throw validationError("Unsupported memory category");
	if (patch.subjectKey !== undefined && patch.subjectKey !== null)
		validateText(patch.subjectKey, "Subject key", MAX_SUBJECT_KEY_LENGTH);
	if (patch.tags !== undefined) {
		if (!Array.isArray(patch.tags) || patch.tags.length > MAX_TAGS) throw validationError("Memory tags are invalid");
		for (const tag of patch.tags) validateText(tag, "Memory tag", MAX_TAG_LENGTH);
		if (new Set(patch.tags).size !== patch.tags.length) throw validationError("Memory tags must be unique");
	}
	if (patch.importance !== undefined && !([0, 1, 2, 3] as readonly number[]).includes(patch.importance))
		throw validationError("Memory importance is invalid");
	for (const value of [patch.validFrom, patch.validUntil]) {
		if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0))
			throw validationError("Memory validity timestamp is invalid");
	}
	if (
		patch.validFrom !== undefined &&
		patch.validFrom !== null &&
		patch.validUntil !== undefined &&
		patch.validUntil !== null &&
		patch.validFrom > patch.validUntil
	)
		throw validationError("Memory validity range is invalid");
	return patch;
}

function reviewTarget(status: MemoryStatus, action: MemoryReviewAction): MemoryStatus {
	if (action === "reject" && status !== "rejected") return "rejected";
	if (action === "mark_stale" && status === "verified") return "stale";
	if (action === "restore_candidate" && (status === "stale" || status === "rejected")) return "candidate";
	throw validationError(`Action ${action} is not allowed from ${status}`);
}

function validationError(message: string): MemoryError {
	return new MemoryError("MEMORY_VALIDATION_ERROR", message);
}

function revisionConflict(): MemoryError {
	return new MemoryError("MEMORY_REVISION_CONFLICT", "Memory changed since it was read");
}
