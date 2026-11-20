import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../../../coding-agent/src/core/auth-storage.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../../coding-agent/test/model-runtime-test-utils.ts";
import { createTestUiContext, getMessageText } from "../../../coding-agent/test/suite/harness.ts";
import { startVectorLab } from "../../fixtures/knowledge/vector-lab.ts";
import { createContextExtension } from "../../src/context/extension.ts";
import { REPEATED_WORKSPACE_READ } from "../../src/context/tool-output.ts";
import { runKnowledgeCommand } from "../../src/knowledge/commands.ts";
import { createKnowledgeExtension } from "../../src/knowledge/extension.ts";
import { projectKnowledgeRequest, registerKnowledgePageAccess } from "../../src/knowledge/request-policy.ts";
import { KnowledgeService } from "../../src/knowledge/service.ts";
import {
	isKnowledgeTool,
	knowledgeResultReferences,
	registerKnowledgeTools,
	storeKnowledgeToolReferences,
} from "../../src/knowledge/tools.ts";
import { openDocumentIndex } from "../../src/knowledge/vector.ts";
import type { ProjectScope } from "../../src/memory/contracts.ts";
import { createMemoryExtension } from "../../src/memory/extension.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { LocalMemoryProvider, type ProviderSearchQuery } from "../../src/memory/provider.ts";
import { MemoryService, openMemoryService } from "../../src/memory/service.ts";
import { ensureProjectStorage } from "../../src/memory/storage.ts";
import { createSandboxExtension } from "../../src/sandbox/extension.ts";
import { createPytestExecutor } from "../../src/sandbox/pytest.ts";
import { ENHANCED_CONFIG_FILE } from "../../src/shared/config.ts";
import { MemoryWorkerError } from "../../src/shared/embedding/python-worker-client.ts";
import type { TaskSnapshot } from "../../src/task-manager/contracts.ts";
import { createTaskManagerExtension } from "../../src/task-manager/extension.ts";
import { createTaskStorageScope } from "../../src/task-manager/provider.ts";
import {
	close,
	dockerImageAvailable,
	sandboxConfigForTesting,
	startStubProvider,
	textSse,
	toolCallsSse,
} from "../../tests/fixtures/runner-support.ts";
import { type RunningBudgetGateway, startBudgetGateway } from "./budget-gateway.ts";
import {
	applyEvaluationContextBudget,
	assessEvaluationContinuation,
	canReserveE17Cell,
	type EvaluationWireMessage,
	measureEvaluationContext,
} from "./evaluation-context-budget.ts";
import { independentTasks } from "./independent-evaluation-tasks.ts";

const PYTEST = "sha256:309133b814f07b1ec715984cdaf5c35f26cf1e0500bc85732442b69af5ca753f";
const MODEL = "gpt-4o";
const FLASH = "deepseek-flash";
const DEEPSEEK = "https://api.deepseek.com";
const FLASH_PRICING = { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 };
const BATCH_CENTS = 96;
const CELL_CENTS = 3;
const RESUME_FIRST_TURN =
	"First run the approved pytest once to reproduce the current failure. Do not edit yet. Stop after reporting the baseline so I can pause and restore the session.";
const RESUME_PROMPT = "Continue the same approved task after restoring the session.";
const READ_ONLY_VERIFY = "Run the approved baseline pytest without editing, then report the evidence and its limits.";
const SYSTEM =
	"Use the visible project tools and documents. Keep changes scoped to the request. Run the approved tests. If a required contract cannot be found, report the missing evidence.";
const FAILED_DEDUPE_ATTEMPT = "sorted(dict.fromkeys(items))";
const LIMITS = {
	maxRequests: 8,
	maxTotalTokens: 20_000,
	maxTotalCostUsd: 0.03,
	maxConcurrency: 1,
	requestTimeoutMs: 20_000,
	maxOutputTokensPerRequest: 512,
	maxRequestBytes: 96_000,
};
const PROFILES = [
	{ id: "A", memory: false, rag: false },
	{ id: "B", memory: true, rag: false },
	{ id: "C", memory: false, rag: true },
	{ id: "D", memory: true, rag: true },
] as const;

type Edit = { path: string; oldText: string; newText: string };
type Fact = { query: string; body: string; marker: string };
export type Task = {
	id: string;
	category: string;
	request: string;
	files: Record<string, string>;
	publicCheck: string;
	edits: Edit[];
	hidden: string;
	memory?: Fact;
	doc?: Fact;
	referenceOnly?: Fact;
	retired?: string;
	resume?: boolean;
	abstain?: boolean;
};
const edit = (oldText: string, newText: string, path = "app.py"): Edit => ({ path, oldText, newText });
const fact = (query: string, marker: string, body: string): Fact => ({ query, marker, body });
const suite = (primary: string, regression: string) =>
	`from app import evaluate\n\ndef test_contract():\n    assert ${primary}\n\ndef test_regression():\n    assert ${regression}\n`;
const frozenTasks: Task[] = [
	{
		id: "clamp",
		category: "边界缺陷",
		request: "Credit clamp should accept the maximum credit of 100. Preserve rejection for values above it.",
		files: { "app.py": "def evaluate(credit):\n    return 0 <= credit < 100\n" },
		publicCheck: "evaluate(12)",
		edits: [edit("credit < 100", "credit <= 100")],
		hidden: suite("evaluate(100)", "not evaluate(101)"),
	},
	{
		id: "export-api",
		category: "API 兼容",
		request: "Restore the output key expected by the partner's CSV export API. Use the external API contract.",
		files: { "app.py": "def evaluate(row):\n    return {'legacy': row}\n" },
		publicCheck: "isinstance(evaluate(2), dict)",
		edits: [edit("'legacy'", "'export_id'")],
		hidden: suite("evaluate(7) == {'export_id': 7}", "list(evaluate(0).values()) == [0]"),
		doc: fact(
			"CSV export_id API",
			"export_id",
			"CSV export API contract uses export_id as the response key and preserves the row value.",
		),
	},
	{
		id: "retry-rule",
		category: "项目约定",
		request:
			"Fix the default worker retry count using the approved project convention. Keep explicit zero overrides.",
		files: { "app.py": "def evaluate(count=None):\n    return 1 if count is None else count\n" },
		publicCheck: "evaluate(0) == 0",
		edits: [edit("return 1 if", "return 4 if")],
		hidden: suite("evaluate() == 4", "evaluate(0) == 0"),
		memory: fact(
			"worker retry convention",
			"RETRY_DEFAULT_4",
			"The worker retry convention RETRY_DEFAULT_4 is four retries when no override is supplied.",
		),
	},
	{
		id: "invoice",
		category: "多文件修改",
		request: "Tax is represented in cents. Rename tax() to tax_cents() and update the invoice caller to use it.",
		files: {
			"app.py": "from pricing import tax\n\ndef evaluate(cents):\n    return cents + tax(cents)\n",
			"pricing.py": "def tax(cents):\n    return cents // 10\n",
		},
		publicCheck: "evaluate(100) == 110",
		edits: [
			edit("def tax(", "def tax_cents(", "pricing.py"),
			edit(
				"from pricing import tax\n\ndef evaluate(cents):\n    return cents + tax(cents)",
				"from pricing import tax_cents\n\ndef evaluate(cents):\n    return cents + tax_cents(cents)",
			),
		],
		hidden: suite("__import__('pricing').tax_cents(100) == 10", "evaluate(0) == 0"),
	},
	{
		id: "locale",
		category: "跨语言文档",
		request:
			"Use the language fallback specified by the Chinese locale_token contract. Preserve supplied locale names.",
		files: { "app.py": "def evaluate(locale_token=None):\n    return locale_token or 'en'\n" },
		publicCheck: "evaluate('es') == 'es'",
		edits: [edit("or 'en'", "or 'zh-Hant'")],
		hidden: suite("evaluate() == 'zh-Hant'", "evaluate('es') == 'es'"),
		doc: fact(
			"locale_token fallback",
			"zh-Hant",
			"locale_token 为空时，回退语言必须使用 zh-Hant。输入已有语言代码时保持原值。",
		),
	},
	{
		id: "resume",
		category: "失败与恢复",
		request: "Fix the deduplication worker so first-observed order is preserved. Deduplicate without sorting.",
		files: { "app.py": "def evaluate(items):\n    return sorted(set(items))\n" },
		publicCheck: "evaluate([3, 1, 3]) == [3, 1]",
		edits: [edit("sorted(set(items))", "list(dict.fromkeys(items))")],
		hidden: suite("evaluate([6, 2, 6, 3]) == [6, 2, 3]", "evaluate([]) == []"),
		resume: true,
	},
	{
		id: "unknown",
		category: "文档无答案",
		request:
			"Find whether the credentials manual prescribes a weekend lease duration. If it is unspecified, report missing evidence and leave the code unchanged.",
		files: { "app.py": "def evaluate(duration=120):\n    return duration\n" },
		publicCheck: "evaluate(17) == 17",
		edits: [],
		hidden: suite("evaluate() == 120", "evaluate(17) == 17"),
		abstain: true,
	},
	{
		id: "delivery",
		category: "文档换版与联合线索",
		request:
			"Update the delivery protocol using the current partner transport documentation and the verified project queue convention.",
		files: { "app.py": "def evaluate(value):\n    return {'key_v1': value, 'lane': 'old'}\n" },
		publicCheck: "10 in evaluate(10).values()",
		edits: [edit("'key_v1': value, 'lane': 'old'", "'delivery_id': value, 'lane': 'verified'")],
		hidden: suite("evaluate(5) == {'delivery_id': 5, 'lane': 'verified'}", "list(evaluate(0).values())[0] == 0"),
		memory: fact(
			"verified delivery lane",
			"LANE_VERIFIED",
			"Delivery queue convention LANE_VERIFIED uses the verified lane.",
		),
		doc: fact(
			"delivery_id transport",
			"delivery_id",
			"Current transport contract uses delivery_id with the original payload.",
		),
		retired: "Previous delivery protocol used key_v1. REVOKED_DELIVERY_289 is historical and invalid.",
	},
];

const output = resolve(process.argv[2] ?? ".artifacts/agent-evaluation/results.json");
const selected = process.argv[3];
const e17Live = selected === "deepseek-e17";
const e17Replay = selected === "e17-replay";
const e17Independent = selected === "e17-independent";
const e18Replay = selected === "e18-replay";
const e18Independent = selected === "e18-independent";
const e19Preflight = selected === "e19-preflight";
const e19Live = selected === "deepseek-e19";
const e19 = e19Preflight || e19Live;
const pairedLive = e17Live || e19Live;
const e18 = e18Replay || e18Independent || e19;
const e17 = e17Live || e17Replay || e17Independent || e18;
const e17Root = resolve(".artifacts/agent-evaluation/e17");
const e18Output = resolve(".artifacts/agent-evaluation/e18/results.json");
const e19Root = resolve(".artifacts/agent-evaluation/e19");
const e19Output = resolve(e19Root, "results.json");
const e19Approval = process.env.PI_E19_APPROVAL;
const e19Cap = process.env.PI_E19_LIMIT_USD;
if (e19Live) {
	assert(e19Approval && /^[a-f0-9]{64}$/u.test(e19Approval), "E19 requires separate paid approval of the frozen experiment");
	assert(e19Cap && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/u.test(e19Cap) && Number(e19Cap) > 0, "E19 requires an explicit positive global USD cap");
	assert(process.argv.length === 4, "E19 paid scope, order and paired Token limits are fixed");
}
const e17Cells = new Set(["retry-rule:B", "delivery:D", "export-api:C", "unknown:C"]);
const e17Tiers = [20_000, 25_000] as const;
const e17GlobalLimitUsd = 0.12;
const e17Approved = process.env.PI_E17_APPROVAL;
if (e17Live) {
	assert(
		e17Approved && /^[a-f0-9]{64}$/u.test(e17Approved),
		"E17 requires a separate paid approval and the frozen source digest",
	);
	assert(process.argv.length === 4, "E17 paid scope and order are fixed");
}
const e16 = selected === "e16-replay" || selected === "e16-matrix" || selected === "e16-independent";
const tokenTiers = new Set([20_000, 25_000, 30_000]);
const tokenTier = e16 || e17Replay || e17Independent || (e18 && !e19) ? Number(process.argv[4]) : LIMITS.maxTotalTokens;
if (e17Replay || e17Independent || (e18 && !e19))
	assert(
		e17Tiers.some((tier) => tier === tokenTier),
		"E17 replay requires 20000 or 25000 Token",
	);
