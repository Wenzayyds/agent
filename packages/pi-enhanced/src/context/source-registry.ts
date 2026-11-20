import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KnowledgeService } from "../knowledge/service.ts";

type Session = ExtensionContext["sessionManager"];
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

interface SourceRegistry {
	owners: WeakMap<Session, ExtensionAPI>;
	pages: WeakMap<Session, (host: boolean) => boolean>;
	knowledge: WeakMap<Session, () => KnowledgeService | undefined>;
	legacyBoundaries: WeakMap<Session, number>;
	memoryViews: WeakSet<ToolResult>;
}

// Pi loads separate extension entry points with separate module caches. The registry
// uses the host's session identity and weak references, and is never serialized.
const key = Symbol.for("wz-agent.pi-enhanced.source-registry.v1");
const host: typeof globalThis & { [key]?: SourceRegistry } = globalThis;

host[key] ??= {
	owners: new WeakMap(),
	pages: new WeakMap(),
	knowledge: new WeakMap(),
	legacyBoundaries: new WeakMap(),
	memoryViews: new WeakSet(),
};

export const sourceRegistry = host[key];
