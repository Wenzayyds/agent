export const MEMORY_KINDS = ["fact", "decision", "experience"] as const;
export const MEMORY_STATUSES = ["candidate", "verified", "stale", "rejected"] as const;
export const MEMORY_SOURCE_TYPES = ["user", "file", "session", "test", "git"] as const;
export const MEMORY_VERIFICATION_TYPES = ["user_confirmed", "file_observed", "test_passed", "git_observed"] as const;
export const MEMORY_CATEGORIES = [
	"architecture",
	"dependency",
	"environment",
	"convention",
	"bug_fix",
	"procedure",
	"test_insight",
	"preference",
	"temporary",
	"other",
] as const;
export const MEMORY_LIFECYCLES = ["active", "archived"] as const;
export const MEMORY_RELATION_TYPES = ["derived_from", "supersedes", "related_to"] as const;
export const MAINTENANCE_ACTIONS = ["keep", "retag", "merge", "compress", "archive", "mark_stale", "delete"] as const;
export const MAINTENANCE_PROPOSAL_STATUSES = ["draft", "reviewed", "applied", "rejected"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];
export type MemoryVerificationType = (typeof MEMORY_VERIFICATION_TYPES)[number];
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryLifecycle = (typeof MEMORY_LIFECYCLES)[number];
export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];
export type MaintenanceProposalStatus = (typeof MAINTENANCE_PROPOSAL_STATUSES)[number];

export interface ProjectScope {
	projectId: string;
	rootPath: string;
	identityKey: string;
	dataDir: string;
	manifestPath: string;
	databasePath: string;
}

export interface MemorySource {
	type: MemorySourceType;
	ref: string;
	commit?: string;
	observedAt: number;
}

export interface MemoryVerification {
	id: string;
	type: MemoryVerificationType;
	evidenceRef: string;
	evidenceVersion: string;
	verifiedContentRevision: number;
	verifiedAt: number;
}

export interface MemoryRecord {
	id: string;
	projectId: string;
	kind: MemoryKind;
	content: string;
	status: MemoryStatus;
	category: MemoryCategory;
	subjectKey?: string;
	tags: readonly string[];
	importance: 0 | 1 | 2 | 3;
	validFrom?: number;
	validUntil?: number;
	lifecycle: MemoryLifecycle;
	lastUsedAt?: number;
	useCount: number;
	sources: readonly MemorySource[];
	verifications: readonly MemoryVerification[];
	contentHash: string;
	revision: number;
	contentRevision: number;
	createdAt: number;
	updatedAt: number;
}

const TASK_EXPERIENCE_SOURCE = /^task:([^:\s]+):experience:/u;

export function memoryTaskId(sources: readonly Pick<MemorySource, "ref">[]): string | undefined {
	const taskIds = new Set(
		sources.flatMap(({ ref }) => {
			const id = TASK_EXPERIENCE_SOURCE.exec(ref)?.[1];
			return id ? [id] : [];
		}),
	);
	return taskIds.size === 1 ? taskIds.values().next().value : undefined;
}

export function classifyMemory(record: MemoryRecord): "profile" | "preference" | "long-term" | "task" {
	if (record.sources.some(({ ref }) => TASK_EXPERIENCE_SOURCE.test(ref)) || record.category === "temporary")
		return "task";
	if (record.category === "preference") return "preference";
	if (record.subjectKey?.startsWith("profile:") && record.sources.some(({ type }) => type === "user"))
		return "profile";
	return "long-term";
}

export interface NewMemoryInput {
	kind: MemoryKind;
	content: string;
	source: {
		type: MemorySourceType;
		ref: string;
		commit?: string;
	};
	metadata?: {
		category?: MemoryCategory;
		subjectKey?: string;
		tags?: readonly string[];
		importance?: 0 | 1 | 2 | 3;
		validFrom?: number;
		validUntil?: number;
	};
}

export interface ScopedSearchQuery {
	text: string;
	limit?: number;
	kinds?: MemoryKind[];
	statuses?: MemoryStatus[];
	sourceTypes?: MemorySourceType[];
	categories?: MemoryCategory[];
	lifecycles?: MemoryLifecycle[];
}

