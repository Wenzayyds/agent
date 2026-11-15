import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { LocalMemoryProvider } from "../../src/memory/provider.ts";
import { ensureProjectStorage } from "../../src/memory/storage.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import type { BatchLAuthorization } from "./batch-l-authorization.ts";
import {
	BATCH_L_MODULE_TOOLS,
	batchLPrompt,
	batchLReferences,
	TASK_PAIR_INSTRUCTIONS,
	TASK_PAIR_PROFILE,
} from "./batch-l-profile.ts";
import { type ControlledCell, LONG_REPORT_TASK, longReport, MEMORY_RULE, TASK_STEPS } from "./controlled-cases.ts";
import { digest } from "./evaluation-identity.ts";
import type { EvaluationPlan } from "./evaluation-policy.ts";
import { NEXT_EVALUATION_INSTRUCTIONS, NEXT_EVALUATION_PROFILE } from "./evaluation-telemetry.ts";
import type { OfflineDenialPolicy } from "./offline-denial-policy.ts";
import { SWE_TASK_CONFIGURATION } from "./swe-profile.ts";
import { swePrompt } from "./swe-instance.ts";
import { prepareSweWorkspace, type SweTask } from "./swe-workspace.ts";
import type { TaskPairAuthorization, TaskPairInput } from "./task-pair-authorization.ts";
export interface ExperimentTask {
	id: string;
	category: string;
	prompt: string;
	swebench?: SweTask;
}
export interface ModuleSwitches {
	memory: boolean;
	context: boolean;
	task: boolean;
}
export interface RunnerContext {
	task: ExperimentTask;
	root: string;
	packageRoot: string;
	repositoryRoot: string;
	runOutput: string;
	plan: EvaluationPlan;
	switches: ModuleSwitches;
	batchL: boolean;
	cell?: ControlledCell;
	comparisonProfile?: string;
	condition: string;
	readonlyModuleTools: boolean;
	singleFileTestFeedback?: boolean;
	telemetryEnabled: boolean;
	localStubUrl?: string;
	authorization?: BatchLAuthorization;
	taskPairAuthorization?: TaskPairAuthorization;
	taskPairExpected?: TaskPairInput;
	offlinePolicy?: OfflineDenialPolicy;
	observedCost: number;
	taskMode?: "off" | "v1" | "v2";
}

