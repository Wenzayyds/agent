import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryIntelligenceConfig } from "./config.ts";
import type { MemoryRuntimeInfo, ProjectScope, ScopedMemoryReader } from "./contracts.ts";
import type { MemoryGovernanceConfig } from "./governance.ts";
import { createProjectScope, type ProjectScopeOptions } from "./project-scope.ts";
import { ScopedMemoryReaderAdapter } from "./reader.ts";
import { SemanticSearchAdapter } from "./semantic-search-adapter.ts";
import { MemoryService } from "./service.ts";
import { SessionRecallAdapter } from "./session-recall.ts";

export interface ClosableMemoryBackend {
	readonly searchStatus?: "fts-ready" | "degraded";
	close(): Promise<void>;
}

export type OpenMemoryBackend = (scope: ProjectScope) => Promise<ClosableMemoryBackend>;

export interface MemoryRuntime extends MemoryRuntimeInfo {
	readonly backend?: ClosableMemoryBackend;
	readonly sessionRecall?: SessionRecallAdapter;
	readonly reader?: ScopedMemoryReader;
	readonly intelligence?: SemanticSearchAdapter;
	readonly governanceConfig?: MemoryGovernanceConfig;
	close(): Promise<void>;
}

export interface StartMemoryRuntimeOptions extends Omit<ProjectScopeOptions, "platform" | "realpath"> {
	enabled: boolean;
	intelligenceConfig?: MemoryIntelligenceConfig;
	governanceConfig?: MemoryGovernanceConfig;
	projectTrusted: boolean;
	createScope?: (options: ProjectScopeOptions) => ProjectScope;
	openBackend?: OpenMemoryBackend;
	sessionManager?: ExtensionContext["sessionManager"];
	createSessionRecall?: (
		scope: ProjectScope,
		sessionManager: ExtensionContext["sessionManager"],
	) => SessionRecallAdapter;
}

export async function startMemoryRuntime(options: StartMemoryRuntimeOptions): Promise<MemoryRuntime> {
	if (!options.enabled) return inertRuntime("disabled");
	if (!options.projectTrusted) return inertRuntime("blocked");

	let backend: ClosableMemoryBackend | undefined;
	let sessionRecall: SessionRecallAdapter | undefined;
	let reader: ScopedMemoryReaderAdapter | undefined;
	let intelligence: SemanticSearchAdapter | undefined;
	try {
		const scope = (options.createScope ?? createProjectScope)({ cwd: options.cwd, agentDir: options.agentDir });
		backend = options.openBackend ? await options.openBackend(scope) : undefined;
		if (backend instanceof MemoryService) {
			reader = new ScopedMemoryReaderAdapter(backend);
			if (options.intelligenceConfig) {
				intelligence = new SemanticSearchAdapter({ service: backend, config: options.intelligenceConfig });
			}
		}
		if (options.sessionManager) {
			sessionRecall = (
				options.createSessionRecall ?? ((currentScope, manager) => new SessionRecallAdapter(currentScope, manager))
			)(scope, options.sessionManager);
		}
		let closed = false;
		return {
			state: "ready",
			scope,
			...(backend?.searchStatus ? { searchStatus: backend.searchStatus } : {}),
			...(backend ? { backend } : {}),
			...(sessionRecall ? { sessionRecall } : {}),
			...(reader ? { reader } : {}),
			...(intelligence ? { intelligence } : {}),
			...(options.governanceConfig ? { governanceConfig: options.governanceConfig } : {}),
			async close() {
				if (closed) return;
				closed = true;
				await intelligence?.close().catch(() => undefined);
				reader?.close();
				sessionRecall?.close();
				await backend?.close();
			},
		};
	} catch (error) {
		await intelligence?.close().catch(() => undefined);
		reader?.close();
		sessionRecall?.close();
		await backend?.close().catch(() => undefined);
		return inertRuntime("error", error instanceof Error ? error.message : String(error));
	}
}

function inertRuntime(state: "disabled" | "blocked" | "error", error?: string): MemoryRuntime {
	return {
		state,
		...(error ? { error } : {}),
		async close() {},
	};
}