export interface MemoryRelation {
	sourceMemoryId: string;
	targetMemoryId: string;
	relation: MemoryRelationType;
	createdAt: number;
}

export interface MaintenanceProposal {
	id: string;
	projectId: string;
	action: MaintenanceAction;
	sourceIds: readonly string[];
	expectedRevisions: readonly number[];
	proposedContent?: string;
	proposedCategory?: MemoryCategory;
	justification: string;
	evidenceRefs: readonly string[];
	status: MaintenanceProposalStatus;
	createdAt: number;
	reviewedAt?: number;
	appliedAt?: number;
}

export interface MemoryDoctorReport {
	recordCount: number;
	activeCount: number;
	archivedCount: number;
	expiredActiveIds: readonly string[];
	exactDuplicateGroups: readonly (readonly string[])[];
	nearDuplicateGroups: readonly (readonly string[])[];
	conflictGroups: readonly (readonly string[])[];
	uncategorizedIds: readonly string[];
	archiveCandidateIds: readonly string[];
	coreBytes: Readonly<Record<CoreMemoryName, number>>;
	warnings: readonly string[];
}

export interface FileEvidenceInput {
	relativePath: string;
	exactExcerpt: string;
	expectedFileHash?: string;
}

export const CORE_MEMORY_NAMES = ["project", "architecture", "decisions"] as const;
export type CoreMemoryName = (typeof CORE_MEMORY_NAMES)[number];

export interface CoreMemoryDocument {
	projectId: string;
	name: CoreMemoryName;
	relativePath: string;
	content: string;
	contentHash: string;
	modifiedAt: number;
}

export interface CoreMemoryWriteResult {
	document: CoreMemoryDocument;
	visibilityWarning?: string;
}

export interface ReadonlyMemoryQuery {
	text: string;
	limit?: number;
	kinds?: MemoryKind[];
}

export interface ScopedMemoryReader {
	search(query: ReadonlyMemoryQuery): Promise<readonly MemoryRecord[]>;
	get(id: string): Promise<MemoryRecord | null>;
	getCore(name: CoreMemoryName): Promise<CoreMemoryDocument | null>;
}

export interface VerifiedMemorySnapshot {
	records: readonly MemoryRecord[];
	truncated: boolean;
}

export type MemoryIntelligenceState = "disabled" | "unavailable" | "ready" | "degraded";

export interface MemoryIntelligenceStatus {
	state: MemoryIntelligenceState;
	configuredMode: "lexical" | "semantic" | "hybrid";
	activeMode: "lexical" | "semantic" | "hybrid";
	modelId?: string;
	indexSize: number;
	reranker: "disabled" | "unavailable";
	lastErrorCode?: string;
}

export interface MemorySearchResult {
	records: readonly MemoryRecord[];
	mode: "lexical" | "semantic" | "hybrid";
	fallbackReason?: string;
}

export const SESSION_RECALL_MODES = ["raw-active-branch", "model-visible"] as const;
export type SessionRecallMode = (typeof SESSION_RECALL_MODES)[number];
export type SessionRecallRole = "user" | "assistant" | "toolResult" | "custom";

export interface SessionRecallQuery {
	text: string;
	mode?: SessionRecallMode;
	limit?: number;
}

export interface SessionRecallHit {
	projectId: string;
	sessionId: string;
	entryId: string;
	branchLeafId: string | null;
	entryType: string;
	role: SessionRecallRole;
	projection: SessionRecallMode;
	content: string;
	contentHash: string;
	entryTimestamp: string;
	truncated: boolean;
}

export interface SessionRecallResult {
	projectId: string;
	sessionId: string;
	branchLeafId: string | null;
	projection: SessionRecallMode;
	hits: readonly SessionRecallHit[];
	scannedEntries: number;
	scannedTexts: number;
	scanLimitReached: boolean;
	sourceLimitReached: boolean;
	resultLimitReached: boolean;
}

export type MemorySearchStatus = "fts-ready" | "degraded";

export interface MemoryRuntimeInfo {
	state: "disabled" | "blocked" | "ready" | "error";
	scope?: ProjectScope;
	searchStatus?: MemorySearchStatus;
	error?: string;
}