const runtimeOnly = e16 && process.argv[5] === "runtime-only";
if (e16) {
	assert(tokenTiers.has(tokenTier), "E16 requires a frozen 20000, 25000, or 30000 Token tier");
	assert(process.argv[5] === undefined || runtimeOnly, "Unknown E16 comparison policy");
}
const e16Output = resolve(".artifacts/agent-evaluation/e16/results.json");
const e14Matrix = selected === "e14" || selected === "e16-matrix";
const e14Replay = selected === "e14-replay" || selected === "e16-replay" || e17Replay || e18Replay;
const e14Retry = selected === "e14-retry-edited";
const e15 = selected === "e15" || selected === "e16-independent" || e17Independent || e18Independent || e19;
const e15Freeze = selected === "e15-freeze";
const e15Validate = selected === "e15-validate";
const enhancedWorkflow = e14Matrix || e14Replay || e14Retry || e15 || e17Live;
const workflowOutput = resolve(".artifacts/agent-evaluation/e14-e15/results.json");
const taskSet = e15 || e15Freeze || e15Validate ? independentTasks : frozenTasks;
const smoke = selected === "deepseek-smoke";
const e12Pilot = selected === "deepseek-e12-pilot";
const e12Live = selected === "deepseek-e12" || e12Pilot;
const e12Baseline = selected === "e12-baseline";
const e12PostEditReplay = selected === "e12-post-edit";
const e12PostEditMatrix = selected === "e12-post-edit-matrix";
const e12Matrix = selected === "e12" || e12Baseline || e12PostEditMatrix;
const e12Replay = selected === "e12-budget";
const e12Probe = selected === "e12-context-probe";
const e12Output = resolve(".artifacts/agent-evaluation/e10-e12/results.json");
const live = selected === "deepseek" || smoke || e12Live || pairedLive;
const budgetReplay = selected === "e9-budget" || e12Replay || e12PostEditReplay;
const postEditOutput = resolve(".artifacts/agent-evaluation/e12-post-edit/results.json");
const e9Pilot = selected === "e9-resume-pilot";
const e9Matrix = selected === "e9" || e9Pilot || e12Matrix || e14Matrix || e15;
const e12Retry = selected === "e12-retry-edited";
const retryAfterEdit = selected === "e9-retry-edited" || e12Retry || e14Retry;
const e9Retry = selected === "e9-retry" || retryAfterEdit;
const e9Worker = selected === "e9-worker";
const e9Output = resolve(".artifacts/agent-evaluation/e6-2-e9/results.json");
const scopeProbe = selected === "e6-scope";
const replayTools = selected === "e6" || scopeProbe || e9Matrix || e9Retry || e12Probe;
const e6Output = resolve(".artifacts/agent-evaluation/e6-results.json");
const e6Limits = { ...LIMITS, minOutputTokensPerRequest: 128 };
const cellLimits = e16 || e17 ? { ...e6Limits, maxTotalTokens: tokenTier } : e6Limits;
const discoveryTools = ["ls", "find", "grep", "read", "edit", "run_tests"] as const;
const scopeCanary = "E6_PRIVATE_GRADING_FIXTURE_896";
const archivedLiveOutput = resolve(".artifacts/agent-evaluation/deepseek-flash.json");
const liveOutput = e19Live
	? resolve(e19Root, "paid.json")
	: e17Live
	? resolve(e17Root, "paid.json")
	: e12Live
		? resolve(dirname(e12Output), e12Pilot ? "deepseek-pilot.json" : "deepseek-full.json")
		: smoke
			? resolve(dirname(e9Output), "deepseek-smoke.json")
			: archivedLiveOutput;
const modelId = live || e17 ? FLASH : MODEL;
let flashKey: string | undefined;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshot = () => process.memoryUsage.rss();
const percentile = (numbers: number[], q: number) =>
	[...numbers].sort((a, b) => a - b)[Math.ceil(numbers.length * q) - 1] ?? null;
const groups = taskSet.flatMap((task) => PROFILES.map((profile) => ({ task, profile })));
const seed = "pi-agent-eval-e1-e5-v1";
groups.sort((a, b) =>
	hash(`${seed}/${a.task.id}/${a.profile.id}`).localeCompare(hash(`${seed}/${b.task.id}/${b.profile.id}`)),
);

type Profile = (typeof PROFILES)[number];
type Call = { name: string; args: Record<string, unknown> };
type VectorFault = {
	kind: "qdrant" | "e5";
	lab: Awaited<ReturnType<typeof startVectorLab>>;
	armed: boolean;
	resources?: Record<string, unknown>;
};
const defaults = {
	memory: fact(
		"deployment convention",
		"PROJECT_APPROVED_627",
		"Deployment convention PROJECT_APPROVED_627 requires an approved change ticket.",
	),
	doc: fact(
		"credentials manual",
		"DOC_APPROVED_527",
		"Credentials manual DOC_APPROVED_527 requires the dispatcher to keep its key in an administrator-managed secret store.",
	),
};
const approvedDoc = "partner.md";
const testFile = "test_public.py";

const e19BaseDigest = "6b4b2b0a6fa23bb1c3d095bd0ef0fb7325021acdf18f8c312aa8850ffd704f69";
const e19TaskDigest = "d8b13112115bbb19cfd4efbc6ad495397f3af4f575bd020bf88467230f2dcab5";
const e19Profile = (task: Task) => PROFILES.find(
	(profile) => profile.memory === !!task.memory && profile.rag === !!(task.doc || task.referenceOnly),
)!;

function freezeE19Experiment(plan: { task: Task; profile: Profile; tier: number }[]) {
	const parent = JSON.parse(readFileSync("F:/p18-9f44/.artifacts/agent-evaluation/e18/results.json", "utf8"));
	assert.equal(parent.freeze.digest, e19BaseDigest);
	const base = parent.freeze.files as Record<string, string>;
	assert.equal(hash(JSON.stringify(base)), e19BaseDigest);
	const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		encoding: "utf8",
	});
	const files = [...new Set(paths.split("\0").filter((file) => file && existsSync(file)))].sort();
	assert.deepEqual(files, Object.keys(base).sort(), "E19 file list differs from E18");
	const hashes = Object.fromEntries(
		files.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]),
	);
	const harness = "packages/pi-enhanced/benchmarks/real-agent/agent-evaluation.ts";
	assert.deepEqual(files.filter((file) => hashes[file] !== base[file]), [harness], "Only the E19 evaluation entry can differ");
	assert.equal(hash(JSON.stringify(taskSet)), e19TaskDigest);
	assert.equal(plan.length, 18);
	const experiment = {
		candidateSha256: e19BaseDigest,
		evaluationSha256: hashes[harness],
		treeSha256: hash(JSON.stringify(hashes)),
		manifestSha256: e19TaskDigest,
		plan: plan.map(({ task, profile, tier }) => ({
			task: task.id,
			profile: profile.id,
			tier,
			requires: {
				memory: !!task.memory, rag: !!task.doc, approvedReference: !!task.referenceOnly,
				resume: !!task.resume, readOnly: !!task.abstain,
			},
		})),
		allowedTools: discoveryTools.concat(),
		sourceTools: ["enhanced_memory_search", "enhanced_docs_search", "enhanced_docs_read"],
		model: FLASH,
		modelOptions: { temperature: 0, thinking: "disabled" },
		limits: { ...e6Limits, maxTotalTokens: e17Tiers, maxSeconds: 180 },
		pricing: FLASH_PRICING,
		grading: { image: PYTEST, publicTarget: testFile, independent: ["contract", "regression"], hiddenWorkspace: "separate" },
	};
	return { ...experiment, digest: hash(JSON.stringify(experiment)) };
}

const shortDescriptions: Record<string, string> = {
	ls: "List project directory entries.",
	find: "Find project files by glob.",
	grep: "Search project text.",
	read: "Read a project file. Offset is 1-indexed.",
	edit: "Apply exact oldText/newText replacements to one source file.",
	run_tests: "Run approved pytest targets in Docker. At most three calls.",
	enhanced_memory_search: "Search authorized project memory.",
	enhanced_docs_search: "Search authorized documents. Check candidate passages before citing.",
	enhanced_docs_read: "Read an authorized chunk by ID.",
};

function stripSchemaAnnotations(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const {
		description: _description,
		title: _title,
		examples: _examples,
		...keywords
	} = schema as Record<string, unknown>;
	for (const key of ["properties", "$defs", "patternProperties"]) {
		const entries = keywords[key];
		if (entries && typeof entries === "object") {
			keywords[key] = Object.fromEntries(
				Object.entries(entries).map(([name, value]) => [name, stripSchemaAnnotations(value)]),
			);
		}
	}
	for (const key of ["items", "additionalProperties", "not", "contains"]) {
		if (key in keywords) keywords[key] = stripSchemaAnnotations(keywords[key]);
	}
	for (const key of ["anyOf", "allOf", "oneOf", "prefixItems"]) {
		const entries = keywords[key];
		if (Array.isArray(entries)) keywords[key] = entries.map(stripSchemaAnnotations);
	}
	return keywords;
}

function projectEvaluationTools(payload: unknown) {
	if (!payload || typeof payload !== "object" || !("tools" in payload) || !Array.isArray(payload.tools))
		return payload;
	return {
		...payload,
		tools: payload.tools.map((tool) => {
			const fn = tool?.function;
			const description = typeof fn?.name === "string" && shortDescriptions[fn.name];
			return description
				? {
						...tool,
						function: {
							...fn,
							description,
							parameters: stripSchemaAnnotations(fn.parameters),
						},
					}
				: tool;
		}),
	};
}

type ContextProjection = {
	before: ReturnType<typeof measureEvaluationContext>;
	after: ReturnType<typeof measureEvaluationContext>;
	context?: ReturnType<typeof applyEvaluationContextBudget>["observation"];
	runtimeDuplicateReads?: number;
	runtimeWorkflow?: true;
};

class EvaluationMemoryProvider extends LocalMemoryProvider {
	override async search(query: ProviderSearchQuery) {
		const exact = await super.search(query);
		const terms = query.text.trim().split(/\s+/u);
		if (
			exact.length ||
			query.preferenceKey !== undefined ||
			terms.length < 3 ||
			terms.length > 12 ||
			terms.some((term) => !/^[\p{L}\p{N}_-]+$/u.test(term))
		)
			return exact;
		const alternatives = new Set([
			terms.slice(-3).join(" "),
			terms.slice(0, 3).join(" "),
			terms.slice(1, 3).join(" "),
			terms.slice(-2).join(" "),
		]);
		alternatives.delete(terms.join(" "));
		for (const text of alternatives) {
			const found = await super.search({ ...query, text });
			if (found.length) return found;
		}
		return exact;
	}
}

async function openEvaluationMemory(scope: ProjectScope) {
	ensureProjectStorage(scope);
	return new MemoryService(scope, new EvaluationMemoryProvider(scope));
}

type RecordedTurn = { inputTokens: number; outputTokens: number; modelStopReason: string };

type ReplayChunk = {
	chunkId: string;
	documentVersion: number;
	source: { path: string; lineStart?: number; lineEnd?: number };
	accessPolicy?: string;
};

function replayChunkLocation(chunk: ReplayChunk) {
	return JSON.stringify([chunk.documentVersion, chunk.source.path, chunk.source.lineStart, chunk.source.lineEnd]);
}

function verifyE17Candidate(manifestSha256: string, approval: string): void {
	const evidence = JSON.parse(readFileSync(resolve(e17Root, "results.json"), "utf8"));
	const candidate = evidence.candidate;
	assert.equal(candidate?.digest, approval, "E17 approval is for another source snapshot");
	assert.equal(candidate?.manifestSha256, manifestSha256);
	const listing = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		encoding: "utf8",
	});
	const files = [...new Set(listing.split("\0").filter((file) => file && existsSync(file)))].sort();
	assert.deepEqual(files, Object.keys(candidate.files).sort(), "E17 candidate file set changed");
	const hashes = Object.fromEntries(
		files.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]),
	);
	assert.equal(hash(JSON.stringify(hashes)), approval, "E17 candidate contents changed");
	for (const tier of e17Tiers) {
		const replay = evidence.preflight?.[`e17-replay:${tier}`]?.evaluated;
		assert(
			Array.isArray(replay) && replay.length === 5 && replay.every((row) => !row.violation),
			"E17 offline replay incomplete",
		);
		const heldOut = evidence.preflight?.[`e17-independent:${tier}`]?.evaluated;
		assert(
			Array.isArray(heldOut) && heldOut.length === 36 && heldOut.every((row) => !row.violation),
			"E17 independent preflight incomplete",
		);
	}
	assert(evidence.preflight["e17-replay:25000"].evaluated.every((row: { success: boolean }) => row.success));
	assert(
		evidence.engineering?.testCounts?.windows?.failed === 0 && evidence.engineering?.testCounts?.linux?.failed === 0,
	);
	assert(evidence.verification?.wire?.restrictedBytes === 0);
	assert.equal(evidence.verification?.paidPhase, "awaiting-separate-authorization");
	assert(!existsSync(liveOutput), "This E17 paid batch already has a journal");
}

function workflowReplay(task: Task, profile: Profile) {
	const fromPaid = e18Replay && task.abstain;
	const path = fromPaid
		? resolve(process.env.PI_E18_E17_LEDGER ?? "")
		: e17Replay || e18Replay
		? resolve(process.env.PI_E17_HISTORY_DIR ?? dirname(e12Output), "deepseek-full.json")
		: resolve(dirname(e12Output), "deepseek-full.json");
	if (e17Replay || e18Replay)
		assert.equal(
			createHash("sha256").update(readFileSync(path)).digest("hex"),
			fromPaid
				? "a14946d93db2474268cac6c2c0c7f53ba74a93ac64df0020778dd07a66c2e8b6"
				: "d16f7be8e46f3d0d09946e487d43e8e04e6ce3a2c056de5494ac31487044091a",
			"Archived trace digest changed",
		);
	const archived = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(archived.manifestSha256, hash(JSON.stringify(frozenTasks)));
	const row = archived.evaluated.find(
		(item: { task: string; profile: string; tokenTier?: number }) =>
			item.task === task.id && item.profile === profile.id && (!fromPaid || item.tokenTier === tokenTier),
	);
	assert(row && !row.success);
	const ids: string[] = row.events
		.filter((x: { phase: string }) => x.phase === "tool_execution_start")
		.map((x: { toolCallId: string }) => x.toolCallId);
	const outcomes = row.budget.requestOutcomes as RecordedTurn[];
	const usage = outcomes.filter((turn) => turn.inputTokens !== null);
	const requests: { latestTool?: string }[] = row.requests.filter(
		(_: unknown, i: number) => outcomes[i]?.inputTokens !== null,
	);
	const plan: Call[][] = [];
	let consumed = 0;
	for (const [i, turn] of usage.entries()) {
		if (turn.modelStopReason !== "tool_calls") {
			if (task.resume || task.abstain) plan.push([]);
			continue;
		}
		const next = requests[i + 1];
		const end = next?.latestTool ? ids.indexOf(next.latestTool) + 1 : ids.length;
		assert(end > consumed);
		plan.push(row.calls.slice(consumed, end));
		consumed = end;
	}
	assert.equal(consumed, row.calls.length);
	const archivedChunks = new Map<string, string>();
	for (const retrieval of row.retrievals as { kind: string; sources: ReplayChunk[] }[]) {
		if (retrieval.kind !== "rag") continue;
		for (const chunk of retrieval.sources) archivedChunks.set(chunk.chunkId, replayChunkLocation(chunk));
	}
	return { plan, usage, archivedChunks };
}

