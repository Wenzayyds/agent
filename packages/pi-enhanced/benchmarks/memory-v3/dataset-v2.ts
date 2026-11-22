import type { NewMemoryInput, ScopedSearchQuery } from "../../src/memory/contracts.ts";
import { corpus, queries } from "./dataset.ts";

export interface Case {
	stratum: string;
	query: ScopedSearchQuery;
	expected?: string;
	forbidden?: readonly string[];
}
export interface Fixture {
	key: string;
	input: Omit<NewMemoryInput, "source">;
	proof?: "explicit" | "withdrawn" | "archived" | "revised";
}

export const baseFixtures: readonly Fixture[] = corpus.map(([key, content]) => ({ key, input: { kind: "fact", content } }));
export const baseCases: readonly Case[] = queries.map(([text, expected], index) => ({
	stratum: index < 5 ? "exact" : index === 6 || index === 8 ? "cross-language" : "paraphrase",
	query: { text }, expected,
}));

export const version = "memory-v3-stratified-v2";
export const fixtures: readonly Fixture[] = [
	...baseFixtures,
	{ key: "task-own", input: { kind: "experience", type: "episodic", scope: { kind: "task", id: "release-1" },
		content: "Release incident resolved using the staging manifest.", data: { occurredAt: 200, outcome: "success", causes: ["test:manifest"] } } },
	{ key: "task-foreign", input: { kind: "experience", type: "episodic", scope: { kind: "task", id: "release-10" },
		content: "Release incident resolved using the production manifest.", data: { occurredAt: 210, outcome: "success" } } },
	{ key: "task-failure", input: { kind: "experience", type: "episodic", scope: { kind: "task", id: "release-1" },
		content: "Release incident failed without a staging manifest.", data: { occurredAt: 150, outcome: "failure" } } },
	{ key: "working-own", proof: "explicit", input: { kind: "fact", type: "working", scope: { kind: "session", id: "session-1" },
		content: "Check the staging manifest after resuming.", data: { taskId: "release-1" }, metadata: { importance: 3 } } },
	{ key: "working-expired", proof: "explicit", input: { kind: "fact", type: "working", scope: { kind: "session", id: "session-1" },
		content: "Check the old staging manifest after resuming.", data: { taskId: "release-1" }, metadata: { validUntil: 1 } } },
	{ key: "working-foreign", proof: "explicit", input: { kind: "fact", type: "working", scope: { kind: "session", id: "session-10" },
		content: "Check the private manifest after resuming.", data: { taskId: "release-1" } } },
	{ key: "withdrawn", proof: "withdrawn", input: { kind: "fact", type: "semantic", content: "A deployment token uses the legacy issuer.",
		metadata: { subjectKey: "token.issuer" } } },
	{ key: "current", input: { kind: "fact", type: "semantic", content: "A deployment token uses the current issuer.",
		metadata: { subjectKey: "token.issuer" } } },
	{ key: "linux", input: { kind: "experience", type: "procedural", content: "Release workflow on Linux checks the manifest with a POSIX tool.",
		data: { conditions: ["platform:linux", "tool:read"], steps: ["read manifest"], prerequisites: ["existing local manifest"] } } },
	{ key: "windows", input: { kind: "experience", type: "procedural", content: "Release workflow on Windows checks the manifest with PowerShell.",
		data: { conditions: ["platform:win32", "tool:read"], steps: ["read manifest"] } } },
	{ key: "pref-old", proof: "explicit", input: { kind: "decision", type: "preference", content: "Use compact output for the summary.",
		metadata: { subjectKey: "summary.view" }, data: { value: "compact" } } },
	{ key: "pref-new", proof: "explicit", input: { kind: "decision", type: "preference", content: "Use detailed output for the summary.",
		metadata: { subjectKey: "summary.view" }, data: { value: "detailed" } } },
	{ key: "archived", proof: "archived", input: { kind: "fact", type: "semantic",
		content: "Manifest rollout lookup uses the ARCHIVED_MANIFEST_V1 selector." } },
	{ key: "revised", proof: "revised", input: { kind: "fact", type: "semantic",
		content: "Manifest rollout lookup uses the OBSOLETE_MANIFEST_V1 selector." } },
];

export const cases: readonly Case[] = [
	...baseCases,
	{ stratum: "inflection", query: { text: "Which credential masks protect access tokens?" }, expected: "redact" },
	{ stratum: "task-isolation", query: { text: "Release incident", types: ["episodic"], visibility: { taskId: "release-1" },
		episodeOutcome: "success", occurredAfter: 180, occurredBefore: 205 }, expected: "task-own", forbidden: ["task-foreign", "task-failure"] },
	{ stratum: "task-isolation", query: { text: "Release incident", types: ["episodic"], visibility: { taskId: "release-10" } },
		expected: "task-foreign", forbidden: ["task-own", "task-failure"] },
	{ stratum: "ttl-and-session", query: { text: "", types: ["working"], visibility: { sessionId: "session-1", taskId: "release-1" },
		order: "priority" }, expected: "working-own", forbidden: ["working-expired", "working-foreign"] },
	{ stratum: "ttl-and-session", query: { text: "", types: ["working"], visibility: { sessionId: "session-1", taskId: "release-10" } },
		forbidden: ["working-own", "working-expired", "working-foreign"] },
	{ stratum: "conflicting-evidence", query: { text: "deployment token issuer", types: ["semantic"] },
		expected: "current", forbidden: ["withdrawn"] },
	{ stratum: "procedure-applicability", query: { text: "release workflow", types: ["procedural"], conditions: ["platform:linux", "tool:read"] },
		expected: "linux", forbidden: ["windows"] },
	{ stratum: "procedure-applicability", query: { text: "release workflow", types: ["procedural"], conditions: ["platform:linux"] },
		forbidden: ["linux", "windows"] },
	{ stratum: "preference-key", query: { text: "", preferenceKey: "summary.view" }, expected: "pref-new", forbidden: ["pref-old"] },
	{ stratum: "preference-key", query: { text: "", preferenceKey: "summary" }, forbidden: ["pref-new", "pref-old"] },
	{ stratum: "archive-exclusion", query: { text: "ARCHIVED_MANIFEST_V1", types: ["semantic"] },
		forbidden: ["archived"] },
	{ stratum: "revision", query: { text: "CURRENT_MANIFEST_V2", types: ["semantic"] }, expected: "revised" },
];