/** Creates only host-owned synthetic fixtures. Never verifies model-written code here. */
export function prepareWorkspace(
	task: ExperimentTask,
	root: string,
	cell: ControlledCell | undefined,
	batchL: boolean,
	comparisonProfile?: string,
) {
	const cwd = join(root, task.id);
	if (task.swebench) {
		const tree = prepareSweWorkspace(task.swebench, cwd);
		return { cwd, inputFixtureHash: digest(tree), repositoryCommit: task.swebench.issue.base_commit };
	}
	mkdirSync(cwd);
	generate(task.id, cwd);
	if (batchL)
		for (const [name, content] of Object.entries(batchLReferences(cell!))) writeFileSync(join(cwd, name), content);
	const inputFixtureHash = digest(
		Object.fromEntries(
			readdirSync(cwd)
				.sort()
				.map((name) => [name, readFileSync(join(cwd, name), "utf8")]),
		),
	);
	initGit(cwd);
	// Only pristine, host-generated fixtures reach this check, before any Agent is started.
	const initialVerifierPassed = comparisonProfile === TASK_PAIR_PROFILE ? null : verifyTrustedFixture(task.id, cwd);
	if (initialVerifierPassed) throw new Error(`Fixture ${task.id} is not initially failing`);
	const repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	return { cwd, inputFixtureHash, repositoryCommit };
}
export async function prepareAgent(context: RunnerContext, workspace: ReturnType<typeof prepareWorkspace>) {
	const { task, root, cell, batchL, switches, condition, readonlyModuleTools, comparisonProfile } = context;
	const { cwd } = workspace;
	const agentDir = join(root, `${task.id}-agent`);
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProjectTrust: "always",
			...(cell || task.swebench || context.singleFileTestFeedback ? { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } } : {}),
		}),
	);
	writeFileSync(
		join(agentDir, "pi-enhanced.json"),
		JSON.stringify({
			modules: {
				"mcp-policy": {
					enabled: false,
					defaultAction: "ask",
					rules: [],
					nativeToolGuard: { enabled: true, workspaceMutationAction: "allow", protectProjectMetadata: true },
				},
				memory: { enabled: switches.memory },
				context: {
					enabled: switches.context,
					mode: "select",
					memoryInjection: { enabled: switches.memory },
					taskInjection: { enabled: switches.task },
					...(cell?.module === "context"
						? { toolOutput: { enabled: cell.treatment, maximumTextCharacters: 2_000 } }
						: {}),
				},
				"task-manager": context.taskMode
					? { mode: context.taskMode, modelPlanTool: context.taskMode === "v2" }
					: { enabled: switches.task },
			},
		}),
	);
	const memorySeed = (batchL ? cell!.module === "memory" : condition === "memory_seeded" && switches.memory)
		? await seedMemory(cwd, agentDir, cell ? MEMORY_RULE : undefined)
		: null;
	let seededTaskId: string | undefined;
	let taskStateBefore: ReturnType<TaskService["get"]> = null;
	if (batchL ? cell!.module === "task" : !task.swebench && readonlyModuleTools && switches.task) {
		const service = new TaskService(
			new TaskProvider(createTaskStorageScope(createProjectScope({ cwd, agentDir }), agentDir)),
			20,
		);
		try {
			seededTaskId = service.create(
				batchL ? batchLPrompt(cell!) : task.prompt,
				cell
					? TASK_STEPS
					: [
							{ title: "阅读实现并定位缺陷", expectedOutcome: "说明缺陷来源" },
							{ title: "最小修改", expectedOutcome: "公开 API 保持一致，不修改测试", dependsOn: [] },
						],
				"controlled-pilot-setup",
				null,
			).task.taskId;
			taskStateBefore = service.get(seededTaskId);
		} finally {
			service.close();
		}
	}
	const moduleTools = task.swebench
		? [...SWE_TASK_CONFIGURATION.moduleTools[context.taskMode ?? "off"]]
		: batchL
			? BATCH_L_MODULE_TOOLS
			: readonlyModuleTools
				? [...(switches.memory ? ["enhanced_memory_search"] : []), ...(switches.task ? ["enhanced_task_get"] : [])]
				: [];
	const prompt = task.swebench
		? swePrompt(task.prompt)
		: batchL
			? batchLPrompt(cell!) +
				(comparisonProfile === TASK_PAIR_PROFILE
					? `\n${TASK_PAIR_INSTRUCTIONS}`
					: comparisonProfile === NEXT_EVALUATION_PROFILE
						? `\n${NEXT_EVALUATION_INSTRUCTIONS}`
						: "")
			: task.prompt +
				(context.singleFileTestFeedback ? "\n先用 run_tests 复现失败。只修改 math.js，修改后复测；若失败，按测试反馈继续修复。" : "") +
				(cell?.id === "m_inline" ? `\n项目规则：${MEMORY_RULE}` : "") +
				(cell?.id === "t_inline" ? `\n步骤计划：${JSON.stringify({ goal: task.prompt, steps: TASK_STEPS })}` : "") +
				(moduleTools.includes("enhanced_memory_search")
					? " 可使用只读项目记忆搜索查阅 normalizeKey 项目约定。"
					: "") +
				(seededTaskId ? ` 任务计划 ID 为 ${seededTaskId}，可先用 enhanced_task_get 查询。` : "");
	return { ...workspace, agentDir, memorySeed, seededTaskId, taskStateBefore, moduleTools, prompt };
}
export type PreparedAgent = Awaited<ReturnType<typeof prepareAgent>>;
async function seedMemory(
	cwd: string,
	agentDir: string,
	controlledContent?: string,
): Promise<{ id: string; probeQuery: string; verifiedHits: number }> {
	const scope = createProjectScope({ cwd, agentDir });
	ensureProjectStorage(scope);
	const provider = new LocalMemoryProvider(scope);
	try {
		const content =
			controlledContent ??
			"项目约定：normalizeKey 必须 trim 后转成小写且不改变输入；validateItems 必须检查整个数组，不能只检查前十项。修改前阅读实现，保留公开 API，不修改测试。";
		const normalizedContent = content.normalize("NFKC").replace(/\s+/gu, " ").trim();
		const candidate = await provider.saveCandidate({
			kind: "experience",
			content,
			normalizedContent,
			contentHash: createHash("sha256").update(normalizedContent).digest("hex"),
			source: { type: "user", ref: "controlled-ablation-seed", observedAt: Date.now() },
			now: Date.now(),
		});
		await provider.setStatus({
			id: candidate.id,
			status: "verified",
			verification: {
				id: randomUUID(),
				type: "test_passed",
				evidenceRef: "controlled-ablation-fixture",
				evidenceVersion: "v1",
				verifiedAt: Date.now(),
			},
			expectedRevision: candidate.revision,
			now: Date.now(),
		});
		const probeQuery = "normalizeKey";
		const records = await provider.search({ text: probeQuery, statuses: ["verified"] });
		if (!records.some((record) => record.id === candidate.id)) throw new Error("EVAL_MEMORY_SEED_NOT_SEARCHABLE");
		if (controlledContent) {
			for (const distractor of [
				"无关约定：formatName 仅用于显示名称。",
				"候选信息：normalizeKey 应保留首尾空格（未确认，不可用于参考）。",
			]) {
				const normalized = distractor.normalize("NFKC");
				await provider.saveCandidate({
					kind: "experience",
					content: distractor,
					normalizedContent: normalized,
					contentHash: createHash("sha256").update(normalized).digest("hex"),
					source: { type: "test", ref: "controlled-distractor", observedAt: Date.now() },
					now: Date.now(),
				});
			}
		}
		return { id: candidate.id, probeQuery, verifiedHits: records.length };
	} finally {
		provider.close();
	}
}
function initGit(cwd: string): void {
	execFileSync("git", ["init"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd });
	execFileSync("git", ["config", "user.name", "Fixture"], { cwd });
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["commit", "-m", "failing fixture"], {
		cwd,
		stdio: "ignore",
		env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
	});
}
function generate(id: string, cwd: string): void {
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: "module", private: true }));
	if (id === LONG_REPORT_TASK.id) {
		writeFileSync(join(cwd, "diagnostics.txt"), longReport());
		writeFileSync(
			join(cwd, "validate.js"),
			"export const validateItems = items => items.slice(0, 10).every(value => value >= 0);\n",
		);
		return;
	}
	const files: Record<string, Record<string, string>> = {
		"single-file-off-by-one": { "math.js": "export const sumTo = n => n * (n - 1) / 2;\n" },
		"cross-file-export": {
			"formatter.js": "const formatName = value => value.toUpperCase();\n",
			"index.js": "export { formatName } from './formatter.js';\n",
		},
		"config-default": {
			"config.js": "export const loadConfig = input => ({ timeoutMs: input.timeoutMs || 1000 });\n",
		},
		"long-output-localization": {
			"validate.js": "export const validateItems = items => items.slice(0, 10).every(value => value >= 0);\n",
		},
		"memory-guided-regression": { "key.js": "export const normalizeKey = value => value.trim();\n" },
	};
	for (const [name, content] of Object.entries(files[id]!)) writeFileSync(join(cwd, name), content);
}
function verifyTrustedFixture(id: string, cwd: string): boolean {
	if (id === LONG_REPORT_TASK.id) {
		if (readFileSync(join(cwd, "diagnostics.txt"), "utf8") !== longReport()) return false;
		id = "long-output-localization";
	}
	const programs: Record<string, string> = {
		"single-file-off-by-one": "import('./math.js').then(m=>{if(m.sumTo(3)!==6)process.exit(1)})",
		"cross-file-export":
			"import('./index.js').then(m=>{if(m.formatName('pi')!=='PI')process.exit(1)}).catch(()=>process.exit(1))",
		"config-default":
			"import('./config.js').then(m=>{if(m.loadConfig({}).timeoutMs!==5000||m.loadConfig({timeoutMs:7}).timeoutMs!==7)process.exit(1)})",
		"long-output-localization":
			"import('./validate.js').then(m=>{if(m.validateItems([...Array(20).fill(1),-1])!==false)process.exit(1)})",
		"memory-guided-regression":
			"import('./key.js').then(m=>{const x='  PI ';if(m.normalizeKey(x)!=='pi'||x!=='  PI ')process.exit(1)})",
	};
	return (
		spawnSync(process.execPath, ["--input-type=module", "-e", programs[id]!], {
			cwd,
			stdio: "ignore",
			timeout: 5_000,
		}).status === 0
	);
}