function historicalBudgetReplay(task: Task, profile: Profile) {
	const path = e12PostEditReplay
		? resolve(dirname(e12Output), "deepseek-full.json")
		: e12Replay
			? resolve(dirname(e9Output), "deepseek-full.json")
			: resolve(".artifacts/agent-evaluation/deepseek-smoke.json");
	const archived = JSON.parse(readFileSync(path, "utf8"));
	if (e12PostEditReplay) assert.equal(archived.manifestSha256, hash(JSON.stringify(taskSet)));
	const row = archived.evaluated.find(
		(item: { task: string; profile: string }) => item.task === task.id && item.profile === profile.id,
	);
	assert(row && row.reason === "budget");
	const callIds: string[] = row.events
		.filter((event: { phase: string }) => event.phase === "tool_execution_start")
		.map((event: { toolCallId: string }) => event.toolCallId);
	let first = 0;
	const plan: Call[][] = [];
	const requestOutcomes = row.budget.requestOutcomes as { inputTokens: number | null; outputTokens: number | null }[];
	const accepted = row.requests.filter((_request: unknown, i: number) => requestOutcomes[i]?.inputTokens !== null);
	for (const request of accepted.slice(1)) {
		const next = callIds.indexOf(request.latestTool);
		assert(next >= first);
		plan.push(row.calls.slice(first, next + 1));
		first = next + 1;
	}
	if (first < row.calls.length) plan.push(row.calls.slice(first));
	if (!plan.flat().some((call) => call.name === "run_tests"))
		plan.push([{ name: "run_tests", args: { targets: [testFile] } }]);
	// Model output is scripted; preserve the captured Usage up through the prior denial.
	const usage = requestOutcomes.filter(
		(q): q is { inputTokens: number; outputTokens: number } => q.inputTokens !== null && q.outputTokens !== null,
	);
	assert(usage.length > 0);
	return { plan, usage };
}

function inspectWire(body: Record<string, unknown>) {
	const messages = body.messages as EvaluationWireMessage[];
	return {
		messages,
		text: JSON.stringify(messages),
		systems: messages.filter((m) => m.role === "system").map((m) => m.content),
		last: messages.findLast((m) => m.role === "tool"),
	};
}

function hybridFaultExtension(fault: VectorFault, workspace: string, projectId: string, filename: string) {
	return (pi: ExtensionAPI) => {
		let service: KnowledgeService | undefined;
		let sessionId: string | undefined;
		const access = (ctx: ExtensionContext) => {
			if (
				!service ||
				!ctx.isProjectTrusted() ||
				ctx.cwd !== workspace ||
				ctx.sessionManager.getSessionId() !== sessionId
			)
				return;
			return service;
		};
		pi.on("session_start", (_event, ctx) => {
			sessionId = ctx.sessionManager.getSessionId();
			const { lab } = fault;
			service = new KnowledgeService({
				projectId,
				filename,
				mode: "hybrid",
				vectors: {
					collection: lab.collection,
					index: openDocumentIndex(lab.endpoint, lab.embedding.model, lab.collection),
					embedding: {
						model: lab.embedding.model,
						encode(texts, purpose) {
							if (fault.armed && fault.kind === "e5")
								throw new MemoryWorkerError("worker-unavailable", "Owned offline E5 stopped");
							return lab.embedding.encode(texts, purpose);
						},
					},
				},
			});
			registerKnowledgePageAccess(ctx, () => access(ctx));
			registerKnowledgeTools(pi, true, (toolCtx) => {
				const active = access(toolCtx);
				if (!active) throw new Error("Evaluation Knowledge scope is closed");
				return active;
			});
		});
		pi.on("tool_result", (event) => {
			if (isKnowledgeTool(event.toolName))
				return storeKnowledgeToolReferences({ ...event, toolName: event.toolName });
		});
		pi.on("model_request_policy", (event, ctx) => projectKnowledgeRequest(event, ctx, () => access(ctx)));
		pi.on("session_shutdown", async () => {
			const current = service;
			service = undefined;
			await current?.close();
		});
		pi.registerCommand("enhanced-docs", {
			description: "Evaluate the production Knowledge command",
			handler: async (args, ctx) => {
				const active = access(ctx);
				if (!active) throw new Error("Evaluation Knowledge scope is closed");
				await runKnowledgeCommand(args, ctx, active);
			},
		});
	};
}

async function gradeIndependent(task: Task, grading: string, owned: Task["files"]) {
	const verdicts: Record<string, unknown>[] = [];
	for (const [path, value] of Object.entries(owned)) writeFileSync(join(grading, path), value);
	for (const name of ["contract", "regression"]) {
		// Run each assertion separately so a malformed patch cannot hide a regression count.
		writeFileSync(join(grading, "test_hidden.py"), task.hidden);
		const execute = createPytestExecutor(sandboxConfigForTesting({ workspace: grading }), {
			image: PYTEST,
			files: [...Object.keys(owned), "test_hidden.py"],
			tests: ["test_hidden.py"],
			timeoutMs: 12_000,
		});
		const verdict = await execute([`test_hidden.py::test_${name}`]);
		verdicts.push({ kind: "independent", check: name, ...verdict });
	}
	return verdicts;
}

type ContinuationCheck = ReturnType<typeof assessEvaluationContinuation> & { validationReservation?: number };
type EvaluationSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type SessionListener = Parameters<EvaluationSession["subscribe"]>[0];
type EvaluationSessionOptions = {
	root: string;
	manager: SessionManager;
	url: string;
	phase: string;
	task: Task;
	inputFiles: Task["files"];
	notes: string[];
	audits: string[];
	compact: boolean;
	projections: ContextProjection[];
	vectorFault?: VectorFault;
	gateway?: RunningBudgetGateway;
	postEditBudget?: boolean;
	workflow?: boolean;
	runtimeProjection?: boolean;
	flashCompatibility?: boolean;
	productionOnly?: boolean;
	productionBudget?: boolean;
	verifyReadOnly?: () => boolean;
	continuations?: ContinuationCheck[];
	onEvent?: SessionListener;
};

async function openEvaluationSession({
	root,
	manager,
	url,
	phase,
	task,
	inputFiles,
	compact,
	notes,
	audits,
	projections,
	vectorFault,
	gateway,
	postEditBudget,
	workflow,
	runtimeProjection,
	flashCompatibility,
	productionOnly,
	productionBudget,
	verifyReadOnly,
	continuations,
	onEvent,
}: EvaluationSessionOptions) {
	const workspace = join(root, "p");
	const agentDir = join(root, "a");
	const scope = createProjectScope({ cwd: workspace, agentDir });
	const knowledgeDb = join(agentDir, "pi-enhanced", "knowledge", "projects", scope.projectId, "knowledge.sqlite3");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false, provider: { maxRetries: live || e9Retry || flashCompatibility ? 1 : 0 } },
	});
	settingsManager.setProjectTrusted(true);
	const audit = join(root, `sandbox-${phase}.json`);
	audits.push(audit);
	const injectedText = new Set<string>();
	const requestParts = (payload: Record<string, unknown>) =>
		measureEvaluationContext(
			payload,
			(text) => text === task.request || text.startsWith(`${task.request}\n\n`) || text === RESUME_PROMPT,
			injectedText,
		);
	let runtimeDecision: ContextProjection["context"];
	const loader = new DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager,
		noExtensions: true,
		systemPrompt:
			workflow && task.abstain
				? `${SYSTEM} This is a read-only task. Verify the unchanged workspace with the approved pytest.${productionBudget ? " Omit targets in run_tests to use the approved baseline." : ""}`
				: SYSTEM,
		extensionFactories: [
			createTaskManagerExtension({ agentDir }),
			createMemoryExtension({
				agentDir,
				...(workflow && !productionOnly && !productionBudget ? { openBackend: openEvaluationMemory } : {}),
			}),
			vectorFault
				? hybridFaultExtension(vectorFault, workspace, scope.projectId, knowledgeDb)
				: createKnowledgeExtension({ agentDir }),
			createContextExtension({
				agentDir,
				...(productionBudget && gateway?.preview
					? {
							requestBudget: {
								preview: gateway.preview,
								status: gateway.status,
								readOnly: task.abstain,
								verifyReadOnly,
								onProjection: ({ observation }) => { runtimeDecision = observation; },
								onContinuation: (decision) => continuations?.push(decision),
							},
						}
					: {}),
				onView(_before, after) {
					injectedText.clear();
					for (const message of after) {
						if (message.role === "custom" && message.customType.startsWith("pi-enhanced-context-")) {
							const text = getMessageText(message);
							if (text) injectedText.add(text);
						}
					}
				},
			}),
			createSandboxExtension(
				(cwd) =>
					sandboxConfigForTesting({
						workspace: cwd,
						runId: `ae-${randomUUID().slice(0, 10)}`,
						containerOwner: randomUUID(),
						auditReportPath: audit,
						readonlyModuleTools: true,
						readonlyKnowledgeTools: true,
					}),
				undefined,
				{ image: PYTEST, files: Object.keys(inputFiles), tests: [testFile] },
			),
			(pi) => {
				let successfulEditId: string | undefined;
				let publicPassId: string | undefined;
				let restriction: NonNullable<ContextProjection["context"]>["mode"] = "full";
				let validationFloor: Record<string, unknown> | undefined;
				pi.on("tool_result", (event) => {
					successfulEditId =
						postEditBudget && event.toolName === "edit" && !event.isError && !event.parentToolCallId
							? event.toolCallId
							: undefined;
					publicPassId =
						workflow && event.toolName === "run_tests" && !event.isError && !event.parentToolCallId
							? event.toolCallId
							: undefined;
				});
				pi.on("before_provider_request", ({ payload }) => {
					if (
						!(
							workflow ||
							live ||
							e9Matrix ||
							e9Retry ||
							budgetReplay ||
							e12Probe ||
							selected === "e9-restore-child"
						) ||
						!payload ||
						typeof payload !== "object"
					)
						return;
					const before = requestParts(payload as Record<string, unknown>);
					const projected = (compact && !productionOnly && !productionBudget ? projectEvaluationTools(payload) : payload) as Record<
						string,
						unknown
					>;
					const latest = Array.isArray(projected.messages) ? projected.messages.at(-1) : undefined;
					if (workflow && !productionBudget && task.abstain && Array.isArray(projected.tools)) {
						projected.tools = projected.tools.filter((tool) => tool.function?.name !== "edit");
					}
					if (workflow && !productionBudget && Array.isArray(projected.messages) && Array.isArray(projected.tools)) {
						const tests = projected.tools.filter((tool) => tool?.function?.name === "run_tests");
						if (tests.length === 1) {
							const { messages, ...rest } = projected;
							validationFloor = {
								...rest,
								tools: tests,
								messages: (messages as EvaluationWireMessage[]).filter(
									({ role }) => role === "system" || role === "user",
								),
							};
						}
					}
					if (live || e12PostEditReplay || flashCompatibility) {
						projected.thinking = { type: "disabled" };
						projected.temperature = 0;
						delete projected.reasoning_effort;
					}
					const decision = !productionBudget && gateway?.preview
						? applyEvaluationContextBudget(
								projected,
								gateway.preview,
								successfulEditId,
								workflow
									? {
											publicPassId,
											runtimeProjection,
											readOnly: task.abstain,
											verifyReadOnly: task.abstain && latest?.role === "user" && verifyReadOnly?.(),
										}
									: undefined,
							)
						: undefined;
					restriction = decision?.observation.mode ?? "full";
					const outgoing = decision?.selected ?? projected;
					projections.push({
						before,
						after: requestParts(outgoing),
						...(runtimeProjection && Array.isArray(outgoing.messages)
							? {
									runtimeDuplicateReads: outgoing.messages.filter(
										(message: EvaluationWireMessage) => message.content === REPEATED_WORKSPACE_READ,
									).length,
								}
							: {}),
						...(decision || runtimeDecision ? { context: decision?.observation ?? runtimeDecision } : {}),
						...(runtimeDecision ? { runtimeWorkflow: true as const } : {}),
					});
					runtimeDecision = undefined;
					return outgoing;
				});
				pi.on("tool_call", (event) => {
					if (workflow && restriction === "text-closeout")
						return { block: true, reason: "The closing turn only permits a text response." };
					if (restriction === "test-only" && event.toolName !== "run_tests")
						return { block: true, reason: "This budget-limited turn only permits the approved pytest." };
					if (event.toolName === "edit") {
						if (workflow && task.abstain) return { block: true, reason: "The approved task is read-only" };
						const inputPath = event.input.path;
						if (typeof inputPath !== "string") return { block: true, reason: "Edit requires a path" };
						const path = relative(workspace, resolve(workspace, inputPath)).replaceAll("\\", "/");
						if (!Object.hasOwn(task.files, path))
							return { block: true, reason: "Only business source files may be edited in this evaluation" };
					}
					if (productionBudget || !gateway?.preview || (event.toolName !== "edit" && event.toolName !== "run_tests")) return;
					const decision: ContinuationCheck = assessEvaluationContinuation(
						event.toolName,
						flashCompatibility ? FLASH : modelId,
						gateway.status(),
						gateway.preview,
					);
					if (event.toolName === "edit" && validationFloor && !decision.blocked) {
						const minimum = gateway.preview(validationFloor);
						decision.validationReservation = minimum.diagnostics.candidateReservedTokens;
						if (minimum.denial) {
							decision.denial = minimum.denial;
							decision.blocked = true;
							decision.minimumReservation = minimum.diagnostics.candidateReservedTokens;
						}
					}
					continuations?.push(decision);
					if (decision.blocked)
						return {
							block: true,
							reason: `Edit blocked before writing: ${decision.denial}. Testing and final response need remaining model budget.`,
						};
				});
			},
		],
	});
	await loader.reload();
	const auth = AuthStorage.inMemory();
	const registry = await createInMemoryModelRegistry(auth);
	const model = {
		...getModel("openai", MODEL),
		id: flashCompatibility ? FLASH : modelId,
		name: live || flashCompatibility ? "DeepSeek Flash" : "GPT-4o stub",
		maxTokens: LIMITS.maxOutputTokensPerRequest,
		api: "openai-completions" as const,
		baseUrl: `${url}/v1`,
		provider: "evaluation",
	};
	registry.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "agent-evaluation-client",
		models: [model],
	});
	const { session } = await createAgentSession({
		cwd: workspace,
		agentDir,
		settingsManager,
		sessionManager: manager,
		resourceLoader: loader,
		modelRuntime: getModelRuntime(registry),
		model,
		tools: [...discoveryTools, "enhanced_memory_search", "enhanced_docs_search", "enhanced_docs_read"],
	});
	if (onEvent) session.subscribe(onEvent);
	await session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({ notify: (text) => notes.push(text), confirm: async () => true }),
	});
	return session;
}
async function invokeEvaluationTask(session: EvaluationSession, notes: string[], cmd: string, args: string) {
	const noteLines = notes.length;
	await session.prompt(`/${cmd} ${args}`);
	assert(notes.length > noteLines, `No result from ${cmd}`);
	const note = notes.at(-1)!;
	assert(note.startsWith("{"), `${cmd}: ${note.split(" ", 1)[0]}`);
	return JSON.parse(note) as TaskSnapshot;
}

