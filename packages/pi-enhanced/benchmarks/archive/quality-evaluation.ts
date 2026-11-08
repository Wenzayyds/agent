import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateContextMessages } from "../../src/context/budget.ts";
import type { ContextMessage } from "../../src/context/contracts.ts";
import { selectContextMessages } from "../../src/context/selector.ts";
import { hasValidToolPairing } from "../../src/context/tool-output.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { LocalMemoryProvider } from "../../src/memory/provider.ts";
import { SemanticSearchAdapter } from "../../src/memory/semantic-search-adapter.ts";
import { MemoryService } from "../../src/memory/service.ts";
import { ensureProjectStorage } from "../../src/memory/storage.ts";

const samples = [
	["m01", "Windows file lock prevents SQLite rename; close every DatabaseSync handle before restore."],
	["m02", "认证模块跨文件故障位于 auth/token.ts 与 middleware/session.ts 的过期时间单位不一致。"],
	["m03", "Rare symbol reconcileOrphanAttempt marks an interrupted task as needs_reconciliation."],
	["m04", "Context selection must keep a tool call adjacent to its matching tool result."],
	["m05", "FTS5 lexical search is the fallback when the Python worker is unavailable."],
	["m06", "部署前必须由用户明确批准，任务管理器不能自动重放外部副作用。"],
	["m07", "The release package excludes SQLite databases, credentials, logs, and vector indexes."],
	["m08", "Memory candidate requires independent verification before becoming verified."],
	["m09", "normalizeProjectRoot resolves symlinks before deriving the project identifier."],
	["m10", "长工具输出裁剪仍需保留最新错误、退出码以及完整的调用结果配对。"],
	["m11", "Task plan changes use planRevision compare-and-swap to reject stale writers."],
	["m12", "The backup manifest records projectId, schema version, timestamp and SHA-256."],
	["m13", "Serena provides symbol-oriented code navigation but is not the authority for Memory state."],
	["m14", "LSA uses corpus-local TF-IDF and SVD; it is not a pretrained neural embedding."],
	["m15", "归档、过期、失效与删除的记忆都不能自动注入上下文。"],
	["m16", "Native write and edit tools must resolve the canonical path before execution."],
	["m17", "Shell syntax cannot be safely authorized with a command substring blacklist."],
	["m18", "A task completion claim from the model is not trusted execution evidence."],
	["m19", "Python worker results are revalidated by TypeScript against revision and content hash."],
	["m20", "Context custom messages map to user-role model messages and remain low-trust references."],
] as const;
const queries = [
	["q01", "数据库恢复时提示文件被占用", "m01", "synonym"],
	["q02", "登录令牌跨模块过期异常", "m02", "cross_file"],
	["q03", "reconcileOrphanAttempt", "m03", "rare_symbol"],
	["q04", "工具调用和工具结果不能拆散", "m04", "chinese"],
	["q05", "没有 Python 时用什么检索", "m05", "synonym"],
	["q06", "危险操作崩溃后不要再次执行", "m06", "chinese"],
	["q07", "planRevision stale concurrent writer", "m11", "rare_symbol"],
	["q08", "本地语义向量是不是神经 embedding", "m14", "synonym"],
] as const;
const root = mkdtempSync(join(process.cwd(), ".batch-e-quality-"));
const project = join(root, "project");
mkdirSync(project);
const scope = createProjectScope({ cwd: project, agentDir: join(root, "agent") });
ensureProjectStorage(scope);
const provider = new LocalMemoryProvider(scope);
const service = new MemoryService(scope, provider);
try {
	const ids = new Map<string, string>();
	for (const [index, [label, content]] of samples.entries()) {
		const normalized = content.normalize("NFKC").replace(/\s+/gu, " ").trim();
		const candidate = await provider.saveCandidate({
			id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			kind: "fact",
			content,
			normalizedContent: normalized,
			contentHash: createHash("sha256").update(normalized).digest("hex"),
			source: { type: "test", ref: `batch-e:${label}`, observedAt: Date.now() },
			now: Date.now(),
		});
		const verified = await provider.setStatus({
			id: candidate.id,
			status: "verified",
			verification: {
				id: randomUUID(),
				type: "test_passed",
				evidenceRef: "batch-e-human-label",
				evidenceVersion: "v1",
				verifiedAt: Date.now(),
			},
			expectedRevision: candidate.revision,
			now: Date.now(),
		});
		ids.set(label, verified.id);
	}
	const config = (mode: "semantic" | "hybrid") =>
		({
			enabled: true,
			mode,
			rerankerEnabled: false,
			startupTimeoutMs: 5_000,
			requestTimeoutMs: 2_000,
			maximumSnapshotRecords: 100,
			semanticCandidates: 10,
		}) as const;
	const semantic = new SemanticSearchAdapter({ service, config: config("semantic") });
	const hybrid = new SemanticSearchAdapter({ service, config: config("hybrid") });
	const rows = [];
	for (const [queryId, text, expected, category] of queries) {
		const lexical = await service.search({ text, limit: 5, statuses: ["verified"] });
		const semanticResult = await semantic.search({ text, limit: 5 });
		const hybridResult = await hybrid.search({ text, limit: 5 });
		const expectedId = ids.get(expected)!;
		const rank = (records: readonly { id: string }[]) => {
			const value = records.findIndex((item) => item.id === expectedId);
			return value < 0 ? null : value + 1;
		};
		rows.push({
			queryId,
			category,
			expected,
			ranks: { lexical: rank(lexical), semantic: rank(semanticResult.records), hybrid: rank(hybridResult.records) },
			activeModes: { semantic: semanticResult.mode, hybrid: hybridResult.mode },
		});
	}
	const score = (mode: "lexical" | "semantic" | "hybrid") => ({
		recallAt5: rows.filter((row) => row.ranks[mode] !== null).length / rows.length,
		mrrAt5: rows.reduce((sum, row) => sum + (row.ranks[mode] ? 1 / row.ranks[mode]! : 0), 0) / rows.length,
	});
	const history: ContextMessage[] = [];
	for (let index = 0; index < 20; index++)
		history.push({ role: "user", content: `historic request ${index} ${"x".repeat(400)}`, timestamp: index });
	history.push(
		assistantTool("quality-call"),
		{
			role: "toolResult",
			toolCallId: "quality-call",
			toolName: "read",
			content: [{ type: "text", text: "important failure evidence" }],
			isError: false,
			timestamp: 21,
		},
		{ role: "user", content: "latest objective", timestamp: 22 },
	);
	const selected = selectContextMessages(history, {
		budget: { maximumEstimatedTokens: 1_200, reserveEstimatedTokens: 0, recentMessagesToKeep: 2 },
		toolOutput: { enabled: true, maximumTextCharacters: 1_000 },
	});
	const result = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		sampleClass: "manually-authored-non-private",
		limitations: "20 records and 8 labeled queries; not representative of production repositories",
		records: samples.length,
		queries: queries.length,
		model: "lsa-tfidf-svd-v1",
		metrics: { lexical: score("lexical"), semantic: score("semantic"), hybrid: score("hybrid") },
		context: {
			observeEstimatedTokens: estimateContextMessages(history),
			selectEstimatedTokens: selected.afterEstimatedTokens,
			selectedMessages: selected.messages.length,
			latestUserRetained: selected.messages.at(-1)?.role === "user",
			toolPairingValid: hasValidToolPairing(selected.messages),
			memoryTaskPassRate: null,
			passRateReason: "real model not authorized",
		},
		rows,
	};
	writeFileSync(
		new URL("../../docs/memory-context-quality-results.json", import.meta.url),
		`${JSON.stringify(result, null, 2)}\n`,
	);
	process.stdout.write(`${JSON.stringify(result.metrics)}\n`);
	await semantic.close();
	await hybrid.close();
} finally {
	await service.close();
	rmSync(root, { recursive: true, force: true });
}

function assistantTool(id: string): ContextMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "src/example.ts" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 20,
	};
}