type RestoreProbe = {
	file: string;
	task: string;
	upstream: string;
	runId: string;
	taskId: string;
	revision: number;
	checkpointId: string;
	deadline: number;
	requestsStarted: number;
	actualTotalTokens: number;
	contextBudget?: boolean;
	postEditBudget?: boolean;
	workflow?: boolean;
	cellBudget?: number;
	flashCompatibility?: boolean;
	runtimeOnly?: boolean;
	productionBudget?: boolean;
};

async function restoreProbe(stateFile: string) {
	const root = dirname(stateFile);
	const state = JSON.parse(readFileSync(stateFile, "utf8")) as RestoreProbe;
	assert(state.cellBudget === undefined || tokenTiers.has(state.cellBudget));
	assert(/^http:\/\/127\.0\.0\.1:\d+$/u.test(state.upstream), "Only loopback recovery is permitted");
	const task = [...frozenTasks, ...independentTasks].find(({ id, resume }) => id === state.task && resume);
	assert(task);
	const workspace = join(root, "p");
	const agentDir = join(root, "a");
	const { databasePath } = createTaskStorageScope(createProjectScope({ cwd: workspace, agentDir }), agentDir);
	const notes: string[] = [];
	const audits: string[] = [];
	const events: { toolName: string; toolCallId: string; phase: string; isError?: boolean }[] = [];
	const testRuns: unknown[] = [];
	const projections: ContextProjection[] = [];
	const continuations: ContinuationCheck[] = [];
	const assistantStops: string[] = [];
	const budget = await startBudgetGateway({
		runId: state.runId,
		upstreamBaseUrl: state.upstream,
		upstreamApiKey: "mock-upstream-key",
		clientToken: "agent-evaluation-client",
		adminToken: "agent-evaluation-admin",
		allowedModel: state.flashCompatibility ? FLASH : MODEL,
		guardedClientRetry: state.flashCompatibility,
		limits: { ...e6Limits, maxTotalTokens: state.cellBudget ?? LIMITS.maxTotalTokens },
		pricing: state.cellBudget === undefined ? { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } : FLASH_PRICING,
		persistence: { databasePath, id: state.taskId, mode: "resume" },
	});
	let host: EvaluationSession | undefined;
	try {
		const before = budget.status();
		assert.equal(before.requestsStarted, state.requestsStarted);
		assert.equal(before.actualTotalTokens, state.actualTotalTokens);
		assert.equal(budget.deadlineAt, state.deadline);
		host = await openEvaluationSession({
			root,
			manager: SessionManager.open(state.file, undefined, workspace),
			url: budget.url,
			phase: "after",
			task,
			inputFiles: { ...task.files, [testFile]: "" },
			notes,
			audits,
			compact: true,
			projections,
			gateway: state.contextBudget && !state.runtimeOnly ? budget : undefined,
			postEditBudget: state.postEditBudget,
			workflow: state.workflow,
			runtimeProjection: state.cellBudget !== undefined,
			flashCompatibility: state.flashCompatibility,
			productionOnly: state.runtimeOnly,
			productionBudget: state.productionBudget,
			continuations,
			onEvent(event) {
				if (event.type === "message_end" && event.message.role === "assistant")
					assistantStops.push(event.message.stopReason);
				if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
					events.push({
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						phase: event.type,
						...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
					});
				}
				if (event.type === "tool_execution_end" && event.toolName === "run_tests")
					testRuns.push(JSON.parse(getMessageText(event.result)));
			},
		});
		const restored = await invokeEvaluationTask(host, notes, "enhanced-task-inspect", state.taskId);
		assert.equal(restored.lastCheckpoint?.checkpointId, state.checkpointId);
		assert.equal(restored.task.revision, state.revision);
		assert.equal(restored.task.status, "paused");
		const continuation =
			state.contextBudget && budget.preview
				? assessEvaluationContinuation(
						"restore",
						state.flashCompatibility ? FLASH : MODEL,
						budget.status(),
						budget.preview,
					)
				: undefined;
		if (continuation) continuations.push(continuation);
		if (!continuation?.blocked) {
			await invokeEvaluationTask(host, notes, "enhanced-task-resume", `${state.taskId} ${restored.task.revision}`);
			await invokeEvaluationTask(host, notes, "enhanced-task-step", `${state.taskId} work bind`);
			assert.equal(events.length, 0, "Restoring a Task must not execute tools");
			await host.prompt(RESUME_PROMPT);
		}
		return {
			pid: process.pid,
			requestCountAtRestore: before.requestsStarted,
			checkpointId: state.checkpointId,
			events,
			testRuns,
			projections,
			continuations,
			assistantStops,
			resumeSkipped: continuation?.blocked ? continuation.denial : undefined,
			audits,
			budget: budget.status(),
		};
	} finally {
		if (host) {
			await host.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			host.dispose();
		}
		await budget.close();
	}
}

async function evaluateCell(
	task: Task,
	profile: Profile,
	vectorFault?: VectorFault,
	injectFailedEdit = false,
	compact = enhancedWorkflow || live || e9Matrix || e9Retry || e12Probe,
	contextBudget = enhancedWorkflow || e12Live || (e12Matrix && !e12Baseline) || e12Probe || e12Retry,
	postEditBudget = contextBudget && !e12Replay,
	limits = cellLimits,
) {
	const started = performance.now();
	const cpuStart = process.cpuUsage();
	const root = mkdtempSync(join(tmpdir(), "ae-"));
	const workspace = join(root, "p"),
		agentDir = join(root, "a"),
		sources = join(root, "d"),
		grading = join(root, "g");
	for (const dir of [workspace, agentDir, sources, grading]) mkdirSync(dir);
	const runId = `${task.id}-${profile.id}-${randomUUID().slice(0, 8)}`;
	const sessionManager = SessionManager.create(workspace, join(root, "s"));
	const scope = createProjectScope({ cwd: workspace, agentDir });
	const knowledgeDb = join(agentDir, "pi-enhanced", "knowledge", "projects", scope.projectId, "knowledge.sqlite3");
	const memory = task.memory ?? defaults.memory,
		doc = task.doc ?? task.referenceOnly ?? defaults.doc;
	if (scopeProbe) writeFileSync(join(grading, "test_hidden.py"), `# ${scopeCanary}`);
	const inputFiles = {
		...task.files,
		[testFile]: `from app import evaluate\n\ndef test_public():\n    assert ${task.publicCheck}\n`,
	};
	for (const [name, body] of Object.entries(inputFiles)) writeFileSync(join(workspace, name), body);
	const hashes = Object.fromEntries(Object.entries(inputFiles).map(([name, body]) => [name, hash(body)]));
	const meta = {
		task: task.id,
		profile: profile.id,
		hashes,
		runId,
		...(e17 ? { tokenTier: limits.maxTotalTokens } : {}),
	};
	const retrievals: {
		kind: string;
		query: string;
		mode: unknown;
		sources: unknown;
		present: boolean;
		used: boolean;
		status?: string;
		toolCallId?: string;
	}[] = [];
	const calls: Call[] = [];
	const events: { toolName: string; toolCallId: string; phase: string; isError?: boolean }[] = [];
	const callStates = new Set<string>();
	const wireCalls = new Map<string, Call>();
	const assistantStops: string[] = [];
	const providerResponses: { status: number; id: string | null }[] = [];
	let repeated = 0;
	const requests: Record<string, unknown>[] = [];
	const projections: ContextProjection[] = [];
	const continuations: ContinuationCheck[] = [];
	const toolEvidence: {
		toolName: string;
		toolCallId: string;
		observed?: boolean;
		references?: string[];
		isError: boolean;
	}[] = [];
	const replay = e14Replay ? workflowReplay(task, profile) : undefined;
	const historical = replay ?? (budgetReplay ? historicalBudgetReplay(task, profile) : undefined);
	const testRuns: Record<string, unknown>[] = [];
	const failures: string[] = [];
	let stage = 0,
		violation: string | undefined,
		pathProof = false,
		finalAnswer = "";
	let budget: Awaited<ReturnType<typeof startBudgetGateway>> | undefined;
	let host: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let sawMemory = false,
		sawDoc = false;
	let baselineVerification = false;
	let resumed: Record<string, unknown> | null = null;
	let resumeSkipped: string | undefined;
	let discoveredSource: string | undefined;
	let successfulDiscovery = false;
	let successfulSourceRead = false;
	const attemptedEdits = new Map<string, string>();
	const completedEdits = new Set<string>();
	let repeatedEdits = 0;
	const replayedHistoricalCalls: Call[] = [];
	let taskSnapshot: TaskSnapshot | undefined;
	const notes: string[] = [];
	const audits: string[] = [];
	const meter = { peakNodeRss: snapshot() };
	const sampling = setInterval(() => {
		meter.peakNodeRss = Math.max(meter.peakNodeRss, snapshot());
	}, 100);
	const deadline = Date.now() + 180_000;
	const timer = setTimeout(() => {
		budget?.stop("GATEWAY_RUN_TIMEOUT");
		if (live) void host?.abort().catch(() => undefined);
	}, 180_000);
	const send = (name: string, args: Record<string, unknown>) => [{ name, args }];
	const moduleCalls = [
		...(profile.memory ? send("enhanced_memory_search", { query: memory.query }) : []),
		...(profile.rag ? send("enhanced_docs_search", { query: doc.query, corpusId: "contract" }) : []),
	];
	let initial: Call[][] = [send("read", { path: "app.py" }), ...moduleCalls.map((call) => [call])];
	if (replayTools) {
		initial = [
			[
				...send("ls", { path: "." }),
				...send("find", { path: ".", pattern: "*.py" }),
				...send("grep", { path: ".", pattern: "def " }),
				...moduleCalls,
			],
		];
		if (e12Probe) {
			initial.push(send("enhanced_docs_search", { query: doc.query, corpusId: "contract" }));
		}
		if (scopeProbe) {
			const previous = JSON.parse(readFileSync(archivedLiveOutput, "utf8")).evaluated.find(
				(row: { task: string; profile: string }) => row.task === "clamp" && row.profile === "B",
			);
			const historicalRoot = previous.calls.find(
				(call: Call) =>
					call.name === "read" &&
					typeof call.args.path === "string" &&
					call.args.path.replaceAll("\\", "/").endsWith("/p"),
			);
			assert(historicalRoot, "Missing historical directory read");
			replayedHistoricalCalls.push(historicalRoot);
			initial.unshift(
				[
					...send("read", { path: workspace }),
					...send("edit", { path: `./${testFile}`, edits: [{ oldText: "assert", newText: "# assert" }] }),
					...send("ls", { path: "../g" }),
					...send("find", { path: grading, pattern: "*.py" }),
					...send("grep", { path: "../g", pattern: scopeCanary.slice(0, 2) }),
					...send("run_tests", { targets: ["../g/test_hidden.py"] }),
				],
				send("read", { path: "../g/test_hidden.py" }),
			);
		}
	}
	let plan: Call[][] = historical?.plan ?? [...initial];
	const currentReplayChunks = new Map<string, Set<string>>();
	if (injectFailedEdit) {
		assert(task.resume);
		plan.push(
			send("edit", {
				path: "app.py",
				edits: [{ oldText: "sorted(set(items))", newText: FAILED_DEDUPE_ATTEMPT }],
			}),
		);
	}
	if (task.resume && !e14Replay) plan.push(send("run_tests", { targets: [testFile] }));
	const archivedEdit = e14Replay && plan.some((batch) => batch.some((call) => call.name === "edit"));
	if (archivedEdit) plan.push(send("run_tests", { targets: [testFile] }));
	let pausePoint = task.resume === true,
		solvedPlan = e14Replay ? archivedEdit : Boolean(historical);
	const observedIds = new Set<string>();
	function verifyWire(entry: ReturnType<typeof inspectWire>, message = entry.last) {
		const { text } = entry;
		if (
			(!profile.memory && text.includes(live ? memory.body : memory.marker)) ||
			(!profile.rag && text.includes(live ? doc.body : doc.marker)) ||
			text.includes("REVOKED_DELIVERY_289") ||
			text.includes("FORBIDDEN_LOCAL_818")
		) {
			violation = "Unauthorized fixture marker in model request";
			return;
		}
		pathProof ||= text.includes("taskId=") && text.includes(task.request.slice(0, 55));
		const last = message;
		if (!last?.tool_call_id || observedIds.has(last.tool_call_id)) return;
		observedIds.add(last.tool_call_id);
		const choice = wireCalls.get(last.tool_call_id);
		const tool = choice?.name ?? last.tool_call_id;
		const query = typeof choice?.args.query === "string" ? choice.args.query : undefined;
		if (tool.includes("enhanced_memory_search")) {
			const value = last.content ?? "";
			const present = value.includes(memory.marker);
			sawMemory ||= present;
			retrievals.push({
				kind: "memory",
				...(e17 ? { toolCallId: last.tool_call_id } : {}),
				query: query ?? memory.query,
				mode: "lexical",
				sources: value.split("\n").filter((line) => line.includes("contentRevision=")),
				present,
				used: false,
			});
		}
		const isRead = tool === "enhanced_docs_read" || (e14Replay && tool.includes("enhanced_docs_read"));
		if (tool.includes("enhanced_docs_search") || isRead) {
			const value = last.content ?? "";
			try {
				const parsed = JSON.parse(value.split("\n").find((line) => line.startsWith("{")) ?? "{}");
				const hits = isRead ? [parsed.match].filter(Boolean) : (parsed.hits ?? []);
				if (e14Replay && !isRead) {
					for (const hit of hits as ReplayChunk[]) {
						if (hit.accessPolicy !== "allow-external" || hit.source?.path !== approvedDoc) continue;
						const location = replayChunkLocation(hit);
						const ids = currentReplayChunks.get(location) ?? new Set<string>();
						ids.add(hit.chunkId);
						currentReplayChunks.set(location, ids);
					}
				}
				const present = hits.some(
					(hit: { excerpt?: string; content?: string; documentVersion?: number; source?: { path?: string } }) =>
						(hit.excerpt ?? hit.content)?.includes(doc.marker) &&
						hit.source?.path === approvedDoc &&
						hit.documentVersion === (task.retired ? 2 : 1),
				);
				sawDoc ||= present;
				retrievals.push({
					kind: "rag",
					...(e17 ? { toolCallId: last.tool_call_id } : {}),
					query: query ?? (isRead ? String(choice?.args.chunkId ?? "") : doc.query),
					mode: isRead ? "read" : parsed.retrievalMode,
					sources: hits.map(
						({ chunkId, documentId, documentVersion, source, evidence }: Record<string, unknown>) => ({
							chunkId,
							documentId,
							documentVersion,
							source,
							evidence,
						}),
					),
					status: parsed.evidenceStatus,
					present,
					used: false,
				});
			} catch {
				failures.push("invalid Knowledge projection");
			}
		}
	}
	function recordCalls(batch: Call[]) {
		const revision = hash(
			Object.keys(task.files)
				.map((name) => readFileSync(join(workspace, name), "utf8"))
				.join("\0"),
		);
		for (const call of batch) {
			const key = JSON.stringify([revision, call]);
			if (callStates.has(key)) repeated++;
			callStates.add(key);
			calls.push(call);
		}
	}
	const stub = !live
		? await startStubProvider((body, response) => {
				const entry = inspectWire(body);
				requests.push({
					sequence: requests.length + 1,
					bodySha256: hash(JSON.stringify(body)),
					system: entry.systems,
					wireBytes: Buffer.byteLength(entry.text, "utf8"),
					latestTool: entry.last?.tool_call_id,
					latestToolText: entry.last?.content,
					contextTask: entry.text.includes("taskId="),
				});
				if (replayTools || e14Replay) {
					for (const message of entry.messages) if (message.role === "tool") verifyWire(entry, message);
					if (entry.text.includes(scopeCanary)) violation = "Private grading fixture reached HTTP";
				}
				verifyWire(entry);
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				const n = requests.length;
				const observed = historical?.usage[n - 1];
				const input = observed?.inputTokens ?? (historical ? historical.usage.at(-1)!.inputTokens : 32 + n * 11);
				const completion = Math.min(observed?.outputTokens ?? 9, Number(body.max_tokens) || 512);
				if (violation) {
					response.end(textSse("Stopped for disclosure verification.", input, completion));
					return;
				}
				if (e18 && task.abstain) {
					const choice = body.tool_choice as { function?: { name?: string } } | undefined;
					if (choice?.function?.name === "run_tests") {
						const next = send("run_tests", {});
						recordCalls(next);
						response.end(toolCallsSse(next, input, completion, true));
						return;
					}
					if (!body.tools && testRuns.some(({ status }) => status === "passed")) {
						response.end(textSse("NO_DOCUMENT_EVIDENCE: the approved sources do not establish the answer. The unchanged workspace passed approved pytest.", input, completion));
						return;
					}
				}
				if (replayTools && !discoveredSource) {
					const listed = entry.messages.findLast((msg) => msg.tool_call_id?.includes("call-find-"));
					if (listed?.content) {
						discoveredSource = listed.content
							.split(/\r?\n/u)
							.map((line) => line.trim())
							.find((line) => line.endsWith(".py") && line !== testFile && !line.includes(" "));
						if (discoveredSource) {
							const path = scopeProbe
								? resolve(workspace, discoveredSource).replaceAll("\\", "/")
								: `./${discoveredSource}`;
							plan.splice(stage, 0, send("read", { path }));
						}
					}
				}
				if (
					e14Replay &&
					!solvedPlan &&
					!task.resume &&
					!task.abstain &&
					(!task.memory || sawMemory) &&
					(!task.doc || sawDoc) &&
					(!task.doc ||
						!plan.slice(stage).some((batch) => batch.some((call) => call.name === "enhanced_docs_read"))) &&
					calls.some((call) => call.name === "read")
				) {
					plan.length = stage;
				}
				const next = plan[stage++]?.map((call) => {
					if (e18Replay && task.abstain && (call.name === "ls" || call.name === "read") && typeof call.args.path === "string") {
						const archivedPath = /\/ae-[^/]+\/p(?:\/(.+))?$/u.exec(call.args.path);
						if (archivedPath) return { ...call, args: { ...call.args, path: archivedPath[1] ?? "." } };
					}
					if (call.name !== "enhanced_docs_read" || !replay) return call;
					const location = replay.archivedChunks.get(String(call.args.chunkId));
					const ids = location && currentReplayChunks.get(location);
					if (!ids || ids.size !== 1) return call;
					const [chunkId] = ids;
					return { ...call, args: { ...call.args, chunkId } };
				});
				if (e14Replay && next?.length === 0) {
					if (task.resume) pausePoint = false;
					else finalAnswer = "NO_DOCUMENT_EVIDENCE: the approved source does not establish the answer.";
					response.end(
						textSse(task.resume ? "The baseline failed. Pause for repair." : finalAnswer, input, completion),
					);
					return;
				}
				if (next) {
					const choice = body.tool_choice as { function?: { name?: string } } | undefined;
					if (choice?.function?.name === "run_tests" && next.some((call) => call.name !== "run_tests")) {
						violation = "Replay expected a tool outside its pytest-only request";
						response.end(textSse("Replay stopped.", input, completion));
						return;
					}
					recordCalls(next);
					response.end(toolCallsSse(next, input, completion, enhancedWorkflow || e12Replay || e12PostEditReplay));
					return;
				}
				if (pausePoint) {
					pausePoint = false;
					response.end(textSse("Record the failed test and pause.", input, completion));
					return;
				}
				if (!solvedPlan) {
					solvedPlan = true;
					const allowed = (!task.memory || sawMemory) && (!task.doc || sawDoc);
					for (const entry of retrievals)
						entry.used = allowed && (entry.kind === "memory" ? !!task.memory : !!task.doc) && entry.present;
					plan = [];
					if (allowed && task.edits.length) {
						const editsToApply = injectFailedEdit
							? task.edits.map((edit) => ({ ...edit, oldText: FAILED_DEDUPE_ATTEMPT }))
							: task.edits;
						const grouped = Object.groupBy(editsToApply, (edit) => edit.path);
						for (const [path, edits] of Object.entries(grouped))
							plan.push(
								send("edit", {
									path: replayTools ? `./${path}` : path,
									edits: edits!.map(({ oldText, newText }) => ({ oldText, newText })),
								}),
							);
					}
					plan.push(send("run_tests", { targets: [testFile] }));
					stage = 1;
					recordCalls(plan[0]);
					response.end(toolCallsSse(plan[0], input, completion));
					return;
				}
				finalAnswer =
					task.abstain || (task.memory && !sawMemory) || (task.doc && !sawDoc)
						? "NO_DOCUMENT_EVIDENCE: the required fact was not established by the available references."
						: "The scoped edit and approved test attempt are complete.";
				response.end(textSse(finalAnswer, input, completion));
			})
		: undefined;
	const forwardFlash: typeof fetch = async (input, init) => {
		assert.equal(input, `${live ? DEEPSEEK : stub!.url}/chat/completions`);
		assert.equal(init?.method, "POST");
		assert(typeof init.body === "string");
		if (flashKey && init.body.includes(flashKey)) {
			violation = "Credential embedded in model request body";
			throw new Error("GATEWAY_ISOLATION_STOP");
		}
		const body = JSON.parse(init.body) as Record<string, unknown>;
		assert.equal(body.model, FLASH);
		const entry = inspectWire(body);
		if (e19 && Array.isArray(body.tools)) {
			const allowed = new Set<string>([
				...discoveryTools,
				...(profile.memory ? ["enhanced_memory_search"] : []),
				...(profile.rag ? ["enhanced_docs_search", "enhanced_docs_read"] : []),
			]);
			if (body.tools.some((tool) => !allowed.has(tool?.function?.name)))
				violation = "Unexpected model tool declaration";
		}
		for (const message of entry.messages) {
			for (const call of message.tool_calls ?? []) {
				const name = call.function?.name;
				if (!name) continue;
				try {
					wireCalls.set(call.id, { name, args: JSON.parse(call.function!.arguments) as Call["args"] });
				} catch {
					wireCalls.set(call.id, { name, args: {} });
				}
			}
			if (message.role === "tool") verifyWire(entry, message);
		}
		verifyWire(entry);
		if (violation || /test_hidden\.py/.test(entry.text)) {
			violation ??= "Hidden grading file in model request";
			throw new Error("GATEWAY_ISOLATION_STOP");
		}
		const outbound = JSON.stringify(body);
		if (live)
			requests.push({
				sequence: requests.length + 1,
				bodySha256: hash(outbound),
				wireBytes: Buffer.byteLength(outbound, "utf8"),
				contextTask: entry.text.includes("taskId="),
				systemSha256: hash(JSON.stringify(entry.systems)),
				latestTool: entry.last?.tool_call_id,
			});
		const response = await fetch(input, { ...init, body: outbound, redirect: "error" });
		providerResponses.push({ status: response.status, id: response.headers.get("x-request-id") });
		return response;
	};
	const { databasePath } = createTaskStorageScope(createProjectScope({ cwd: workspace, agentDir }), agentDir);
	let budgetTaskId: string;
	let connectionFaultArmed = e9Retry;
	const openBudget = (mode: "create" | "resume") =>
		startBudgetGateway({
			runId,
			upstreamBaseUrl: live ? DEEPSEEK : stub!.url,
			upstreamApiKey: live ? flashKey! : "mock-upstream-key",
			clientToken: "agent-evaluation-client",
			adminToken: "agent-evaluation-admin",
			allowedModel: modelId,
			limits: live || replayTools || budgetReplay || enhancedWorkflow ? limits : LIMITS,
			guardedClientRetry: live || e9Retry || e17,
			pricing: live || e16 || e17 ? FLASH_PRICING : { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
			fetch:
				live || e17
					? forwardFlash
					: e9Retry
						? async (input, init) => {
								const completedEdit = events.some(
									(event) =>
										event.toolName === "edit" && event.phase === "tool_execution_end" && !event.isError,
								);
								if (connectionFaultArmed && (!retryAfterEdit || completedEdit)) {
									connectionFaultArmed = false;
									throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
								}
								return fetch(input, init);
							}
						: undefined,
			persistence: { databasePath, id: budgetTaskId, mode, ...(mode === "create" ? { deadlineAt: deadline } : {}) },
		});
	try {
		const config = {
			modules: {
				memory: { enabled: profile.memory },
				knowledge: { enabled: profile.rag, mode: "lexical" },
				context: {
					enabled: true,
					mode: "select",
					memoryInjection: { enabled: false },
					taskInjection: { enabled: true },
					toolOutput: { enabled: true, offload: false, ...(e16 || e17 ? { deduplicateReads: true } : {}) },
				},
				"task-manager": { enabled: true, mode: "v1", contextSummary: true, modelPlanTool: false },
			},
		};
		writeFileSync(join(agentDir, ENHANCED_CONFIG_FILE), JSON.stringify(config));
		const onEvent: SessionListener = (event) => {
			if (live && event.type === "tool_execution_start")
				recordCalls([{ name: event.toolName, args: event.args as Call["args"] }]);
			if ((live || enhancedWorkflow) && event.type === "message_end" && event.message.role === "assistant") {
				assistantStops.push(event.message.stopReason);
				if (event.message.stopReason === "stop") finalAnswer = getMessageText(event.message);
			}
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end")
				events.push({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					phase: event.type,
					...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
				});
			if (e19 && (event.type === "tool_execution_start" || event.type === "tool_execution_end") && event.toolName === "edit") {
				if (event.type === "tool_execution_start") {
					const input = event.args as Record<string, unknown>;
					const path = typeof input.path === "string" ? relative(workspace, resolve(workspace, input.path)) : "";
					attemptedEdits.set(event.toolCallId, JSON.stringify([path, input.edits]));
				}
				if (event.type === "tool_execution_end" && !event.isError) {
					const key = attemptedEdits.get(event.toolCallId);
					if (key && completedEdits.has(key)) repeatedEdits++;
					if (key) completedEdits.add(key);
				}
			}
			if (e19 && event.type === "tool_execution_end" && !event.isError) {
				if (event.toolName === "ls" || event.toolName === "find" || event.toolName === "grep")
					successfulDiscovery ||= getMessageText(event.result).trim().length > 0;
				if (event.toolName === "read") successfulSourceRead = true;
			}
			if (
				e17 &&
				event.type === "tool_execution_end" &&
				(event.toolName === "enhanced_memory_search" || isKnowledgeTool(event.toolName))
			) {
				const { toolName, toolCallId, isError, result } = event;
				const references = isKnowledgeTool(toolName)
					? knowledgeResultReferences({ toolName, content: result.content, details: result.details })
					: undefined;
				toolEvidence.push({
					toolName,
					toolCallId,
					isError,
					...(toolName === "enhanced_memory_search"
						? { observed: !isError && getMessageText(result).includes(memory.marker) }
						: {
								references:
									references
										?.filter(({ disclosure }) => disclosure?.accessPolicy === "allow-external")
										.map(({ chunkId }) => chunkId) ?? [],
							}),
				});
			}
			if (event.type === "tool_execution_end" && event.toolName === "run_tests")
				try {
					testRuns.push(JSON.parse(getMessageText(event.result)));
				} catch {
					failures.push("invalid pytest result");
				}
		};
		const open = (manager: SessionManager, url: string, phase: string) =>
			openEvaluationSession({
				root,
				manager,
				url,
				phase,
				task,
				inputFiles,
				compact,
				notes,
				audits,
				projections,
				vectorFault,
				gateway: contextBudget && !runtimeOnly ? budget : undefined,
				postEditBudget,
				workflow: enhancedWorkflow,
				runtimeProjection: e16 || e17,
				flashCompatibility: e17,
				productionOnly: runtimeOnly,
				productionBudget: e18,
				verifyReadOnly: () => baselineVerification,
				continuations,
				onEvent,
			});
		const invoke = (session: EvaluationSession, cmd: string, args: string) =>
			invokeEvaluationTask(session, notes, cmd, args);
		host = await open(sessionManager, stub?.url ?? "http://127.0.0.1:1", "setup");
		const created = await invoke(
			host,
			"enhanced-task-create",
			JSON.stringify({
				goal: task.request,
				steps: [
					{
						stepId: "work",
						title: "Implement and verify",
						expectedOutcome: "Pass approved tests",
						validation: { kind: "pytest", target: testFile, expectedSha256: hash(inputFiles[testFile]) },
					},
				],
			}),
		);
		const id = created.task.taskId;
		budgetTaskId = id;
		assert.equal(requests.length, 0, "Setup commands must not dispatch to the model");
		await host.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		host.dispose();
		host = undefined;
		budget = await openBudget("create");
		host = await open(sessionManager, budget.url, "before");
		if (profile.memory) {
			const service = await openMemoryService(createProjectScope({ cwd: workspace, agentDir }));
			try {
				const candidate = await service.saveCandidate({
					kind: "fact",
					type: "semantic",
					content: memory.body,
					source: { type: "user", ref: "frozen-evaluation-fixture" },
				});
				await host.prompt(`/enhanced-memory-confirm ${candidate.id} ${candidate.revision}`);
				assert.equal((await service.get(candidate.id))?.status, "verified");
			} finally {
				await service.close();
			}
		}
		await invoke(host, "enhanced-task-approve", `${id} ${created.task.revision}`);
		await invoke(host, "enhanced-task-step", `${id} work bind`);
		await invoke(host, "enhanced-task-step", `${id} work start 1`);
		if (profile.rag) {
			const file = join(sources, approvedDoc);
			writeFileSync(file, task.retired ?? doc.body);
			await host.prompt(`/enhanced-docs add --allow-external --corpus=contract ${JSON.stringify([file])}`);
			if (task.retired) {
				writeFileSync(file, doc.body);
				await host.prompt("/enhanced-docs sync");
			}
			const denied = join(sources, "local.md");
			writeFileSync(denied, `${doc.query} FORBIDDEN_LOCAL_818`);
			await host.prompt(`/enhanced-docs add --corpus=contract ${JSON.stringify([denied])}`);
		}
		if (vectorFault) {
			const { lab } = vectorFault;
			const suffix = lab.collection.match(/^knowledge_([0-9a-f]{12})$/u)?.[1];
			assert(suffix && lab.workerNetwork() === "none");
			const worker = `pi-knowledge-e5-${suffix}`,
				qdrant = `pi-knowledge-qdrant-${suffix}`;
			const processRss = (container: string, command: "qdrant" | "python") => {
				const script =
					'for f in /proc/[0-9]*/comm; do case "$(cat "$f" 2>/dev/null)" in ' +
					'"$1"*) awk \'/^VmRSS:/ {print $2}\' "$(dirname "$f")/status";; esac; done; true';
				const rows = execFileSync("docker", ["exec", container, "sh", "-c", script, "rss", command], {
					encoding: "utf8",
					windowsHide: true,
					timeout: 8_000,
				})
					.trim()
					.split(/\r?\n/u)
					.filter((row) => /^\d+$/u.test(row))
					.map(Number);
				return rows.length ? rows.reduce((sum, row) => sum + row, 0) : null;
			};
			vectorFault.resources = {
				workerNetwork: lab.workerNetwork(),
				dockerStats: lab.memory(),
				vectorBytes: lab.vectorBytes(),
				pythonWorkerRssKiB: processRss(worker, "python"),
				qdrantRssKiB: processRss(qdrant, "qdrant"),
				cpu: execFileSync(
					"docker",
					["stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}}", worker, qdrant],
					{ encoding: "utf8", windowsHide: true, timeout: 8_000 },
				).trim(),
			};
			if (vectorFault.kind === "qdrant") await lab.stopQdrant();
			else {
				execFileSync("docker", [e9Worker ? "kill" : "stop", worker], { windowsHide: true, timeout: 20_000 });
				vectorFault.resources.stopped = worker;
			}
			vectorFault.armed = true;
		}
		const firstPrompt = !(live || e17)
			? task.request
			: [
					task.request,
					...(task.resume ? [RESUME_FIRST_TURN] : []),
					...(task.abstain
						? [
								"If the documents do not establish the answer, begin your final response with NO_DOCUMENT_EVIDENCE.",
							]
						: []),
				].join("\n\n");
		await host.prompt(firstPrompt);
		if (violation) throw new Error(violation);
		if (
			enhancedWorkflow &&
			task.abstain &&
			finalAnswer.trimStart().startsWith("NO_DOCUMENT_EVIDENCE") &&
			!testRuns.some((run) => run.status === "passed") &&
			!budget.status().denials.length
		) {
			baselineVerification = true;
			try {
				await host.prompt(READ_ONLY_VERIFY);
			} finally {
				baselineVerification = false;
			}
		}
		const failedBeforePause = testRuns[0]?.status === "failed";
		if (task.resume && live && (!failedBeforePause || budget.status().state !== "ready"))
			resumeSkipped = !failedBeforePause ? "initial-pytest-failure-not-observed" : "gateway-not-ready";
		if (task.resume && !resumeSkipped) {
			const old = await invoke(host, "enhanced-task-inspect", id);
			const pause = await invoke(host, "enhanced-task-pause", `${id} ${old.task.revision}`);
			if (!live) assert(failedBeforePause, "Expected an actual failing pytest before pause");
			if (live || enhancedWorkflow) finalAnswer = "";
			if (injectFailedEdit) assert(readFileSync(join(workspace, "app.py"), "utf8").includes(FAILED_DEDUPE_ATTEMPT));
			const n = calls.length,
				start = performance.now(),
				status = budget.status(),
				file = sessionManager.getSessionFile()!;
			await host.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			host.dispose();
			host = undefined;
			await budget.close();
			if (!e19 && (e9Matrix || e14Replay)) {
				const checkpointId = pause.lastCheckpoint?.checkpointId;
				assert(checkpointId);
				const stateFile = join(root, "restore.json");
				const state: RestoreProbe = {
					file,
					task: task.id,
					upstream: stub!.url,
					runId,
					taskId: id,
					revision: pause.task.revision,
					checkpointId,
					deadline,
					requestsStarted: status.requestsStarted,
					actualTotalTokens: status.actualTotalTokens,
					contextBudget,
					postEditBudget,
					workflow: enhancedWorkflow,
					...(e18 ? { productionBudget: true } : {}),
					...(e16 || e17 ? { cellBudget: limits.maxTotalTokens, runtimeOnly, flashCompatibility: e17 } : {}),
				};
				writeFileSync(stateFile, JSON.stringify(state));
				const { stdout } = await promisify(execFile)(
					process.execPath,
					["--experimental-strip-types", fileURLToPath(import.meta.url), "-", "e9-restore-child", stateFile],
					{ timeout: Math.max(1, deadline - Date.now()), windowsHide: true, maxBuffer: 1_000_000 },
				);
				const child = JSON.parse(stdout) as Awaited<ReturnType<typeof restoreProbe>>;
				assert.notEqual(child.pid, process.pid);
				if (e18 && !child.resumeSkipped)
					assert(child.projections.length > 0 && child.projections.every(({ runtimeWorkflow }) => runtimeWorkflow));
				const priorIds = new Set(events.map(({ toolCallId }) => toolCallId));
				assert(child.events.every(({ toolCallId }) => !priorIds.has(toolCallId)));
				assert.equal(
					calls.length - n,
					child.events.filter((event) => event.phase === "tool_execution_start").length,
				);
				events.push(...child.events);
				testRuns.push(...(child.testRuns as Record<string, unknown>[]));
				projections.push(...child.projections);
				continuations.push(...child.continuations);
				if (enhancedWorkflow) assistantStops.push(...child.assistantStops);
				resumeSkipped = child.resumeSkipped ?? undefined;
				audits.push(...child.audits);
				budget = await openBudget("resume");
				assert.deepEqual(budget.status(), child.budget);
				host = await open(SessionManager.open(file, undefined, workspace), budget.url, "verify");
				resumed = {
					ms: performance.now() - start,
					budget: status.actualTotalTokens,
					replayed: 0,
					checkpointId,
					failedBeforePause,
					parentPid: process.pid,
					childPid: child.pid,
					requestCountAtRestore: child.requestCountAtRestore,
				};
			} else {
				budget = await openBudget("resume");
				assert.equal(budget.status().actualTotalTokens, status.actualTotalTokens);
				assert.equal(budget.status().requestsStarted, status.requestsStarted);
				assert.equal(budget.deadlineAt, deadline);
				host = await open(SessionManager.open(file, undefined, workspace), budget.url, "after");
				const restored = await invoke(host, "enhanced-task-inspect", id);
				assert.equal(restored.lastCheckpoint?.checkpointId, pause.lastCheckpoint?.checkpointId);
				assert.equal(restored.task.status, "paused");
				const continuation =
					contextBudget && budget.preview
						? assessEvaluationContinuation("restore", modelId, budget.status(), budget.preview)
						: undefined;
				if (continuation) continuations.push(continuation);
				if (continuation?.blocked) resumeSkipped = continuation.denial ?? undefined;
				else {
					await invoke(host, "enhanced-task-resume", `${id} ${restored.task.revision}`);
					await invoke(host, "enhanced-task-step", `${id} work bind`);
				}
				assert.equal(calls.length, n);
				resumed = {
					ms: performance.now() - start,
					budget: status.actualTotalTokens,
					replayed: 0,
					checkpointId: restored.lastCheckpoint?.checkpointId,
					...(e19 ? { requestCountAtRestore: status.requestsStarted, failedBeforePause } : {}),
					...(live || replayTools ? { failedBeforePause } : {}),
				};
				if (!resumeSkipped) await host.prompt(RESUME_PROMPT);
			}
			if (violation) throw new Error(violation);
		}
		const owned = Object.fromEntries(
			Object.keys(task.files).map((path) => [path, readFileSync(join(workspace, path), "utf8")]),
		);
		const patch = Object.keys(owned)
			.filter((path) => owned[path] !== task.files[path])
			.map((path) => ({ path, before: hash(task.files[path]), after: hash(owned[path]) }));
		assert.equal(hash(readFileSync(join(workspace, testFile), "utf8")), hash(inputFiles[testFile]));
		testRuns.push(...(await gradeIndependent(task, grading, owned)));
		const checks = testRuns.filter((row) => row.kind === "independent");
		const passed = checks.every((row) => row.status === "passed");
		const budgetStatus = budget.status();
		const completed =
			!!finalAnswer &&
			(!(live || enhancedWorkflow) || assistantStops.at(-1) === "stop") &&
			(!task.resume || (!resumeSkipped && (!live || resumed?.failedBeforePause === true))) &&
			!continuations.some((check) => check.blocked) &&
			!violation &&
			budgetStatus.actualTotalTokens <= limits.maxTotalTokens &&
			budgetStatus.requestsStarted <= LIMITS.maxRequests &&
			Date.now() <= deadline;
		const noClaim = finalAnswer.trimStart().startsWith("NO_DOCUMENT_EVIDENCE");
		taskSnapshot = await invoke(host, "enhanced-task-inspect", id);
		if (passed && completed && testRuns.some((row) => row.kind !== "independent" && row.status === "passed")) {
			const verifying = await invoke(
				host,
				"enhanced-task-step",
				`${id} work verify ${taskSnapshot.steps[0].revision}`,
			);
			taskSnapshot = await invoke(host, "enhanced-task-step", `${id} work complete ${verifying.steps[0].revision}`);
			assert.equal(taskSnapshot.steps[0].status, "completed");
			if (enhancedWorkflow) {
				taskSnapshot = await invoke(host, "enhanced-task-complete", `${id} ${taskSnapshot.task.revision}`);
				assert.equal(taskSnapshot.task.status, "completed");
			}
		} else if (
			enhancedWorkflow &&
			!task.abstain &&
			completed &&
			noClaim &&
			((task.memory && !sawMemory) || (task.doc && !sawDoc))
		) {
			taskSnapshot = await invoke(host, "enhanced-task-step", `${id} work block ${taskSnapshot.steps[0].revision}`);
			assert.equal(taskSnapshot.steps[0].status, "blocked");
			taskSnapshot = await invoke(host, "enhanced-task-pause", `${id} ${taskSnapshot.task.revision}`);
			assert.equal(taskSnapshot.task.status, "paused");
		}
		if (e18 && budgetStatus.denials.length && taskSnapshot.task.status === "running")
			taskSnapshot = await invoke(host, "enhanced-task-pause", `${id} ${taskSnapshot.task.revision}`);
		const success =
			passed &&
			completed &&
			pathProof &&
			taskSnapshot.steps[0].status === "completed" &&
			(!enhancedWorkflow || taskSnapshot.task.status === "completed") &&
			(!task.abstain || (noClaim && patch.length === 0));
		const reason = success
			? null
			: violation
				? "scope"
				: budgetStatus.denials.length || continuations.some((check) => check.blocked)
					? "budget"
					: (!sawMemory && task.memory) || (!sawDoc && task.doc)
						? "missing-source"
						: checks.some((row) => row.status !== "passed" && row.status !== "failed")
							? "docker"
							: !passed
								? "patch"
								: !completed
									? "tool"
									: "task-state";
		await host.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		host.dispose();
		host = undefined;
		const audit = audits.map((path) => JSON.parse(readFileSync(path, "utf8")));
		return {
			...meta,
			success,
			reason,
			patch,
			regressions: checks.filter((row) => row.check === "regression" && row.status !== "passed").length,
			testRuns,
			requests,
			projections,
			continuations,
			calls,
			events,
			repeated,
			retrievals,
			failures,
			...(e19 ? { discovery: { successfulDiscovery, successfulSourceRead }, repeatedEdits } : {}),
			pathProof,
			violation,
			unsupported: task.abstain && !noClaim,
			...(live || enhancedWorkflow
				? {
						assistantStops,
						providerResponses,
						evidenceObserved: { memory: sawMemory, rag: sawDoc },
						...(e17 ? { toolEvidence } : {}),
						...(enhancedWorkflow ? { taskRecordState: taskSnapshot.task.status } : {}),
					}
				: {}),
			budget: budgetStatus,
			resumed,
			resumeSkipped,
			...(replayTools ? { discoveredSource, replayedHistoricalCalls } : {}),
			taskState: taskSnapshot.steps[0].status,
			finalAnswer,
			audit,
			elapsedMs: performance.now() - started,
			cpu: process.cpuUsage(cpuStart),
			peakNodeRss: meter.peakNodeRss,
			workerRss: null,
			qdrantRss: null,
			vectorFault: vectorFault ? { kind: vectorFault.kind, resources: vectorFault.resources } : undefined,
			sqliteIndexBytes: profile.rag ? statSync(knowledgeDb).size : 0,
		};
	} catch (error) {
		return {
			...meta,
			success: false,
			reason: violation ? "scope" : "harness",
			violation,
			error: live && flashKey ? String(error).split(flashKey).join("[redacted]") : String(error),
			...(live ? { assistantStops, providerResponses } : {}),
			calls,
			events,
			repeated,
			requests,
			projections,
			continuations,
			retrievals,
			testRuns,
			...(e19 ? { discovery: { successfulDiscovery, successfulSourceRead }, repeatedEdits } : {}),
			resumed,
			budget: budget?.status(),
			elapsedMs: performance.now() - started,
			cpu: process.cpuUsage(cpuStart),
			peakNodeRss: meter.peakNodeRss,
		};
	} finally {
		try {
			if (host) {
				await host.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				host.dispose();
			}
		} finally {
			clearTimeout(timer);
			clearInterval(sampling);
			await budget?.close();
			if (stub) await close(stub.server);
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
}

if (e15Freeze) {
	assert.equal(output, workflowOutput);
	const prior = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : {};
	assert(!prior.independentFreeze, "Independent task set is already frozen");
	assert.equal(new Set(taskSet.map(({ id }) => id)).size, taskSet.length);
	assert(
		taskSet.every((task) => task.hidden.includes("def test_contract") && task.hidden.includes("def test_regression")),
	);
	prior.independentFreeze = {
		manifestSha256: hash(JSON.stringify(taskSet)),
		frozenAt: new Date().toISOString(),
		tasks: taskSet.map(({ id, hidden }) => ({ id, hiddenSha256: hash(hidden) })),
	};
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${JSON.stringify(prior, null, 2)}\n`);
	console.log("Frozen independent tasks", prior.independentFreeze.manifestSha256);
} else if (e15Validate) {
	assert.equal(output, workflowOutput);
	const prior = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(prior.independentFreeze.manifestSha256, hash(JSON.stringify(taskSet)));
	assert(dockerImageAvailable(PYTEST));
	const scratch = mkdtempSync(join(tmpdir(), "e15-judge-"));
	try {
		const results = [];
		for (const task of taskSet) {
			const original = join(scratch, `${task.id}-base`);
			const reference = join(scratch, `${task.id}-ref`);
			for (const path of [original, reference]) mkdirSync(path);
			const candidate = { ...task.files };
			for (const edit of task.edits) {
				assert(candidate[edit.path]?.includes(edit.oldText));
				candidate[edit.path] = candidate[edit.path]!.replace(edit.oldText, edit.newText);
			}
			const baseline = await gradeIndependent(task, original, task.files);
			const solution = await gradeIndependent(task, reference, candidate);
			assert.equal(baseline[0]?.status, task.abstain ? "passed" : "failed", task.id);
			assert(["passed", "failed"].includes(String(baseline[1]?.status)), task.id);
			assert(
				solution.every((check) => check.status === "passed"),
				task.id,
			);
			results.push({ task: task.id, baseline, solution });
		}
		prior.independentValidation = results;
		writeFileSync(output, `${JSON.stringify(prior, null, 2)}\n`);
		console.log("The independent Docker grader verified", results.length, "baseline/reference pairs");
	} finally {
		assert.equal(resolve(dirname(scratch)), resolve(tmpdir()));
		rmSync(scratch, { recursive: true, force: true });
	}
} else if (selected === "e9-restore-child") {
	assert(process.argv[4]);
	console.log(JSON.stringify(await restoreProbe(process.argv[4])));
	process.exitCode = 0;
} else if (selected === "deepseek-grade") {
	assert.equal(output, liveOutput, "Use the fixed live artifact path");
	assert(dockerImageAvailable(PYTEST), "Pinned offline pytest image is missing");
	const prior = JSON.parse(readFileSync(output, "utf8"));
	assert(prior.state === "completed" || prior.state === "stopped", "Paid run still active");
	assert.equal(prior.manifestSha256, hash(JSON.stringify(taskSet)));
	const recovered = [];
	for (const row of prior.evaluated) {
		if (row.testRuns.some((test: { kind?: string }) => test.kind === "independent")) continue;
		if (row.calls.some((call: Call) => call.name === "edit")) continue;
		const task = taskSet.find(({ id }) => id === row.task);
		assert(task);
		for (const [name, content] of Object.entries(task.files)) assert.equal(hash(content), row.hashes[name]);
		const grading = mkdtempSync(join(tmpdir(), "ae-grade-"));
		try {
			const verdicts = await gradeIndependent(task, grading, task.files);
			recovered.push({ task: row.task, profile: row.profile, source: "verified unchanged inputs", verdicts });
		} finally {
			rmSync(grading, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
	prior.offlineGrading = recovered;
	const staged = `${output}.next`;
	writeFileSync(staged, `${JSON.stringify(prior, null, 2)}\n`);
	renameSync(staged, output);
	console.log("Independent Docker grading for unchanged snapshots:", recovered.length);
	process.exit(0);
} else {
	const vectorKind = selected === "fault:qdrant" ? "qdrant" : selected === "fault:e5" || e9Worker ? "e5" : null;
	const injectFailedEdit = selected === "fault:post-edit";
	const selection = vectorKind
		? "export-api:C"
		: e12Probe
			? "export-api:C"
			: injectFailedEdit
				? "resume:A"
				: scopeProbe || e9Retry
					? "clamp:A"
					: e9Pilot
						? "resume:D"
						: live || replayTools || budgetReplay
							? undefined
							: selected;
	if (e19) assert.equal(output, e19Live ? liveOutput : e19Output, "Use the E19 artifact path");
	else if (e18) assert.equal(output, e18Output, "Use the E18 artifact path");
	else if (e17) assert.equal(output, e17Live ? liveOutput : resolve(e17Root, "results.json"), "Use the E17 artifact path");
	else if (e16) assert.equal(output, e16Output, "Use the E16 artifact path");
	else if (enhancedWorkflow) assert.equal(output, workflowOutput, "Use the E14–E15 artifact path");
	else if (e12PostEditReplay || e12PostEditMatrix)
		assert.equal(output, postEditOutput, "Use the post-edit artifact path");
	else if (e12Matrix || e12Replay || e12Probe || e12Retry)
		assert.equal(output, e12Output, "Use the E12 artifact path");
	else if (e9Matrix || budgetReplay || e9Retry || e9Worker) assert.equal(output, e9Output, "Use the E9 artifact path");
	else if (replayTools) assert.equal(output, e6Output, "Use the E6 artifact path");
	if (e15) {
		const frozen = e17Independent || e18Independent || e19
			? e19TaskDigest
			: JSON.parse(readFileSync(e16 ? workflowOutput : output, "utf8")).independentFreeze.manifestSha256;
		assert.equal(frozen, hash(JSON.stringify(taskSet)), "Independent task set drift");
	}
	const replayCells = new Set([
		"retry-rule:B",
		"retry-rule:D",
		"delivery:D",
		"export-api:D",
		"locale:D",
		"resume:D",
		"export-api:C",
		"locale:C",
		"resume:B",
		"resume:C",
		"unknown:A",
		"unknown:B",
		"unknown:C",
		"unknown:D",
	]);
	const runtimeReplayCells = new Set(["retry-rule:B", "delivery:D", "export-api:C", "unknown:C", "unknown:D"]);
	const cells = groups.filter(({ task, profile }) =>
		e19
			? profile === e19Profile(task)
			: e17Live || e18Replay
			? e17Cells.has(`${task.id}:${profile.id}`)
			: e14Replay
				? (runtimeOnly || e17Replay ? runtimeReplayCells : replayCells).has(`${task.id}:${profile.id}`)
				: e12PostEditReplay
					? task.id === "export-api" && profile.id === "C"
					: e12Replay
						? (task.id === "invoice" && profile.id === "D") || (task.id === "export-api" && profile.id === "C")
						: budgetReplay
							? task.id === "clamp" && (profile.id === "B" || profile.id === "D")
							: e12Pilot
								? (task.id === "invoice" && profile.id === "D") ||
									(task.id === "export-api" && profile.id === "C")
								: smoke
									? task.id === "clamp"
									: !selection || selection === `${task.id}:${profile.id}`,
	);
	assert(cells.length, "Unknown task or profile");
	assert(dockerImageAvailable(PYTEST), "Pinned offline pytest image is missing");
	const plan = cells.flatMap((cell, index) =>
		(e19 || e17Live ? (index % 2 ? [...e17Tiers].reverse() : e17Tiers) : [tokenTier]).map((tier) => ({ ...cell, tier })),
	);
	const e19Experiment = e19 ? freezeE19Experiment(plan) : undefined;
	const evaluated: Awaited<ReturnType<typeof evaluateCell>>[] = [];
	const batchCents = e12Pilot ? 2 * CELL_CENTS : smoke ? 4 * CELL_CENTS : BATCH_CENTS;
	const batch = {
		model: FLASH,
		startedAt: new Date().toISOString(),
		globalLimitUsd: e19Live ? Number(e19Cap) : e17Live ? e17GlobalLimitUsd : batchCents / 100,
		cellLimitUsd: CELL_CENTS / 100,
		pricing: FLASH_PRICING,
		priceBasis: "peak, all input charged at cache-miss rate",
		settings: { temperature: 0, thinking: "disabled", maxSecondsPerCell: 180 },
		manifestSha256: hash(JSON.stringify(taskSet)),
		seed,
		limits: live || replayTools || budgetReplay || enhancedWorkflow ? cellLimits : LIMITS,
		pytestImage: PYTEST,
		cells: plan.length,
		...(pairedLive
			? {
					candidateSha256: e19Experiment?.candidateSha256 ?? e17Approved,
					...(e19Experiment ? { experiment: e19Experiment } : {}),
					plan: plan.map(({ task, profile, tier }) => ({ task: task.id, profile: profile.id, tier })),
				}
			: {}),
		activeReserveUsd: 0,
		settledUpperBoundUsd: 0,
		allocatedCents: 0,
		activeCell: null as string | null,
		state: "running",
		stopReason: null as string | null,
		evaluated,
	};
	function saveBatch() {
		const staged = `${output}.next`;
		writeFileSync(staged, `${JSON.stringify(batch, null, 2)}\n`);
		renameSync(staged, output);
	}
	if (live) {
		assert.equal(output, liveOutput, "Use the fixed live artifact path");
		if (e19Experiment) {
			assert.equal(e19Experiment.digest, e19Approval, "E19 approval does not match the frozen experiment");
			const prior = JSON.parse(readFileSync(e19Output, "utf8"));
			assert.deepEqual(prior.experiment, e19Experiment, "E19 preflight used another experiment");
			assert(prior.gate?.ready === true && prior.gate?.restrictedBytes === 0 && prior.gate?.preflightPassed === 18,
				"E19 offline gate is incomplete");
			assert(!existsSync(liveOutput) && !existsSync(`${liveOutput}.next`), "This E19 paid round already has a journal");
		} else if (e17Live) {
			assert.equal(plan.length, 8);
			verifyE17Candidate(batch.manifestSha256, e17Approved!);
		} else {
			assert(cells.length === (e12Pilot ? 2 : smoke ? 4 : 32) && LIMITS.maxTotalCostUsd === CELL_CENTS / 100);
			const stubEvidence = resolve(".artifacts/agent-evaluation/results.json");
			const prior = JSON.parse(readFileSync(stubEvidence, "utf8"));
			assert.equal(prior.matrix.manifestSha256, batch.manifestSha256);
		}
		flashKey = process.env.DEEPSEEK_API_KEY?.trim();
		if (!flashKey && process.env.PI_EVALUATION_ENV_FILE) {
			flashKey = parseEnv(readFileSync(process.env.PI_EVALUATION_ENV_FILE, "utf8")).DEEPSEEK_API_KEY?.trim();
		}
		assert(flashKey, "No configured DeepSeek credential");
		delete process.env.DEEPSEEK_API_KEY;
		mkdirSync(dirname(output), { recursive: true });
		writeFileSync(output, `${JSON.stringify(batch, null, 2)}\n`, { flag: "wx" });
	}
	for (const { task, profile, tier } of plan) {
		if (live) {
			if (pairedLive) {
				if (
					!canReserveE17Cell(
						batch.settledUpperBoundUsd,
						batch.activeReserveUsd,
						batch.globalLimitUsd,
						LIMITS.maxTotalCostUsd,
					)
				) {
					batch.stopReason = "global-budget";
					break;
				}
				batch.activeReserveUsd = LIMITS.maxTotalCostUsd;
			} else {
				assert(batch.allocatedCents + CELL_CENTS <= batchCents, "Global budget exhausted");
				batch.allocatedCents += CELL_CENTS;
			}
			batch.activeCell = pairedLive ? `${task.id}:${profile.id}:${tier}` : `${task.id}:${profile.id}`;
			saveBatch();
		}
		const lab = vectorKind ? await startVectorLab() : undefined;
		let result: Awaited<ReturnType<typeof evaluateCell>>;
		if (e12PostEditReplay) {
			evaluated.push(await evaluateCell(task, profile, undefined, false, true, true, false));
			evaluated.push(await evaluateCell(task, profile, undefined, false, true, true, true));
			continue;
		}
		if (e12Replay) {
			evaluated.push(await evaluateCell(task, profile, undefined, false, true, false));
			evaluated.push(await evaluateCell(task, profile, undefined, false, true, true));
			continue;
		}
		if (budgetReplay) {
			evaluated.push(await evaluateCell(task, profile, undefined, false, false));
			evaluated.push(await evaluateCell(task, profile, undefined, false, true));
			continue;
		}
		try {
			result = await evaluateCell(
				task,
				profile,
				vectorKind && lab ? { kind: vectorKind, lab, armed: false } : undefined,
				injectFailedEdit,
				undefined,
				undefined,
				undefined,
				e19 || e17Live ? { ...cellLimits, maxTotalTokens: tier } : undefined,
			);
		} finally {
			if (lab) {
				await lab.close().catch(async (error) => {
					if (
						!(error instanceof Error) ||
						!error.message.includes("removal of container") ||
						!error.message.includes("is already in progress")
					)
						throw error;
					// The Docker CLI started with --rm can race the fixture's explicit removal.
					await delay(500);
					await lab.close();
				});
			}
		}
		evaluated.push(result);
		console.log(task.id, profile.id, result.success, result.reason, !live && "error" in result ? result.error : "");
		if (live) {
			const gateway = result.budget;
			const fatalHttp = result.providerResponses?.find(({ status }) => [400, 401, 402, 403, 404].includes(status));
			if (result.violation) batch.stopReason = "isolation";
			else if (pairedLive && result.reason === "harness") batch.stopReason = "harness";
			else if (fatalHttp) batch.stopReason = `provider-http-${fatalHttp.status}`;
			else if (
				!gateway ||
				gateway.activeRequests ||
				gateway.reservedTokens ||
				gateway.reservedCostUsd ||
				gateway.requestsStarted > LIMITS.maxRequests ||
				gateway.committedTokenUpperBound > (pairedLive ? tier : LIMITS.maxTotalTokens) ||
				gateway.committedCostUpperBoundUsd > LIMITS.maxTotalCostUsd + 1e-10 ||
				gateway.lastError === "GATEWAY_PROVIDER_USAGE_EXCEEDED_RESERVATION"
			)
				batch.stopReason = "ledger-invariant";
			if (
				pairedLive &&
				gateway &&
				!gateway.activeRequests &&
				!gateway.reservedTokens &&
				!gateway.reservedCostUsd &&
				gateway.lastError !== "GATEWAY_PROVIDER_USAGE_EXCEEDED_RESERVATION"
			) {
				batch.settledUpperBoundUsd += gateway.committedCostUpperBoundUsd;
				batch.activeReserveUsd = 0;
			}
			if (!batch.activeReserveUsd) batch.activeCell = null;
			saveBatch();
			if (batch.stopReason) break;
		}
		if (result.violation) break;
	}
	const perProfile = PROFILES.map((profile) => {
		const x = evaluated.filter((row) => row.profile === profile.id);
		const avg = (fn: (row: (typeof x)[number]) => number) =>
			x.length ? x.reduce((sum, row) => sum + fn(row), 0) / x.length : null;
		const tests = x.flatMap((row) => row.testRuns.filter((t) => t.kind === "independent"));
		return {
			profile: profile.id,
			cells: x.length,
			successes: x.filter((row) => row.success).length,
			gradedTests: tests.length,
			passedTests: tests.filter((row) => row.status === "passed").length,
			meanTools: avg((row) => row.calls.length),
			meanRepeated: avg((row) => row.repeated),
			meanReads: avg((row) => row.calls.filter((call) => call.name === "read").length),
			meanMemory: avg((row) => row.retrievals.filter((r) => r.kind === "memory").length),
			meanRag: avg((row) => row.retrievals.filter((r) => r.kind === "rag").length),
			meanInput: avg((row) => row.budget?.actualInputTokens ?? 0),
			meanOutput: avg((row) => row.budget?.actualOutputTokens ?? 0),
			meanMs: avg((row) => row.elapsedMs),
			p50Ms: percentile(
				x.map((r) => r.elapsedMs),
				0.5,
			),
			p95Ms: percentile(
				x.map((r) => r.elapsedMs),
				0.95,
			),
			recovered: x.filter((row) => row.resumed).length,
		};
	});
	if (live) {
		batch.state = batch.stopReason ? "stopped" : "completed";
		Object.assign(batch, {
			endedAt: new Date().toISOString(),
			...(e19 ? { unrun: batch.plan?.slice(evaluated.length) } : {}),
			perProfile,
			reportedUsageAtPeakUsd: evaluated.reduce((total, row) => total + (row.budget?.actualCostUsd ?? 0), 0),
			committedUpperBoundUsd: evaluated.reduce(
				(total, row) => total + (row.budget?.committedCostUpperBoundUsd ?? 0),
				0,
			),
		});
		saveBatch();
		if (batch.stopReason) process.exitCode = 1;
	} else {
		const state = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : {};
		const manifest = taskSet.map(({ files, hidden, edits, ...task }) => ({
			...task,
			files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])),
			hiddenSha256: hash(hidden),
			editPaths: [...new Set(edits.map((edit) => edit.path))],
		}));
		const run = {
			seed,
			manifest,
			manifestSha256: hash(JSON.stringify(taskSet)),
			profile: PROFILES,
			limits: replayTools || enhancedWorkflow ? cellLimits : LIMITS,
			pytestImage: PYTEST,
			mode: replayTools ? "loopback-discovery" : "loopback-deterministic",
			context: "select; task injection on; automatic Memory injection off",
			taskManager: "v1; same configuration for all groups",
			perProfile,
			evaluated,
		};
		if (e19) {
			assert(!existsSync(resolve(e19Root, "paid.json")), "Preserve the authenticated E19 round");
			state.experiment = e19Experiment;
			state.offline = run;
			delete state.gate;
		} else if (e17) {
			state.preflight ??= {};
			state.preflight[`${selected}:${tokenTier}`] = {
				...run,
				compatibilityModelId: modelId,
				simulatedPricing: FLASH_PRICING,
			};
		} else if (e16) {
			state.runs ??= {};
			state.runs[`${selected}:${tokenTier}:${runtimeOnly ? "runtime-only" : "combined"}`] = {
				...run,
				workflow: runtimeOnly ? "runtime-only" : "combined",
				deadlineSeconds: 180,
				simulatedPricing: FLASH_PRICING,
			};
		} else if (e14Replay) {
			state.e14Replay = run;
		} else if (e14Retry) {
			state.e14Retry = run;
		} else if (e14Matrix || e15) {
			state[e15 ? "e15" : "e14Matrix"] = run;
		} else if (e12Baseline) {
			state.offlineBaseline = run;
		} else if (e12Retry) {
			state.e12RetryAfterEdit = run;
		} else if (e12Probe) {
			state.contextProbe = run;
		} else if (budgetReplay) {
			state.budgetReplay = run;
		} else if (e9Retry) {
			state[retryAfterEdit ? "transportReplayAfterEdit" : "transportReplay"] = run;
		} else if (e9Pilot) {
			state.resumePilot = run;
		} else if (scopeProbe) {
			state.scope = run;
		} else if (replayTools) {
			state.offlineMatrix = run;
		} else if (injectFailedEdit) {
			state.postEditFault = run;
		} else if (vectorKind) {
			state.inTaskVectorFaults ??= {};
			state.inTaskVectorFaults[vectorKind] = run;
		} else if (selected) state.pilot = run;
		else {
			if (state.matrix && !state.initialMatrix) state.initialMatrix = state.matrix;
			state.matrix = run;
		}
		mkdirSync(dirname(output), { recursive: true });
		writeFileSync(output, `${JSON.stringify(state, null, 2)}\n`);
		if (
			evaluated.some(
				(row) =>
					row.violation ||
					row.reason === "harness" ||
					(replayTools && !("discoveredSource" in row && row.discoveredSource)),
			) ||
			(e12Probe &&
				!evaluated.every(
					(row) => row.success && row.projections.some((projection) => (projection.context?.duplicates ?? 0) > 0),
				)) ||
			(scopeProbe && !evaluated.every((row) => row.success)) ||
			(injectFailedEdit && !evaluated.every((row) => row.success && row.resumed)) ||
			(vectorKind &&
				!evaluated.every(
					(row) =>
						row.success && row.retrievals.some((x) => x.status === "backend-unavailable" && x.mode === "lexical"),
				))
		)
			process.exitCode = 1;
	}
}
